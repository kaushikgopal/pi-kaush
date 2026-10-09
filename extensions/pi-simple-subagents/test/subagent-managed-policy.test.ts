import { describe, expect, test } from "vitest";
import {
  attemptSessionId,
  classifyUnplannedExit,
  holdsForFallback,
  nextCandidateStep,
  transition,
  watchdogVerdict,
} from "../src/_managed-policy.ts";
import type {
  ChildAssignment,
  ChildStatus,
  ManagedConfig,
} from "../src/_managed-store.ts";
import { emptyUsage } from "../src/_usage.ts";

function config(overrides: Partial<ManagedConfig> = {}): ManagedConfig {
  return {
    v: 1,
    handle: "mw-abc123",
    parentSessionId: "parent",
    createdAt: 1,
    launch: {
      agent: { name: "c3po", source: "user" },
      modelCandidates: ["fake/a", "fake/b"],
      cwd: "/work",
      trace: {
        rootSessionId: "root",
        parentSessionId: "parent",
        parentToolCallId: "call-1",
        depth: 1,
      },
      isolation: {},
      taskPreview: "task",
    },
    lifecycle: "starting",
    candidateIndex: 0,
    sessionId: "mw-abc123",
    attempts: [],
    nextSeq: 2,
    lastAssignmentId: "a-1",
    updatedAt: 1,
    ...overrides,
  };
}

function assignment(overrides: Partial<ChildAssignment> = {}): ChildAssignment {
  return {
    id: "a-1",
    seq: 1,
    state: "running",
    disposition: "prompt",
    preview: "task",
    acceptedAt: 1_000,
    usage: emptyUsage(),
    toolActivity: false,
    startedAt: 1_000,
    ...overrides,
  };
}

function status(overrides: Partial<ChildStatus> = {}): ChildStatus {
  return {
    v: 1,
    bootId: "boot-1",
    sessionId: "mw-abc123",
    pid: 4242,
    state: "busy",
    ackedSeq: 1,
    queue: [],
    assignments: [assignment()],
    activeAssignmentId: "a-1",
    usage: emptyUsage(),
    toolActivity: false,
    updatedAt: 1_000,
    ...overrides,
  };
}

const placement = { kind: "rpc", pid: 4242 } as const;
const attempt = { candidateIndex: 0, sessionId: "mw-abc123", error: "bad" };

describe("transition", () => {
  test("started runs the worker at its placement and clears the last error", () => {
    const before = config({ lastError: "earlier failure" });
    const after = transition(before, { kind: "started", placement });
    expect(after).toMatchObject({ lifecycle: "running", placement });
    expect(after).not.toHaveProperty("lastError");
    expect(before.lifecycle).toBe("starting");
  });

  test("candidateAdvanced records the attempt and starts a new session", () => {
    const after = transition(config(), {
      kind: "candidateAdvanced",
      attempt,
    });
    expect(after).toMatchObject({
      attempts: [attempt],
      candidateIndex: 1,
      sessionId: "mw-abc123-m1",
      lifecycle: "starting",
    });
  });

  test("launchFailed records the attempt and the failure", () => {
    const after = transition(config(), {
      kind: "launchFailed",
      attempt,
      error: "did not start",
    });
    expect(after).toMatchObject({
      attempts: [attempt],
      candidateIndex: 0,
      lifecycle: "failed",
      lastError: "did not start",
    });
  });

  test("shutdown of a live worker always records the target lifecycle", () => {
    for (const lifecycle of ["stopped", "suspended", "starting"] as const)
      expect(
        transition(config({ lifecycle: "stopped" }), {
          kind: "shutdownRequested",
          lifecycle,
        }).lifecycle,
      ).toBe(lifecycle);
  });

  test("shutdown of an idle worker never revives a stopped one", () => {
    const stopped = config({ lifecycle: "stopped" });
    expect(
      transition(stopped, { kind: "shutdownIdle", lifecycle: "suspended" }),
    ).toBe(stopped);
    expect(
      transition(config({ lifecycle: "exited" }), {
        kind: "shutdownIdle",
        lifecycle: "suspended",
      }).lifecycle,
    ).toBe("suspended");
  });

  test("an unplanned exit only changes a running worker", () => {
    const running = config({ lifecycle: "running", lastError: "old" });
    expect(transition(running, { kind: "exitedUnplanned" })).toEqual({
      ...config({ lifecycle: "exited" }),
    });
    expect(
      transition(running, { kind: "exitedUnplanned", lastError: "crashed" }),
    ).toMatchObject({ lifecycle: "exited", lastError: "crashed" });
    const stopped = config({ lifecycle: "stopped" });
    expect(transition(stopped, { kind: "exitedUnplanned" })).toBe(stopped);
  });

  test("never touches the sequence or timestamps", () => {
    const before = config({ nextSeq: 7, updatedAt: 99 });
    const after = transition(before, { kind: "started", placement });
    expect(after).toMatchObject({ nextSeq: 7, updatedAt: 99 });
  });
});

describe("model candidates", () => {
  test("attempt sessions keep the handle for the first candidate", () => {
    expect(attemptSessionId("mw-x", 0)).toBe("mw-x");
    expect(attemptSessionId("mw-x", 2)).toBe("mw-x-m2");
  });

  test("only non-resume launches before the last candidate hold for fallback", () => {
    expect(holdsForFallback("initial", 0, 2)).toBe(true);
    expect(holdsForFallback("fallback", 0, 3)).toBe(true);
    expect(holdsForFallback("initial", 1, 2)).toBe(false);
    expect(holdsForFallback("resume", 0, 2)).toBe(false);
    expect(holdsForFallback("initial", 0, 0)).toBe(false);
  });

  test("advances only while nothing ran and another candidate remains", () => {
    const base = {
      launchKind: "initial",
      aborted: false,
      retryable: true,
      ran: false,
      candidateIndex: 0,
      candidateCount: 2,
    } as const;
    expect(nextCandidateStep(base)).toEqual({ kind: "advance" });
    expect(nextCandidateStep({ ...base, launchKind: "fallback" })).toEqual({
      kind: "advance",
    });
    for (const blocked of [
      { launchKind: "resume" as const },
      { aborted: true },
      { retryable: false },
      { ran: true },
      { candidateIndex: 1 },
    ])
      expect(nextCandidateStep({ ...base, ...blocked })).toEqual({
        kind: "stop",
      });
  });
});

describe("watchdogVerdict", () => {
  const limits = { maxRuntimeMs: 100, maxInactivityMs: 50 };

  test("is idle without a running active assignment", () => {
    const { activeAssignmentId: _none, ...between } = status();
    const { startedAt: _unstarted, ...accepted } = assignment();
    expect(watchdogVerdict(between, limits, 1e9, 0)).toEqual({ kind: "idle" });
    expect(
      watchdogVerdict(
        status({ assignments: [assignment({ state: "completed" })] }),
        limits,
        1e9,
        0,
      ),
    ).toEqual({ kind: "idle" });
    expect(
      watchdogVerdict(status({ assignments: [accepted] }), limits, 1e9, 0),
    ).toEqual({ kind: "idle" });
  });

  test("terminates past the runtime limit plus grace", () => {
    const fresh = status({ updatedAt: 1_120 });
    expect(watchdogVerdict(fresh, limits, 1_110, 10)).toEqual({
      kind: "running",
    });
    expect(watchdogVerdict(fresh, limits, 1_111, 10)).toEqual({
      kind: "terminate",
      reason:
        "Worker exceeded the 100 ms runtime limit and did not stop itself; the parent terminated it.",
    });
  });

  test("terminates past the inactivity limit plus grace, after the runtime check", () => {
    const quiet = status({ updatedAt: 1_000 });
    expect(
      watchdogVerdict(
        quiet,
        { maxRuntimeMs: 0, maxInactivityMs: 50 },
        1_061,
        10,
      ),
    ).toEqual({
      kind: "terminate",
      reason:
        "Worker exceeded the 50 ms inactivity limit and did not stop itself; the parent terminated it.",
    });
    expect(watchdogVerdict(quiet, limits, 1_200, 10)).toMatchObject({
      reason: expect.stringContaining("runtime limit"),
    });
  });

  test("zero limits never terminate", () => {
    expect(
      watchdogVerdict(
        status(),
        { maxRuntimeMs: 0, maxInactivityMs: 0 },
        1e12,
        0,
      ),
    ).toEqual({ kind: "running" });
  });
});

describe("classifyUnplannedExit", () => {
  const base = { bootId: "boot-1", sessionId: "mw-abc123" };

  test("a parent kill reason wins", () => {
    expect(
      classifyUnplannedExit({
        ...base,
        killReason: "runtime limit",
        status: status({ state: "exited" }),
      }),
    ).toEqual({ kind: "failed", reason: "runtime limit" });
  });

  test("an orderly exit of this boot and session is clean", () => {
    expect(
      classifyUnplannedExit({
        ...base,
        killReason: undefined,
        status: status({ state: "exited" }),
      }),
    ).toEqual({ kind: "clean" });
  });

  test("this boot's own error is the reason", () => {
    expect(
      classifyUnplannedExit({
        ...base,
        killReason: undefined,
        status: status({ state: "exited", lastError: "Parent gone" }),
      }),
    ).toEqual({ kind: "failed", reason: "Parent gone" });
  });

  test("anything else is a crash", () => {
    for (const current of [
      undefined,
      status({ state: "busy" }),
      status({ state: "exited", sessionId: "other" }),
      status({ state: "exited", bootId: "boot-0", lastError: "older boot" }),
    ])
      expect(
        classifyUnplannedExit({
          ...base,
          killReason: undefined,
          status: current,
        }),
      ).toEqual({ kind: "crashed" });
  });
});
