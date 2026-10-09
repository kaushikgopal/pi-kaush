/**
 * Assignment bookkeeping for the managed child bridge, without I/O. The ledger
 * owns the assignment list, the follow-up queue, and the active assignment id
 * inside the bridge's status record. Time arrives as data, and every operation
 * that ends an assignment returns archive effects for the bridge to persist.
 */
import {
  type ChildAssignment,
  type ChildStatus,
  isTerminalAssignmentState,
  MANAGED_RESULT_PREVIEW_BYTES,
  MANAGED_STATUS_ASSIGNMENT_LIMIT,
  type ManagedOutcome,
  type TerminalAssignmentState,
} from "./_managed-protocol.ts";
import { truncateUtf8Head } from "./_text.ts";
import type { SubagentYieldDetails } from "./_yield.ts";

/** A terminal assignment snapshot the shell writes to `assignments/*.json`. */
export interface ArchiveEffect {
  readonly kind: "archive";
  readonly assignment: ChildAssignment;
}

export type LedgerRecord = Pick<
  ChildStatus,
  "assignments" | "queue" | "activeAssignmentId"
>;

export class AssignmentLedger {
  /** Full parent-authored text of queued follow-ups; previews are capped. */
  private readonly queuedText = new Map<string, string>();

  constructor(private readonly record: LedgerRecord) {}

  get activeId(): string | undefined {
    return this.record.activeAssignmentId;
  }

  get all(): readonly ChildAssignment[] {
    return this.record.assignments;
  }

  find(id: string): ChildAssignment | undefined {
    return this.record.assignments.find((entry) => entry.id === id);
  }

  active(): ChildAssignment | undefined {
    const id = this.record.activeAssignmentId;
    return id ? this.find(id) : undefined;
  }

  /** The first assignment decides the model-fallback policy, so trimming keeps it. */
  isInitial(id: string): boolean {
    return this.record.assignments[0]?.id === id;
  }

  push(assignment: ChildAssignment): void {
    this.record.assignments.push(assignment);
    const overflow =
      this.record.assignments.length - MANAGED_STATUS_ASSIGNMENT_LIMIT;
    if (overflow <= 0) return;
    // Keep the initial assignment (fallback policy) and drop the oldest terminal ones.
    let remaining = overflow;
    this.record.assignments = this.record.assignments.filter((entry, index) => {
      if (
        remaining === 0 ||
        index === 0 ||
        !isTerminalAssignmentState(entry.state)
      )
        return true;
      remaining--;
      return false;
    });
  }

  /**
   * Adopts a previous boot's assignments. Nothing is replayed: started work is
   * interrupted and queued work cancelled.
   */
  restore(
    previous: readonly ChildAssignment[],
    now: number,
  ): readonly ArchiveEffect[] {
    const effects: ArchiveEffect[] = [];
    this.record.assignments = previous.map((assignment) => {
      if (isTerminalAssignmentState(assignment.state)) return assignment;
      const queued = assignment.state === "accepted";
      effects.push(
        terminate(assignment, queued ? "cancelled" : "interrupted", now, {
          source: "lifecycle",
          result: queued
            ? "Worker restarted before this queued assignment started; it was not delivered."
            : "Worker restarted before this assignment finished; it was not replayed.",
        }),
      );
      return assignment;
    });
    return effects;
  }

  terminate(
    assignment: ChildAssignment,
    state: TerminalAssignmentState,
    outcome: ManagedOutcome,
    now: number,
  ): ArchiveEffect {
    return terminate(assignment, state, now, outcome);
  }

  enqueue(assignment: ChildAssignment, text: string): void {
    assignment.disposition = "followUp";
    this.record.queue.push(assignment.id);
    this.queuedText.set(assignment.id, text);
  }

  /** Next queued follow-up still waiting to start; entries that ended meanwhile are skipped. */
  takeNextQueued(): { assignment: ChildAssignment; text: string } | undefined {
    for (;;) {
      const id = this.record.queue.shift();
      if (id === undefined) return undefined;
      const text = this.queuedText.get(id);
      this.queuedText.delete(id);
      const next = this.find(id);
      if (next?.state === "accepted")
        return { assignment: next, text: text ?? next.preview };
    }
  }

  markDelivering(assignment: ChildAssignment): void {
    assignment.state = "delivering";
    this.record.activeAssignmentId = assignment.id;
  }

  markRunning(assignment: ChildAssignment, now: number): void {
    assignment.state = "running";
    assignment.startedAt = now;
    this.record.activeAssignmentId = assignment.id;
  }

  /** A steer the model received while its target was still working joins that target. */
  merge(steer: ChildAssignment, targetId: string, now: number): void {
    steer.state = "running";
    steer.mergedInto = targetId;
    steer.startedAt = now;
  }

  /**
   * Ends `id` and every steer merged into it with the same outcome. Returns
   * whether `id` was the active assignment, which the caller's run belonged to.
   */
  finish(
    id: string,
    state: TerminalAssignmentState,
    outcome: ManagedOutcome,
    now: number,
  ): {
    readonly assignment: ChildAssignment | undefined;
    readonly wasActive: boolean;
    readonly effects: readonly ArchiveEffect[];
  } {
    const effects: ArchiveEffect[] = [];
    const assignment = this.find(id);
    if (assignment && !isTerminalAssignmentState(assignment.state))
      effects.push(terminate(assignment, state, now, outcome));
    for (const merged of this.record.assignments) {
      if (merged.mergedInto === id && !isTerminalAssignmentState(merged.state))
        effects.push(terminate(merged, state, now, outcome));
    }
    const wasActive = this.record.activeAssignmentId === id;
    if (wasActive) delete this.record.activeAssignmentId;
    return { assignment, wasActive, effects };
  }

  /** Ends every unfinished assignment honestly: started work is interrupted, the rest cancelled. */
  terminalizeAll(reason: string, now: number): readonly ArchiveEffect[] {
    const effects: ArchiveEffect[] = [];
    for (const assignment of this.record.assignments) {
      if (isTerminalAssignmentState(assignment.state)) continue;
      effects.push(
        assignment.state === "running"
          ? terminate(assignment, "interrupted", now, {
              source: "lifecycle",
              result: `${reason} before this assignment finished; it was not replayed.`,
            })
          : terminate(assignment, "cancelled", now, {
              source: "lifecycle",
              result: `${reason} before this assignment started; it was not delivered.`,
            }),
      );
    }
    this.record.queue = [];
    this.queuedText.clear();
    delete this.record.activeAssignmentId;
    return effects;
  }
}

function terminate(
  assignment: ChildAssignment,
  state: TerminalAssignmentState,
  now: number,
  outcome: ManagedOutcome,
): ArchiveEffect {
  assignment.state = state;
  assignment.outcome = outcome;
  assignment.endedAt = now;
  return { kind: "archive", assignment: structuredClone(assignment) };
}

// ------------------------------------------------------------------ outcome

/** What one running segment produced so far. */
export interface RunCapture {
  yielded?: SubagentYieldDetails;
  lastText?: string;
  stopReason?: string;
  errorMessage?: string;
  timedOut?: string;
}

export interface SettledOutcome {
  readonly state: TerminalAssignmentState;
  readonly outcome: ManagedOutcome;
  /** A failure before any tool ran, which a different model might avoid. */
  readonly modelError: boolean;
}

/** Final state of a segment: timeout, then yield, then an error stop, then assistant text. */
export function settleRunOutcome(
  run: RunCapture,
  toolActivity: boolean,
): SettledOutcome {
  if (run.timedOut) {
    return {
      state: "timedOut",
      outcome: { source: "lifecycle", result: run.timedOut },
      modelError: false,
    };
  }
  if (run.yielded) {
    const result = truncateUtf8Head(
      run.yielded.result,
      MANAGED_RESULT_PREVIEW_BYTES,
    );
    return {
      state: run.yielded.status,
      outcome: {
        source: "yield",
        result: result.value,
        ...(result.truncated ? { truncated: true } : {}),
        ...(run.yielded.artifacts ? { artifacts: run.yielded.artifacts } : {}),
      },
      modelError: false,
    };
  }
  if (run.stopReason === "error" || run.stopReason === "aborted") {
    const result = truncateUtf8Head(
      run.errorMessage ||
        run.lastText ||
        `Assistant stopped: ${run.stopReason}`,
      MANAGED_RESULT_PREVIEW_BYTES,
    );
    return {
      state: run.stopReason === "error" ? "failed" : "aborted",
      outcome: {
        source: "error",
        result: result.value,
        ...(result.truncated ? { truncated: true } : {}),
      },
      modelError: run.stopReason === "error" && !toolActivity,
    };
  }
  const result = truncateUtf8Head(
    run.lastText ?? "(no output)",
    MANAGED_RESULT_PREVIEW_BYTES,
  );
  return {
    state: "completed",
    outcome: {
      source: "assistant",
      result: result.value,
      ...(result.truncated ? { truncated: true } : {}),
    },
    modelError: false,
  };
}
