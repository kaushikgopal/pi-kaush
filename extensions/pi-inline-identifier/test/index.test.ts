import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const runtimeMock = vi.hoisted(() => ({ agentDir: "" }));
const tuiMock = vi.hoisted(() => {
  class FakeEditor {
    autocompleteTriggerCharacters: string[] = [];
    autocompleteTriggerPattern?: RegExp;
    autocompleteDebouncePattern?: RegExp;

    constructor(private readonly lines: string[]) {}

    render(_width: number): string[] {
      return this.lines;
    }

    setAutocompleteTriggerCharacters(characters: string[]): void {
      this.autocompleteTriggerCharacters = characters.filter(
        (character) => character !== "/",
      );
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
  return { ...original, getAgentDir: () => runtimeMock.agentDir };
});

vi.mock("@earendil-works/pi-tui", () => ({
  Editor: tuiMock.FakeEditor,
  visibleWidth: tuiMock.visibleWidth,
}));

const [{ default: registerSkill }, { default: registerAgent }, promptModule] =
  await Promise.all([
    import("../src/skill.ts"),
    import("../src/agent.ts"),
    import("../src/prompt.ts"),
  ]);
const { default: registerPrompt, expandInlineTemplate } = promptModule;

type Handler = (event: any, context: any) => any;
type FeatureName = "skill" | "agent" | "prompt";

type Command = {
  name: string;
  source: "skill" | "prompt" | "extension";
  description?: string;
  sourceInfo: {
    path: string;
    source: string;
    scope: "user" | "project" | "temporary";
    origin: "package" | "top-level";
  };
};

let roots: string[] = [];

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "pi-inline-identifier-"));
  roots.push(root);
  runtimeMock.agentDir = join(root, "agent-dir");
  mkdirSync(join(runtimeMock.agentDir, "agents"), { recursive: true });

  tuiMock.FakeEditor.prototype.render = tuiMock.rawRender;
  const globals = globalThis as Record<symbol, unknown>;
  delete globals[Symbol.for("kg.pi.inlineIdentifier.decorationState.v1")];
});

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

function sourceInfo(path: string): Command["sourceInfo"] {
  return {
    path,
    source: "test",
    scope: "user",
    origin: "top-level",
  };
}

function writeAgent(name: string, source: "user" | "project" = "user"): void {
  const dir =
    source === "user"
      ? join(runtimeMock.agentDir, "agents")
      : join(roots[0]!, "project", ".pi", "agents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${name}.md`),
    `---\nname: ${name}\ndescription: ${name} agent\n---\n\nAgent body.\n`,
  );
}

function writePrompt(name: string, body: string): Command {
  const path = join(roots[0]!, `${name}.md`);
  writeFileSync(path, `---\ndescription: ${name} prompt\n---\n\n${body}\n`);
  return {
    name,
    source: "prompt",
    description: `${name} prompt`,
    sourceInfo: sourceInfo(path),
  };
}

function createHarness(
  features: FeatureName[],
  commands: Command[],
  options: { cwd?: string; trusted?: boolean } = {},
) {
  const handlers = new Map<string, Handler>();
  const fallback = { prefix: "fallback", items: [] };
  const currentAutocomplete = {
    getSuggestions: vi.fn(async () => fallback),
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
        const next = [...lines];
        next[cursorLine] = before + item.value + line.slice(cursorCol);
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
  let editorText = "";
  const eventListeners = new Map<string, Set<(data: unknown) => void>>();
  const createPiFacade = () => ({
    events: {
      emit(channel: string, data: unknown) {
        for (const listener of eventListeners.get(channel) ?? [])
          listener(data);
      },
      on(channel: string, listener: (data: unknown) => void) {
        const listeners = eventListeners.get(channel) ?? new Set();
        listeners.add(listener);
        eventListeners.set(channel, listeners);
        return () => listeners.delete(listener);
      },
    },
    getCommands: () => commands,
    getAllTools: () => [
      {
        name: "subagent",
        parameters: {
          type: "object",
          properties: {
            agent: { type: "string" },
            agentScope: { type: "string" },
          },
        },
      },
    ],
    on(name: string, handler: Handler) {
      handlers.set(name, handler);
    },
  });

  for (const feature of features) {
    // Pi gives each extension entrypoint its own API facade over one event bus.
    const pi = createPiFacade();
    if (feature === "skill") registerSkill(pi as never);
    if (feature === "agent") registerAgent(pi as never);
    if (feature === "prompt") registerPrompt(pi as never);
  }

  const context = {
    cwd: options.cwd ?? roots[0]!,
    mode: "tui",
    isProjectTrusted: () => options.trusted ?? true,
    ui: {
      getEditorText: () => editorText,
      addAutocompleteProvider(factory: (current: any) => any) {
        autocompleteProvider = factory(currentAutocomplete);
      },
    },
  };

  return {
    async input(text: string, source = "interactive") {
      return handlers.get("input")?.({ text, source }, context);
    },
    start(mode = "tui") {
      context.mode = mode;
      handlers.get("session_start")?.({}, context);
    },
    shutdown() {
      handlers.get("session_shutdown")?.({}, context);
    },
    setEditorText(text: string) {
      editorText = text;
    },
    autocompleteProvider: () => autocompleteProvider,
    currentAutocomplete,
    fallback,
  };
}

function occurrences(text: string, value: string): number {
  return text.split(value).length - 1;
}

describe("coordinated input routing", () => {
  test("preserves native leading slash behavior across all features", async () => {
    writeAgent("reviewer");
    const prompt = writePrompt("pi-prompt-review", "Review carefully.");
    const commands: Command[] = [
      {
        name: "skill:review",
        source: "skill",
        sourceInfo: sourceInfo("/skills/review/SKILL.md"),
      },
      prompt,
    ];
    const harness = createHarness(["skill", "agent", "prompt"], commands);

    await expect(
      harness.input("  /pi-prompt-review $review &reviewer"),
    ).resolves.toEqual({ action: "continue" });
    await expect(harness.input("/model $review")).resolves.toEqual({
      action: "continue",
    });
  });

  test("routes one skill with one copy of the original request", async () => {
    const commands: Command[] = [
      {
        name: "skill:review",
        source: "skill",
        sourceInfo: sourceInfo("/skills/review/SKILL.md"),
      },
    ];
    const harness = createHarness(["skill"], commands);
    const request = "Use $review, then mention $review again.";
    const result = await harness.input(request);

    expect(result).toEqual({
      action: "transform",
      text: `/skill:review ${request}`,
    });
    expect(occurrences(result.text, request)).toBe(1);
  });

  test("routes one agent with one copy of the original request", async () => {
    writeAgent("reviewer");
    const harness = createHarness(["agent"], []);
    const request = "Ask &reviewer, then remind &reviewer.";
    const result = await harness.input(request);

    expect(result.action).toBe("transform");
    expect(occurrences(result.text, request)).toBe(1);
  });

  test("leaves mixed or distinct identifiers unchanged", async () => {
    writeAgent("reviewer");
    const prompt = writePrompt("pi-prompt-review", "Review carefully.");
    const commands: Command[] = [
      {
        name: "skill:review",
        source: "skill",
        sourceInfo: sourceInfo("/skills/review/SKILL.md"),
      },
      {
        name: "skill:test",
        source: "skill",
        sourceInfo: sourceInfo("/skills/test/SKILL.md"),
      },
      prompt,
    ];
    const harness = createHarness(["skill", "agent", "prompt"], commands);

    await expect(harness.input("Use $review with &reviewer.")).resolves.toEqual(
      { action: "continue" },
    );
    await expect(
      harness.input("Use $review and /pi-prompt-review."),
    ).resolves.toEqual({ action: "continue" });
    await expect(harness.input("Use $review and $test.")).resolves.toEqual({
      action: "continue",
    });
  });

  test("does not discover agents before a relevant ampersand interaction", async () => {
    const harness = createHarness(["agent"], []);

    await expect(harness.input("An ordinary request.")).resolves.toEqual({
      action: "continue",
    });
    writeAgent("reviewer");
    expect((await harness.input("Ask &reviewer."))?.action).toBe("transform");
  });

  test("requires complete identifier boundaries", async () => {
    writeAgent("reviewer");
    const prompt = writePrompt("pi-prompt-review", "Review carefully.");
    const commands: Command[] = [
      {
        name: "skill:review",
        source: "skill",
        sourceInfo: sourceInfo("/skills/review/SKILL.md"),
      },
      prompt,
    ];
    const harness = createHarness(["skill", "agent", "prompt"], commands);

    await expect(
      harness.input("Skip foo$review, $review_mode, and $review.md."),
    ).resolves.toEqual({ action: "continue" });
    await expect(
      harness.input("Skip &reviewer.py and &reviewer_extra."),
    ).resolves.toEqual({ action: "continue" });
    await expect(
      harness.input("Skip /pi-prompt-review.md and /pi-prompt-review_v2."),
    ).resolves.toEqual({ action: "continue" });
  });

  test("only routes features whose entrypoints are enabled", async () => {
    writeAgent("reviewer");
    const prompt = writePrompt("pi-prompt-review", "Review carefully.");
    const harness = createHarness(["prompt"], [prompt]);

    await expect(harness.input("Use $review.")).resolves.toEqual({
      action: "continue",
    });
    await expect(harness.input("Use &reviewer.")).resolves.toEqual({
      action: "continue",
    });
    expect((await harness.input("Use /pi-prompt-review."))?.action).toBe(
      "transform",
    );
  });
});

describe("inline prompt expansion", () => {
  test("appends one original request when the template has no placeholder", async () => {
    const prompt = writePrompt("pi-prompt-review", "Review carefully.");
    const harness = createHarness(["prompt"], [prompt]);
    const request = "Use /pi-prompt-review on this diff.";
    const result = await harness.input(request);

    expect(result.action).toBe("transform");
    expect(result.text).toContain("Review carefully.");
    expect(result.text).toContain("Original request:");
    expect(occurrences(result.text, request)).toBe(1);
  });

  test("does not append when $@ or $1 already inserts the full request", async () => {
    for (const placeholder of ["$@", "$1", "$ARGUMENTS"]) {
      const prompt = writePrompt(
        `pi-prompt-${placeholder.replace(/\W/g, "x")}`,
        `Review this request:\n${placeholder}`,
      );
      const harness = createHarness(["prompt"], [prompt]);
      const request = `Use /${prompt.name} on this diff.`;
      const result = await harness.input(request);

      expect(result.action).toBe("transform");
      expect(result.text).not.toContain("Original request:");
      expect(occurrences(result.text, request)).toBe(1);
      harness.shutdown();
    }
  });

  test("prevents a template body from entering Pi's next slash-expansion pass", async () => {
    const prompt = writePrompt("pi-prompt-review", "/pi-prompt-other $@");
    const harness = createHarness(["prompt"], [prompt]);
    const result = await harness.input("Use /pi-prompt-review here.");

    expect(result.action).toBe("transform");
    expect(result.text).toMatch(/^Inline prompt template/);
    expect(result.text).not.toMatch(/^\/pi-prompt-other/);
  });

  test("does not add a third copy when the template intentionally repeats a placeholder", () => {
    const request = "Use /pi-prompt-review here.";
    const result = expandInlineTemplate("First: $@\nSecond: $1", request);

    expect(result.insertedRequest).toBe(true);
    expect(occurrences(result.text, request)).toBe(2);
  });

  test("supports defaults and slices while tracking request insertion", () => {
    const request = "Use /pi-prompt-review here.";

    expect(expandInlineTemplate("${1:-fallback}", request)).toEqual({
      text: request,
      insertedRequest: true,
    });
    expect(expandInlineTemplate("${2:-fallback}", request)).toEqual({
      text: "fallback",
      insertedRequest: false,
    });
    expect(expandInlineTemplate("${@:1}", request)).toEqual({
      text: request,
      insertedRequest: true,
    });
  });
});

describe("shared TUI behavior", () => {
  test("delegates command-mode completion and suppresses command-mode coloring", async () => {
    const prompt = writePrompt("pi-prompt-review", "Review carefully.");
    const harness = createHarness(["prompt"], [prompt]);
    harness.setEditorText("/pi-prompt-review");
    harness.start();

    const provider = harness.autocompleteProvider();
    await expect(
      provider.getSuggestions(["/pi-prompt"], 0, 10, {
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual(harness.fallback);
    expect(harness.currentAutocomplete.getSuggestions).toHaveBeenCalledOnce();

    const rendered = new tuiMock.FakeEditor(["/pi-prompt-review"]).render(
      80,
    )[0];
    expect(rendered).toBe("/pi-prompt-review");
    harness.shutdown();
  });

  test("uses one provider and one render patch for all enabled features", async () => {
    writeAgent("reviewer");
    const prompt = writePrompt("pi-prompt-review", "Review carefully.");
    const commands: Command[] = [
      {
        name: "skill:review",
        source: "skill",
        sourceInfo: sourceInfo("/skills/review/SKILL.md"),
      },
      prompt,
    ];
    const harness = createHarness(["skill", "agent", "prompt"], commands);
    harness.setEditorText("Use $review, &reviewer, and /pi-prompt-review.");
    harness.start();

    const provider = harness.autocompleteProvider();
    await expect(
      provider.getSuggestions(["Use /pi-p"], 0, 9, {
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      prefix: "/pi-p",
      items: [{ value: "/pi-prompt-review" }],
    });

    const editor = new tuiMock.FakeEditor([
      "Use $review, &reviewer, and /pi-prompt-review.",
    ]);
    editor.setAutocompleteTriggerCharacters(["$", "&", "/"]);
    expect(editor.autocompleteTriggerCharacters).toContain("/");
    expect(editor.autocompleteDebouncePattern?.test("@src/file.ts")).toBe(true);
    expect(
      editor.autocompleteDebouncePattern?.test('@"src/quoted file.ts'),
    ).toBe(true);

    expect(
      provider.applyCompletion(
        ["Context", "/pi-p"],
        1,
        5,
        { value: "/pi-prompt-review", label: "/pi-prompt-review" },
        "/pi-p",
      ),
    ).toEqual({
      lines: ["Context", "/pi-prompt-review"],
      cursorLine: 1,
      cursorCol: 17,
    });
    expect(harness.currentAutocomplete.applyCompletion).not.toHaveBeenCalled();

    const rendered = editor.render(80)[0]!;
    expect(rendered.match(/\x1b\[38;2;/g)).toHaveLength(3);
    expect(tuiMock.visibleWidth(rendered)).toBe(
      "Use $review, &reviewer, and /pi-prompt-review.".length,
    );
    harness.shutdown();
  });
});
