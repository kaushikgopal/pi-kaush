import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const runtimeMock = vi.hoisted(() => ({ agentDir: "" }));
const tuiMock = vi.hoisted(() => {
  class FakeEditor {
    constructor(private readonly lines: string[]) {}

    render(_width: number): string[] {
      return this.lines;
    }
  }

  return {
    FakeEditor,
    rawRender: FakeEditor.prototype.render,
    visibleWidth(text: string) {
      return text.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "").length;
    },
  };
});

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return {
    ...original,
    getAgentDir: () => runtimeMock.agentDir,
  };
});

vi.mock("@earendil-works/pi-tui", () => ({
  Editor: tuiMock.FakeEditor,
  visibleWidth: tuiMock.visibleWidth,
}));

const {
  colorizeAgentAliases,
  createAgentAutocompleteProvider,
  default: inlineAgentIdentifier,
  discoverAgentDefinitions,
  getNamedSubagentSupport,
  referencedAgents,
} = await import("../src/index.ts");

type Handler = (event: any, context: any) => any;

type HarnessOptions = {
  cwd: string;
  trusted?: boolean;
  namedTool?: boolean;
  projectScope?: boolean;
};

let tempRoots: string[] = [];

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "pi-inline-agent-"));
  tempRoots.push(root);
  runtimeMock.agentDir = join(root, "pi-agent");
  mkdirSync(join(runtimeMock.agentDir, "agents"), { recursive: true });
});

afterEach(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
  tempRoots = [];
});

function writeAgent(
  dir: string,
  name: string,
  description = `${name} description`,
  relativePath = `${name}.md`,
): void {
  const filePath = join(dir, relativePath);
  mkdirSync(join(filePath, ".."), { recursive: true });
  writeFileSync(
    filePath,
    `---\nname: ${name}\ndescription: ${description}\n---\n\nAgent prompt.\n`,
  );
}

function namedSubagentTool(projectScope = true) {
  return {
    name: "subagent",
    parameters: {
      type: "object",
      properties: {
        agent: { type: "string" },
        task: { type: "string" },
        ...(projectScope ? { agentScope: { type: "string" } } : {}),
      },
    },
  };
}

function createHarness(options: HarnessOptions) {
  const handlers = new Map<string, Handler>();
  const currentAutocomplete = {
    getSuggestions: vi.fn(async () => ({
      prefix: "@",
      items: [{ value: "@fallback", label: "@fallback" }],
    })),
    applyCompletion: vi.fn(
      (
        lines: string[],
        cursorLine: number,
        cursorCol: number,
        item: { value: string },
        prefix: string,
      ) => {
        const line = lines[cursorLine] ?? "";
        const before = line.slice(0, cursorCol - prefix.length);
        const after = line.slice(cursorCol);
        const next = [...lines];
        next[cursorLine] = before + item.value + after;
        return {
          lines: next,
          cursorLine,
          cursorCol: before.length + item.value.length,
        };
      },
    ),
    shouldTriggerFileCompletion: vi.fn(() => true),
  };
  let autocompleteProvider: any;
  const tools =
    options.namedTool === false
      ? [
          {
            name: "subagent",
            parameters: { type: "object", properties: { task: {} } },
          },
        ]
      : [namedSubagentTool(options.projectScope)];
  const pi = {
    getAllTools: () => tools,
    on(name: string, handler: Handler) {
      handlers.set(name, handler);
    },
  };
  const context = {
    cwd: options.cwd,
    mode: "tui",
    isProjectTrusted: () => options.trusted ?? true,
    ui: {
      addAutocompleteProvider(factory: (current: any) => any) {
        autocompleteProvider = factory(currentAutocomplete);
      },
    },
  };

  inlineAgentIdentifier(pi as never);
  return {
    input(text: string, source = "interactive") {
      return handlers.get("input")?.({ text, source }, context);
    },
    start(mode = "tui") {
      handlers.get("session_start")?.({}, { ...context, mode });
    },
    shutdown() {
      handlers.get("session_shutdown")?.({}, context);
    },
    autocompleteProvider: () => autocompleteProvider,
    currentAutocomplete,
  };
}

describe("named subagent compatibility", () => {
  test("requires a subagent tool with an agent parameter", () => {
    expect(
      getNamedSubagentSupport({
        getAllTools: () => [namedSubagentTool()],
      } as never),
    ).toEqual({ available: true, supportsProjectScope: true });
    expect(
      getNamedSubagentSupport({
        getAllTools: () => [
          {
            name: "subagent",
            parameters: { type: "object", properties: { task: {} } },
          },
        ],
      } as never),
    ).toEqual({ available: false, supportsProjectScope: false });
  });
});

describe("agent discovery", () => {
  test("discovers nested user agents and lets project agents override them", () => {
    const userDir = join(runtimeMock.agentDir, "agents");
    writeAgent(userDir, "reviewer", "User reviewer");
    writeAgent(userDir, "scout", "Nested scout", "nested/scout.md");

    const project = join(tempRoots[0]!, "project");
    const projectDir = join(project, ".pi", "agents");
    writeAgent(projectDir, "reviewer", "Project reviewer");
    writeAgent(projectDir, "worker", "Project worker");

    expect(discoverAgentDefinitions(join(project, "src"), true)).toMatchObject([
      { name: "reviewer", description: "Project reviewer", source: "project" },
      { name: "scout", description: "Nested scout", source: "user" },
      { name: "worker", description: "Project worker", source: "project" },
    ]);
    expect(discoverAgentDefinitions(join(project, "src"), false)).toMatchObject(
      [
        { name: "reviewer", description: "User reviewer", source: "user" },
        { name: "scout", description: "Nested scout", source: "user" },
      ],
    );
  });

  test("lets project agents override case-insensitive user name collisions", () => {
    const userDir = join(runtimeMock.agentDir, "agents");
    writeAgent(userDir, "Reviewer", "User reviewer");

    const project = join(tempRoots[0]!, "project");
    const projectDir = join(project, ".pi", "agents");
    writeAgent(projectDir, "reviewer", "Project reviewer");

    const definitions = discoverAgentDefinitions(project, true);
    expect(
      definitions.filter(
        (definition) => definition.name.toLowerCase() === "reviewer",
      ),
    ).toMatchObject([
      { name: "reviewer", description: "Project reviewer", source: "project" },
    ]);
  });

  test("ignores malformed and unsupported agent definitions", () => {
    const userDir = join(runtimeMock.agentDir, "agents");
    writeFileSync(join(userDir, "broken.md"), "---\nname: [\n---\n");
    writeAgent(userDir, "has.dot", "Unsupported name");
    writeAgent(userDir, "valid-agent", "Valid");

    expect(discoverAgentDefinitions(tempRoots[0]!, false)).toMatchObject([
      { name: "valid-agent" },
    ]);
  });
});

describe("inline agent input", () => {
  test("requests delegation for exactly one known user agent", () => {
    writeAgent(
      join(runtimeMock.agentDir, "agents"),
      "reviewer",
      "Review changes",
    );
    const harness = createHarness({ cwd: tempRoots[0]! });

    expect(harness.input("Ask &reviewer to inspect this.")).toEqual({
      action: "transform",
      text: 'Delegate this request to the "reviewer" subagent by calling the subagent tool. Use the full original request below as its task.\n\nAsk &reviewer to inspect this.',
    });
    expect(
      harness.input("Ask &reviewer, then remind &reviewer."),
    ).toMatchObject({
      action: "transform",
    });
  });

  test("requests project scope for a trusted project agent", () => {
    const project = join(tempRoots[0]!, "project");
    writeAgent(join(project, ".pi", "agents"), "project-reviewer");
    const harness = createHarness({ cwd: project, trusted: true });

    expect(harness.input("Use &project-reviewer.")).toEqual({
      action: "transform",
      text: 'Delegate this request to the "project-reviewer" subagent by calling the subagent tool. Set agentScope to "both" so the project agent is available. Use the full original request below as its task.\n\nUse &project-reviewer.',
    });
  });

  test("leaves ambiguous, file, shell, slash, and extension input unchanged", () => {
    const userDir = join(runtimeMock.agentDir, "agents");
    writeAgent(userDir, "reviewer");
    writeAgent(userDir, "scout");
    const harness = createHarness({ cwd: tempRoots[0]! });

    expect(harness.input("Use &unknown.")).toEqual({ action: "continue" });
    expect(harness.input("Use &reviewer and &scout.")).toEqual({
      action: "continue",
    });
    expect(harness.input("Attach @reviewer.")).toEqual({
      action: "continue",
    });
    expect(harness.input("Run foo &&reviewer.")).toEqual({
      action: "continue",
    });
    expect(harness.input("/model &reviewer")).toEqual({ action: "continue" });
    expect(harness.input("Use &reviewer.", "extension")).toEqual({
      action: "continue",
    });
  });

  test("does nothing without a compatible named-agent tool", () => {
    writeAgent(join(runtimeMock.agentDir, "agents"), "reviewer");
    const harness = createHarness({ cwd: tempRoots[0]!, namedTool: false });

    expect(harness.input("Use &reviewer.")).toEqual({ action: "continue" });
    harness.start();
    expect(harness.autocompleteProvider()).toBeUndefined();
  });

  test("does not expose project agents without trust or agentScope support", () => {
    const project = join(tempRoots[0]!, "project");
    writeAgent(join(project, ".pi", "agents"), "project-reviewer");

    expect(
      createHarness({ cwd: project, trusted: false }).input(
        "Use &project-reviewer.",
      ),
    ).toEqual({ action: "continue" });
    expect(
      createHarness({ cwd: project, projectScope: false }).input(
        "Use &project-reviewer.",
      ),
    ).toEqual({ action: "continue" });
  });
});

describe("inline agent references", () => {
  const agents = [
    {
      name: "reviewer",
      description: "Review",
      source: "user" as const,
      filePath: "/agents/reviewer.md",
    },
    {
      name: "reviewer-fast",
      description: "Review fast",
      source: "user" as const,
      filePath: "/agents/reviewer-fast.md",
    },
  ];

  test("matches complete known tokens once", () => {
    expect(
      referencedAgents(
        "Use &reviewer-fast, then &reviewer-fast again; skip &unknown.",
        agents,
      ).map((agent) => agent.name),
    ).toEqual(["reviewer-fast"]);
    expect(referencedAgents("Skip &reviewer-faster.", agents)).toEqual([]);
  });

  test("does not match shell operators or file references", () => {
    expect(referencedAgents("run foo &&reviewer", agents)).toEqual([]);
    expect(referencedAgents("attach @reviewer", agents)).toEqual([]);
  });
});

describe("inline agent autocomplete", () => {
  test("suggests matching agents through Pi autocomplete", async () => {
    const userDir = join(runtimeMock.agentDir, "agents");
    writeAgent(userDir, "reviewer", "Review changes");
    writeAgent(userDir, "reviewer-fast", "Review quickly");
    const harness = createHarness({ cwd: tempRoots[0]! });
    harness.start();
    const provider = harness.autocompleteProvider();
    const signal = new AbortController().signal;

    expect(provider.triggerCharacters).toEqual(["&"]);
    await expect(
      provider.getSuggestions(["Use &rev"], 0, 8, { signal }),
    ).resolves.toEqual({
      prefix: "&rev",
      items: [
        {
          value: "&reviewer",
          label: "&reviewer",
          description: "Review changes",
        },
        {
          value: "&reviewer-fast",
          label: "&reviewer-fast",
          description: "Review quickly",
        },
      ],
    });
    harness.shutdown();
  });

  test("preserves file completion and delegates completion behavior", async () => {
    const current = {
      getSuggestions: vi.fn(async () => ({ prefix: "@", items: [] })),
      applyCompletion: vi.fn(() => ({
        lines: ["Use &reviewer"],
        cursorLine: 0,
        cursorCol: 13,
      })),
      shouldTriggerFileCompletion: vi.fn(() => true),
    };
    const provider = createAgentAutocompleteProvider(
      current as never,
      () => [],
    );
    const signal = new AbortController().signal;

    await expect(
      provider.getSuggestions(["Open @src/file"], 0, 14, { signal }),
    ).resolves.toEqual({ prefix: "@", items: [] });
    expect(current.getSuggestions).toHaveBeenCalledOnce();

    expect(
      provider.applyCompletion(
        ["Use &rev"],
        0,
        8,
        { value: "&reviewer", label: "&reviewer" },
        "&rev",
      ),
    ).toEqual({ lines: ["Use &reviewer"], cursorLine: 0, cursorCol: 13 });
    expect(current.applyCompletion).toHaveBeenCalledOnce();
  });

  test("closes suggestions after a space", async () => {
    const current = {
      getSuggestions: vi.fn(async () => null),
      applyCompletion: vi.fn(),
    };
    const provider = createAgentAutocompleteProvider(
      current as never,
      () => [],
    );

    await expect(
      provider.getSuggestions(["Use &rev "], 0, 9, {
        signal: new AbortController().signal,
      }),
    ).resolves.toBeNull();
    expect(current.getSuggestions).not.toHaveBeenCalled();
  });
});

describe("inline agent highlighting", () => {
  test("colors known aliases without changing visible width", () => {
    const original = "Use &reviewer-fast, &reviewer, and &unknown.";
    const colored = colorizeAgentAliases(original, [
      "reviewer",
      "reviewer-fast",
    ]);

    expect(tuiMock.visibleWidth(colored)).toBe(tuiMock.visibleWidth(original));
    expect(colored).toContain("\x1b[38;2;125;211;252m&reviewer-fast\x1b[39m");
    expect(colored).toContain("\x1b[38;2;125;211;252m&reviewer\x1b[39m");
    expect(colored).toContain("&unknown");
  });

  test("patches once across reloads and clears lifecycle state", () => {
    writeAgent(join(runtimeMock.agentDir, "agents"), "reviewer");
    const first = createHarness({ cwd: tempRoots[0]! });
    first.start();
    const firstLine = new tuiMock.FakeEditor(["Use &reviewer."]).render(80)[0]!;
    expect(firstLine.match(/\x1b\[38;2;125;211;252m/g)).toHaveLength(1);
    first.shutdown();

    const second = createHarness({ cwd: tempRoots[0]! });
    second.start();
    const secondLine = new tuiMock.FakeEditor(["Use &reviewer."]).render(
      80,
    )[0]!;
    expect(secondLine.match(/\x1b\[38;2;125;211;252m/g)).toHaveLength(1);
    second.shutdown();

    expect(new tuiMock.FakeEditor(["Use &reviewer."]).render(80)[0]).toBe(
      "Use &reviewer.",
    );
  });

  test("upgrades a stale render patch after the alias syntax changes", () => {
    writeAgent(join(runtimeMock.agentDir, "agents"), "reviewer");
    const stateKey = Symbol.for("kg.pi.inlineAgentIdentifiers.decorationState");
    const globals = globalThis as Record<symbol, unknown>;
    const previousState = globals[stateKey];
    const prototype = tuiMock.FakeEditor.prototype;
    const previousRender = prototype.render;

    prototype.render = tuiMock.rawRender;
    globals[stateKey] = { patchedPrototype: prototype };
    const harness = createHarness({ cwd: tempRoots[0]! });

    try {
      harness.start();
      const line = new tuiMock.FakeEditor(["Use &reviewer."]).render(80)[0]!;
      expect(line).toContain("\x1b[38;2;125;211;252m&reviewer\x1b[39m");
    } finally {
      harness.shutdown();
      prototype.render = previousRender;
      if (previousState === undefined) delete globals[stateKey];
      else globals[stateKey] = previousState;
    }
  });
});
