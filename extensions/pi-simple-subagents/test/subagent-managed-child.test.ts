import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  type BridgeContext,
  ManagedChildBridge,
  type ManagedChildBridgeOptions,
  managedBridgeOptionsFromEnv,
} from "../src/_managed-child.ts";
import {
  managedPaths,
  readArchivedAssignment,
  readChildStatus,
  writeArchivedAssignment,
  writeInboxMessage,
  writeJsonAtomic,
  type ChildAssignment,
  type ManagedDelivery,
} from "../src/_managed-store.ts";

const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

const CONFIRM_MS = 1_000;
const GRACE_MS = 500;

interface Harness {
  bridge: ManagedChildBridge;
  sent: { text: string; steer: boolean }[];
  ctx: BridgeContext & {
    idle: boolean;
    pending: boolean;
    aborts: number;
    shutdowns: number;
  };
  clock: { now: number };
  dir: string;
  send: (seq: number, text: string, delivery?: ManagedDelivery) => void;
  shutdownMessage: (seq: number) => void;
  status: () => ReturnType<typeof readChildStatus>;
}

function harness(
  overrides: Partial<ManagedChildBridgeOptions> = {},
  dir = fs.mkdtempSync(path.join(tmpdir(), "managed-child-")),
  sessionId = "s-1",
): Harness {
  if (!roots.includes(dir)) roots.push(dir);
  const paths = managedPaths(dir);
  const sent: Harness["sent"] = [];
  const clock = { now: 1_000 };
  const ctx = {
    idle: true,
    pending: false,
    aborts: 0,
    shutdowns: 0,
    isIdle() {
      return ctx.idle;
    },
    abort() {
      ctx.aborts++;
    },
    shutdown() {
      ctx.shutdowns++;
    },
    hasPendingMessages() {
      return ctx.pending;
    },
    sessionId,
    sessionFile: path.join(dir, "session", `${sessionId}.jsonl`),
  };
  const bridge = new ManagedChildBridge({
    dir,
    bootId: "boot-1",
    pid: 4242,
    expectedSessionId: sessionId,
    resumeFloorSeq: 0,
    controlFloorSeq: 0,
    freshAttempt: false,
    holdOnInitialModelError: false,
    limits: { maxRuntimeMs: 0, maxInactivityMs: 0 },
    sendUserMessage: (text, delivery) =>
      sent.push({ text, steer: delivery?.deliverAs === "steer" }),
    now: () => clock.now,
    pollMs: 0,
    deliveryConfirmMs: CONFIRM_MS,
    settleGraceMs: GRACE_MS,
    ...overrides,
  });
  return {
    bridge,
    sent,
    ctx,
    clock,
    dir,
    send: (seq, text, delivery = "auto") =>
      writeInboxMessage(paths.inbox, {
        kind: "assignment",
        seq,
        id: `m${seq}`,
        assignmentId: `a${seq}`,
        delivery,
        text,
        createdAt: clock.now,
      }),
    shutdownMessage: (seq) =>
      writeInboxMessage(paths.inbox, {
        kind: "shutdown",
        seq,
        id: `m${seq}`,
        createdAt: clock.now,
      }),
    status: () => readChildStatus(paths.status),
  };
}

const assignmentOf = (h: Harness, id: string) =>
  h.status()?.assignments.find((entry) => entry.id === id);

const userMessage = (text: string) => ({
  role: "user",
  content: [{ type: "text", text }],
});

/** Pi echoes the prompt, validates it, then starts a run for it. */
function runPrompt(h: Harness, index = 0): void {
  const text = h.sent[index]!.text;
  h.bridge.onInput(text, "extension");
  h.ctx.idle = false;
  h.bridge.onBeforeAgentStart(text);
  h.bridge.onMessageStart(userMessage(text));
}

function yieldResult(h: Harness, result: string): void {
  h.bridge.onToolStart("yield");
  h.bridge.onMessageEnd({
    role: "toolResult",
    toolName: "yield",
    details: { status: "completed", result },
  });
}

function settle(h: Harness): void {
  h.ctx.idle = true;
  h.bridge.onSettled();
}

/** Advances past the grace window with two polls so "quiet since" timers elapse. */
function pollThroughGrace(h: Harness): void {
  h.bridge.poll();
  h.clock.now += GRACE_MS + 1;
  h.bridge.poll();
}

describe("managed child bridge delivery", () => {
  test("an input echo is not delivery; the run start marks the prompt running", () => {
    const h = harness();
    h.send(1, "task one");
    h.bridge.start(h.ctx);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.text).toContain("[Managed assignment a1]\ntask one");
    expect(assignmentOf(h, "a1")?.state).toBe("delivering");

    h.bridge.onInput(h.sent[0]!.text, "extension");
    expect(assignmentOf(h, "a1")?.state).toBe("delivering");
    h.ctx.idle = false;
    h.bridge.onBeforeAgentStart(h.sent[0]!.text);
    expect(assignmentOf(h, "a1")?.state).toBe("running");
    expect(h.status()?.ackedSeq).toBe(1);
  });

  test("an echo with no run start fails after the deadline instead of running forever", () => {
    const h = harness();
    h.send(1, "task");
    h.bridge.start(h.ctx);
    h.bridge.onInput(h.sent[0]!.text, "extension");
    h.clock.now += CONFIRM_MS - 1;
    h.bridge.poll();
    expect(assignmentOf(h, "a1")?.state).toBe("delivering");
    h.clock.now += 2;
    h.bridge.poll();
    expect(assignmentOf(h, "a1")).toMatchObject({
      state: "failed",
      modelError: true,
      outcome: { source: "error" },
    });
    expect(assignmentOf(h, "a1")?.outcome?.result).toContain(
      "did not start this assignment",
    );
    expect(h.status()?.state).toBe("idle");
  });

  test("a validation failure before the run holds the worker for model fallback", () => {
    const h = harness({ holdOnInitialModelError: true });
    h.send(1, "task");
    h.send(2, "later", "followUp");
    h.bridge.start(h.ctx);
    // Pi echoes, then rejects the prompt (no model or credentials): no run starts.
    h.bridge.onInput(h.sent[0]!.text, "extension");
    h.clock.now += CONFIRM_MS + 1;
    h.bridge.poll();
    expect(h.status()?.state).toBe("held");
    expect(assignmentOf(h, "a1")).toMatchObject({
      state: "failed",
      modelError: true,
    });
    expect(h.sent).toHaveLength(1);

    // A late run start for the expired prompt is aborted, never tracked.
    h.ctx.idle = false;
    h.bridge.onBeforeAgentStart(h.sent[0]!.text);
    expect(h.ctx.aborts).toBe(1);
    expect(assignmentOf(h, "a1")?.state).toBe("failed");
  });

  test("a prompt transformed by another extension is still recognized as started", () => {
    const h = harness();
    h.send(1, "task");
    h.bridge.start(h.ctx);
    h.bridge.onInput(h.sent[0]!.text, "extension");
    h.ctx.idle = false;
    h.bridge.onBeforeAgentStart("rewritten prompt without the marker");
    expect(assignmentOf(h, "a1")?.state).toBe("running");
  });

  test("an unmarked run after someone else's input is not taken for the prompt", () => {
    const h = harness();
    h.send(1, "task");
    h.bridge.start(h.ctx);
    h.bridge.onInput(h.sent[0]!.text, "extension");
    h.bridge.onInput("typed by a person", "interactive");
    h.ctx.idle = false;
    h.bridge.onBeforeAgentStart("typed by a person");
    expect(assignmentOf(h, "a1")?.state).toBe("delivering");
    // The queued prompt starts later in the same run via its tagged message.
    h.bridge.onMessageStart(userMessage(h.sent[0]!.text));
    expect(assignmentOf(h, "a1")?.state).toBe("running");
  });

  test("a prompt queued behind a busy run does not expire while it waits", () => {
    const h = harness();
    h.send(1, "task");
    h.bridge.start(h.ctx);
    h.ctx.idle = false; // a run began between delivery and the echo
    h.bridge.onInput(h.sent[0]!.text, "extension");
    h.ctx.pending = true;
    h.clock.now += CONFIRM_MS * 5;
    h.bridge.poll();
    expect(assignmentOf(h, "a1")?.state).toBe("delivering");
    h.bridge.onMessageStart(userMessage(h.sent[0]!.text));
    expect(assignmentOf(h, "a1")?.state).toBe("running");
  });

  test("a synchronous send error fails the assignment and the next one still runs", () => {
    let calls = 0;
    const h = harness({
      sendUserMessage: () => {
        calls++;
        if (calls === 1) throw new Error("not ready");
      },
    });
    h.send(1, "first");
    h.send(2, "second", "followUp");
    h.bridge.start(h.ctx);
    expect(assignmentOf(h, "a1")).toMatchObject({
      state: "failed",
      outcome: { source: "error" },
    });
    expect(assignmentOf(h, "a2")?.state).toBe("delivering");
  });

  test("yield wins over assistant text, and assistant text is the fallback", () => {
    const h = harness();
    h.send(1, "one");
    h.bridge.start(h.ctx);
    runPrompt(h);
    h.bridge.onMessageEnd({
      role: "assistant",
      content: [{ type: "text", text: "thinking out loud" }],
    });
    h.bridge.onMessageEnd({
      role: "toolResult",
      toolName: "yield",
      details: {
        status: "blocked",
        result: "need access",
        artifacts: ["/tmp/a"],
      },
    });
    settle(h);
    expect(assignmentOf(h, "a1")).toMatchObject({
      state: "blocked",
      outcome: {
        source: "yield",
        result: "need access",
        artifacts: ["/tmp/a"],
      },
    });

    h.send(2, "two");
    h.bridge.poll();
    runPrompt(h, 1);
    h.bridge.onMessageEnd({
      role: "assistant",
      content: [{ type: "text", text: "plain answer" }],
    });
    settle(h);
    expect(assignmentOf(h, "a2")).toMatchObject({
      state: "completed",
      outcome: { source: "assistant", result: "plain answer" },
    });
    expect(h.status()?.state).toBe("idle");
  });

  test("interactive runs hold parent messages until they settle", () => {
    const h = harness();
    h.bridge.start(h.ctx);
    h.ctx.idle = false; // user typed in the native TUI
    h.bridge.onBeforeAgentStart("hello");
    expect(h.status()?.state).toBe("busy");
    h.send(1, "parent task");
    h.bridge.poll();
    expect(h.sent).toEqual([]);
    expect(assignmentOf(h, "a1")).toMatchObject({
      state: "accepted",
      disposition: "followUp",
    });
    settle(h);
    expect(assignmentOf(h, "a1")?.state).toBe("delivering");
  });
});

describe("managed child assignment archives", () => {
  test("archives a completed yield with its usage and artifacts", () => {
    const h = harness();
    h.send(1, "archive this result");
    h.bridge.start(h.ctx);
    runPrompt(h);
    h.bridge.onMessageEnd({
      role: "assistant",
      content: [{ type: "text", text: "working" }],
      usage: {
        input: 23,
        output: 7,
        cacheRead: 2,
        cacheWrite: 3,
        totalTokens: 30,
        cost: { total: 0.42 },
      },
      provider: "fake",
      model: "model-a",
    });
    h.bridge.onToolStart("yield");
    h.bridge.onMessageEnd({
      role: "toolResult",
      toolName: "yield",
      details: {
        status: "completed",
        result: "durable result",
        artifacts: ["/tmp/report.md"],
      },
    });
    settle(h);

    expect(readArchivedAssignment(h.dir, "s-1", "a1")).toMatchObject({
      id: "a1",
      state: "completed",
      model: "fake/model-a",
      outcome: {
        source: "yield",
        result: "durable result",
        artifacts: ["/tmp/report.md"],
      },
      usage: {
        input: 23,
        output: 7,
        cacheRead: 2,
        cacheWrite: 3,
        cost: 0.42,
        turns: 1,
        contextTokens: 30,
      },
    });
  });

  test("hashes safe archive paths and isolates the same assignment across model sessions", () => {
    const dir = fs.mkdtempSync(path.join(tmpdir(), "managed-archive-"));
    roots.push(dir);
    const id = "../same-assignment";
    const makeAssignment = (
      model: string,
      result: string,
    ): ChildAssignment => ({
      id,
      seq: 1,
      state: "completed",
      disposition: "prompt",
      preview: "task",
      acceptedAt: 1,
      endedAt: 2,
      outcome: { source: "yield", result },
      usage: {
        input: 1,
        output: 2,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0.1,
        turns: 1,
        contextTokens: 3,
      },
      toolActivity: false,
      model,
    });
    const firstSession = "attempt-0/model-a";
    const secondSession = "attempt-1/model-b";
    const first = makeAssignment("fake/model-a", "first attempt result");
    const second = makeAssignment("fake/model-b", "second attempt result");
    writeArchivedAssignment(dir, firstSession, first);
    writeArchivedAssignment(dir, secondSession, second);

    const firstName =
      createHash("sha256").update(`${firstSession}:${id}`).digest("hex") +
      ".json";
    const secondName =
      createHash("sha256").update(`${secondSession}:${id}`).digest("hex") +
      ".json";
    const archiveDir = path.join(dir, "assignments");
    expect(fs.readdirSync(archiveDir).sort()).toEqual(
      [firstName, secondName].sort(),
    );
    expect(
      fs
        .readdirSync(archiveDir)
        .every((name) => /^[a-f0-9]{64}\.json$/.test(name)),
    ).toBe(true);
    expect(readArchivedAssignment(dir, firstSession, id)).toMatchObject({
      model: "fake/model-a",
      outcome: { result: "first attempt result" },
    });
    expect(readArchivedAssignment(dir, secondSession, id)).toMatchObject({
      model: "fake/model-b",
      outcome: { result: "second attempt result" },
    });
    expect(
      readArchivedAssignment(dir, "another-model-attempt", id),
    ).toBeUndefined();
  });

  test("a nonterminal archive is not returned as a completed result", () => {
    const dir = fs.mkdtempSync(path.join(tmpdir(), "managed-archive-"));
    roots.push(dir);
    writeArchivedAssignment(dir, "session", {
      id: "unfinished",
      seq: 1,
      state: "running",
      disposition: "prompt",
      preview: "task",
      acceptedAt: 1,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        turns: 0,
        contextTokens: 0,
      },
      toolActivity: false,
    });
    expect(
      readArchivedAssignment(dir, "session", "unfinished"),
    ).toBeUndefined();
  });
});

describe("managed child bridge steering", () => {
  test("a steer merges only once the model receives its tagged message", () => {
    const h = harness();
    h.send(1, "main");
    h.bridge.start(h.ctx);
    runPrompt(h);
    h.send(2, "tweak");
    h.bridge.poll();
    expect(h.sent[1]).toMatchObject({ steer: true });
    expect(h.sent[1]!.text).toContain("[Update for managed assignment a1]");
    expect(assignmentOf(h, "a2")).toMatchObject({
      state: "delivering",
      disposition: "steer",
    });
    expect(assignmentOf(h, "a2")?.mergedInto).toBeUndefined();

    h.bridge.onMessageStart(userMessage(h.sent[1]!.text));
    expect(assignmentOf(h, "a2")).toMatchObject({
      state: "running",
      mergedInto: "a1",
    });
    yieldResult(h, "r");
    settle(h);
    expect(assignmentOf(h, "a2")).toMatchObject({
      state: "completed",
      mergedInto: "a1",
      outcome: { result: "r" },
    });
  });

  test("a steer the model receives after the target yielded becomes its own assignment", () => {
    const h = harness();
    h.send(1, "main");
    h.bridge.start(h.ctx);
    runPrompt(h);
    h.send(2, "tweak");
    h.bridge.poll();
    yieldResult(h, "main done");
    // Pi polls steering after the yield turn; the steer starts a new segment.
    h.bridge.onMessageStart(userMessage(h.sent[1]!.text));
    expect(assignmentOf(h, "a1")).toMatchObject({
      state: "completed",
      outcome: { result: "main done" },
    });
    expect(assignmentOf(h, "a2")).toMatchObject({ state: "running" });
    expect(assignmentOf(h, "a2")?.mergedInto).toBeUndefined();
    expect(h.status()?.activeAssignmentId).toBe("a2");

    h.bridge.onMessageEnd({
      role: "assistant",
      content: [{ type: "text", text: "tweak applied" }],
    });
    settle(h);
    expect(assignmentOf(h, "a2")).toMatchObject({
      state: "completed",
      outcome: { source: "assistant", result: "tweak applied" },
    });
    expect(h.sent).toHaveLength(2);
  });

  test("a steer Pi never consumed is reported only once its queue is empty, never re-sent", () => {
    const h = harness();
    h.send(1, "main");
    h.bridge.start(h.ctx);
    runPrompt(h);
    h.send(2, "tweak");
    h.bridge.poll();
    yieldResult(h, "done");
    settle(h);
    expect(assignmentOf(h, "a1")?.state).toBe("completed");

    // Still queued inside Pi: unknown fate, so it stays pending.
    h.ctx.pending = true;
    pollThroughGrace(h);
    expect(assignmentOf(h, "a2")?.state).toBe("delivering");

    h.ctx.pending = false;
    pollThroughGrace(h);
    expect(assignmentOf(h, "a2")).toMatchObject({
      state: "cancelled",
      outcome: { source: "lifecycle" },
    });
    expect(assignmentOf(h, "a2")?.outcome?.result).toContain("not re-sent");
    expect(h.sent).toHaveLength(2);
  });

  test("steers and follow-ups keep their order and every message reaches a final state", () => {
    const h = harness();
    h.send(1, "main");
    h.bridge.start(h.ctx);
    runPrompt(h);
    h.send(2, "steer one");
    h.send(3, "follow up", "followUp");
    h.send(4, "steer two");
    h.bridge.poll();
    expect(h.sent.map((entry) => entry.steer)).toEqual([false, true, true]);
    expect(assignmentOf(h, "a3")).toMatchObject({
      state: "accepted",
      disposition: "followUp",
    });

    h.bridge.onMessageStart(userMessage(h.sent[1]!.text));
    yieldResult(h, "main result");
    h.bridge.onMessageStart(userMessage(h.sent[2]!.text));
    h.bridge.onMessageEnd({
      role: "assistant",
      content: [{ type: "text", text: "second steer handled" }],
    });
    settle(h);
    expect(assignmentOf(h, "a2")).toMatchObject({
      state: "completed",
      mergedInto: "a1",
      outcome: { result: "main result" },
    });
    expect(assignmentOf(h, "a4")).toMatchObject({
      state: "completed",
      outcome: { result: "second steer handled" },
    });

    // The follow-up is delivered only after both steers were accounted for.
    expect(h.sent).toHaveLength(4);
    expect(h.sent[3]!.text).toContain("[Managed assignment a3]");
    runPrompt(h, 3);
    yieldResult(h, "follow result");
    settle(h);
    expect(assignmentOf(h, "a3")).toMatchObject({
      state: "completed",
      outcome: { result: "follow result" },
    });
    expect(h.status()?.state).toBe("idle");
  });
});

describe("managed child bridge recovery", () => {
  test.each(["missing", "wrong"] as const)(
    "keeps the first assignment unread until %s activation is replaced by this boot",
    (initialActivation) => {
      const h = harness({ waitForActivation: true });
      h.send(1, "first task");
      const activation = managedPaths(h.dir).activation;
      if (initialActivation === "wrong")
        writeJsonAtomic(activation, { bootId: "boot-other" });
      h.bridge.start(h.ctx);

      expect(h.status()).toMatchObject({
        state: "idle",
        ackedSeq: 0,
        assignments: [],
      });
      expect(h.sent).toEqual([]);

      writeJsonAtomic(activation, { bootId: "boot-1" });
      h.bridge.poll();
      expect(h.status()?.ackedSeq).toBe(1);
      expect(assignmentOf(h, "a1")?.state).toBe("delivering");
      expect(h.sent).toHaveLength(1);

      h.bridge.poll();
      expect(h.sent).toHaveLength(1);
    },
  );

  test("a ready marker from an earlier boot does not release a restarted child", () => {
    const first = harness({ waitForActivation: true });
    first.send(1, "first task");
    first.bridge.start(first.ctx);
    writeJsonAtomic(managedPaths(first.dir).activation, { bootId: "boot-1" });
    first.bridge.dispose();

    const retry = harness(
      { bootId: "boot-2", waitForActivation: true },
      first.dir,
    );
    retry.bridge.start(retry.ctx);
    expect(retry.status()).toMatchObject({
      bootId: "boot-2",
      state: "idle",
      ackedSeq: 0,
      assignments: [],
    });
    expect(retry.sent).toEqual([]);

    writeJsonAtomic(managedPaths(retry.dir).activation, { bootId: "boot-2" });
    retry.bridge.poll();
    retry.bridge.poll();
    expect(retry.sent).toHaveLength(1);
    expect(retry.status()?.ackedSeq).toBe(1);
  });

  test("honors shutdown before activation without consuming assignments", () => {
    const h = harness({ waitForActivation: true });
    h.send(1, "do not deliver");
    h.shutdownMessage(2);
    h.bridge.start(h.ctx);

    expect(h.sent).toEqual([]);
    expect(h.status()).toMatchObject({
      state: "stopping",
      ackedSeq: 0,
      assignments: [],
    });
    expect(h.ctx.shutdowns).toBe(1);
  });

  test("an abort that never settles does not leave the worker busy", async () => {
    const h = harness({ limits: { maxRuntimeMs: 10, maxInactivityMs: 0 } });
    h.send(1, "slow");
    h.send(2, "next", "followUp");
    h.bridge.start(h.ctx);
    runPrompt(h);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(h.ctx.aborts).toBe(1);
    // Pi stopped, but agent_settled never arrives.
    h.ctx.idle = true;
    pollThroughGrace(h);
    expect(assignmentOf(h, "a1")).toMatchObject({
      state: "timedOut",
      outcome: { source: "lifecycle" },
    });
    expect(assignmentOf(h, "a2")?.state).toBe("delivering");
    h.bridge.dispose();
  });

  test("an untracked run that never settles releases the worker after the grace window", () => {
    const h = harness();
    h.bridge.start(h.ctx);
    h.ctx.idle = false;
    h.bridge.onBeforeAgentStart("typed");
    h.send(1, "parent task");
    h.bridge.poll();
    h.ctx.idle = true;
    pollThroughGrace(h);
    expect(assignmentOf(h, "a1")?.state).toBe("delivering");
  });

  test("streaming activity refreshes inactivity without writing status per delta", async () => {
    vi.useFakeTimers();
    const h = harness({ limits: { maxRuntimeMs: 0, maxInactivityMs: 100 } });
    h.send(1, "streaming task");
    h.bridge.start(h.ctx);
    runPrompt(h);

    const startedAt = h.status()?.updatedAt;
    h.clock.now += 49;
    h.bridge.onActivity();
    expect(h.status()?.updatedAt).toBe(startedAt);

    h.clock.now += 1;
    h.bridge.onActivity();
    expect(h.status()?.updatedAt).toBe(startedAt! + 50);
    const firstHeartbeat = h.status()?.updatedAt;
    h.clock.now += 10;
    h.bridge.onActivity();
    expect(h.status()?.updatedAt).toBe(firstHeartbeat);

    for (let index = 0; index < 4; index++) {
      await vi.advanceTimersByTimeAsync(90);
      h.clock.now += 50;
      h.bridge.onActivity();
    }

    expect(h.ctx.aborts).toBe(0);
    expect(assignmentOf(h, "a1")?.state).toBe("running");
    expect(h.status()?.updatedAt).toBeGreaterThan(firstHeartbeat!);
    h.bridge.dispose();
  });

  test("restart interrupts unfinished work and the resume floor prevents replay", () => {
    const first = harness();
    first.send(1, "running");
    first.send(2, "queued", "followUp");
    first.bridge.start(first.ctx);
    runPrompt(first);
    first.bridge.dispose();

    first.send(3, "sent while down");
    const second = harness(
      { bootId: "boot-2", resumeFloorSeq: 3, controlFloorSeq: 3 },
      first.dir,
    );
    second.bridge.start(second.ctx);
    expect(second.sent).toEqual([]);
    expect(assignmentOf(second, "a1")?.state).toBe("interrupted");
    expect(assignmentOf(second, "a2")?.state).toBe("cancelled");
    expect(assignmentOf(second, "a3")?.state).toBe("cancelled");
    expect(second.status()).toMatchObject({
      ackedSeq: 3,
      state: "idle",
      bootId: "boot-2",
    });
  });

  test("a disposed bridge never overwrites the status of its replacement", () => {
    const first = harness();
    first.send(1, "running");
    first.bridge.start(first.ctx);
    runPrompt(first);
    first.bridge.dispose();
    const second = harness({ bootId: "boot-2", resumeFloorSeq: 1 }, first.dir);
    second.bridge.start(second.ctx);
    // Late events still reach the old instance, as during a reload.
    first.bridge.onMessageEnd({
      role: "assistant",
      content: [{ type: "text", text: "late" }],
    });
    settle(first);
    expect(second.status()).toMatchObject({ bootId: "boot-2", state: "idle" });
  });

  test("a fresh model attempt waits for its new boot activation and ignores stale shutdowns", () => {
    const first = harness({
      holdOnInitialModelError: true,
      waitForActivation: true,
    });
    first.send(1, "task");
    first.bridge.start(first.ctx);
    writeJsonAtomic(managedPaths(first.dir).activation, { bootId: "boot-1" });
    first.bridge.poll();
    runPrompt(first);
    first.bridge.onMessageEnd({
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: "429",
    });
    settle(first);
    expect(first.status()?.state).toBe("held");
    first.send(2, "later");
    first.bridge.poll();
    expect(first.status()?.ackedSeq).toBe(1);

    first.shutdownMessage(3);
    first.bridge.poll();
    expect(first.ctx.shutdowns).toBe(1);
    first.bridge.dispose();

    const retry = harness(
      {
        bootId: "boot-2",
        freshAttempt: true,
        controlFloorSeq: 3,
        waitForActivation: true,
      },
      first.dir,
      "s-1-m1",
    );
    retry.bridge.start(retry.ctx);
    expect(retry.ctx.shutdowns).toBe(0);
    expect(retry.sent).toEqual([]);
    expect(retry.status()).toMatchObject({ state: "idle", ackedSeq: 0 });

    writeJsonAtomic(managedPaths(retry.dir).activation, { bootId: "boot-2" });
    retry.bridge.poll();
    expect(retry.sent).toHaveLength(1);
    expect(retry.sent[0]!.text).toContain("[Managed assignment a1]");
    expect(assignmentOf(retry, "a2")).toMatchObject({
      state: "accepted",
      disposition: "followUp",
    });
  });

  test("watchdog aborts only the active assignment and records a timeout", async () => {
    const h = harness({ limits: { maxRuntimeMs: 10, maxInactivityMs: 0 } });
    h.bridge.start(h.ctx);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(h.ctx.aborts).toBe(0);
    h.send(1, "slow");
    h.bridge.poll();
    runPrompt(h);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(h.ctx.aborts).toBe(1);
    h.bridge.onMessageEnd({
      role: "assistant",
      content: [],
      stopReason: "aborted",
    });
    settle(h);
    expect(assignmentOf(h, "a1")).toMatchObject({
      state: "timedOut",
      outcome: { source: "lifecycle" },
    });
    h.bridge.dispose();
  });

  test("tracks usage, model, and tool activity per assignment", () => {
    const h = harness();
    h.send(1, "work");
    h.bridge.start(h.ctx);
    runPrompt(h);
    h.bridge.onToolStart("bash");
    h.bridge.onMessageEnd({
      role: "assistant",
      provider: "openai",
      model: "gpt",
      content: [{ type: "text", text: "x" }],
      usage: {
        input: 3,
        output: 4,
        cacheRead: 1,
        cacheWrite: 0,
        totalTokens: 8,
        cost: { total: 0.5 },
      },
    });
    expect(assignmentOf(h, "a1")).toMatchObject({
      toolActivity: true,
      model: "openai/gpt",
      usage: {
        input: 3,
        output: 4,
        cacheRead: 1,
        cost: 0.5,
        turns: 1,
        contextTokens: 8,
      },
    });
    expect(h.status()).toMatchObject({
      toolActivity: true,
      model: "openai/gpt",
    });
  });
});

describe("managed child bridge shutdown and session safety", () => {
  test("a dead parent aborts the run, shuts down, and force-exits if shutdown stalls", () => {
    vi.useFakeTimers();
    let forced = 0;
    const alive = { parent: true };
    const h = harness({
      parentPid: 99,
      isPidAlive: () => alive.parent,
      forceExit: () => forced++,
    });
    h.send(1, "work");
    h.bridge.start(h.ctx);
    runPrompt(h);
    h.bridge.checkParent();
    expect(h.ctx.shutdowns).toBe(0);

    alive.parent = false;
    h.bridge.checkParent();
    expect(h.ctx.aborts).toBe(1);
    expect(h.ctx.shutdowns).toBe(1);
    expect(h.status()).toMatchObject({ state: "stopping" });
    expect(h.status()?.lastError).toContain("Parent Pi process exited");
    h.bridge.checkParent();
    expect(h.ctx.shutdowns).toBe(1);

    vi.advanceTimersByTime(15_000);
    expect(forced).toBe(1);
  });

  test("a shutdown message interrupts started work and records final states", () => {
    const h = harness();
    h.send(1, "work");
    h.send(2, "queued", "followUp");
    h.bridge.start(h.ctx);
    runPrompt(h);
    h.shutdownMessage(3);
    h.bridge.poll();
    expect(h.ctx.aborts).toBe(1);
    expect(h.ctx.shutdowns).toBe(1);
    h.bridge.onShutdown();
    expect(h.status()).toMatchObject({ state: "exited" });
    expect(assignmentOf(h, "a1")?.state).toBe("interrupted");
    expect(assignmentOf(h, "a2")?.state).toBe("cancelled");
  });

  test("a replaced session stops consuming the inbox and shuts down with an error", () => {
    const first = harness();
    first.send(1, "work");
    first.bridge.start(first.ctx);
    runPrompt(first);
    first.bridge.onShutdown("new");
    expect(first.status()?.lastError).toContain("/new");
    expect(assignmentOf(first, "a1")?.state).toBe("interrupted");

    // Pi re-creates the extension in the new session.
    first.send(2, "after new");
    const second = harness({ expectedSessionId: "s-1" }, first.dir, "s-other");
    second.bridge.start(second.ctx);
    expect(second.sent).toEqual([]);
    expect(second.ctx.aborts).toBe(1);
    expect(second.ctx.shutdowns).toBe(1);
    expect(second.status()).toMatchObject({
      state: "stopping",
      sessionId: "s-1",
      ackedSeq: 1,
    });
    expect(second.status()?.lastError).toContain("s-other");
    second.bridge.poll();
    second.bridge.onBeforeAgentStart("anything");
    expect(second.status()?.ackedSeq).toBe(1);
  });
});

describe("managed child bridge environment", () => {
  const full = {
    PI_MANAGED_SUBAGENT_DIR: "/d",
    PI_MANAGED_SUBAGENT_BOOT_ID: "b",
    PI_MANAGED_SUBAGENT_PARENT_PID: "12",
    PI_MANAGED_SUBAGENT_RESUME_FLOOR: "4",
    PI_MANAGED_SUBAGENT_CONTROL_FLOOR: "5",
    PI_MANAGED_SUBAGENT_FRESH_ATTEMPT: "1",
    PI_MANAGED_SUBAGENT_HOLD_ON_MODEL_ERROR: "1",
    PI_MANAGED_SUBAGENT_MAX_RUNTIME_MS: "100",
    PI_MANAGED_SUBAGENT_MAX_INACTIVITY_MS: "0",
    PI_MANAGED_SUBAGENT_SESSION_ID: "mw-1",
  };

  test("reads its configuration from the managed environment", () => {
    expect(managedBridgeOptionsFromEnv({}, () => {})).toBeUndefined();
    expect(managedBridgeOptionsFromEnv(full, () => {})).toMatchObject({
      dir: "/d",
      bootId: "b",
      parentPid: 12,
      expectedSessionId: "mw-1",
      resumeFloorSeq: 4,
      controlFloorSeq: 5,
      freshAttempt: true,
      holdOnInitialModelError: true,
      limits: { maxRuntimeMs: 100, maxInactivityMs: 0 },
    });
  });

  test("a partial or malformed managed environment fails loudly", () => {
    expect(() =>
      managedBridgeOptionsFromEnv(
        { PI_MANAGED_SUBAGENT_DIR: "/d", PI_MANAGED_SUBAGENT_BOOT_ID: "b" },
        () => {},
      ),
    ).toThrow(/incomplete: missing PI_MANAGED_SUBAGENT_PARENT_PID/);
    expect(() =>
      managedBridgeOptionsFromEnv(
        { ...full, PI_MANAGED_SUBAGENT_MAX_INACTIVITY_MS: "junk" },
        () => {},
      ),
    ).toThrow(/MAX_INACTIVITY_MS must be a non-negative integer/);
    expect(() =>
      managedBridgeOptionsFromEnv(
        { ...full, PI_MANAGED_SUBAGENT_FRESH_ATTEMPT: "yes" },
        () => {},
      ),
    ).toThrow(/FRESH_ATTEMPT must be 0 or 1/);
  });
});
