import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";

const PI_AGENT_MODE_STATE_TYPE = "pi-agent-mode/state";
const LEGACY_ACTIVE_AGENT_STATE_TYPE = "active-agent-state";
const ALL_TOOL_NAMES = ["read", "bash", "edit", "write"];

// The mock's getAgentDir resolves lazily so every test can point it at its
// own isolated user home.
let userAgentDir = "";

vi.doMock("@earendil-works/pi-coding-agent", () => ({
  CONFIG_DIR_NAME: ".pi",
  getAgentDir: () => userAgentDir,
  parseFrontmatter<T extends Record<string, unknown>>(content: string) {
    const normalized = content.replace(/\r\n/g, "\n");
    const match = normalized.match(/^---\n([\s\S]*?)\n---\s*\n?/);
    if (!match) return { frontmatter: {} as T, body: normalized };

    const frontmatter: Record<string, unknown> = {};
    const frontmatterLines = match[1] ?? "";
    for (const line of frontmatterLines.split("\n")) {
      const separator = line.indexOf(":");
      if (separator === -1) continue;
      const key = line.slice(0, separator).trim();
      const raw = line.slice(separator + 1).trim();
      frontmatter[key] =
        raw === "true"
          ? true
          : raw === "false"
            ? false
            : /^\[.*\]$/.test(raw)
              ? raw
                  .slice(1, -1)
                  .split(",")
                  .map((value) => value.trim())
              : /^-?\d+(\.\d+)?$/.test(raw)
                ? Number(raw)
                : raw.replace(/^["']|["']$/g, "");
    }
    return {
      frontmatter: frontmatter as T,
      body: normalized.slice(match[0].length),
    };
  },
}));

const { parseAgentModelSpec, registerAgentMode } = await import(
  "../src/index.ts"
);

interface Model {
  provider: string;
  id: string;
  name: string;
}

interface PiHarness {
  activate(name: string): Promise<void>;
  commands(): string[];
  entries: Array<{ type: string; data?: unknown }>;
  branch: any[];
  notifications: Array<[string, string]>;
  statuses: Array<[string, string | undefined]>;
  confirmCalls: number;
  beforeAgentStart(systemPrompt: string): any;
  removeModel(id: string): void;
  setAuthUnavailable(value: boolean): void;
  setConfirmResult(value: boolean): void;
  setCurrentModel(id: string): void;
  setHasUI(value: boolean): void;
  setSelectResult(value: string | undefined): void;
  sessionStart(): Promise<void>;
  sessionShutdown(): void;
  state(): { model: string; thinkingLevel: string; activeTools: string[] };
}

interface CommandHandler {
  (args: string, ctx: any): Promise<void>;
}

function writeAgent(
  dir: string,
  name: string,
  model: string,
  extraFrontmatter = "",
) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${name}.md`),
    `---\nname: ${name}\ndescription: ${name} agent\nmodel: ${model}\ntools: read\n${extraFrontmatter}---\nWrite clearly.\n`,
  );
}

function createHarness(root: string, branch: any[] = []): PiHarness {
  userAgentDir = join(root, "home", ".pi");
  const cwd = join(root, "work");
  mkdirSync(cwd, { recursive: true });

  const baselineModel: Model = {
    provider: "provider",
    id: "baseline",
    name: "Baseline",
  };
  const targetModel: Model = {
    provider: "provider",
    id: "target",
    name: "Target",
  };
  const plainModel: Model = {
    provider: "provider",
    id: "plain",
    name: "Plain",
  };
  const models = [baselineModel, targetModel, plainModel];

  let currentModel: Model = baselineModel;
  let thinkingLevel = "medium";
  let activeTools = [...ALL_TOOL_NAMES.slice(0, 2)];
  let authUnavailable = false;
  let confirmResult = true;
  let hasUI = false;
  let selectResult: string | undefined;
  const entries: Array<{ type: string; data?: unknown }> = [];
  const notifications: Array<[string, string]> = [];
  const statuses: Array<[string, string | undefined]> = [];
  const commands = new Map<string, CommandHandler>();
  const handlers = new Map<string, (event: any, ctx: any) => any>();
  let confirmCalls = 0;

  const ctx = {
    cwd,
    model: currentModel,
    hasUI: false,
    modelRegistry: {
      find: (provider: string, id: string) =>
        models.find((model) => model.provider === provider && model.id === id),
      getAll: () => models,
    },
    ui: {
      notify: (message: string, level: string) =>
        notifications.push([message, level]),
      setStatus: (key: string, value: string | undefined) =>
        statuses.push([key, value]),
      confirm: async () => {
        confirmCalls++;
        return confirmResult;
      },
      select: async () => selectResult,
      theme: {
        bold: (value: string) => value,
        fg: (_color: string, value: string) => value,
      },
    },
    sessionManager: { getBranch: () => branch },
  };

  const pi = {
    getActiveTools: () => [...activeTools],
    getAllTools: () => ALL_TOOL_NAMES.map((name) => ({ name })),
    setActiveTools: (tools: string[]) => {
      activeTools = [...tools];
    },
    getThinkingLevel: () => thinkingLevel,
    setThinkingLevel: (level: string) => {
      thinkingLevel = level;
    },
    setModel: async (model: Model) => {
      if (authUnavailable) return false;
      currentModel = model;
      ctx.model = model;
      return true;
    },
    appendEntry: (type: string, data: unknown) => {
      const record = { type, data };
      entries.push(record);
      branch.push({
        id: `entry-${entries.length}`,
        type: "custom",
        customType: type,
        data,
      });
    },
    registerCommand: (name: string, definition: any) => {
      commands.set(name, definition.handler);
    },
    on: (event: string, handler: (event: any, ctx: any) => any) => {
      handlers.set(event, handler);
    },
  };

  registerAgentMode(pi as any);

  const agentHandler = commands.get("agent");
  if (!agentHandler) throw new Error("agent command was not registered");

  return {
    activate: (name: string) => agentHandler(name, ctx),
    commands: () => [...commands.keys()],
    entries,
    branch,
    notifications,
    statuses,
    get confirmCalls() {
      return confirmCalls;
    },
    beforeAgentStart(systemPrompt: string) {
      return handlers.get("before_agent_start")!({ systemPrompt }, ctx);
    },
    removeModel(id: string) {
      const index = models.findIndex((model) => model.id === id);
      if (index !== -1) models.splice(index, 1);
    },
    setAuthUnavailable(value: boolean) {
      authUnavailable = value;
    },
    setConfirmResult(value: boolean) {
      confirmResult = value;
    },
    setCurrentModel(id: string) {
      const model = models.find((candidate) => candidate.id === id);
      if (!model) throw new Error(`Unknown model: ${id}`);
      currentModel = model;
      ctx.model = model;
    },
    setHasUI(value: boolean) {
      ctx.hasUI = value;
    },
    setSelectResult(value: string | undefined) {
      selectResult = value;
    },
    sessionStart: async () => {
      await handlers.get("session_start")!(undefined, ctx);
    },
    sessionShutdown: () => {
      handlers.get("session_shutdown")!(undefined, ctx);
    },
    state: () => ({
      model: currentModel.id,
      thinkingLevel,
      activeTools: [...activeTools],
    }),
  };
}

// Replica of the dual-read restore rule that Aikado's local implementation
// uses for rollback compatibility: filter both state entry types and take the
// newest recognized entry on the active branch.
function readLatestState(branch: any[]): any {
  return branch
    .filter(
      (entry: any) =>
        entry.type === "custom" &&
        (entry.customType === LEGACY_ACTIVE_AGENT_STATE_TYPE ||
          entry.customType === PI_AGENT_MODE_STATE_TYPE),
    )
    .pop()?.data;
}

describe("pi-agent-mode", () => {
  test("registers only /agent; no subagent tool or command appears", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-agent-mode-"));
    try {
      writeAgent(
        join(root, "home", ".pi", "agents"),
        "thinker",
        "provider/target:high",
      );
      const harness = createHarness(root);
      expect(harness.entries.length).toBe(0);
      expect(harness.commands()).toEqual(["agent"]);
      expect(ALL_TOOL_NAMES).not.toContain("subagent");
      // Activating proves discovery still works without any delegated-subagent
      // extension loaded.
      await harness.activate("thinker");
      expect(harness.state()).toMatchObject({ model: "target" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("loads and activates a user agent with no delegated-subagent extension present", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-agent-mode-"));
    try {
      writeAgent(
        join(root, "home", ".pi", "agents"),
        "thinker",
        "provider/target",
      );
      const harness = createHarness(root);

      await harness.activate("thinker");
      expect(harness.state()).toMatchObject({
        model: "target",
        activeTools: ["read"],
      });
      expect(
        harness.notifications.some(([message]) =>
          message.includes("Active agent: thinker"),
        ),
      ).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("activates model plus thinking suffix and restores the prior values", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-agent-mode-"));
    try {
      writeAgent(
        join(root, "home", ".pi", "agents"),
        "thinker",
        "provider/target:high",
      );
      const harness = createHarness(root);

      await harness.activate("thinker");
      expect(harness.state()).toMatchObject({
        model: "target",
        thinkingLevel: "high",
        activeTools: ["read"],
      });

      await harness.activate("none");
      expect(harness.state()).toMatchObject({
        model: "baseline",
        thinkingLevel: "medium",
        activeTools: ["read", "bash"],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("switches between agents while preserving the original baseline", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-agent-mode-"));
    try {
      writeAgent(
        join(root, "home", ".pi", "agents"),
        "thinker",
        "provider/target:high",
      );
      writeAgent(
        join(root, "home", ".pi", "agents"),
        "plain",
        "provider/plain",
      );
      const harness = createHarness(root);

      await harness.activate("thinker");
      await harness.activate("plain");
      expect(harness.state()).toMatchObject({
        model: "plain",
        thinkingLevel: "medium",
      });

      await harness.activate("none");
      expect(harness.state()).toMatchObject({
        model: "baseline",
        thinkingLevel: "medium",
        activeTools: ["read", "bash"],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("applies an agent tool allowlist and reports unavailable tools", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-agent-mode-"));
    try {
      const dir = join(root, "home", ".pi", "agents");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "restricted.md"),
        `---\nname: restricted\ndescription: restricted agent\nmodel: provider/target\ntools: read, nonexistent-tool\n---\nTerse.\n`,
      );
      const harness = createHarness(root);
      harness.setConfirmResult(true);

      await harness.activate("restricted");
      expect(harness.state()).toMatchObject({ activeTools: ["read"] });
      expect(
        harness.notifications.some(([message]) =>
          message.includes("unavailable tools ignored: nonexistent-tool"),
        ),
      ).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects an unknown model without partially changing state", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-agent-mode-"));
    try {
      writeAgent(join(root, "home", ".pi", "agents"), "ghost", "provider/nope");
      const harness = createHarness(root);

      await harness.activate("ghost");
      expect(harness.state()).toEqual({
        model: "baseline",
        thinkingLevel: "medium",
        activeTools: ["read", "bash"],
      });
      expect(harness.entries.length).toBe(0);
      expect(
        harness.notifications.some(([message]) =>
          message.includes('configured model "provider/nope" was not found'),
        ),
      ).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("handles unavailable authentication without partially changing state", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-agent-mode-"));
    try {
      writeAgent(
        join(root, "home", ".pi", "agents"),
        "thinker",
        "provider/target",
      );
      const harness = createHarness(root);
      harness.setAuthUnavailable(true);

      await harness.activate("thinker");
      expect(harness.state()).toEqual({
        model: "baseline",
        thinkingLevel: "medium",
        activeTools: ["read", "bash"],
      });
      expect(harness.entries.length).toBe(0);
      expect(
        harness.notifications.some(([message]) =>
          message.includes("authentication is unavailable"),
        ),
      ).toBe(true);

      harness.setAuthUnavailable(false);
      await harness.activate("thinker");
      expect(harness.state()).toMatchObject({ model: "target" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("aborts restoring a no-model agent when its baseline model is unavailable", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-agent-mode-"));
    try {
      const dir = join(root, "home", ".pi", "agents");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "plain.md"),
        `---\nname: plain\ndescription: plain agent\ntools: read\n---\nWrite plainly.\n`,
      );
      const branch = [
        {
          id: "ns-1",
          type: "custom",
          customType: PI_AGENT_MODE_STATE_TYPE,
          data: {
            active: true,
            name: "plain",
            baseline: {
              model: { provider: "provider", id: "baseline" },
              thinkingLevel: "medium",
              tools: ["read", "bash"],
            },
          },
        },
      ];
      const harness = createHarness(root, branch);
      harness.setCurrentModel("target");
      harness.removeModel("baseline");

      await harness.sessionStart();

      expect(harness.state()).toMatchObject({ model: "target" });
      expect(harness.beforeAgentStart("Base prompt")).toBeUndefined();
      expect(harness.entries).toHaveLength(0);
      expect(harness.notifications).toContainEqual([
        "Agent plain: could not restore the baseline model; activation aborted.",
        "error",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("clears agent state with a warning when its baseline model is unavailable", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-agent-mode-"));
    try {
      writeAgent(
        join(root, "home", ".pi", "agents"),
        "thinker",
        "provider/target:high",
      );
      const harness = createHarness(root);
      await harness.activate("thinker");
      harness.removeModel("baseline");

      await harness.activate("none");

      expect(harness.state()).toEqual({
        model: "target",
        thinkingLevel: "medium",
        activeTools: ["read", "bash"],
      });
      expect(harness.entries.at(-1)).toEqual({
        type: PI_AGENT_MODE_STATE_TYPE,
        data: { active: false },
      });
      expect(harness.statuses.at(-1)).toEqual(["active-agent", undefined]);
      expect(harness.notifications).toContainEqual([
        "Active agent cleared, but the previous model could not be restored.",
        "warning",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("clears with both none and off", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-agent-mode-"));
    try {
      writeAgent(
        join(root, "home", ".pi", "agents"),
        "thinker",
        "provider/target:high",
      );
      const harness = createHarness(root);

      await harness.activate("thinker");
      await harness.activate("none");
      expect(harness.state()).toMatchObject({
        model: "baseline",
        thinkingLevel: "medium",
      });
      expect(harness.entries.at(-1)).toEqual({
        type: PI_AGENT_MODE_STATE_TYPE,
        data: { active: false },
      });

      await harness.activate("thinker");
      await harness.activate("off");
      expect(harness.state()).toMatchObject({
        model: "baseline",
        thinkingLevel: "medium",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("ignores malformed scalar frontmatter without aborting discovery", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-agent-mode-"));
    try {
      const dir = join(root, "home", ".pi", "agents");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "array-tools.md"),
        `---\nname: array-tools\ndescription: array tools agent\nmodel: provider/plain\ntools: [read, grep]\n---\nArray tools.\n`,
      );
      writeFileSync(
        join(dir, "numeric-emoji.md"),
        `---\nname: numeric-emoji\ndescription: numeric emoji agent\nmodel: provider/plain\nemoji: 42\n---\nNumeric emoji.\n`,
      );
      writeAgent(dir, "valid", "provider/target");
      const harness = createHarness(root);

      await harness.activate("array-tools");
      expect(harness.state()).toMatchObject({ model: "plain" });
      await harness.activate("numeric-emoji");
      expect(harness.state()).toMatchObject({ model: "plain" });
      await harness.activate("valid");
      expect(harness.state()).toMatchObject({ model: "target" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("persists activation and restores after session start/reload", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-agent-mode-"));
    try {
      writeAgent(
        join(root, "home", ".pi", "agents"),
        "thinker",
        "provider/target:high",
      );
      const harness = createHarness(root);

      await harness.activate("thinker");
      expect(harness.entries.at(-1)).toMatchObject({
        type: PI_AGENT_MODE_STATE_TYPE,
        data: {
          active: true,
          name: "thinker",
          baseline: {
            model: { provider: "provider", id: "baseline" },
            thinkingLevel: "medium",
            tools: ["read", "bash"],
          },
        },
      });

      // Simulate reload: model, thinking, and tools are gone and must be
      // restored from the persisted state without writing a new entry.
      const entriesBeforeRestore = harness.entries.length;
      await harness.sessionStart();
      expect(harness.state()).toMatchObject({
        model: "target",
        thinkingLevel: "high",
        activeTools: ["read"],
      });
      expect(harness.entries.length).toBe(entriesBeforeRestore);
      expect(harness.statuses.at(-1)).toEqual(["active-agent", "thinker"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reads a legacy active-agent-state entry and writes the new namespaced entry", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-agent-mode-"));
    try {
      writeAgent(
        join(root, "home", ".pi", "agents"),
        "plain",
        "provider/plain",
      );
      const legacyEntry = {
        id: "legacy-1",
        type: "custom",
        customType: LEGACY_ACTIVE_AGENT_STATE_TYPE,
        data: {
          active: true,
          name: "plain",
          baseline: {
            model: { provider: "provider", id: "baseline" },
            thinkingLevel: "medium",
            tools: ["read", "bash"],
          },
        },
      };
      const harness = createHarness(root, [legacyEntry]);

      await harness.sessionStart();
      expect(harness.state()).toMatchObject({ model: "plain" });

      await harness.activate("none");
      expect(harness.entries.at(-1)).toEqual({
        type: PI_AGENT_MODE_STATE_TYPE,
        data: { active: false },
      });
      expect(
        harness.entries.some(
          (entry) => entry.type === LEGACY_ACTIVE_AGENT_STATE_TYPE,
        ),
      ).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("prefers the newest recognized state entry on the active branch", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-agent-mode-"));
    try {
      writeAgent(
        join(root, "home", ".pi", "agents"),
        "thinker",
        "provider/target:high",
      );
      writeAgent(
        join(root, "home", ".pi", "agents"),
        "plain",
        "provider/plain",
      );
      const legacyEntry = {
        id: "legacy-1",
        type: "custom",
        customType: LEGACY_ACTIVE_AGENT_STATE_TYPE,
        data: {
          active: true,
          name: "plain",
          baseline: {
            model: { provider: "provider", id: "baseline" },
            thinkingLevel: "medium",
            tools: ["read", "bash"],
          },
        },
      };
      const namespacedEntry = {
        id: "ns-1",
        type: "custom",
        customType: PI_AGENT_MODE_STATE_TYPE,
        data: {
          active: true,
          name: "thinker",
          baseline: {
            model: { provider: "provider", id: "baseline" },
            thinkingLevel: "medium",
            tools: ["read", "bash"],
          },
        },
      };
      const harness = createHarness(root, [legacyEntry, namespacedEntry]);

      await harness.sessionStart();
      expect(harness.state()).toMatchObject({
        model: "target",
        thinkingLevel: "high",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("skips malformed persisted agent state entries", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-agent-mode-"));
    try {
      const malformedEntries = [
        {
          id: "bad-name",
          type: "custom",
          customType: PI_AGENT_MODE_STATE_TYPE,
          data: { active: true, name: 42 },
        },
        {
          id: "bad-tools",
          type: "custom",
          customType: PI_AGENT_MODE_STATE_TYPE,
          data: {
            active: true,
            name: "plain",
            baseline: {
              thinkingLevel: "medium",
              tools: "read,bash",
            },
          },
        },
      ];
      const harness = createHarness(root, malformedEntries);

      await expect(harness.sessionStart()).resolves.toBeUndefined();
      expect(harness.beforeAgentStart("Base prompt")).toBeUndefined();
      expect(harness.statuses.at(-1)).toEqual(["active-agent", undefined]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("disambiguates duplicate non-TUI labels by agent value", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-agent-mode-"));
    try {
      const dir = join(root, "home", ".pi", "agents");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "first.md"),
        `---\nname: beta\ndescription: same agent\nemoji: x alpha\nmodel: provider/plain\n---\nFirst.\n`,
      );
      writeFileSync(
        join(dir, "second.md"),
        `---\nname: alpha beta\ndescription: same agent\nemoji: x\nmodel: provider/target\n---\nSecond.\n`,
      );
      const harness = createHarness(root);
      harness.setHasUI(true);
      harness.setSelectResult("x alpha beta — same agent [alpha beta]");

      await harness.activate("");

      expect(harness.state()).toMatchObject({ model: "target" });
      expect(harness.notifications).toContainEqual([
        "Active agent: x alpha beta",
        "info",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("cancels an ambiguous non-TUI label collision", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-agent-mode-"));
    try {
      const dir = join(root, "home", ".pi", "agents");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "first.md"),
        `---\nname: beta\ndescription: same agent\nemoji: x alpha\nmodel: provider/plain\n---\nFirst.\n`,
      );
      writeFileSync(
        join(dir, "second.md"),
        `---\nname: alpha beta\ndescription: same agent\nemoji: x\nmodel: provider/target\n---\nSecond.\n`,
      );
      writeFileSync(
        join(dir, "collision.md"),
        `---\nname: x alpha beta\ndescription: same agent [beta]\nmodel: provider/target\n---\nCollision.\n`,
      );
      const harness = createHarness(root);
      harness.setHasUI(true);
      harness.setSelectResult("x alpha beta — same agent [beta]");

      await harness.activate("");

      expect(harness.state()).toEqual({
        model: "baseline",
        thinkingLevel: "medium",
        activeTools: ["read", "bash"],
      });
      expect(harness.entries).toHaveLength(0);
      expect(harness.notifications).toContainEqual([
        "That selection matches more than one agent; rename one of the duplicates.",
        "warning",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("confirms project agents when required and honors confirmProjectAgents: false", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-agent-mode-"));
    try {
      const projectDir = join(root, "work", ".pi", "agents");
      writeAgent(projectDir, "proj-agent", "provider/plain");
      writeAgent(
        projectDir,
        "trusted",
        "provider/plain",
        "confirmProjectAgents: false\n",
      );
      const harness = createHarness(root);
      harness.setHasUI(true);
      harness.setConfirmResult(false);

      // Denied project agent stays inactive.
      await harness.activate("proj-agent");
      expect(harness.state()).toMatchObject({ model: "baseline" });
      expect(harness.confirmCalls).toBe(1);
      expect(harness.entries.length).toBe(0);

      // Approved project agent activates.
      harness.setConfirmResult(true);
      await harness.activate("proj-agent");
      expect(harness.state()).toMatchObject({ model: "plain" });
      expect(harness.confirmCalls).toBe(2);

      // confirmProjectAgents: false skips confirmation entirely.
      await harness.activate("trusted");
      expect(harness.state()).toMatchObject({ model: "plain" });
      expect(harness.confirmCalls).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("handles missing agent files during resume without leaving stale UI state", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-agent-mode-"));
    try {
      const namespacedEntry = {
        id: "ns-1",
        type: "custom",
        customType: PI_AGENT_MODE_STATE_TYPE,
        data: {
          active: true,
          name: "vanished",
          baseline: {
            model: { provider: "provider", id: "baseline" },
            thinkingLevel: "medium",
            tools: ["read", "bash"],
          },
        },
      };
      const harness = createHarness(root, [namespacedEntry]);

      await harness.sessionStart();
      expect(
        harness.notifications.some(([message]) =>
          message.includes('Active agent "vanished" is no longer available'),
        ),
      ).toBe(true);
      expect(harness.statuses.at(-1)).toEqual(["active-agent", undefined]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("clears status during session shutdown", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-agent-mode-"));
    try {
      writeAgent(
        join(root, "home", ".pi", "agents"),
        "thinker",
        "provider/target",
      );
      const harness = createHarness(root);

      await harness.activate("thinker");
      expect(harness.statuses.at(-1)).toEqual(["active-agent", "thinker"]);

      harness.sessionShutdown();
      expect(harness.statuses.at(-1)).toEqual(["active-agent", undefined]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("proves a package-written namespaced state is readable by the dual-read rollback implementation", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-agent-mode-"));
    try {
      writeAgent(
        join(root, "home", ".pi", "agents"),
        "thinker",
        "provider/target:high",
      );
      const harness = createHarness(root);

      await harness.activate("thinker");
      expect(harness.entries.at(-1)?.type).toBe(PI_AGENT_MODE_STATE_TYPE);
      expect(
        harness.entries.some(
          (entry) => entry.type === LEGACY_ACTIVE_AGENT_STATE_TYPE,
        ),
      ).toBe(false);

      // The pre-cutover local implementation reads both entry types and picks
      // the newest; it must see the package-written state unchanged.
      const latest = readLatestState(harness.branch);
      expect(latest).toMatchObject({ active: true, name: "thinker" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("parses supported thinking suffixes while leaving unknown suffixes attached", () => {
    expect(parseAgentModelSpec("provider/model:high")).toEqual({
      model: "provider/model",
      thinkingLevel: "high",
    });
    expect(parseAgentModelSpec("model:medium")).toEqual({
      model: "model",
      thinkingLevel: "medium",
    });
    expect(parseAgentModelSpec("provider/model:custom")).toEqual({
      model: "provider/model:custom",
    });
  });
});
