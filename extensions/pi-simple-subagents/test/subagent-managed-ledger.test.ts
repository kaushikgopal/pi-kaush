import { describe, expect, test } from "vitest";
import {
  AssignmentLedger,
  type LedgerRecord,
  settleRunOutcome,
} from "../src/_managed-ledger.ts";
import {
  type ChildAssignment,
  MANAGED_RESULT_PREVIEW_BYTES,
  MANAGED_STATUS_ASSIGNMENT_LIMIT,
} from "../src/_managed-protocol.ts";
import { emptyUsage } from "../src/_usage.ts";

function assignment(
  id: string,
  state: ChildAssignment["state"] = "accepted",
): ChildAssignment {
  return {
    id,
    seq: 1,
    state,
    disposition: "prompt",
    preview: `preview ${id}`,
    acceptedAt: 0,
    usage: emptyUsage(),
    toolActivity: false,
  };
}

function ledger(): { record: LedgerRecord; ledger: AssignmentLedger } {
  const record: LedgerRecord = { assignments: [], queue: [] };
  return { record, ledger: new AssignmentLedger(record) };
}

describe("assignment ledger", () => {
  test("finishing an assignment ends its merged steers and returns archive effects", () => {
    const { record, ledger: l } = ledger();
    const target = assignment("a1");
    const steer = assignment("a2");
    l.push(target);
    l.push(steer);
    l.markRunning(target, 10);
    l.merge(steer, "a1", 11);
    const outcome = { source: "yield" as const, result: "done" };
    const finished = l.finish("a1", "completed", outcome, 20);
    expect(finished.wasActive).toBe(true);
    expect(record.activeAssignmentId).toBeUndefined();
    expect(finished.effects.map((effect) => effect.assignment.id)).toEqual([
      "a1",
      "a2",
    ]);
    expect(steer).toMatchObject({
      state: "completed",
      outcome,
      endedAt: 20,
      mergedInto: "a1",
    });
    // Effects are snapshots: later mutation does not rewrite what gets archived.
    steer.preview = "changed";
    expect(finished.effects[1]?.assignment.preview).toBe("preview a2");
    // Finishing again is a no-op.
    expect(l.finish("a1", "failed", outcome, 30).effects).toEqual([]);
  });

  test("terminalizeAll interrupts started work, cancels the rest, and clears the queue", () => {
    const { record, ledger: l } = ledger();
    const running = assignment("a1");
    const queued = assignment("a2");
    const done = assignment("a3", "completed");
    for (const entry of [running, queued, done]) l.push(entry);
    l.markRunning(running, 1);
    l.enqueue(queued, "full text");
    const effects = l.terminalizeAll("Worker shut down", 5);
    expect(effects.map((effect) => effect.assignment.state)).toEqual([
      "interrupted",
      "cancelled",
    ]);
    expect(running.outcome?.result).toBe(
      "Worker shut down before this assignment finished; it was not replayed.",
    );
    expect(queued.outcome?.result).toBe(
      "Worker shut down before this assignment started; it was not delivered.",
    );
    expect(record).toMatchObject({ queue: [] });
    expect(record.activeAssignmentId).toBeUndefined();
    expect(l.takeNextQueued()).toBeUndefined();
  });

  test("restore cancels queued and interrupts started work from a previous boot", () => {
    const { record, ledger: l } = ledger();
    const effects = l.restore(
      [
        assignment("a1", "running"),
        assignment("a2"),
        assignment("a3", "failed"),
      ],
      7,
    );
    expect(record.assignments.map((entry) => entry.state)).toEqual([
      "interrupted",
      "cancelled",
      "failed",
    ]);
    expect(effects).toHaveLength(2);
  });

  test("the queue hands out full text and skips entries that ended meanwhile", () => {
    const { ledger: l } = ledger();
    const first = assignment("a1");
    const second = assignment("a2");
    l.push(first);
    l.push(second);
    l.enqueue(first, "full one");
    l.enqueue(second, "full two");
    l.terminate(first, "cancelled", { source: "lifecycle", result: "x" }, 1);
    expect(l.takeNextQueued()).toEqual({
      assignment: second,
      text: "full two",
    });
    expect(second.disposition).toBe("followUp");
    expect(l.takeNextQueued()).toBeUndefined();
  });

  test("trimming keeps the initial assignment and every unfinished one", () => {
    const { record, ledger: l } = ledger();
    l.push(assignment("initial", "failed"));
    for (let index = 1; index < MANAGED_STATUS_ASSIGNMENT_LIMIT; index++)
      l.push(assignment(`done-${index}`, "completed"));
    l.push(assignment("new"));
    expect(record.assignments).toHaveLength(MANAGED_STATUS_ASSIGNMENT_LIMIT);
    expect(l.isInitial("initial")).toBe(true);
    expect(l.find("done-1")).toBeUndefined();
    expect(l.find("new")).toBeDefined();
  });
});

describe("settleRunOutcome", () => {
  test("timeout wins over yield, yield over an error stop, error over text", () => {
    const yielded = { status: "blocked" as const, result: "need input" };
    expect(settleRunOutcome({ timedOut: "Timed out", yielded }, false)).toEqual(
      {
        state: "timedOut",
        outcome: { source: "lifecycle", result: "Timed out" },
        modelError: false,
      },
    );
    expect(
      settleRunOutcome({ yielded, stopReason: "error" }, false),
    ).toMatchObject({
      state: "blocked",
      outcome: { source: "yield", result: "need input" },
    });
    expect(
      settleRunOutcome({ stopReason: "error", lastText: "partial" }, false),
    ).toEqual({
      state: "failed",
      outcome: { source: "error", result: "partial" },
      modelError: true,
    });
    expect(settleRunOutcome({ stopReason: "error" }, true)).toMatchObject({
      outcome: { result: "Assistant stopped: error" },
      modelError: false,
    });
    expect(settleRunOutcome({ stopReason: "aborted" }, false)).toMatchObject({
      state: "aborted",
      modelError: false,
    });
    expect(settleRunOutcome({}, false)).toEqual({
      state: "completed",
      outcome: { source: "assistant", result: "(no output)" },
      modelError: false,
    });
  });

  test("bounds long results and marks them truncated", () => {
    const settled = settleRunOutcome(
      { lastText: "x".repeat(MANAGED_RESULT_PREVIEW_BYTES + 10) },
      false,
    );
    expect(settled.outcome).toMatchObject({ truncated: true });
    expect(settled.outcome.result).toHaveLength(MANAGED_RESULT_PREVIEW_BYTES);
  });
});
