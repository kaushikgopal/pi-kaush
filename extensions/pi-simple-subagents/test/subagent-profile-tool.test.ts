import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
vi.mock("@earendil-works/pi-coding-agent", async () => {
  const { createPiCodingAgentMock } = await import("./pi-coding-agent.mock.ts");
  return createPiCodingAgentMock();
});
vi.mock("@earendil-works/pi-ai", async () => {
  const { createPiAiMock } = await import("./pi-mocks.ts");
  return createPiAiMock();
});
vi.mock("@earendil-works/pi-tui", async () => {
  const { createPiTuiMock } = await import("./pi-mocks.ts");
  return createPiTuiMock();
});
vi.mock("typebox", async () => {
  const { createTypeboxMock } = await import("./pi-mocks.ts");
  return createTypeboxMock();
});

const { registerSubagent } = await import("../src/subagent.ts");

// registerSubagent loads profiles.yaml from the mocked agent dir and
// limits.json from the extension dir it is given. The runtime profiles.yaml
// is gitignored and per-machine, so tests write a minimal ladder into the
// mocked agent dir and copy the checked-in limits.json into a throwaway
// extension dir.
const srcDir = join(import.meta.dirname, "..", "src");
function makeTestExtensionDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-subagent-tool-"));
  writeFileSync(
    join(dir, "profiles.yaml"),
    "version: 1\nprofiles:\n  quick: { description: d, candidates: [{ model: p/m }] }\n  coder: { description: d, candidates: [{ model: p/m }] }\n  default: { description: d, candidates: [{ model: p/m }] }\n  thinker: { description: d, candidates: [{ model: p/m }] }\n  deep-thinker: { description: d, candidates: [{ model: p/m }] }\n",
  );
  copyFileSync(join(srcDir, "limits.json"), join(dir, "limits.json"));
  // Keep the mocked agent dir's ladder in sync: registration and call-time
  // reloads both read profiles.yaml from getAgentDir().
  const agentDir = join(tmpdir(), "pi-agent");
  mkdirSync(agentDir, { recursive: true });
  copyFileSync(join(dir, "profiles.yaml"), join(agentDir, "profiles.yaml"));
  const agentsDir = join(agentDir, "agents");
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(
    join(agentsDir, "redteam.md"),
    "---\nname: redteam\ndescription: Independent adversarial reviewer.\n---\nReview adversarially.\n",
  );
  return dir;
}

function registerTestTool(): {
  tool: any;
  tools: any[];
  handlers: Record<string, () => Promise<void>>;
} {
  let tool: any;
  const tools: any[] = [];
  const handlers: Record<string, () => Promise<void>> = {};
  registerSubagent(
    {
      registerTool: (definition: unknown) => {
        tool = definition;
        tools.push(definition);
      },
      on: (event: string, handler: () => Promise<void>) =>
        (handlers[event] = handler),
    } as any,
    makeTestExtensionDir(),
  );
  return { tool, tools, handlers };
}

describe("subagent profile tool surface", () => {
  test("publishes profiles in every mode and renders the selected profile in brackets", () => {
    const { tool, handlers } = registerTestTool();
    expect(typeof handlers.session_shutdown).toBe("function");

    const expectedProfiles = [
      "quick",
      "coder",
      "default",
      "thinker",
      "deep-thinker",
    ];
    expect(tool.parameters.properties.profile.enum).toEqual(expectedProfiles);
    expect(
      tool.parameters.properties.tasks.items.properties.profile.enum,
    ).toEqual(expectedProfiles);
    expect(
      tool.parameters.properties.chain.items.properties.profile.enum,
    ).toEqual(expectedProfiles);
    expect(tool.parameters.properties.tasks.maxItems).toBe(5);
    expect(tool.parameters.properties.chain.maxItems).toBe(5);
    expect(tool.parameters.properties.context.optional).toBe(true);
    expect(tool.parameters.properties.context.description).toContain(
      "every task in parallel mode",
    );
    expect(tool.description).toContain(
      "Agents select behavior and tools; profiles select compute",
    );
    expect(tool.description).toContain(
      "their order in the user's wording does not matter",
    );
    expect(tool.description).toContain("Available user agents:");
    expect(tool.description).toContain(
      "redteam (user): Independent adversarial reviewer.",
    );
    expect(tool.description).toContain(
      'Phrases "thinker redteam" and "redteam thinker" both mean agent "redteam" with profile "thinker".',
    );
    expect(tool.parameters.properties.agent.description).toContain(
      "Agent name; selects behavior and tools. Profile separately selects compute.",
    );
    expect(
      tool.parameters.properties.tasks.items.properties.agent.description,
    ).toContain("Profile separately selects compute.");
    expect(tool.promptGuidelines.join(" ")).toContain(
      "When the user names both in either order, preserve both",
    );
    expect(tool.promptGuidelines.join(" ")).toContain(
      '"thinker redteam" and "redteam thinker"',
    );
    expect(tool.description).toContain("Execution profiles: quick:");
    expect(tool.description).toContain(
      "5 active child processes per Pi session",
    );
    expect(tool.description).toContain("2 hours total runtime");
    expect(tool.description).toContain("15 minutes without output");
    expect(tool.description).toContain("do not apply to the orchestrator");
    expect(tool.description).toContain("private JSONL artifacts");
    expect(tool.description).toContain("bounded previews");
    expect(tool.description).toContain("share one immutable context string");

    const theme = {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
      italic: (text: string) => `<i>${text}</i>`,
    };
    const rendered = tool.renderCall(
      { agent: "bee", task: "Do the work", profile: "quick" },
      theme,
      { cwd: "/tmp", state: {} },
    ) as { text: string };

    expect(rendered.text).toContain("bee [quick] [user]");
  });

  test("registers yield only inside delegated child sessions", () => {
    const previousDepth = process.env.PI_SUBAGENT_DEPTH;
    try {
      delete process.env.PI_SUBAGENT_DEPTH;
      expect(registerTestTool().tools.map((tool) => tool.name)).toEqual([
        "subagent",
      ]);

      process.env.PI_SUBAGENT_DEPTH = "1";
      expect(registerTestTool().tools.map((tool) => tool.name)).toEqual([
        "yield",
        "subagent",
      ]);
    } finally {
      if (previousDepth === undefined) delete process.env.PI_SUBAGENT_DEPTH;
      else process.env.PI_SUBAGENT_DEPTH = previousDepth;
    }
  });

  test("hides the profile badge when an explicit model overrides it", () => {
    const { tool } = registerTestTool();
    const theme = {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
      italic: (text: string) => `<i>${text}</i>`,
    };
    const rendered = tool.renderCall(
      {
        agent: "bee",
        task: "Do the work",
        profile: "deep-thinker",
        model: "provider/model",
      },
      theme,
      { cwd: "/tmp", state: {} },
    ) as { text: string };

    expect(rendered.text).not.toContain("deep-thinker");
  });

  test("rejects shared context outside parallel mode", async () => {
    const { tool } = registerTestTool();
    const result = await tool.execute(
      "call-context-single",
      { agent: "bee", task: "must not start", context: "shared" },
      undefined,
      undefined,
      {
        cwd: "/tmp",
        scopedModels: [],
        modelRegistry: { getAvailable: () => [] },
        sessionManager: {
          getSessionId: () => "root-session",
          getEntries: () => [],
        },
      },
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(
      "context is supported only with parallel tasks[]",
    );
  });

  test("treats empty shared context as omitted in single mode", async () => {
    const { tool } = registerTestTool();
    const result = await tool.execute(
      "call-empty-context-single",
      { agent: "missing", task: "must not start", context: "" },
      undefined,
      undefined,
      {
        cwd: "/tmp",
        scopedModels: [],
        modelRegistry: { getAvailable: () => [] },
        sessionManager: {
          getSessionId: () => "root-session",
          getEntries: () => [],
        },
      },
    );

    expect(result.content[0].text).not.toContain("context is supported only");
    expect(result.content[0].text).toContain("Unknown agent");
  });

  test("blocks execution beyond the hard delegation depth", async () => {
    const { tool } = registerTestTool();
    const previousDepth = process.env.PI_SUBAGENT_DEPTH;
    process.env.PI_SUBAGENT_DEPTH = "2";
    try {
      const result = await tool.execute(
        "call-depth-3",
        { agent: "bee", task: "must not start" },
        undefined,
        undefined,
        {
          cwd: "/tmp",
          sessionManager: {
            getSessionId: () => "root-session",
            getEntries: () => [],
          },
        },
      );

      expect(result.content[0].text).toContain("blocked at depth 3");
      expect(result.details.concurrency).toMatchObject({
        active: 0,
        limit: 5,
        available: 5,
      });
    } finally {
      if (previousDepth === undefined) delete process.env.PI_SUBAGENT_DEPTH;
      else process.env.PI_SUBAGENT_DEPTH = previousDepth;
    }
  });
});
