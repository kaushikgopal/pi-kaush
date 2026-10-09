/**
 * Delivery evidence for the managed child bridge, without I/O. Tracks the one
 * prompt handed to Pi but not yet started, the steers handed to Pi but not yet
 * seen by the model, and prompts that missed their start deadline. Each
 * message carries its own marker, so matching is by text and nothing is
 * re-sent. Time arrives as data.
 */

export function assignmentMarker(assignmentId: string): string {
  return `[Managed assignment ${assignmentId}]`;
}

function steerMarker(steerId: string): string {
  return `(update ${steerId})`;
}

export function formatAssignmentPrompt(
  assignmentId: string,
  text: string,
): string {
  return [
    assignmentMarker(assignmentId),
    text,
    "",
    'Assignment rule: when this assignment is complete or cannot continue, call the "yield" tool once with status, result, and any useful artifact paths. Yield ends this assignment only; you remain available for later assignments in this session.',
  ].join("\n");
}

export function formatSteerPrompt(
  targetId: string,
  steerId: string,
  text: string,
): string {
  return `[Update for managed assignment ${targetId}] ${steerMarker(steerId)}\n${text}`;
}

/**
 * - `sent`: handed to Pi; no evidence yet, or someone else's input came after ours.
 * - `echoedIdle`: our input echo was the latest input while Pi was idle, so an
 *   unmarked (transformed) run start may be ours.
 * - `queued`: echoed while Pi was busy, so Pi queued it behind the current run;
 *   it starts when the queue drains and no start deadline applies.
 */
export type DeliveryPhase = "sent" | "echoedIdle" | "queued";

export interface PendingDelivery {
  readonly id: string;
  readonly marker: string;
  readonly phase: DeliveryPhase;
  readonly deadline: number;
}

/** Whether Pi is running something when an input echo arrives. */
export type PiActivity = "idle" | "busy";

/** Whether Pi is idle with an empty steering/follow-up queue. */
export type PiQueue = "drained" | "active";

export interface DroppedMessages {
  readonly steerIds: readonly string[];
  readonly queuedPromptId?: string;
}

export class DeliveryTracker {
  private pending: PendingDelivery | undefined;
  /** Steers handed to Pi whose tagged message the model has not received yet. */
  private readonly steers = new Set<string>();
  /** Prompts that missed their start deadline; if Pi starts one later, it is aborted. */
  private readonly expired = new Set<string>();
  private quietSince: number | undefined;

  get pendingPrompt(): PendingDelivery | undefined {
    return this.pending;
  }

  sendPrompt(id: string, deadline: number): void {
    this.pending = {
      id,
      marker: assignmentMarker(id),
      phase: "sent",
      deadline,
    };
  }

  /** Forgets the pending prompt, or only `id` when given. */
  clearPrompt(id?: string): void {
    if (id === undefined || this.pending?.id === id) this.pending = undefined;
  }

  /** `input` echo: evidence the prompt reached Pi, not that the model will see it. */
  observeInput(text: string, source: string, pi: PiActivity): void {
    const pending = this.pending;
    if (!pending) return;
    if (source === "extension" && text.includes(pending.marker)) {
      if (pi === "busy") this.setPhase("queued");
      else if (pending.phase !== "queued") this.setPhase("echoedIdle");
      return;
    }
    // Someone else's prompt is in flight; an unmarked run start is not ours.
    if (pending.phase === "echoedIdle") this.setPhase("sent");
  }

  /** Claims the pending prompt when Pi starts a run for it. */
  claimRunStart(prompt: string): string | undefined {
    const pending = this.pending;
    if (
      !pending ||
      !(prompt.includes(pending.marker) || pending.phase === "echoedIdle")
    )
      return undefined;
    this.pending = undefined;
    return pending.id;
  }

  /** Claims the pending prompt when the model context receives its tagged message. */
  claimMessage(text: string): string | undefined {
    const pending = this.pending;
    if (!pending || !text.includes(pending.marker)) return undefined;
    this.pending = undefined;
    return pending.id;
  }

  /** Compaction before the first turn can take minutes; the deadline waits for it. */
  extendDeadline(atLeast: number): void {
    if (this.pending)
      this.pending = {
        ...this.pending,
        deadline: Math.max(this.pending.deadline, atLeast),
      };
  }

  resetDeadline(deadline: number): void {
    if (this.pending) this.pending = { ...this.pending, deadline };
  }

  /** Removes and returns a prompt whose start deadline passed. Queued prompts have none. */
  takeOverdue(now: number): string | undefined {
    const pending = this.pending;
    if (!pending || pending.phase === "queued" || now <= pending.deadline)
      return undefined;
    this.pending = undefined;
    return pending.id;
  }

  addSteer(id: string): void {
    this.steers.add(id);
  }

  dropSteer(id: string): void {
    this.steers.delete(id);
  }

  clearSteers(): void {
    this.steers.clear();
  }

  /** Removes and returns every pending steer whose marker appears in `text`. */
  takeSteersIn(text: string): string[] {
    const matched = [...this.steers].filter((id) =>
      text.includes(steerMarker(id)),
    );
    for (const id of matched) this.steers.delete(id);
    return matched;
  }

  markExpired(id: string): void {
    this.expired.add(id);
  }

  /** Removes and returns the first expired prompt whose marker appears in `text`. */
  takeExpiredIn(text: string): string | undefined {
    for (const id of this.expired) {
      if (!text.includes(assignmentMarker(id))) continue;
      this.expired.delete(id);
      return id;
    }
    return undefined;
  }

  /**
   * A steer or queued prompt the model never received is reported only once
   * Pi is drained for `graceMs`; it is never re-sent. Returns what was dropped
   * and forgets the steers; the caller ends the queued prompt.
   */
  takeDropped(
    now: number,
    pi: PiQueue,
    graceMs: number,
  ): DroppedMessages | undefined {
    const queuedPrompt =
      this.pending?.phase === "queued" ? this.pending : undefined;
    if ((this.steers.size === 0 && !queuedPrompt) || pi !== "drained") {
      this.quietSince = undefined;
      return undefined;
    }
    this.quietSince ??= now;
    if (now - this.quietSince < graceMs) return undefined;
    this.quietSince = undefined;
    const steerIds = [...this.steers];
    this.steers.clear();
    return queuedPrompt
      ? { steerIds, queuedPromptId: queuedPrompt.id }
      : { steerIds };
  }

  private setPhase(phase: DeliveryPhase): void {
    if (this.pending) this.pending = { ...this.pending, phase };
  }
}
