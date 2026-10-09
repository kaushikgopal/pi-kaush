import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
  ManagedRuntime,
  ManagedRuntimeOptions,
  ManagedWorkerView,
} from "../src/_managed.ts";
import { buildSubagentIsolationArgs } from "../src/_execution.ts";
import {
  createModelResolver,
  type DelegationTrace,
} from "../src/_delegation.ts";
import type { AgentConfig } from "../src/_definition.ts";
import type { SubagentProcessRegistry } from "../src/_process-tree.ts";
import { parseModelProfiles } from "@pi-kaush/pi-model-profiles";
import {
  boundManagedToolOutput,
  MANAGED_TOOL_OUTPUT_LIMIT_BYTES,
  prepareManagedLaunch,
  truncateManagedText,
} from "../src/_managed-tool.ts";
import { parseSubagentCall } from "../src/_subagent-command.ts";

function parseError(params: Record<string, unknown>): string | undefined {
  const parsed = parseSubagentCall(params);
  return parsed.ok ? undefined : parsed.error;
}

const mockState = vi.hoisted(() => ({ agentDir: "" }));
vi.mock("@earendil-works/pi-coding-agent", async () => {
  const { createPiCodingAgentMock } = await import("./pi-coding-agent.mock.ts");
  return {
    ...createPiCodingAgentMock(),
    getAgentDir: () => mockState.agentDir,
  };
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

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

const profiles = parseModelProfiles({
  version: 1,
  profiles: {
    quick: {
      description: "Fast profile.",
      candidates: [
        { model: "provider/model-a", thinkingLevel: "high" },
        { model: "provider/model-b" },
        { model: "missing/model-c" },
      ],
    },
    thinker: {
      description: "Reasoning profile.",
      candidates: [{ model: "provider/model-b", thinkingLevel: "xhigh" }],
    },
  },
});

const trace: DelegationTrace = {
  rootSessionId: "parent-session",
  parentSessionId: "parent-session",
  parentToolCallId: "call-1",
  depth: 1,
};
const models = [
  { provider: "provider", id: "model-a" },
  { provider: "provider", id: "model-b" },
  { provider: "provider", id: "model-override" },
];
const availableModelReferences = new Set(
  models.map((model) => `${model.provider}/${model.id}`),
);
const resolveModel = createModelResolver(models);

function agent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "coder",
    description: "Coding agent.",
    emoji: "🛠️",
    profile: "quick",
    tools: ["read", "edit"],
    systemPrompt: "You implement code.",
    source: "user",
    filePath: "/agents/coder.md",
    ...overrides,
  };
}

function prepare(
  request: Parameters<typeof prepareManagedLaunch>[0]["request"],
  configuredAgent = agent(),
) {
  return prepareManagedLaunch({
    discovery: { agents: [configuredAgent], projectAgentsDir: null },
    profiles,
    availableModelReferences,
    resolveModel,
    defaultCwd: "/repo",
    trace,
    request,
  });
}

describe("managed launch preparation", () => {
  test("explicit model overrides invocation and agent profiles without inheriting parent scope", () => {
    const result = prepare({
      agent: "coder",
      task: "Implement it",
      profile: "thinker",
      model: "provider/model-override",
      tools: ["read", "write"],
      cwd: "packages/tool",
    });

    expect(result).toMatchObject({
      ok: true,
      launch: {
        agent: { name: "coder", emoji: "🛠️", tools: ["read", "write"] },
        modelCandidates: ["provider/model-override"],
        cwd: "/repo/packages/tool",
        task: "Implement it",
      },
    });
    if (result.ok) expect(result.launch.profile).toBeUndefined();
  });

  test("filters unavailable profile candidates and keeps thinking levels", () => {
    const result = prepare({
      agent: "coder",
      task: "Review the change",
      profile: "thinker",
    });

    expect(result).toMatchObject({
      ok: true,
      launch: {
        profile: "thinker",
        modelCandidates: ["provider/model-b:xhigh"],
      },
    });
  });

  test("uses the agent profile when no invocation profile or model is provided", () => {
    const result = prepare({ agent: "coder", task: "Implement it" });
    expect(result).toMatchObject({
      ok: true,
      launch: {
        profile: "quick",
        modelCandidates: ["provider/model-a:high", "provider/model-b"],
      },
    });
  });

  test("returns a safe default-model launch when neither agent nor invocation selects compute", () => {
    const unconfiguredAgent = agent();
    delete unconfiguredAgent.profile;
    delete unconfiguredAgent.tools;
    const result = prepare(
      { agent: "coder", task: "Implement it" },
      unconfiguredAgent,
    );
    expect(result).toMatchObject({ ok: true, launch: { modelCandidates: [] } });
    if (result.ok) expect(result.launch.agent.tools).toBeUndefined();
  });

  test("reports invalid agent compute, missing profiles, and unavailable explicit models", () => {
    expect(
      prepare(
        { agent: "coder", task: "x" },
        agent({ model: "provider/model-a" }),
      ),
    ).toMatchObject({
      ok: false,
      error: expect.stringContaining('either "profile" or "model"'),
    });
    const agentWithoutProfile = agent();
    delete agentWithoutProfile.profile;
    expect(
      prepare(
        { agent: "coder", task: "x", profile: "not-configured" },
        agentWithoutProfile,
      ),
    ).toMatchObject({
      ok: false,
      error: expect.stringContaining("Unknown subagent profile"),
    });
    expect(
      prepare(
        { agent: "coder", task: "x", model: "unknown" },
        agentWithoutProfile,
      ),
    ).toMatchObject({
      ok: false,
      error: expect.stringContaining("not available in Pi's model catalog"),
    });
  });

  test("refuses empty tool overrides and unsupported managed MCP isolation", () => {
    expect(prepare({ agent: "coder", task: "x", tools: [] })).toMatchObject({
      ok: false,
      error: expect.stringContaining("empty tools override"),
    });
    expect(
      prepare({ agent: "coder", task: "x", isolation: { noMcp: true } }),
    ).toMatchObject({
      ok: false,
      error: expect.stringContaining("do not support noMcp"),
    });
  });
});

describe("managed tool output bounds", () => {
  test("truncated output stays within its byte limit, marker included", () => {
    const bounded = boundManagedToolOutput(
      "x".repeat(MANAGED_TOOL_OUTPUT_LIMIT_BYTES + 1),
    );
    expect(Buffer.byteLength(bounded)).toBe(MANAGED_TOOL_OUTPUT_LIMIT_BYTES);
    expect(bounded).toContain("managed result truncated");
    const preview = truncateManagedText("y".repeat(5000), 2048);
    expect(Buffer.byteLength(preview)).toBe(2048);
    expect(preview.endsWith("\n… result preview truncated.")).toBe(true);
    expect(truncateManagedText("short", 2048)).toBe("short");
  });
});

describe("managed action validation and bounded isolation", () => {
  test("keeps run as the no-action default and rejects mixed control requests", () => {
    const run = parseSubagentCall({ agent: "coder", task: "x" });
    expect(run.ok && run.command.kind).toBe("run");
    expect(
      parseError({
        action: "status",
        handle: "mw-123456",
        model: "provider/model-a",
      }),
    ).toContain("does not accept launch fields: model");
    expect(
      parseError({
        action: "send",
        handle: "mw-123456",
        message: "hello",
        waitTimeoutMs: 1,
      }),
    ).toContain("does not accept assignmentId or waitTimeoutMs");
    expect(
      parseError({ action: "spawn", chain: [{ agent: "coder" }] }),
    ).toContain("does not support chains");
    expect(parseError({ action: "spawn", tasks: [] })).toContain(
      "non-empty tasks[]",
    );
  });

  test("loads the child bridge explicitly when extension discovery is disabled", () => {
    expect(
      buildSubagentIsolationArgs(
        {
          noExtensions: true,
          noSkills: true,
          noContextFiles: true,
          noPromptTemplates: true,
          noMcp: true,
        },
        "/package/src/index.ts",
      ),
    ).toEqual([
      "--no-extensions",
      "--extension",
      "/package/src/index.ts",
      "--no-skills",
      "--no-context-files",
      "--no-prompt-templates",
      "--no-mcp",
    ]);
    expect(
      buildSubagentIsolationArgs(undefined, "/package/src/index.ts"),
    ).toEqual([]);
  });
});

type LifecycleHandler = (
  event: unknown,
  ctx: ExtensionContext,
) => void | Promise<void>;

function makeWorker(handle: string): ManagedWorkerView {
  const usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    turns: 0,
    contextTokens: 0,
  };
  return {
    handle,
    label: "🛠️ coder",
    agent: { name: "coder", emoji: "🛠️", source: "user" },
    profile: "quick",
    model: "provider/model-a",
    modelCandidates: ["provider/model-a:high"],
    candidateIndex: 0,
    attempts: [],
    lifecycle: "running",
    live: true,
    childState: "idle",
    hostKind: "rpc",
    placement: { kind: "rpc" },
    cwd: "/repo",
    dir: "/managed",
    sessionId: "child-session",
    usage,
    toolActivity: false,
    queued: 0,
    lastAssignmentId: "assignment-1",
    createdAt: 1,
    recentAssignments: [],
  };
}

function sessionFor(sessionId: string) {
  return { getSessionId: () => sessionId, getBranch: () => [] };
}

function makeHarness() {
  const root = mkdtempSync(join(tmpdir(), "pi-simple-subagents-managed-"));
  roots.push(root);
  const agentDir = join(root, "agent");
  const extensionDir = join(root, "extension");
  const agentsDir = join(agentDir, "agents");
  mkdirSync(agentsDir, { recursive: true });
  mkdirSync(extensionDir, { recursive: true });
  writeFileSync(
    join(agentsDir, "coder.md"),
    "---\nname: coder\ndescription: Coding agent.\nemoji: 🛠️\nprofile: quick\n---\nYou implement code.\n",
  );
  const profilesPath = join(root, "profiles.yaml");
  writeFileSync(
    profilesPath,
    "version: 1\nprofiles:\n  quick:\n    description: Fast profile.\n    candidates:\n      - model: provider/model-a\n        thinkingLevel: high\n",
  );
  copyFileSync(profilesPath, join(agentDir, "profiles.yaml"));
  writeFileSync(
    join(extensionDir, "limits.json"),
    JSON.stringify({
      version: 1,
      maxDepth: 2,
      maxChildrenPerCall: 5,
      maxConcurrency: 1,
      maxRuntimeMs: 7_200_000,
      maxInactivityMs: 900_000,
      persistChildSessions: true,
    }),
  );
  mockState.agentDir = agentDir;

  const handlers = new Map<string, LifecycleHandler[]>();
  let tool: any;
  const commands = new Map<string, any>();
  const pi = {
    registerTool(definition: unknown) {
      tool = definition;
    },
    on(event: string, handler: LifecycleHandler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerCommand(name: string, definition: unknown) {
      commands.set(name, definition);
    },
    registerMessageRenderer: vi.fn(),
    sendMessage: vi.fn(),
    appendEntry: vi.fn(),
  };
  const runtimes = new Map<string, ReturnType<typeof makeFakeRuntime>>();
  const runtimeOptions: ManagedRuntimeOptions[] = [];
  const managedRuntimeFactory = vi.fn((options: ManagedRuntimeOptions) => {
    runtimeOptions.push(options);
    let runtime = runtimes.get(options.parentSessionId);
    if (!runtime) {
      runtime = makeFakeRuntime(options);
      runtimes.set(options.parentSessionId, runtime);
    }
    return runtime.runtime;
  });
  const processRegistries: Array<{
    isShuttingDown: boolean;
    terminateAll: ReturnType<typeof vi.fn>;
  }> = [];
  const processRegistryFactory = vi.fn(() => {
    const registry = {
      isShuttingDown: false,
      terminateAll: vi.fn(async () => {
        registry.isShuttingDown = true;
      }),
    };
    processRegistries.push(registry);
    return registry as unknown as SubagentProcessRegistry;
  });
  const context = {
    cwd: "/repo",
    mode: "json",
    hasUI: false,
    isIdle: () => true,
    ui: { notify: vi.fn(), confirm: vi.fn(async () => true) },
    sessionManager: sessionFor("parent-1"),
    modelRegistry: {
      refresh: vi.fn(async () => undefined),
      getAvailable: vi.fn(() => models),
    },
  } as unknown as ExtensionContext & {
    sessionManager: ReturnType<typeof sessionFor>;
    modelRegistry: {
      refresh: ReturnType<typeof vi.fn>;
      getAvailable: ReturnType<typeof vi.fn>;
    };
  };
  return {
    context,
    extensionDir,
    handlers,
    managedRuntimeFactory,
    processRegistryFactory,
    processRegistries,
    pi,
    runtimeOptions,
    runtimes,
    commands,
    get tool() {
      return tool;
    },
  };
}

function makeFakeRuntime(options: ManagedRuntimeOptions) {
  let gate = options.gate;
  let sequence = 0;
  let activeReleases: Array<() => void> = [];
  const bindGates: (typeof options.gate)[] = [];
  const worker = makeWorker("mw-123456");
  const runtime = {
    parentSessionId: options.parentSessionId,
    bind: vi.fn((nextGate: typeof gate) => {
      gate = nextGate;
      bindGates.push(nextGate);
    }),
    restore: vi.fn(async () => []),
    spawn: vi.fn(async () => {
      const release = await gate.acquire();
      activeReleases.push(release);
      sequence++;
      return {
        handle: `mw-${String(sequence).padStart(6, "0")}`,
        assignmentId: `a-${sequence}`,
      };
    }),
    list: vi.fn(() => (activeReleases.length ? [worker] : [])),
    listResults: vi.fn(() => []),
    status: vi.fn(() => worker),
    send: vi.fn(() => ({ assignmentId: "a-next", state: "queued" as const })),
    wait: vi.fn(async () => ({
      handle: worker.handle,
      id: worker.lastAssignmentId,
      state: "completed" as const,
      terminal: true,
      preview: "task",
      outcome: { source: "yield" as const, result: "done" },
      usage: worker.usage,
      toolActivity: false,
    })),
    stop: vi.fn(async () => {
      activeReleases.shift()?.();
      return { ...worker, lifecycle: "stopped" as const, live: false };
    }),
    resume: vi.fn(async () => worker),
    suspendAll: vi.fn(async () => {
      for (const release of activeReleases.splice(0)) release();
    }),
    open: vi.fn(async () => undefined),
  } as unknown as ManagedRuntime;
  return { runtime, bindGates };
}

describe("subagent managed integration", () => {
  test("warns once for a headless spawn and keeps native launch details expanded-only", async () => {
    vi.stubEnv("PI_SUBAGENT_DEPTH", "0");
    const { registerSubagent } = await import("../src/subagent.ts");
    const h = makeHarness();
    registerSubagent(h.pi as any, h.extensionDir, {
      managedRuntimeFactory: h.managedRuntimeFactory,
      processRegistryFactory: h.processRegistryFactory,
    });
    const ctx = { ...h.context, hasUI: true };
    const spawn = (callId: string) =>
      h.tool.execute(
        callId,
        {
          action: "spawn",
          agent: "coder",
          profile: "quick",
          task: "A read-only task",
        },
        undefined,
        undefined,
        ctx,
      );
    const headless = await spawn("headless-spawn");
    expect(headless.isError).toBeUndefined();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Cannot automatically open subagent."),
      "warning",
    );
    expect(headless.details.managedSpawn.manualOpen).toBe(true);

    const runtime = h.runtimes.get("parent-1")!.runtime;
    await runtime.stop("mw-000001");
    vi.mocked(runtime.status).mockReturnValue({
      ...makeWorker("mw-000002"),
      hostKind: "herdr",
      placement: {
        kind: "herdr",
        tabId: "parent-tab",
        paneId: "child-pane",
        layout: "split",
      },
    });
    vi.mocked(ctx.ui.notify).mockClear();
    const native = await spawn("native-spawn");
    expect(native.content[0].text).toContain(
      "worker-handle [mw-000002] assignment-id [a-2]",
    );
    expect(native.content[0].text).not.toContain(
      "Cannot automatically open subagent.",
    );
    expect(ctx.ui.notify).not.toHaveBeenCalled();
    const theme = { fg: (_color: string, text: string) => text };
    expect(
      h.tool.renderResult(native, { expanded: false }, theme, {}).text,
    ).toBe("1 background worker started");
    expect(
      h.tool.renderResult(native, { expanded: true }, theme, {}).text,
    ).toContain("worker-handle [mw-000002]");
    await runtime.stop("mw-000002");
  });

  test("routes managed actions before model resolution and shares fresh session gates across reloads", async () => {
    vi.stubEnv("PI_SUBAGENT_DEPTH", "0");
    const { registerSubagent } = await import("../src/subagent.ts");
    const h = makeHarness();
    registerSubagent(h.pi as any, h.extensionDir, {
      managedRuntimeFactory: h.managedRuntimeFactory,
      processRegistryFactory: h.processRegistryFactory,
    });
    const fire = async (
      event: string,
      ctx: ExtensionContext,
      payload: Record<string, unknown> = {},
    ) => {
      for (const handler of h.handlers.get(event) ?? [])
        await handler(payload, ctx);
    };

    await fire("session_start", h.context);
    expect(h.commands.has("subagent")).toBe(true);
    expect(h.runtimeOptions).toHaveLength(1);
    const firstGate = h.runtimeOptions[0]!.gate;
    const firstRuntime = h.runtimes.get("parent-1")!;

    const result = await h.tool.execute(
      "spawn-1",
      {
        action: "spawn",
        agent: "coder",
        task: "Implement a parser",
        profile: "quick",
      },
      undefined,
      undefined,
      h.context,
    );
    expect(result.content[0].text).toContain(
      "- coder: worker-handle [mw-000001] assignment-id [a-1]",
    );
    expect(result.content[0].text).toContain("Results report automatically.");
    expect(result.content[0].text).toContain("ask me for status or to wait");
    expect(h.tool.description).not.toContain("collected only with wait");
    expect(h.tool.description).toContain(
      "not a separate assistant chat acknowledgement",
    );
    expect(h.tool.promptGuidelines.join(" ")).toContain(
      "finish without a prose acknowledgement",
    );
    const theme = { fg: (_color: string, text: string) => text };
    const collapsed = h.tool.renderResult(
      result,
      { expanded: false },
      theme,
      {},
    );
    expect(collapsed.text).toBe(
      "1 background worker started · manual open only",
    );
    expect(collapsed.text).not.toContain("mw-000001");
    expect(collapsed.text).not.toContain("assignment-id");
    const expanded = h.tool.renderResult(result, { expanded: true }, theme, {});
    expect(expanded.text).toContain(
      "worker-handle [mw-000001] assignment-id [a-1]",
    );
    expect(expanded.text).toContain("Results report automatically.");
    expect(expanded.text).toContain("Cannot automatically open subagent.");
    expect(expanded.text).toContain("Stop running headless worker");
    expect(expanded.text).toContain(
      "pi --session-dir '/managed/session' --session-id 'child-session'",
    );
    expect(h.context.ui.notify).not.toHaveBeenCalled();
    expect(firstGate.status).toMatchObject({ active: 1, limit: 1 });

    vi.stubEnv("PI_SUBAGENT_DEPTH", "1");
    const nestedSpawn = await h.tool.execute(
      "nested-spawn",
      { action: "spawn", agent: "coder", task: "must stay top-level" },
      undefined,
      undefined,
      h.context,
    );
    expect(nestedSpawn.isError).toBe(true);
    expect(nestedSpawn.content[0].text).toContain("top-level Pi session");
    const nestedRun = await h.tool.execute(
      "nested-run",
      { agent: "missing-agent", task: "bounded child work remains allowed" },
      undefined,
      undefined,
      h.context,
    );
    expect(nestedRun.details.trace.depth).toBe(2);
    expect(nestedRun.content[0].text).toContain("Unknown agent");
    vi.stubEnv("PI_SUBAGENT_DEPTH", "0");

    const refreshCount = h.context.modelRegistry.refresh.mock.calls.length;
    const status = await h.tool.execute(
      "status-1",
      {
        action: "status",
        handle: "mw-123456",
        model: "provider/model-a",
      },
      undefined,
      undefined,
      h.context,
    );
    expect(status.isError).toBe(true);
    expect(h.context.modelRegistry.refresh).toHaveBeenCalledTimes(refreshCount);
    const validStatus = await h.tool.execute(
      "status-2",
      { action: "status", handle: "mw-123456" },
      undefined,
      undefined,
      h.context,
    );
    expect(validStatus.content[0].text).toContain("mw-123456");
    expect(h.runtimes.get("parent-1")!.runtime.status).toHaveBeenLastCalledWith(
      "mw-123456",
    );
    expect(h.context.modelRegistry.refresh).toHaveBeenCalledTimes(refreshCount);

    const bounded = await h.tool.execute(
      "run-1",
      {
        agent: "missing-agent",
        task: "This should fail before spawning a process",
      },
      undefined,
      undefined,
      h.context,
    );
    expect(bounded.details.concurrency.active).toBe(1);
    expect(h.managedRuntimeFactory).toHaveBeenCalledTimes(1);

    const abort = new AbortController();
    const boundedWaiter = h.tool.execute(
      "bounded-waiter",
      {
        agent: "coder",
        task: "Wait behind the managed worker",
        model: "provider/model-a",
      },
      abort.signal,
      undefined,
      h.context,
    );
    const blockedBoundedRun = await boundedWaiter;
    expect(blockedBoundedRun.isError).toBe(true);
    expect(blockedBoundedRun.content[0].text).toContain(
      "Stop a worker before running bounded work",
    );
    expect(blockedBoundedRun.content[0].text).toContain("mw-");
    expect(firstGate.status).toMatchObject({ active: 1, queued: 0 });

    const queuedSpawn = h.tool.execute(
      "spawn-2",
      {
        action: "spawn",
        agent: "coder",
        task: "Second task",
      },
      undefined,
      undefined,
      h.context,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(firstGate.status).toMatchObject({ active: 1, queued: 1 });
    await h.tool.execute(
      "stop-1",
      {
        action: "stop",
        handle: "mw-123456",
      },
      undefined,
      undefined,
      h.context,
    );
    expect((await queuedSpawn).content[0].text).toContain("mw-000002");

    await fire("session_shutdown", h.context);
    expect(h.processRegistries.at(-1)!.terminateAll).toHaveBeenCalledTimes(1);
    expect(h.runtimes.get("parent-1")!.runtime.suspendAll).toHaveBeenCalled();
    await expect(firstGate.acquire()).rejects.toThrow(
      "session is shutting down",
    );
    const nextContext = {
      ...h.context,
      sessionManager: sessionFor("parent-2"),
    } as unknown as ExtensionContext;
    await fire("session_start", nextContext);
    const secondGate = h.runtimeOptions[h.runtimeOptions.length - 1]!.gate;
    expect(secondGate).not.toBe(firstGate);
    expect(h.runtimes.get("parent-1")!.runtime.suspendAll).toHaveBeenCalled();

    const persistedRuntime = h.runtimes.get("parent-2")!;
    const priorSuspends = vi.mocked(persistedRuntime.runtime.suspendAll).mock
      .calls.length;
    await fire("session_shutdown", nextContext, { reason: "reload" });
    expect(persistedRuntime.runtime.suspendAll).toHaveBeenCalledTimes(
      priorSuspends,
    );
    const reloaded = makeHarness();
    const reloadFactory = vi.fn((options: ManagedRuntimeOptions) => {
      reloaded.runtimeOptions.push(options);
      persistedRuntime.runtime.bind(options.gate, options.limits);
      return persistedRuntime.runtime;
    });
    registerSubagent(reloaded.pi as any, reloaded.extensionDir, {
      managedRuntimeFactory: reloadFactory,
      processRegistryFactory: reloaded.processRegistryFactory,
    });
    const sameSession = {
      ...reloaded.context,
      sessionManager: sessionFor("parent-2"),
    } as unknown as ExtensionContext;
    for (const handler of reloaded.handlers.get("session_start") ?? [])
      await handler({}, sameSession);
    const reboundGate = reloaded.runtimeOptions[0]!.gate;
    expect(reboundGate).not.toBe(secondGate);
    expect(reloadFactory).toHaveBeenCalledTimes(1);
    expect(persistedRuntime.bindGates).toContain(reboundGate);
  });

  test("records a collection receipt only for terminal manual waits", async () => {
    vi.stubEnv("PI_SUBAGENT_DEPTH", "0");
    const { registerSubagent } = await import("../src/subagent.ts");
    const h = makeHarness();
    registerSubagent(h.pi as any, h.extensionDir, {
      managedRuntimeFactory: h.managedRuntimeFactory,
      processRegistryFactory: h.processRegistryFactory,
    });
    for (const handler of h.handlers.get("session_start") ?? [])
      await handler({}, h.context);
    const runtime = h.runtimes.get("parent-1")!.runtime;
    const wait = (callId: string) =>
      h.tool.execute(
        callId,
        { action: "wait", handle: "mw-123456" },
        undefined,
        undefined,
        h.context,
      );
    const receipts = () =>
      h.pi.appendEntry.mock.calls.filter(
        ([type]) => type === "managed-subagent-collected",
      );

    const terminal = await runtime.wait("mw-123456");
    vi.mocked(runtime.wait).mockResolvedValueOnce({
      ...terminal,
      state: "running",
      terminal: false,
      waitTimedOut: true,
    });
    await wait("wait-timeout");
    expect(receipts()).toEqual([]);

    await wait("wait-terminal");
    expect(receipts()).toEqual([
      [
        "managed-subagent-collected",
        { handle: "mw-123456", assignmentId: terminal.id },
      ],
    ]);
    // A repeated wait for the same result does not write another receipt.
    await wait("wait-again");
    expect(receipts()).toHaveLength(1);
  });
});
