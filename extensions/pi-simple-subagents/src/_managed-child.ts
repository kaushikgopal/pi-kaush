/**
 * Managed worker bridge, loaded into every managed child with an explicit
 * `-e` so it survives `--no-extensions`. It owns `status.json`, consumes the
 * parent's immutable inbox files, and turns Pi lifecycle events into durable
 * assignment states.
 *
 * Delivery evidence: a void `sendUserMessage` call proves nothing, and neither
 * does the `input` echo (Pi validates the model and credentials after it). An
 * assignment is running only once Pi starts a run for it (`before_agent_start`)
 * or the model context receives its tagged user message (`message_start`).
 * Every message carries its own marker, so a steer is merged only when the
 * model actually received it, and nothing is ever re-sent.
 *
 * Pure parts live beside this shell: `_managed-ledger.ts` (assignment states
 * and outcomes) and `_managed-delivery.ts` (delivery evidence and markers).
 */
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { parseChildMessage } from "./_child-events.ts";
import {
  formatAssignmentPrompt,
  formatSteerPrompt,
  DeliveryTracker,
} from "./_managed-delivery.ts";
import {
  createSubagentExecutionWatchdog,
  formatSubagentTimeoutMessage,
  type SubagentExecutionWatchdog,
  type TimerScheduler,
} from "./_execution.ts";
import {
  type ArchiveEffect,
  AssignmentLedger,
  type RunCapture,
  settleRunOutcome,
} from "./_managed-ledger.ts";
import {
  type ChildAssignment,
  type ChildStatus,
  decodeManagedBootEnv,
  isTerminalAssignmentState,
  MANAGED_MESSAGE_PREVIEW_BYTES,
  type ManagedInboxMessage,
  type ManagedOutcome,
  type TerminalAssignmentState,
} from "./_managed-protocol.ts";
import {
  isManagedBootActivated,
  managedPaths,
  readChildStatus,
  readInbox,
  writeArchivedAssignment,
  writeJsonAtomic,
} from "./_managed-store.ts";
import { errorText } from "./_parse.ts";
import { isPidAlive } from "./_process-tree.ts";
import { truncateUtf8Head } from "./_text.ts";
import { addTurnUsage, emptyUsage } from "./_usage.ts";
import {
  registerSubagentYield,
  SUBAGENT_YIELD_TOOL_NAME,
  subagentYieldFromMessage,
} from "./_yield.ts";

const DELIVERY_CONFIRM_MS = 30_000;
/** Compaction before the first turn can take minutes; the start deadline waits for it. */
const COMPACTION_ALLOWANCE_MS = 10 * 60_000;
/** How long Pi may sit idle before the bridge stops waiting for an event it missed. */
const SETTLE_GRACE_MS = 5_000;
/** An orphaned worker that cannot shut down gracefully exits after this long. */
const ORPHAN_EXIT_MS = 15_000;
const PARENT_CHECK_MS = 2_000;
const INBOX_POLL_MS = 200;

/** Narrow view of the Pi context the bridge needs. */
export interface BridgeContext {
  isIdle(): boolean;
  abort(): void;
  shutdown(): void;
  /** Pi's steering/follow-up queue; absent means unknown, so nothing is declared dropped. */
  hasPendingMessages?(): boolean;
  readonly sessionId?: string;
  readonly sessionFile?: string;
}

export type ManagedSendUserMessage = (
  text: string,
  options?: { deliverAs: "steer" | "followUp" },
) => void;

/** Timers the bridge and its watchdog use. Handles are opaque to the bridge. */
export interface BridgeScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(callback: () => void, delayMs: number): unknown;
  clearInterval(handle: unknown): void;
}

type TimerHandle = ReturnType<typeof setTimeout>;

/** Real timers that never keep the process alive on their own. */
const realScheduler: BridgeScheduler = {
  setTimeout(callback, delayMs) {
    const timer = setTimeout(callback, delayMs);
    timer.unref?.();
    return timer;
  },
  // SAFETY: handles passed back here came from `setTimeout` above.
  clearTimeout: (handle) => clearTimeout(handle as TimerHandle),
  setInterval(callback, delayMs) {
    const timer = setInterval(callback, delayMs);
    timer.unref?.();
    return timer;
  },
  // SAFETY: handles passed back here came from `setInterval` above.
  clearInterval: (handle) => clearInterval(handle as TimerHandle),
};

function watchdogScheduler(scheduler: BridgeScheduler): TimerScheduler {
  return {
    set(callback, delayMs) {
      const handle = scheduler.setTimeout(callback, delayMs);
      return () => scheduler.clearTimeout(handle);
    },
  };
}

export interface ManagedChildBridgeOptions {
  readonly dir: string;
  readonly bootId: string;
  readonly pid: number;
  readonly parentPid?: number;
  /** Session the parent launched; any other session means it was replaced. */
  readonly expectedSessionId?: string;
  /** Native host must reach an idle prompt before any assignment begins. */
  readonly waitForActivation?: boolean;
  /** Inbox messages at or below this sequence are cancelled instead of delivered (idle resume). */
  readonly resumeFloorSeq: number;
  /** Shutdown commands at or below this sequence were meant for an earlier boot. */
  readonly controlFloorSeq: number;
  /** A fresh model attempt starts the inbox over in a new session; otherwise prior acks carry over. */
  readonly freshAttempt: boolean;
  /** Hold queued work after an initial model error so the parent can relaunch on the next candidate. */
  readonly holdOnInitialModelError: boolean;
  readonly limits: {
    readonly maxRuntimeMs: number;
    readonly maxInactivityMs: number;
  };
  readonly sendUserMessage: ManagedSendUserMessage;
  readonly now?: () => number;
  /** Defaults to real, unref'd timers; also drives the execution watchdog. */
  readonly scheduler?: BridgeScheduler;
  readonly isPidAlive?: (pid: number) => boolean;
  /** Last resort for an orphaned worker whose graceful shutdown did not finish. */
  readonly forceExit?: () => void;
  /** 0 disables background timers; tests then drive `poll()` directly. */
  readonly pollMs?: number;
  readonly deliveryConfirmMs?: number;
  readonly settleGraceMs?: number;
}

/**
 * Whether this bridge owns Pi and `status.json`. Only `attached` may drive Pi;
 * `disposed` (reload, replaced session) and `exited` (shutdown recorded) no
 * longer write status, except the single final write at shutdown.
 */
type BridgeLifecycle =
  | { readonly kind: "unattached" }
  | { readonly kind: "attached"; readonly ctx: BridgeContext }
  | { readonly kind: "disposed" }
  | { readonly kind: "exited" };

/** One running segment: what it captured, its watchdog, and any abort we requested. */
class ActiveRun {
  readonly capture: RunCapture = {};
  /** Set when we aborted Pi ourselves, so an idle gap is not a retry backoff. */
  abortRequestedAt: number | undefined;
  private readonly watchdog: SubagentExecutionWatchdog;

  constructor(
    limits: ManagedChildBridgeOptions["limits"],
    scheduler: BridgeScheduler,
    onTimeout: (run: ActiveRun, message: string) => void,
  ) {
    this.watchdog = createSubagentExecutionWatchdog(
      limits,
      (reason) => onTimeout(this, formatSubagentTimeoutMessage(reason, limits)),
      watchdogScheduler(scheduler),
    );
  }

  recordActivity(): void {
    this.watchdog.recordActivity();
  }

  end(): void {
    this.watchdog.stop();
  }
}

export class ManagedChildBridge {
  private readonly status: ChildStatus;
  private readonly ledger: AssignmentLedger;
  private readonly delivery = new DeliveryTracker();
  private lifecycle: BridgeLifecycle = { kind: "unattached" };
  private run: ActiveRun | undefined;
  private readonly paths;
  private readonly now: () => number;
  private readonly scheduler: BridgeScheduler;
  private readonly isPidAlive: (pid: number) => boolean;
  private readonly confirmMs: number;
  private readonly graceMs: number;
  private timers: unknown[] = [];
  /** Pi idle while we believe it busy; it may outlive or precede any run. */
  private idleSince: number | undefined;

  constructor(private readonly options: ManagedChildBridgeOptions) {
    this.paths = managedPaths(options.dir);
    this.now = options.now ?? Date.now;
    this.scheduler = options.scheduler ?? realScheduler;
    this.isPidAlive = options.isPidAlive ?? isPidAlive;
    this.confirmMs = options.deliveryConfirmMs ?? DELIVERY_CONFIRM_MS;
    this.graceMs = options.settleGraceMs ?? SETTLE_GRACE_MS;
    this.status = {
      v: 1,
      bootId: options.bootId,
      pid: options.pid,
      state: "starting",
      ackedSeq: 0,
      queue: [],
      assignments: [],
      usage: emptyUsage(),
      toolActivity: false,
      updatedAt: this.now(),
    };
    this.ledger = new AssignmentLedger(this.status);
  }

  get snapshot(): ChildStatus {
    return structuredClone(this.status);
  }

  /** Called on session_start. Restores prior status without replaying interrupted work. */
  start(ctx: BridgeContext): void {
    if (this.lifecycle.kind !== "unattached") return;
    this.lifecycle = { kind: "attached", ctx };
    const previous = readChildStatus(this.paths.status);
    // Only a fresh model attempt (new session, nothing ran in its history)
    // may process the inbox from the start. Every other boot keeps acks so
    // nothing is replayed.
    const carryOver =
      previous !== undefined &&
      !(this.options.freshAttempt && previous.bootId !== this.options.bootId);
    if (previous && carryOver) {
      this.status.ackedSeq = previous.ackedSeq;
      this.status.usage = previous.usage;
      this.status.toolActivity = previous.toolActivity;
      if (previous.model) this.status.model = previous.model;
      if (previous.sessionFile) this.status.sessionFile = previous.sessionFile;
      this.archive(this.ledger.restore(previous.assignments, this.now()));
    }
    const expected = this.options.expectedSessionId;
    if (expected && ctx.sessionId && ctx.sessionId !== expected) {
      this.detach(ctx, expected, ctx.sessionId);
      return;
    }
    if (ctx.sessionId) this.status.sessionId = ctx.sessionId;
    if (ctx.sessionFile) this.status.sessionFile = ctx.sessionFile;
    this.status.state = "idle";
    this.flush();
    this.poll();
    const pollMs = this.options.pollMs ?? INBOX_POLL_MS;
    if (pollMs > 0) {
      this.every(pollMs, () => this.poll());
      if (this.options.parentPid)
        this.every(PARENT_CHECK_MS, () => this.checkParent());
    }
  }

  /** Reads new inbox files once and enforces delivery and settle deadlines. Idempotent. */
  poll(): void {
    const ctx = this.attachedContext();
    if (!ctx) return;
    const { controlFloorSeq } = this.options;
    if (
      this.options.waitForActivation &&
      !isManagedBootActivated(this.paths.activation, this.options.bootId)
    ) {
      if (
        hasShutdown(readInbox(this.paths.inbox, { afterSeq: controlFloorSeq }))
      )
        this.beginShutdown();
      return;
    }
    const now = this.now();
    this.checkDeliveryDeadline(now);
    this.checkMissedSettle(now, ctx);
    this.checkDroppedMessages(now, ctx);
    if (this.halted()) {
      // A held worker still honors shutdown so fallback does not wait out the grace window.
      if (
        this.status.state === "held" &&
        hasShutdown(
          readInbox(this.paths.inbox, {
            afterSeq: Math.max(this.status.ackedSeq, controlFloorSeq),
          }),
        )
      )
        this.beginShutdown();
      return;
    }
    let changed = false;
    const messages = readInbox(this.paths.inbox, {
      afterSeq: this.status.ackedSeq,
    });
    for (const message of messages) {
      if (message.seq <= this.status.ackedSeq) continue;
      this.status.ackedSeq = message.seq;
      changed = true;
      this.accept(message, ctx);
      if (this.halted()) break;
    }
    if (changed) this.flush();
  }

  /** A worker whose parent died must not keep running: abort, shut down, then exit if stuck. */
  checkParent(): void {
    const parentPid = this.options.parentPid;
    if (!parentPid || this.stopped() || this.isPidAlive(parentPid)) return;
    if (this.status.state === "stopping") return;
    this.status.lastError =
      "Parent Pi process exited; shutting down managed worker.";
    this.beginShutdown();
    const forceExit = this.options.forceExit;
    if (forceExit) this.scheduler.setTimeout(forceExit, ORPHAN_EXIT_MS);
  }

  /** `input` echo: evidence the prompt reached Pi, not that the model will see it. */
  onInput(text: string, source: string): void {
    const ctx = this.attachedContext();
    this.delivery.observeInput(
      text,
      source,
      ctx && !ctx.isIdle() ? "busy" : "idle",
    );
  }

  /** `before_agent_start`: Pi passed validation and is starting a run for this prompt. */
  onBeforeAgentStart(prompt: string): void {
    const ctx = this.attachedContext();
    if (!ctx) return;
    const started = this.delivery.claimRunStart(prompt);
    if (started !== undefined) {
      this.startPrompt(started);
      return;
    }
    if (this.observeSteers(prompt)) return;
    if (this.abortIfExpired(prompt, ctx)) return;
    // A person typing in the native TUI: hold parent work until the run settles.
    if (!this.ledger.activeId && this.status.state === "idle") {
      this.status.state = "busy";
      this.flush();
    }
  }

  /** User `message_start`: the model context now contains this message. */
  onMessageStart(message: unknown): void {
    const ctx = this.attachedContext();
    if (!ctx) return;
    const parsed = parseChildMessage(message);
    const text =
      parsed?.role === "user" ? parsed.textParts.join("\n") : undefined;
    if (!text) return;
    // A prompt Pi queued behind another run starts here, without before_agent_start.
    const started = this.delivery.claimMessage(text);
    if (started !== undefined) {
      this.startPrompt(started);
      return;
    }
    if (this.observeSteers(text)) return;
    this.abortIfExpired(text, ctx);
  }

  onCompactionStart(): void {
    this.delivery.extendDeadline(this.now() + COMPACTION_ALLOWANCE_MS);
  }

  onCompactionEnd(): void {
    this.delivery.resetDeadline(this.now() + this.confirmMs);
  }

  onActivity(): void {
    this.run?.recordActivity();
    const inactivity = this.options.limits.maxInactivityMs;
    const heartbeatMs =
      inactivity > 0 ? Math.min(1_000, inactivity / 2) : 1_000;
    if (
      this.ledger.active()?.state === "running" &&
      this.now() - this.status.updatedAt >= heartbeatMs
    )
      this.flush();
  }

  onToolStart(toolName: string): void {
    this.run?.recordActivity();
    if (toolName === SUBAGENT_YIELD_TOOL_NAME) return;
    const first = !this.status.toolActivity;
    this.status.toolActivity = true;
    const active = this.ledger.active();
    if (active) active.toolActivity = true;
    if (first || active) this.flush();
  }

  onMessageEnd(message: unknown): void {
    this.run?.recordActivity();
    const active = this.ledger.active();
    const running = active?.state === "running" ? active : undefined;
    const capture = running ? this.run?.capture : undefined;
    const parsed = parseChildMessage(message);
    const yielded = subagentYieldFromMessage(parsed);
    if (yielded) {
      if (capture) capture.yielded = yielded;
      return;
    }
    if (parsed?.role !== "assistant") return;
    addTurnUsage(this.status.usage, parsed.usage);
    if (parsed.model) this.status.model = parsed.model;
    if (running) {
      addTurnUsage(running.usage, parsed.usage);
      if (parsed.model) running.model = parsed.model;
    }
    if (capture) {
      const text = parsed.textParts.join("\n");
      if (text.trim()) capture.lastText = text;
      if (parsed.stopReason !== undefined)
        capture.stopReason = parsed.stopReason;
      if (parsed.errorMessage !== undefined)
        capture.errorMessage = parsed.errorMessage;
    }
    this.flush();
  }

  /** agent_settled: Pi will not continue on its own, so the running assignment ends here. */
  onSettled(): void {
    const ctx = this.attachedContext();
    if (!ctx) return;
    this.idleSince = undefined;
    if (this.run) this.run.abortRequestedAt = undefined;
    if (this.status.state === "stopping") {
      // A busy shutdown aborted first; Pi can now finish shutting down.
      ctx.shutdown();
      return;
    }
    const active = this.ledger.active();
    if (active?.state === "running") {
      const { state, outcome, modelError } = settleRunOutcome(
        this.run?.capture ?? {},
        active.toolActivity,
      );
      if (modelError) active.modelError = true;
      this.finishAndAdvance(active.id, state, outcome);
      return;
    }
    if (!this.ledger.activeId && this.status.state !== "held") {
      // Interactive or untracked runs end here; queued follow-ups may now start.
      this.status.state = "idle";
      this.deliverNext();
      this.flush();
    }
  }

  /** session_shutdown: record honest final states; nothing is replayed later. */
  onShutdown(reason?: string): void {
    if (this.lifecycle.kind === "exited") return;
    const replaced =
      reason === "new" || reason === "resume" || reason === "fork";
    if (replaced)
      this.status.lastError = `Managed worker session was replaced by /${reason}; parent control is detached.`;
    this.terminalizeAll(
      replaced
        ? `Worker session was replaced by /${reason}`
        : "Worker shut down",
    );
    this.status.state = "exited";
    this.releaseResources();
    this.lifecycle = { kind: "exited" };
    this.flushFinal();
  }

  dispose(): void {
    this.releaseResources();
    if (this.lifecycle.kind !== "exited") this.lifecycle = { kind: "disposed" };
  }

  // ------------------------------------------------------------ internals

  private attachedContext(): BridgeContext | undefined {
    return this.lifecycle.kind === "attached" ? this.lifecycle.ctx : undefined;
  }

  private stopped(): boolean {
    return (
      this.lifecycle.kind === "disposed" || this.lifecycle.kind === "exited"
    );
  }

  /** Held (awaiting model fallback) or shutting down: leave further messages unacknowledged. */
  private halted(): boolean {
    const state = this.status.state;
    return this.stopped() || state === "held" || state === "stopping";
  }

  private releaseResources(): void {
    this.endRun();
    for (const timer of this.timers) this.scheduler.clearInterval(timer);
    this.timers = [];
  }

  private every(ms: number, fn: () => void): void {
    this.timers.push(this.scheduler.setInterval(fn, ms));
  }

  /** The session is not the one the parent launched: stop consuming and shut down. */
  private detach(ctx: BridgeContext, expected: string, actual: string): void {
    // Keep the parent's session id so the parent reads these final states.
    this.status.sessionId = expected;
    this.status.lastError = `Managed worker session changed from ${expected} to ${actual} (for example /new, /resume, or /fork); parent control is detached and the worker is stopping.`;
    this.terminalizeAll("Worker session was replaced");
    this.status.state = "stopping";
    this.flush();
    this.dispose();
    ctx.abort();
    ctx.shutdown();
  }

  private accept(message: ManagedInboxMessage, ctx: BridgeContext): void {
    if (message.kind === "shutdown") {
      if (message.seq > this.options.controlFloorSeq) this.beginShutdown();
      return;
    }
    const preview = truncateUtf8Head(
      message.text,
      MANAGED_MESSAGE_PREVIEW_BYTES,
    ).value;
    const assignment: ChildAssignment = {
      id: message.assignmentId,
      seq: message.seq,
      state: "accepted",
      disposition: "prompt",
      preview,
      acceptedAt: this.now(),
      usage: emptyUsage(),
      toolActivity: false,
    };
    this.ledger.push(assignment);
    if (message.seq <= this.options.resumeFloorSeq) {
      this.terminate(assignment, "cancelled", {
        source: "lifecycle",
        result:
          "Worker was resumed idle; this message was sent before the restart and was not delivered.",
      });
      return;
    }
    const active = this.ledger.active();
    const busy =
      active !== undefined ||
      this.delivery.pendingPrompt !== undefined ||
      this.status.state === "busy" ||
      !ctx.isIdle();
    if (!busy) {
      this.deliver(assignment, message.text);
      return;
    }
    if (message.delivery === "auto" && active?.state === "running") {
      // Pending until the model receives the tagged message; never re-sent.
      assignment.disposition = "steer";
      assignment.state = "delivering";
      this.delivery.addSteer(assignment.id);
      try {
        this.options.sendUserMessage(
          formatSteerPrompt(active.id, assignment.id, message.text),
          { deliverAs: "steer" },
        );
      } catch (error) {
        this.delivery.dropSteer(assignment.id);
        this.terminate(assignment, "failed", {
          source: "error",
          result: `Steer delivery failed: ${errorText(error)}`,
        });
      }
      return;
    }
    this.ledger.enqueue(assignment, message.text);
  }

  /** `text` is the full parent-authored text; the assignment keeps only a capped preview. */
  private deliver(assignment: ChildAssignment, text: string): void {
    this.ledger.markDelivering(assignment);
    this.status.state = "busy";
    this.delivery.sendPrompt(assignment.id, this.now() + this.confirmMs);
    try {
      // followUp: if a run starts first (for example a person typing), Pi queues this
      // prompt behind it instead of rejecting it.
      this.options.sendUserMessage(
        formatAssignmentPrompt(assignment.id, text),
        { deliverAs: "followUp" },
      );
    } catch (error) {
      this.finishAndAdvance(assignment.id, "failed", {
        source: "error",
        result: `Prompt delivery failed: ${errorText(error)}`,
      });
    }
  }

  private deliverNext(): void {
    if (this.halted()) return;
    if (this.delivery.pendingPrompt || this.ledger.activeId) return;
    const next = this.ledger.takeNextQueued();
    if (next) {
      this.deliver(next.assignment, next.text);
      return;
    }
    this.status.state =
      this.attachedContext()?.isIdle() === false ? "busy" : "idle";
  }

  private startPrompt(id: string): void {
    const assignment = this.ledger.find(id);
    if (!assignment || assignment.state !== "delivering") return;
    this.closeSegment();
    this.begin(assignment);
  }

  /** Marks any tagged steer in `text` as received. Returns true when one matched. */
  private observeSteers(text: string): boolean {
    const matched = this.delivery.takeSteersIn(text);
    for (const id of matched) {
      const steer = this.ledger.find(id);
      if (!steer || steer.state !== "delivering") continue;
      const active = this.ledger.active();
      const capture = this.run?.capture;
      if (
        active?.state === "running" &&
        !capture?.yielded &&
        !capture?.timedOut
      ) {
        this.ledger.merge(steer, active.id, this.now());
        this.flush();
        continue;
      }
      // The target already yielded (or nothing is running): the update is its own assignment.
      this.closeSegment();
      this.begin(steer);
    }
    return matched.length > 0;
  }

  /** A prompt that missed its start deadline was reported failed; it must not run untracked. */
  private abortIfExpired(text: string, ctx: BridgeContext): boolean {
    if (this.delivery.takeExpiredIn(text) === undefined) return false;
    if (this.run) this.run.abortRequestedAt = this.now();
    this.status.state = "busy";
    this.flush();
    ctx.abort();
    return true;
  }

  /** Ends the running segment with what it captured so far; a new tagged message starts now. */
  private closeSegment(): void {
    const active = this.ledger.active();
    if (active?.state !== "running") return;
    const { state, outcome } = settleRunOutcome(
      this.run?.capture ?? {},
      active.toolActivity,
    );
    this.conclude(active.id, state, outcome);
    this.flush();
  }

  private begin(assignment: ChildAssignment): void {
    this.ledger.markRunning(assignment, this.now());
    this.status.state = "busy";
    this.run?.end();
    this.run = new ActiveRun(
      this.options.limits,
      this.scheduler,
      (run, message) => {
        run.capture.timedOut = message;
        run.abortRequestedAt = this.now();
        this.attachedContext()?.abort();
      },
    );
    this.flush();
  }

  private endRun(): void {
    this.run?.end();
    this.run = undefined;
  }

  private checkDeliveryDeadline(now: number): void {
    const id = this.delivery.takeOverdue(now);
    if (id === undefined) return;
    const assignment = this.ledger.find(id);
    if (!assignment || assignment.state !== "delivering") return;
    // Pi validates the model and credentials after the input echo and reports
    // failures only as an extension error, so a missing run start counts as a
    // model error and may trigger fallback.
    if (!this.status.toolActivity) assignment.modelError = true;
    this.delivery.markExpired(assignment.id);
    this.finishAndAdvance(assignment.id, "failed", {
      source: "error",
      result: `Pi did not start this assignment within ${this.confirmMs} ms; the prompt was likely rejected before the run began (for example no usable model or credentials).`,
    });
  }

  /** Recovers when Pi is idle but the settle event never arrived (for example after an abort). */
  private checkMissedSettle(now: number, ctx: BridgeContext): void {
    if (this.status.state !== "busy" || !ctx.isIdle()) {
      this.idleSince = undefined;
      return;
    }
    this.idleSince ??= now;
    if (now - this.idleSince < this.graceMs) return;
    if (this.ledger.active()?.state === "running") {
      // Without our own abort, an idle gap may be a retry backoff; keep waiting for settle.
      if (this.run?.abortRequestedAt === undefined) return;
      this.onSettled();
      return;
    }
    if (!this.delivery.pendingPrompt && !this.ledger.activeId) {
      this.idleSince = undefined;
      this.status.state = "idle";
      this.deliverNext();
      this.flush();
    }
  }

  /**
   * A steer or queued prompt the model never received is reported only once Pi
   * is idle with an empty queue for the grace window; it is never re-sent.
   */
  private checkDroppedMessages(now: number, ctx: BridgeContext): void {
    const dropped = this.delivery.takeDropped(
      now,
      ctx.isIdle() && ctx.hasPendingMessages?.() === false
        ? "drained"
        : "active",
      this.graceMs,
    );
    if (!dropped) return;
    const outcome: ManagedOutcome = {
      source: "lifecycle",
      result:
        "Pi discarded this message before the model received it (the run ended or was aborted first). It was not re-sent.",
    };
    for (const id of dropped.steerIds) {
      const steer = this.ledger.find(id);
      if (steer && !isTerminalAssignmentState(steer.state))
        this.terminate(steer, "cancelled", outcome);
    }
    if (dropped.queuedPromptId !== undefined)
      this.finishAndAdvance(dropped.queuedPromptId, "cancelled", outcome);
    else this.flush();
  }

  /** Ends `id`, then starts the next queued follow-up unless the worker is held. */
  private finishAndAdvance(
    id: string,
    state: TerminalAssignmentState,
    outcome: ManagedOutcome,
  ): void {
    if (this.conclude(id, state, outcome) === "continue") this.deliverNext();
    this.flush();
  }

  /**
   * Ends `id` and its merged steers, drops its run, and holds the worker when
   * the initial assignment failed on the model before any tool ran. Does not
   * flush or advance the queue.
   */
  private conclude(
    id: string,
    state: TerminalAssignmentState,
    outcome: ManagedOutcome,
  ): "held" | "continue" {
    const { assignment, wasActive, effects } = this.ledger.finish(
      id,
      state,
      outcome,
      this.now(),
    );
    this.archive(effects);
    this.delivery.clearPrompt(id);
    if (wasActive) this.endRun();
    if (
      this.options.holdOnInitialModelError &&
      this.ledger.isInitial(id) &&
      assignment?.modelError &&
      !this.status.toolActivity
    ) {
      this.status.state = "held";
      return "held";
    }
    return "continue";
  }

  private terminate(
    assignment: ChildAssignment,
    state: TerminalAssignmentState,
    outcome: ManagedOutcome,
  ): void {
    this.archive([
      this.ledger.terminate(assignment, state, outcome, this.now()),
    ]);
  }

  /** Ends every unfinished assignment honestly: started work is interrupted, the rest cancelled. */
  private terminalizeAll(reason: string): void {
    this.archive(this.ledger.terminalizeAll(reason, this.now()));
    this.delivery.clearPrompt();
    this.delivery.clearSteers();
    this.endRun();
  }

  private archive(effects: readonly ArchiveEffect[]): void {
    const sessionId = this.status.sessionId;
    if (!sessionId) return;
    for (const effect of effects) {
      try {
        writeArchivedAssignment(this.paths.dir, sessionId, effect.assignment);
      } catch {
        this.status.lastError =
          "Could not persist the assignment result archive.";
      }
    }
  }

  private beginShutdown(): void {
    if (this.status.state === "stopping" || this.stopped()) return;
    this.status.state = "stopping";
    this.flush();
    // Interactive Pi defers shutdown until a run ends, so stop the run first.
    const ctx = this.attachedContext();
    if (ctx && !ctx.isIdle()) ctx.abort();
    ctx?.shutdown();
  }

  /** A disposed bridge no longer owns the status file (a reloaded or replacing bridge does). */
  private flush(): void {
    if (this.stopped()) return;
    this.writeStatus();
  }

  /** The one write after the bridge stops: final states at session shutdown. */
  private flushFinal(): void {
    this.writeStatus();
  }

  private writeStatus(): void {
    this.status.updatedAt = this.now();
    try {
      writeJsonAtomic(this.paths.status, this.status);
    } catch {
      // The next state change retries; a failed status write must not crash the worker.
    }
  }
}

function hasShutdown(messages: readonly ManagedInboxMessage[]): boolean {
  return messages.some((message) => message.kind === "shutdown");
}

/**
 * Returns undefined when no managed variable is set (a normal Pi process).
 * A partial or malformed set throws: running such a process as an ordinary
 * Pi would silently drop the parent's assignments.
 */
export function managedBridgeOptionsFromEnv(
  env: NodeJS.ProcessEnv,
  sendUserMessage: ManagedSendUserMessage,
): ManagedChildBridgeOptions | undefined {
  const decoded = decodeManagedBootEnv(env);
  if (decoded.kind === "absent") return undefined;
  if (decoded.kind === "invalid") throw new Error(decoded.message);
  return {
    ...decoded.boot,
    pid: process.pid,
    waitForActivation: true,
    sendUserMessage,
  };
}

function bridgeContext(ctx: ExtensionContext): BridgeContext {
  const sessionFile = ctx.sessionManager.getSessionFile();
  return {
    isIdle: () => ctx.isIdle(),
    abort: () => ctx.abort(),
    shutdown: () => ctx.shutdown(),
    hasPendingMessages: () => ctx.hasPendingMessages(),
    sessionId: ctx.sessionManager.getSessionId(),
    ...(sessionFile ? { sessionFile } : {}),
  };
}

const SESSION_LOCKED_MESSAGE =
  "This managed worker is bound to one session. Stop it from the parent instead of switching or forking sessions.";

export default function managedChildExtension(pi: ExtensionAPI): void {
  // Throws on a partial managed environment so Pi reports a load error instead
  // of running a worker that silently ignores its parent.
  const options = managedBridgeOptionsFromEnv(process.env, (text, delivery) =>
    pi.sendUserMessage(text, delivery),
  );
  if (!options) return;
  registerSubagentYield(pi, "managedAssignment");
  const bridge = new ManagedChildBridge({
    ...options,
    forceExit: () => process.exit(1),
  });
  const lockSession = (ctx: ExtensionContext) => {
    try {
      ctx.ui.notify(SESSION_LOCKED_MESSAGE, "warning");
    } catch {
      // Notification is advisory.
    }
    return { cancel: true };
  };
  pi.on("session_start", (_event, ctx) => bridge.start(bridgeContext(ctx)));
  pi.on("session_before_switch", (_event, ctx) => lockSession(ctx));
  pi.on("session_before_fork", (_event, ctx) => lockSession(ctx));
  pi.on("input", (event) => {
    bridge.onInput(event.text, event.source);
    return { action: "continue" };
  });
  pi.on("before_agent_start", (event) => {
    bridge.onBeforeAgentStart(event.prompt);
  });
  pi.on("agent_start", () => bridge.onActivity());
  pi.on("message_start", (event) => bridge.onMessageStart(event.message));
  pi.on("message_update", () => bridge.onActivity());
  pi.on("message_end", (event) => bridge.onMessageEnd(event.message));
  pi.on("tool_execution_start", (event) => bridge.onToolStart(event.toolName));
  pi.on("tool_execution_update", () => bridge.onActivity());
  pi.on("session_before_compact", () => bridge.onCompactionStart());
  pi.on("session_compact", () => bridge.onCompactionEnd());
  pi.on("agent_settled", () => bridge.onSettled());
  pi.on("session_shutdown", (event) => {
    // Reload re-instantiates this extension; the next bridge resumes from status.json.
    if (event.reason === "reload") bridge.dispose();
    else bridge.onShutdown(event.reason);
  });
}
