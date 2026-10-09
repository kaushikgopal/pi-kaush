import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  RegisteredCommand,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  formatManualManagedOpenHint,
  MANAGED_FOOTER_STATUS_KEY,
  registerManagedUi,
} from "../src/_managed-ui.ts";
import type { ManagedRuntime, ManagedWorkerView } from "../src/_managed.ts";

type Command = Pick<RegisteredCommand, "handler">;
type LifecycleHandler = (
  event: unknown,
  ctx: ExtensionContext,
) => void | Promise<void>;

function makeWorker(
  handle: string,
  overrides: Partial<ManagedWorkerView> = {},
): ManagedWorkerView {
  const usage = {
    input: 120,
    output: 30,
    cacheRead: 4,
    cacheWrite: 2,
    cost: 0.0123,
    turns: 2,
    contextTokens: 150,
  };
  return {
    handle,
    label: "🧪 coder",
    agent: { name: "coder", emoji: "🧪", source: "user" },
    profile: "quick",
    model: "provider/model",
    modelCandidates: ["provider/model"],
    candidateIndex: 0,
    attempts: [],
    lifecycle: "running",
    live: true,
    childState: "idle",
    hostKind: "herdr",
    placement: {
      kind: "herdr",
      tabId: `tab-${handle}`,
      paneId: `pane-${handle}`,
    },
    cwd: "/repo",
    dir: `/managed/${handle}`,
    sessionId: `session-${handle}`,
    sessionFile: `/sessions/${handle}.jsonl`,
    usage,
    toolActivity: false,
    activeAssignmentId: "assignment-1",
    queued: 0,
    lastAssignmentId: "assignment-1",
    createdAt: 1,
    recentAssignments: [
      {
        handle,
        id: "assignment-1",
        state: "completed",
        terminal: true,
        preview: "Implement the task",
        outcome: {
          source: "yield",
          result: "Done.",
          artifacts: ["/repo/result.md"],
        },
        usage,
        toolActivity: false,
        model: "provider/model",
      },
    ],
    ...overrides,
  };
}

function createRuntime(workers: ManagedWorkerView[]) {
  const order: string[] = [];
  const runtime = {
    list: vi.fn(() => workers),
    status: vi.fn((handle: string) => {
      const worker = workers.find((entry) => entry.handle === handle);
      if (!worker) throw new Error(`missing ${handle}`);
      return worker;
    }),
    send: vi.fn(() => ({
      assignmentId: "assignment-next",
      state: "queued" as const,
    })),
    stop: vi.fn(async (handle: string) => {
      order.push(`stop:${handle}`);
      const worker = workers.find((entry) => entry.handle === handle);
      if (!worker) throw new Error(`missing ${handle}`);
      return worker;
    }),
    resume: vi.fn(async (handle: string) => {
      order.push(`resume:${handle}`);
      const worker = workers.find((entry) => entry.handle === handle);
      if (!worker) throw new Error(`missing ${handle}`);
      return { ...worker, lifecycle: "running" as const };
    }),
    open: vi.fn(async (handle: string) => {
      order.push(`focus-existing:${handle}`);
    }),
    spawn: vi.fn(),
  };
  return {
    runtime: runtime as unknown as ManagedRuntime,
    order,
    list: runtime.list,
  };
}

function createContext(
  options: {
    mode?: "tui" | "rpc" | "json" | "print";
    hasUI?: boolean;
  } = {},
) {
  const ui = {
    select: vi.fn(
      async (_title: string, _options: string[]) =>
        undefined as string | undefined,
    ),
    confirm: vi.fn(async () => false),
    input: vi.fn(async () => undefined as string | undefined),
    notify: vi.fn(),
    setStatus: vi.fn(),
    custom: vi.fn(async () => undefined),
  };
  return {
    context: {
      mode: options.mode ?? "tui",
      hasUI: options.hasUI ?? true,
      ui,
    } as unknown as ExtensionCommandContext,
    ui,
  };
}

function createExtension(
  getRuntime: (ctx: ExtensionContext) => ManagedRuntime,
  isReported?: (
    ctx: ExtensionContext,
    handle: string,
    assignmentId: string,
  ) => boolean,
) {
  const commands = new Map<string, Command>();
  const lifecycle = new Map<string, LifecycleHandler>();
  const api = {
    registerCommand(name: string, command: Command) {
      commands.set(name, command);
    },
    on(name: string, handler: LifecycleHandler) {
      lifecycle.set(name, handler);
      return () => lifecycle.delete(name);
    },
  } as unknown as ExtensionAPI;
  registerManagedUi(api, getRuntime, isReported);
  return { commands, lifecycle };
}

async function runCommand(
  extension: ReturnType<typeof createExtension>,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const command = extension.commands.get("subagent");
  if (!command) throw new Error("/subagent was not registered");
  await command.handler("", ctx);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("managed subagent UI", () => {
  test("requires stop confirmation and retains the child session", async () => {
    const worker = makeWorker("mw-confirm");
    const { runtime } = createRuntime([worker]);
    const extension = createExtension(() => runtime);
    const { context, ui } = createContext();
    ui.select
      .mockResolvedValueOnce("🧪 coder · quick · completed · idle · mw-confirm")
      .mockResolvedValueOnce("Stop");

    await runCommand(extension, context);

    expect(ui.confirm).toHaveBeenCalledWith(
      "Stop managed worker?",
      expect.stringContaining("session and transcripts will be retained"),
    );
    expect(runtime.stop).not.toHaveBeenCalled();

    ui.select
      .mockResolvedValueOnce("🧪 coder · quick · completed · idle · mw-confirm")
      .mockResolvedValueOnce("Stop");
    ui.confirm.mockResolvedValueOnce(true);
    await runCommand(extension, context);

    expect(runtime.stop).toHaveBeenCalledWith("mw-confirm");
    expect(ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("session and transcripts were retained"),
      "info",
    );
  });

  test("manual open hints are fish-safe and use the exact persisted session", () => {
    const worker = makeWorker("mw-quoted", {
      hostKind: "rpc",
      live: true,
      sessionFile: "/tmp/a user's\\session file.jsonl",
    });
    expect(formatManualManagedOpenHint(worker)).toBe(
      [
        "Cannot automatically open subagent.",
        "Stop running headless worker mw-quoted first to avoid two writers.",
        "Open a new terminal tab and run:",
        "  pi --session '/tmp/a user\\'s\\\\session file.jsonl'",
        "This opens a standalone Pi session, not a live attachment. Close it before resuming this worker from the parent.",
      ].join("\n"),
    );

    const { sessionFile: _sessionFile, ...savedWorker } = makeWorker(
      "mw-saved",
      {
        hostKind: "rpc",
        live: false,
        lifecycle: "stopped",
      },
    );
    const saved = formatManualManagedOpenHint(savedWorker);
    expect(saved).toContain("no stop is needed");
    expect(saved).toContain(
      "pi --session-dir '/managed/mw-saved/session' --session-id 'session-mw-saved'",
    );
  });

  test("Open child warns before resume for headless workers", async () => {
    const worker = makeWorker("mw-headless", {
      hostKind: "rpc",
      lifecycle: "suspended",
      live: false,
    });
    const { runtime } = createRuntime([worker]);
    const extension = createExtension(() => runtime);
    const { context, ui } = createContext();
    ui.select
      .mockResolvedValueOnce(
        "🧪 coder · quick · completed · suspended · mw-headless",
      )
      .mockResolvedValueOnce("Open child");

    await runCommand(extension, context);

    expect(runtime.resume).not.toHaveBeenCalled();
    expect(runtime.open).not.toHaveBeenCalled();
    expect(runtime.spawn).not.toHaveBeenCalled();
    expect(ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Cannot automatically open subagent."),
      "warning",
    );
    expect(ui.notify.mock.calls[0]?.[0]).toContain("no stop is needed");
  });

  test("Open child explicitly resumes a suspended Herdr worker before focusing it", async () => {
    const worker = makeWorker("mw-suspended", {
      lifecycle: "suspended",
      live: false,
    });
    const { runtime, order } = createRuntime([worker]);
    const extension = createExtension(() => runtime);
    const { context, ui } = createContext();
    ui.select
      .mockResolvedValueOnce(
        "🧪 coder · quick · completed · suspended · mw-suspended",
      )
      .mockResolvedValueOnce("Open child");

    await runCommand(extension, context);

    expect(order).toEqual([
      "resume:mw-suspended",
      "focus-existing:mw-suspended",
    ]);
    expect(runtime.spawn).not.toHaveBeenCalled();
  });

  test("Open child focuses the existing Herdr pane without creating a worker", async () => {
    const worker = makeWorker("mw-existing");
    const { runtime, order } = createRuntime([worker]);
    const extension = createExtension(() => runtime);
    const { context, ui } = createContext();
    ui.select
      .mockResolvedValueOnce(
        "🧪 coder · quick · completed · idle · mw-existing",
      )
      .mockResolvedValueOnce("Open child");

    await runCommand(extension, context);

    expect(order).toEqual(["focus-existing:mw-existing"]);
    expect(runtime.spawn).not.toHaveBeenCalled();
  });
  test("inspects latest assignment result, usage, model, artifacts, and session path in RPC UI", async () => {
    const worker = makeWorker("mw-inspect");
    const { runtime } = createRuntime([worker]);
    const extension = createExtension(() => runtime);
    const { context, ui } = createContext({ mode: "rpc", hasUI: true });
    ui.select
      .mockResolvedValueOnce("🧪 coder · quick · completed · idle · mw-inspect")
      .mockResolvedValueOnce("Inspect latest assignments");

    await runCommand(extension, context);

    expect(runtime.status).toHaveBeenCalledWith("mw-inspect");
    expect(ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Result: Done."),
      "info",
    );
    const details = ui.notify.mock.calls[0]?.[0];
    expect(details).toContain("in 120");
    expect(details).toContain("provider/model");
    expect(details).toContain("/repo/result.md");
    expect(details).toContain("/sessions/mw-inspect.jsonl");
  });

  test("sends immediately or queues a follow-up using the selected delivery", async () => {
    const worker = makeWorker("mw-send");
    const { runtime } = createRuntime([worker]);
    const extension = createExtension(() => runtime);
    const { context, ui } = createContext();
    ui.select
      .mockResolvedValueOnce("🧪 coder · quick · completed · idle · mw-send")
      .mockResolvedValueOnce("Send / steer")
      .mockResolvedValueOnce("🧪 coder · quick · completed · idle · mw-send")
      .mockResolvedValueOnce("Queue follow-up");
    ui.input
      .mockResolvedValueOnce("  steer this  ")
      .mockResolvedValueOnce("  later  ");

    await runCommand(extension, context);
    await runCommand(extension, context);

    expect(runtime.send).toHaveBeenNthCalledWith(
      1,
      "mw-send",
      "steer this",
      "auto",
    );
    expect(runtime.send).toHaveBeenNthCalledWith(
      2,
      "mw-send",
      "later",
      "followUp",
    );
  });

  test("does not open a worker automatically at session start", async () => {
    const { runtime } = createRuntime([makeWorker("mw-launch")]);
    const getRuntime = vi.fn(() => runtime);
    const extension = createExtension(getRuntime);
    const { context } = createContext();
    const onStart = extension.lifecycle.get("session_start");
    if (!onStart) throw new Error("session_start handler missing");

    await onStart({ type: "session_start", reason: "startup" }, context);

    expect(getRuntime).toHaveBeenCalledWith(context);
    expect(runtime.open).not.toHaveBeenCalled();
    expect(runtime.spawn).not.toHaveBeenCalled();
  });

  test("same-name workers are disambiguated by their handles", async () => {
    const first = makeWorker("mw-first");
    const second = makeWorker("mw-second");
    const { runtime } = createRuntime([first, second]);
    const extension = createExtension(() => runtime);
    const { context, ui } = createContext();
    ui.select
      .mockResolvedValueOnce("🧪 coder · quick · completed · idle · mw-second")
      .mockResolvedValueOnce("Open child");

    await runCommand(extension, context);

    const workerOptions = ui.select.mock.calls[0]?.[1] ?? [];
    expect(workerOptions).toHaveLength(2);
    expect(workerOptions[0]).toContain("mw-first");
    expect(workerOptions[1]).toContain("mw-second");
    expect(runtime.status).toHaveBeenCalledWith("mw-second");
    expect(runtime.open).toHaveBeenCalledWith("mw-second");
  });

  test("clears the refresh timer on reload and rebinds on session start", async () => {
    vi.useFakeTimers();
    const { runtime, list } = createRuntime([makeWorker("mw-timer")]);
    const getRuntime = vi.fn(() => runtime);
    const extension = createExtension(getRuntime);
    const first = createContext();
    const second = createContext();
    const onStart = extension.lifecycle.get("session_start");
    const onShutdown = extension.lifecycle.get("session_shutdown");
    if (!onStart || !onShutdown) throw new Error("lifecycle handlers missing");

    await onStart({ type: "session_start", reason: "startup" }, first.context);
    expect(first.ui.setStatus).toHaveBeenCalledWith(
      MANAGED_FOOTER_STATUS_KEY,
      expect.stringContaining("mw-timer"),
    );
    expect(list).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(list).toHaveBeenCalledTimes(2);

    await onShutdown(
      { type: "session_shutdown", reason: "reload" },
      first.context,
    );
    expect(first.ui.setStatus).toHaveBeenLastCalledWith(
      MANAGED_FOOTER_STATUS_KEY,
      undefined,
    );
    const stoppedAt = list.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(list).toHaveBeenCalledTimes(stoppedAt);

    await onStart({ type: "session_start", reason: "reload" }, second.context);
    expect(second.ui.setStatus).toHaveBeenCalledWith(
      MANAGED_FOOTER_STATUS_KEY,
      expect.stringContaining("mw-timer"),
    );
    expect(getRuntime).toHaveBeenLastCalledWith(second.context);
    expect(list).toHaveBeenCalledTimes(stoppedAt + 1);
    await onShutdown(
      { type: "session_shutdown", reason: "quit" },
      second.context,
    );
    expect(second.ui.setStatus).toHaveBeenLastCalledWith(
      MANAGED_FOOTER_STATUS_KEY,
      undefined,
    );
  });

  test("registers safely without UI and skips the command in no-UI mode", async () => {
    const { runtime } = createRuntime([makeWorker("mw-no-ui")]);
    const getRuntime = vi.fn(() => runtime);
    const extension = createExtension(getRuntime);
    const { context, ui } = createContext({ mode: "print", hasUI: false });

    await expect(runCommand(extension, context)).resolves.toBeUndefined();

    expect(extension.commands.has("subagent")).toBe(true);
    expect(getRuntime).not.toHaveBeenCalled();
    expect(ui.select).not.toHaveBeenCalled();
    expect(ui.notify).not.toHaveBeenCalled();
  });

  test("publishes live workers before pending results and keeps retained history selectable", async () => {
    const source = makeWorker("mw-source");
    const reportedWorker = makeWorker("mw-reported", {
      lifecycle: "exited",
      live: false,
      recentAssignments: [
        {
          ...source.recentAssignments[0]!,
          handle: "mw-reported",
          mergedInto: "assignment-canonical",
        },
      ],
    });
    const pendingWorker = makeWorker("mw-pending", {
      lifecycle: "exited",
      live: false,
    });
    const hiddenWorker = makeWorker("mw-hidden", {
      lifecycle: "stopped",
      live: false,
      recentAssignments: [],
    });
    const hiddenExitedWorker = makeWorker("mw-hidden-exited", {
      lifecycle: "exited",
      live: false,
      recentAssignments: [],
    });
    const olderPendingWorker = makeWorker("mw-pending-old", {
      lifecycle: "stopped",
      live: false,
    });
    const liveWorkers = [
      makeWorker("mw-live-1"),
      makeWorker("mw-live-2"),
      makeWorker("mw-live-3"),
      makeWorker("mw-live-4"),
    ];
    const { runtime, list } = createRuntime([
      reportedWorker,
      pendingWorker,
      hiddenWorker,
      hiddenExitedWorker,
      olderPendingWorker,
      ...liveWorkers,
    ]);
    const isReported = vi.fn(
      (_ctx: ExtensionContext, handle: string, assignmentId: string) =>
        handle === "mw-reported" && assignmentId === "assignment-canonical",
    );
    const extension = createExtension(() => runtime, isReported);
    const { context, ui } = createContext();
    const onStart = extension.lifecycle.get("session_start");
    const onShutdown = extension.lifecycle.get("session_shutdown");
    if (!onStart || !onShutdown) throw new Error("lifecycle handlers missing");

    await onStart({ type: "session_start", reason: "startup" }, context);

    expect(ui.setStatus).toHaveBeenCalledWith(
      MANAGED_FOOTER_STATUS_KEY,
      expect.stringContaining(
        "🧪 quick · completed · idle · coder · mw-live-1",
      ),
    );
    const rows: string[] = ui.setStatus.mock.calls[0]?.[1]?.split("\n") ?? [];
    expect(rows).toHaveLength(6);
    expect(
      rows.slice(0, 4).map((row) => row.slice(row.lastIndexOf("mw-"))),
    ).toEqual(["mw-live-1", "mw-live-2", "mw-live-3", "mw-live-4"]);
    expect(rows[4]).toContain("mw-pending");
    expect(rows[5]).toBe("+1 more");
    expect(rows.join("\n")).not.toContain("mw-reported");
    expect(rows.join("\n")).not.toContain("mw-hidden");
    expect(rows.join("\n")).not.toContain("mw-hidden-exited");
    expect(isReported).toHaveBeenCalledWith(
      context,
      "mw-reported",
      "assignment-canonical",
    );
    expect(list).toHaveBeenCalledTimes(1);

    const historyLabel = "🧪 coder · quick · stopped · mw-hidden";
    ui.select
      .mockResolvedValueOnce(historyLabel)
      .mockResolvedValueOnce("Inspect latest assignments");
    await runCommand(extension, context);
    expect(ui.select.mock.calls[0]?.[1]).toContain(historyLabel);

    await onShutdown({ type: "session_shutdown", reason: "quit" }, context);
    expect(ui.setStatus).toHaveBeenLastCalledWith(
      MANAGED_FOOTER_STATUS_KEY,
      undefined,
    );
  });

  test("keeps five visible rows and reports additional retained workers", async () => {
    const workers = Array.from({ length: 7 }, (_, index) =>
      makeWorker(`mw-overflow-${index}`, { lifecycle: "exited", live: false }),
    );
    const { runtime } = createRuntime(workers);
    const extension = createExtension(() => runtime);
    const { context, ui } = createContext();
    const onStart = extension.lifecycle.get("session_start");
    if (!onStart) throw new Error("session_start handler missing");

    await onStart({ type: "session_start", reason: "startup" }, context);

    const rows: string[] = ui.setStatus.mock.calls[0]?.[1]?.split("\n") ?? [];
    expect(rows).toHaveLength(6);
    expect(rows[5]).toBe("+2 more");
    expect(rows.slice(0, 5).every((row) => row.includes("mw-overflow-"))).toBe(
      true,
    );
  });

  test("shows retained terminal results by default when no reporting callback is provided", async () => {
    const worker = makeWorker("mw-default-history", {
      lifecycle: "exited",
      live: false,
    });
    const { runtime } = createRuntime([worker]);
    const extension = createExtension(() => runtime);
    const { context, ui } = createContext();
    const onStart = extension.lifecycle.get("session_start");
    if (!onStart) throw new Error("session_start handler missing");

    await onStart({ type: "session_start", reason: "startup" }, context);

    expect(ui.setStatus).toHaveBeenCalledWith(
      MANAGED_FOOTER_STATUS_KEY,
      expect.stringContaining("mw-default-history"),
    );
  });
});
