import type {
  ExtensionAPI,
  Theme,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  formatManagedReport,
  MANAGED_RESULT_MESSAGE,
  registerManagedNotifications,
  type ManagedReportDetails,
} from "../src/_managed-notifications.ts";
import type {
  ManagedResultView,
  ManagedRuntime,
  ManagedWorkerView,
} from "../src/_managed.ts";

type Handler = (event: any, ctx: ExtensionContext) => unknown;

interface CustomMessage {
  role: "custom";
  customType: string;
  content: string;
  display: boolean;
  details: unknown;
  timestamp: number;
}

interface Sent {
  message: CustomMessage;
  triggerTurn: boolean;
}

const EMPTY_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
  turns: 0,
  contextTokens: 0,
};

/**
 * A parent Pi session with the delivery rules extensions observe: an idle
 * triggered message starts a run, a busy one waits in the follow-up queue
 * until the run ends, an abort drops that queue, extension `message_end`
 * runs before persistence and may replace the message, and a quiet append
 * persists without extension message events.
 */
class FakeParent {
  readonly handlers = new Map<string, Handler[]>();
  readonly entries: SessionEntry[] = [];
  readonly sent: Sent[] = [];
  readonly followUps: CustomMessage[] = [];
  runs = 0;
  idle = true;
  private seq = 0;

  constructor(public sessionId = "parent-1") {}

  readonly pi = {
    on: (event: string, handler: Handler) => {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
    },
    registerMessageRenderer: vi.fn<ExtensionAPI["registerMessageRenderer"]>(),
    appendEntry: (customType: string, data: unknown) => {
      this.push({ type: "custom", customType, data });
    },
    sendMessage: (
      message: Omit<CustomMessage, "role" | "timestamp">,
      options: { triggerTurn?: boolean; deliverAs?: string },
    ) => {
      const full: CustomMessage = {
        ...message,
        role: "custom",
        timestamp: Date.now(),
      };
      this.sent.push({ message: full, triggerTurn: !!options.triggerTurn });
      if (!this.idle) {
        expect(options.deliverAs).toBe("followUp");
        this.followUps.push(full);
      } else if (options.triggerTurn) {
        this.startRun();
        this.deliver(full);
        this.endRun(false);
      } else this.persist(full);
    },
  };

  ctx(sessionId = this.sessionId): ExtensionContext {
    return {
      sessionManager: {
        getSessionId: () => sessionId,
        getBranch: () => [...this.entries],
      },
      isIdle: () => this.idle,
    } as unknown as ExtensionContext;
  }

  emit(event: string, payload: unknown = {}, ctx = this.ctx()): unknown[] {
    return (this.handlers.get(event) ?? []).map((handler) =>
      handler(payload, ctx),
    );
  }

  push(entry: Record<string, unknown>): void {
    this.entries.push({
      id: `e${++this.seq}`,
      parentId: null,
      timestamp: new Date().toISOString(),
      ...entry,
    } as SessionEntry);
  }

  persist(message: CustomMessage): void {
    this.push({
      type: "custom_message",
      customType: message.customType,
      content: message.content,
      display: message.display,
      details: message.details,
    });
  }

  deliver(message: CustomMessage): void {
    let final = message;
    for (const result of this.emit("message_end", { message }))
      if (result && typeof result === "object" && "message" in result)
        final = (result as { message: CustomMessage }).message;
    this.persist(final);
  }

  startRun(): void {
    this.idle = false;
    this.runs++;
    this.emit("agent_start");
  }

  endRun(aborted: boolean): void {
    if (aborted) this.followUps.splice(0);
    for (const message of this.followUps.splice(0)) this.deliver(message);
    this.emit("agent_end", {
      messages: [
        {
          role: "assistant",
          content: [],
          stopReason: aborted ? "aborted" : "stop",
        },
      ],
    });
    this.idle = true;
    this.emit("agent_settled");
  }

  start(sessionId = this.sessionId): void {
    this.sessionId = sessionId;
    this.emit("session_start", { reason: "startup" }, this.ctx(sessionId));
  }

  reports(): ManagedReportDetails[] {
    return this.entries.flatMap((entry) =>
      entry.type === "custom_message" &&
      entry.customType === MANAGED_RESULT_MESSAGE
        ? [entry.details as ManagedReportDetails]
        : [],
    );
  }
}

function result(
  handle: string,
  id: string,
  overrides: Partial<ManagedResultView> = {},
): ManagedResultView {
  return {
    handle,
    id,
    state: "completed",
    terminal: true,
    preview: `task for ${id}`,
    outcome: { source: "yield", result: `result for ${id}` },
    usage: { ...EMPTY_USAGE, turns: 2, input: 10, output: 5, cost: 0.01 },
    toolActivity: false,
    ...overrides,
  };
}

function worker(handle: string): ManagedWorkerView {
  return {
    handle,
    label: "🤖 c3po",
    profile: "coder",
    model: "fake/model",
    sessionFile: `/sessions/${handle}.jsonl`,
  } as ManagedWorkerView;
}

function setup(parent = new FakeParent()) {
  const results: ManagedResultView[] = [];
  const runtime = {
    listResults: vi.fn(() => [...results]),
    status: vi.fn((handle: string) => worker(handle)),
  } as unknown as ManagedRuntime;
  const getRuntime = vi.fn(async (ctx: ExtensionContext) =>
    ctx.sessionManager.getSessionId() === parent.sessionId
      ? runtime
      : undefined,
  );
  const notifications = registerManagedNotifications(
    parent.pi as never,
    getRuntime,
  );
  return { parent, results, runtime, getRuntime, notifications };
}

const poll = (ms = 1_000) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("managed result notifications", () => {
  test("an idle parent gets one report that starts a turn, with no UI", async () => {
    const { parent, results, notifications } = setup();
    parent.start();
    results.push(result("mw-aaaaaa", "a-1"));
    await poll();

    expect(parent.runs).toBe(1);
    expect(parent.sent).toHaveLength(1);
    expect(parent.sent[0]!.triggerTurn).toBe(true);
    const content = parent.sent[0]!.message.content;
    expect(content).toContain("mw-aaaaaa · a-1 · completed");
    expect(content).toContain("result for a-1");
    expect(content).toContain("Do not restart workers");
    expect(content).toContain("Present the worker's answer directly");
    expect(content).toContain("Do not add launch or completion announcements");
    expect(content).toContain("untrusted");
    expect(content).toContain("Transcript: /sessions/mw-aaaaaa.jsonl");
    expect(parent.reports()).toHaveLength(1);
    expect(notifications.isReported(parent.ctx(), "mw-aaaaaa", "a-1")).toBe(
      true,
    );

    await poll(60_000);
    expect(parent.sent).toHaveLength(1);
    expect(parent.pi.registerMessageRenderer).toHaveBeenCalledWith(
      MANAGED_RESULT_MESSAGE,
      expect.any(Function),
    );
  });

  test("a busy parent receives a queued follow-up without interruption or repeats", async () => {
    const { parent, results, notifications } = setup();
    parent.start();
    parent.startRun();
    results.push(result("mw-aaaaaa", "a-1"));
    await poll(5_000);

    expect(parent.sent).toHaveLength(1);
    expect(parent.followUps).toHaveLength(1);
    expect(parent.runs).toBe(1);
    // Queued is not delivered.
    expect(notifications.isReported(parent.ctx(), "mw-aaaaaa", "a-1")).toBe(
      false,
    );

    // A later result waits until the in-flight report lands.
    results.push(result("mw-aaaaaa", "a-2"));
    await poll(40_000);
    expect(parent.sent).toHaveLength(1);

    parent.endRun(false);
    expect(notifications.isReported(parent.ctx(), "mw-aaaaaa", "a-1")).toBe(
      true,
    );
    await poll();
    expect(parent.sent).toHaveLength(2);
    expect(parent.reports().map((report) => report.assignmentId)).toEqual([
      "a-1",
      "a-2",
    ]);
  });

  test("reload and restart rebuild receipts from the branch instead of resending", async () => {
    const first = setup();
    first.parent.start();
    first.results.push(result("mw-aaaaaa", "a-1"));
    await poll();
    expect(first.parent.reports()).toHaveLength(1);
    first.parent.emit("session_shutdown", { reason: "reload" });

    // The new runtime registers against the same persisted session.
    const reloaded = new FakeParent();
    reloaded.entries.push(...first.parent.entries);
    const second = setup(reloaded);
    second.results.push(result("mw-aaaaaa", "a-1"));
    reloaded.start();
    expect(
      second.notifications.isReported(reloaded.ctx(), "mw-aaaaaa", "a-1"),
    ).toBe(true);
    await poll(60_000);
    expect(reloaded.sent).toHaveLength(0);
    // The old registration stopped polling.
    expect(first.parent.sent).toHaveLength(1);
  });

  test("a crash after the outbox intent still delivers the report once", async () => {
    const parent = new FakeParent();
    parent.push({
      type: "custom",
      customType: "managed-subagent-report-intent",
      data: { reports: [{ handle: "mw-aaaaaa", assignmentId: "a-1" }] },
    });
    const { results } = setup(parent);
    results.push(result("mw-aaaaaa", "a-1"));
    parent.start();
    await poll();
    expect(parent.sent).toHaveLength(1);
    expect(parent.reports()).toHaveLength(1);
    await poll(60_000);
    expect(parent.sent).toHaveLength(1);
  });

  test("an aborted run that dropped the queued report retries quietly after settling", async () => {
    const { parent, results, notifications } = setup();
    parent.start();
    parent.startRun();
    results.push(result("mw-aaaaaa", "a-1"));
    await poll();
    expect(parent.followUps).toHaveLength(1);

    parent.endRun(true);
    expect(parent.reports()).toHaveLength(0);
    await poll(1_000);
    expect(parent.sent).toHaveLength(1);

    await poll(2_000);
    expect(parent.sent).toHaveLength(2);
    expect(parent.sent[1]!.triggerTurn).toBe(false);
    expect(parent.runs).toBe(1);
    expect(parent.reports()).toHaveLength(1);

    // The quiet append has no extension message_end; the branch is the receipt.
    await poll();
    expect(notifications.isReported(parent.ctx(), "mw-aaaaaa", "a-1")).toBe(
      true,
    );
    await poll(120_000);
    expect(parent.sent).toHaveLength(2);
  });

  test("a superseded session never receives the old session's reports", async () => {
    const { parent, results, getRuntime, notifications } = setup();
    parent.start("parent-1");
    const oldCtx = parent.ctx("parent-1");
    parent.emit("session_shutdown", { reason: "new" }, oldCtx);
    parent.start("parent-2");
    results.push(result("mw-aaaaaa", "a-1"));
    await poll();

    expect(
      getRuntime.mock.calls.every(
        ([ctx]) => ctx.sessionManager.getSessionId() === "parent-2",
      ),
    ).toBe(true);
    expect(parent.reports()[0]).toMatchObject({ assignmentId: "a-1" });
    expect(notifications.isReported(oldCtx, "mw-aaaaaa", "a-1")).toBe(false);

    parent.emit("session_shutdown", { reason: "quit" });
    results.push(result("mw-aaaaaa", "a-2"));
    await poll(60_000);
    expect(parent.sent).toHaveLength(1);
  });

  test("reports every terminal state, batching more than ten results", async () => {
    const { parent, results } = setup();
    const states = [
      "completed",
      "blocked",
      "failed",
      "timedOut",
      "aborted",
      "interrupted",
      "cancelled",
    ] as const;
    for (let index = 0; index < 12; index++)
      results.push(
        result("mw-aaaaaa", `a-${index}`, {
          state: states[index % states.length]!,
        }),
      );
    parent.start();
    await poll();
    await poll();

    const reports = parent.reports();
    expect(reports.map((report) => report.reports.length)).toEqual([10, 2]);
    const delivered = reports.flatMap((report) => report.reports);
    expect(new Set(delivered.map((ref) => ref.assignmentId)).size).toBe(12);
    expect(new Set(delivered.map((ref) => ref.state))).toEqual(new Set(states));
  });

  test("a manual wait suppresses future reports and marks an in-flight one as a duplicate", async () => {
    const { parent, results, notifications } = setup();
    parent.start();
    const collected = result("mw-aaaaaa", "a-1");
    notifications.markCollected(parent.ctx(), collected);
    results.push(collected);
    await poll(60_000);
    expect(parent.sent).toHaveLength(0);

    // Timed-out and nonterminal waits are not receipts.
    const pending = result("mw-aaaaaa", "a-2");
    notifications.markCollected(parent.ctx(), {
      ...pending,
      state: "running",
      terminal: false,
      waitTimedOut: true,
    });
    expect(notifications.isReported(parent.ctx(), "mw-aaaaaa", "a-2")).toBe(
      false,
    );

    parent.startRun();
    results.push(pending);
    await poll();
    expect(parent.followUps).toHaveLength(1);
    notifications.markCollected(parent.ctx(), pending);
    parent.endRun(false);

    const [duplicate] = parent.reports();
    expect(duplicate).toMatchObject({ assignmentId: "a-2", duplicate: true });
    const persisted = parent.entries.at(-1) as { content: string };
    expect(persisted.content).toContain("already delivered or collected");
    expect(persisted.content).not.toContain("result for a-2");
    expect(persisted.content).toContain(
      "Do not produce another user-facing reply",
    );
    expect(persisted.content).not.toContain("No action is needed");
    await poll(60_000);
    expect(parent.sent).toHaveLength(1);
  });

  test("merged steers are covered by their root report", async () => {
    const { parent, results, notifications } = setup();
    parent.start();
    results.push(result("mw-aaaaaa", "a-root", { mergedUpdates: ["a-steer"] }));
    await poll();
    expect(parent.sent[0]!.message.content).toContain(
      "Merged updates: a-steer",
    );
    expect(notifications.isReported(parent.ctx(), "mw-aaaaaa", "a-steer")).toBe(
      true,
    );

    // A manual wait on a merged steer counts for its root.
    notifications.markCollected(
      parent.ctx(),
      result("mw-bbbbbb", "a-other-steer", { mergedInto: "a-other" }),
    );
    expect(notifications.isReported(parent.ctx(), "mw-bbbbbb", "a-other")).toBe(
      true,
    );
  });

  test("a legacy manual wait result counts only from a subagent tool result", async () => {
    const parent = new FakeParent();
    const header = "mw-aaaaaa · a-1 · completed\ndone";
    parent.push({
      type: "message",
      message: { role: "user", content: [{ type: "text", text: header }] },
    });
    parent.push({
      type: "message",
      message: {
        role: "toolResult",
        toolName: "other",
        toolCallId: "c0",
        content: [{ type: "text", text: header }],
      },
    });
    const { results, notifications } = setup(parent);
    results.push(result("mw-aaaaaa", "a-1"));
    parent.start();
    expect(notifications.isReported(parent.ctx(), "mw-aaaaaa", "a-1")).toBe(
      false,
    );

    parent.push({
      type: "message",
      message: {
        role: "toolResult",
        toolName: "subagent",
        toolCallId: "c1",
        content: [{ type: "text", text: header }],
        details: { results: [] },
      },
    });
    parent.start();
    expect(notifications.isReported(parent.ctx(), "mw-aaaaaa", "a-1")).toBe(
      true,
    );
    await poll(60_000);
    expect(parent.sent).toHaveLength(0);
  });
});

describe("managed report formatting", () => {
  test("completion metadata is visible only when expanded", async () => {
    const { parent, results } = setup();
    parent.start();
    results.push(result("mw-aaaaaa", "a-1"));
    await poll();
    const render = parent.pi.registerMessageRenderer.mock.calls[0]?.[1];
    const message = parent.sent[0]?.message;
    if (!render || !message)
      throw new Error("Missing registered report renderer or message");
    // SAFETY: this renderer uses only these two theme helpers.
    const theme = {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    } as unknown as Theme;
    expect(
      render(message, { expanded: false, outputPad: 0 }, theme)?.render(240),
    ).toEqual([]);
    const expanded =
      render(message, { expanded: true, outputPad: 0 }, theme)
        ?.render(240)
        .join("\n") ?? "";
    expect(expanded).toContain("mw-aaaaaa · a-1 · completed");
    expect(expanded).toContain("Task: task for a-1");
    expect(expanded).toContain("result for a-1");
    expect(expanded).toContain("Transcript: /sessions/mw-aaaaaa.jsonl");
    expect(expanded).not.toContain("This is not a user message");
    expect(expanded).not.toContain("Present the worker's answer directly");
  });

  test("ten maximum-size results each keep identity and bounded output within 50KiB", () => {
    const results = Array.from({ length: 10 }, (_, index) =>
      result(`mw-worker${index}`, `a-${index}`, {
        preview: `preview-${index} ${"p".repeat(4_096)}`,
        outcome: {
          source: "yield",
          result: `unique-result-${index} ${"r".repeat(64 * 1024)}`,
          truncated: true,
          artifacts: Array.from(
            { length: 200 },
            (_, item) => `/artifacts/${index}/${"x".repeat(40)}-${item}.txt`,
          ),
        },
      }),
    );
    const workers = new Map(
      results.map((entry) => [entry.handle, worker(entry.handle)]),
    );
    const text = formatManagedReport(results, workers);

    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(50 * 1024);
    for (let index = 0; index < 10; index++) {
      expect(text).toContain(`mw-worker${index} · a-${index} · completed`);
      expect(text).toContain(`unique-result-${index}`);
    }
  });
});
