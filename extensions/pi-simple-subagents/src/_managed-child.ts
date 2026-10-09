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
 */
import { StringEnum } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  createSubagentExecutionWatchdog,
  formatSubagentTimeoutMessage,
  type SubagentExecutionWatchdog,
} from "./_execution.ts";
import {
  type ChildAssignment,
  type ChildStatus,
  type ChildWorkerState,
  emptyUsage,
  isManagedBootActivated,
  isTerminalAssignmentState,
  MANAGED_BOOT_ID_ENV,
  MANAGED_CONTROL_FLOOR_ENV,
  MANAGED_DIR_ENV,
  MANAGED_ENV_KEYS,
  MANAGED_FRESH_ATTEMPT_ENV,
  MANAGED_HOLD_ON_MODEL_ERROR_ENV,
  MANAGED_MAX_INACTIVITY_ENV,
  MANAGED_MAX_RUNTIME_ENV,
  MANAGED_MESSAGE_PREVIEW_BYTES,
  MANAGED_PARENT_PID_ENV,
  MANAGED_RESULT_PREVIEW_BYTES,
  MANAGED_RESUME_FLOOR_ENV,
  MANAGED_SESSION_ID_ENV,
  MANAGED_STATUS_ASSIGNMENT_LIMIT,
  type ManagedInboxMessage,
  type ManagedOutcome,
  type ManagedUsage,
  managedPaths,
  readChildStatus,
  readInbox,
  type TerminalAssignmentState,
  writeArchivedAssignment,
  writeJsonAtomic,
} from "./_managed-store.ts";
import { truncateUtf8Head } from "./_transcript.ts";
import {
  SUBAGENT_YIELD_TOOL_NAME,
  subagentYieldFromMessage,
  type SubagentYieldDetails,
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
  readonly isPidAlive?: (pid: number) => boolean;
  /** Last resort for an orphaned worker whose graceful shutdown did not finish. */
  readonly forceExit?: () => void;
  /** 0 disables background timers; tests then drive `poll()` directly. */
  readonly pollMs?: number;
  readonly deliveryConfirmMs?: number;
  readonly settleGraceMs?: number;
}

interface RunCapture {
  yielded?: SubagentYieldDetails;
  lastText?: string;
  stopReason?: string;
  errorMessage?: string;
  timedOut?: string;
}

interface PendingDelivery {
  readonly id: string;
  readonly marker: string;
  /** Our own input echo was the latest input; a transformed prompt may then be ours. */
  inputSeen: boolean;
  /** Echoed while Pi was busy, so Pi queued it; it starts when the queue drains. */
  queued: boolean;
  deadline: number;
}

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: unknown }).code === "EPERM";
  }
}

function capped(
  value: string,
  bytes: number,
): { value: string; truncated: boolean } {
  return truncateUtf8Head(value, bytes);
}

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

function userMessageText(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  const msg = message as { role?: unknown; content?: unknown };
  if (msg.role !== "user") return undefined;
  if (typeof msg.content === "string") return msg.content;
  if (!Array.isArray(msg.content)) return undefined;
  return msg.content
    .filter(
      (part): part is { type: "text"; text: string } =>
        !!part && part.type === "text" && typeof part.text === "string",
    )
    .map((part) => part.text)
    .join("\n");
}

function addUsage(target: ManagedUsage, usage: unknown): void {
  if (!usage || typeof usage !== "object") return;
  const value = usage as {
    input?: unknown;
    output?: unknown;
    cacheRead?: unknown;
    cacheWrite?: unknown;
    totalTokens?: unknown;
    cost?: { total?: unknown };
  };
  const n = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v) ? v : 0;
  target.input += n(value.input);
  target.output += n(value.output);
  target.cacheRead += n(value.cacheRead);
  target.cacheWrite += n(value.cacheWrite);
  target.cost += n(value.cost?.total);
  target.contextTokens = n(value.totalTokens) || target.contextTokens;
}

export class ManagedChildBridge {
  private status: ChildStatus;
  private ctx: BridgeContext | undefined;
  private readonly paths;
  private readonly now: () => number;
  private readonly isPidAlive: (pid: number) => boolean;
  private readonly confirmMs: number;
  private readonly graceMs: number;
  private pendingDelivery: PendingDelivery | undefined;
  /** Steers handed to Pi whose tagged message the model has not received yet. */
  private readonly pendingSteers = new Set<string>();
  /** Prompts that missed their start deadline; if Pi starts one later, it is aborted. */
  private readonly expired = new Set<string>();
  private run: RunCapture = {};
  private watchdog: SubagentExecutionWatchdog | undefined;
  private timers: ReturnType<typeof setInterval>[] = [];
  private stopped = false;
  private shutdownRecorded = false;
  private abortRequestedAt: number | undefined;
  private idleSince: number | undefined;
  private quietSince: number | undefined;

  constructor(private readonly options: ManagedChildBridgeOptions) {
    this.paths = managedPaths(options.dir);
    this.now = options.now ?? Date.now;
    this.isPidAlive = options.isPidAlive ?? defaultIsPidAlive;
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
  }

  get snapshot(): ChildStatus {
    return structuredClone(this.status);
  }

  /** Called on session_start. Restores prior status without replaying interrupted work. */
  start(ctx: BridgeContext): void {
    if (this.ctx) return;
    this.ctx = ctx;
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
      this.status.assignments = previous.assignments.map((assignment) =>
        isTerminalAssignmentState(assignment.state)
          ? assignment
          : this.terminal(
              assignment,
              assignment.state === "accepted" ? "cancelled" : "interrupted",
              {
                source: "lifecycle",
                result:
                  assignment.state === "accepted"
                    ? "Worker restarted before this queued assignment started; it was not delivered."
                    : "Worker restarted before this assignment finished; it was not replayed.",
              },
            ),
      );
    }
    const expected = this.options.expectedSessionId;
    if (expected && ctx.sessionId && ctx.sessionId !== expected) {
      this.detach(expected, ctx.sessionId);
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

  /** Reads new inbox files and enforces delivery and settle deadlines. Idempotent. */
  poll(): void {
    if (!this.ctx || this.stopped) return;
    if (
      this.options.waitForActivation &&
      !isManagedBootActivated(this.paths.activation, this.options.bootId)
    ) {
      if (
        readInbox(this.paths.inbox).some(
          (message) =>
            message.kind === "shutdown" &&
            message.seq > this.options.controlFloorSeq,
        )
      )
        this.beginShutdown();
      return;
    }
    const now = this.now();
    this.checkDeliveryDeadline(now);
    this.checkMissedSettle(now);
    this.checkDroppedMessages(now);
    if (this.halted()) {
      // A held worker still honors shutdown so fallback does not wait out the grace window.
      const shutdown = readInbox(this.paths.inbox).some(
        (message) =>
          message.kind === "shutdown" &&
          message.seq > this.status.ackedSeq &&
          message.seq > this.options.controlFloorSeq,
      );
      if (shutdown && this.status.state === "held") this.beginShutdown();
      return;
    }
    let changed = false;
    for (const message of readInbox(this.paths.inbox)) {
      if (message.seq <= this.status.ackedSeq) continue;
      this.status.ackedSeq = message.seq;
      changed = true;
      this.accept(message);
      if (this.halted()) break;
    }
    if (changed) this.flush();
  }

  /** Held (awaiting model fallback) or shutting down: leave further messages unacknowledged. */
  private halted(): boolean {
    const state: ChildWorkerState = this.status.state;
    return this.stopped || state === "held" || state === "stopping";
  }

  /** A worker whose parent died must not keep running: abort, shut down, then exit if stuck. */
  checkParent(): void {
    const parentPid = this.options.parentPid;
    if (!parentPid || this.stopped || this.isPidAlive(parentPid)) return;
    if (this.status.state === "stopping") return;
    this.status.lastError =
      "Parent Pi process exited; shutting down managed worker.";
    this.beginShutdown();
    const forceExit = this.options.forceExit;
    if (forceExit) {
      const timer = setTimeout(forceExit, ORPHAN_EXIT_MS);
      timer.unref?.();
    }
  }

  /** `input` echo: evidence the prompt reached Pi, not that the model will see it. */
  onInput(text: string, source: string): void {
    const pending = this.pendingDelivery;
    if (!pending) return;
    if (source === "extension" && text.includes(pending.marker)) {
      pending.inputSeen = true;
      if (this.ctx && !this.ctx.isIdle()) pending.queued = true;
      return;
    }
    // Someone else's prompt is in flight; an unmarked run start is not ours.
    pending.inputSeen = false;
  }

  /** `before_agent_start`: Pi passed validation and is starting a run for this prompt. */
  onBeforeAgentStart(prompt: string): void {
    if (!this.ctx || this.stopped) return;
    const pending = this.pendingDelivery;
    if (
      pending &&
      (prompt.includes(pending.marker) ||
        (pending.inputSeen && !pending.queued))
    ) {
      this.startPrompt(pending.id);
      return;
    }
    if (this.observeSteers(prompt)) return;
    if (this.abortIfExpired(prompt)) return;
    // A person typing in the native TUI: hold parent work until the run settles.
    if (!this.status.activeAssignmentId && this.status.state === "idle") {
      this.status.state = "busy";
      this.flush();
    }
  }

  /** User `message_start`: the model context now contains this message. */
  onMessageStart(message: unknown): void {
    if (!this.ctx || this.stopped) return;
    const text = userMessageText(message);
    if (!text) return;
    const pending = this.pendingDelivery;
    // A prompt Pi queued behind another run starts here, without before_agent_start.
    if (pending && text.includes(pending.marker)) {
      this.startPrompt(pending.id);
      return;
    }
    if (this.observeSteers(text)) return;
    this.abortIfExpired(text);
  }

  onCompactionStart(): void {
    const pending = this.pendingDelivery;
    if (pending)
      pending.deadline = Math.max(
        pending.deadline,
        this.now() + COMPACTION_ALLOWANCE_MS,
      );
  }

  onCompactionEnd(): void {
    const pending = this.pendingDelivery;
    if (pending) pending.deadline = this.now() + this.confirmMs;
  }

  onActivity(): void {
    this.watchdog?.recordActivity();
    const inactivity = this.options.limits.maxInactivityMs;
    const heartbeatMs =
      inactivity > 0 ? Math.min(1_000, inactivity / 2) : 1_000;
    if (
      this.active()?.state === "running" &&
      this.now() - this.status.updatedAt >= heartbeatMs
    )
      this.flush();
  }

  onToolStart(toolName: string): void {
    this.watchdog?.recordActivity();
    if (toolName === SUBAGENT_YIELD_TOOL_NAME) return;
    const first = !this.status.toolActivity;
    this.status.toolActivity = true;
    const active = this.active();
    if (active) active.toolActivity = true;
    if (first || active) this.flush();
  }

  onMessageEnd(message: unknown): void {
    this.watchdog?.recordActivity();
    const active = this.active();
    const yielded = subagentYieldFromMessage(message);
    if (yielded) {
      if (active?.state === "running") this.run.yielded = yielded;
      return;
    }
    if (!message || typeof message !== "object") return;
    const msg = message as {
      role?: unknown;
      content?: unknown;
      usage?: unknown;
      model?: unknown;
      provider?: unknown;
      stopReason?: unknown;
      errorMessage?: unknown;
    };
    if (msg.role !== "assistant") return;
    const model =
      typeof msg.model === "string"
        ? typeof msg.provider === "string"
          ? `${msg.provider}/${msg.model}`
          : msg.model
        : undefined;
    addUsage(this.status.usage, msg.usage);
    this.status.usage.turns++;
    if (model) this.status.model = model;
    if (active?.state === "running") {
      addUsage(active.usage, msg.usage);
      active.usage.turns++;
      if (model) active.model = model;
      if (Array.isArray(msg.content)) {
        const text = msg.content
          .filter(
            (part): part is { type: "text"; text: string } =>
              !!part && part.type === "text" && typeof part.text === "string",
          )
          .map((part) => part.text)
          .join("\n");
        if (text.trim()) this.run.lastText = text;
      }
      if (typeof msg.stopReason === "string")
        this.run.stopReason = msg.stopReason;
      if (typeof msg.errorMessage === "string")
        this.run.errorMessage = msg.errorMessage;
    }
    this.flush();
  }

  /** agent_settled: Pi will not continue on its own, so the running assignment ends here. */
  onSettled(): void {
    if (!this.ctx || this.stopped) return;
    this.idleSince = undefined;
    this.abortRequestedAt = undefined;
    if (this.status.state === "stopping") {
      // A busy shutdown aborted first; Pi can now finish shutting down.
      this.ctx.shutdown();
      return;
    }
    const active = this.active();
    if (active?.state === "running") {
      const { state, outcome, modelError } = this.settleOutcome(active);
      if (modelError) active.modelError = true;
      this.finishActive(state, outcome, active.id);
      return;
    }
    if (!this.status.activeAssignmentId && this.status.state !== "held") {
      // Interactive or untracked runs end here; queued follow-ups may now start.
      this.status.state = "idle";
      this.deliverNext();
      this.flush();
    }
  }

  /** session_shutdown: record honest final states; nothing is replayed later. */
  onShutdown(reason?: string): void {
    if (this.shutdownRecorded) return;
    this.shutdownRecorded = true;
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
    this.dispose();
    this.flush(true);
  }

  dispose(): void {
    this.stopped = true;
    this.watchdog?.stop();
    this.watchdog = undefined;
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
  }

  // ------------------------------------------------------------ internals

  private every(ms: number, fn: () => void): void {
    const timer = setInterval(fn, ms);
    timer.unref?.();
    this.timers.push(timer);
  }

  /** The session is not the one the parent launched: stop consuming and shut down. */
  private detach(expected: string, actual: string): void {
    // Keep the parent's session id so the parent reads these final states.
    this.status.sessionId = expected;
    this.status.lastError = `Managed worker session changed from ${expected} to ${actual} (for example /new, /resume, or /fork); parent control is detached and the worker is stopping.`;
    this.terminalizeAll("Worker session was replaced");
    this.status.state = "stopping";
    this.flush();
    this.dispose();
    this.ctx?.abort();
    this.ctx?.shutdown();
  }

  private accept(message: ManagedInboxMessage): void {
    if (message.kind === "shutdown") {
      if (message.seq > this.options.controlFloorSeq) this.beginShutdown();
      return;
    }
    const preview = capped(message.text, MANAGED_MESSAGE_PREVIEW_BYTES).value;
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
    this.pushAssignment(assignment);
    if (message.seq <= this.options.resumeFloorSeq) {
      this.terminal(assignment, "cancelled", {
        source: "lifecycle",
        result:
          "Worker was resumed idle; this message was sent before the restart and was not delivered.",
      });
      return;
    }
    const active = this.active();
    const busy =
      active !== undefined ||
      this.pendingDelivery !== undefined ||
      this.status.state === "busy" ||
      !this.ctx!.isIdle();
    if (!busy) {
      this.deliver(assignment);
      return;
    }
    if (message.delivery === "auto" && active?.state === "running") {
      // Pending until the model receives the tagged message; never re-sent.
      assignment.disposition = "steer";
      assignment.state = "delivering";
      this.pendingSteers.add(assignment.id);
      try {
        this.options.sendUserMessage(
          formatSteerPrompt(active.id, assignment.id, message.text),
          { deliverAs: "steer" },
        );
      } catch (error) {
        this.pendingSteers.delete(assignment.id);
        this.terminal(assignment, "failed", {
          source: "error",
          result: `Steer delivery failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
      return;
    }
    assignment.disposition = "followUp";
    this.status.queue.push(assignment.id);
  }

  private deliver(assignment: ChildAssignment): void {
    const text = formatAssignmentPrompt(
      assignment.id,
      this.fullText(assignment),
    );
    assignment.state = "delivering";
    this.status.activeAssignmentId = assignment.id;
    this.status.state = "busy";
    this.pendingDelivery = {
      id: assignment.id,
      marker: assignmentMarker(assignment.id),
      inputSeen: false,
      queued: false,
      deadline: this.now() + this.confirmMs,
    };
    try {
      // followUp: if a run starts first (for example a person typing), Pi queues this
      // prompt behind it instead of rejecting it.
      this.options.sendUserMessage(text, { deliverAs: "followUp" });
    } catch (error) {
      this.finishActive(
        "failed",
        {
          source: "error",
          result: `Prompt delivery failed: ${error instanceof Error ? error.message : String(error)}`,
        },
        assignment.id,
      );
    }
  }

  /** Previews are capped; the inbox file keeps the full parent-authored text. */
  private fullText(assignment: ChildAssignment): string {
    const message = readInbox(this.paths.inbox).find(
      (entry) =>
        entry.kind === "assignment" && entry.assignmentId === assignment.id,
    );
    return message?.kind === "assignment" ? message.text : assignment.preview;
  }

  private deliverNext(): void {
    if (this.status.state === "held" || this.halted()) return;
    if (this.pendingDelivery || this.status.activeAssignmentId) return;
    while (this.status.queue.length > 0) {
      const id = this.status.queue.shift()!;
      const next = this.find(id);
      if (next && next.state === "accepted") {
        this.deliver(next);
        return;
      }
    }
    this.status.state = this.ctx?.isIdle() === false ? "busy" : "idle";
  }

  private startPrompt(id: string): void {
    this.pendingDelivery = undefined;
    const assignment = this.find(id);
    if (!assignment || assignment.state !== "delivering") return;
    this.closeSegment();
    this.begin(assignment);
  }

  /** Marks any tagged steer in `text` as received. Returns true when one matched. */
  private observeSteers(text: string): boolean {
    let matched = false;
    for (const id of [...this.pendingSteers]) {
      if (!text.includes(steerMarker(id))) continue;
      matched = true;
      this.pendingSteers.delete(id);
      const steer = this.find(id);
      if (!steer || steer.state !== "delivering") continue;
      const active = this.active();
      if (
        active?.state === "running" &&
        !this.run.yielded &&
        !this.run.timedOut
      ) {
        steer.state = "running";
        steer.mergedInto = active.id;
        steer.startedAt = this.now();
        this.flush();
        continue;
      }
      // The target already yielded (or nothing is running): the update is its own assignment.
      this.closeSegment();
      this.begin(steer);
    }
    return matched;
  }

  /** A prompt that missed its start deadline was reported failed; it must not run untracked. */
  private abortIfExpired(text: string): boolean {
    for (const id of this.expired) {
      if (!text.includes(assignmentMarker(id))) continue;
      this.expired.delete(id);
      this.abortRequestedAt = this.now();
      this.status.state = "busy";
      this.flush();
      this.ctx?.abort();
      return true;
    }
    return false;
  }

  /** Ends the running segment with what it captured so far; a new tagged message starts now. */
  private closeSegment(): void {
    const active = this.active();
    if (active?.state !== "running") return;
    const { state, outcome } = this.settleOutcome(active);
    this.finishActive(state, outcome, active.id, false);
  }

  private begin(assignment: ChildAssignment): void {
    assignment.state = "running";
    assignment.startedAt = this.now();
    this.status.activeAssignmentId = assignment.id;
    this.status.state = "busy";
    this.run = {};
    this.abortRequestedAt = undefined;
    this.armWatchdog();
    this.flush();
  }

  private checkDeliveryDeadline(now: number): void {
    const pending = this.pendingDelivery;
    if (!pending || pending.queued || now <= pending.deadline) return;
    const assignment = this.find(pending.id);
    this.pendingDelivery = undefined;
    if (!assignment || assignment.state !== "delivering") return;
    // Pi validates the model and credentials after the input echo and reports
    // failures only as an extension error, so a missing run start counts as a
    // model error and may trigger fallback.
    if (!this.status.toolActivity) assignment.modelError = true;
    this.expired.add(assignment.id);
    this.finishActive(
      "failed",
      {
        source: "error",
        result: `Pi did not start this assignment within ${this.confirmMs} ms; the prompt was likely rejected before the run began (for example no usable model or credentials).`,
      },
      assignment.id,
    );
  }

  /** Recovers when Pi is idle but the settle event never arrived (for example after an abort). */
  private checkMissedSettle(now: number): void {
    if (this.status.state !== "busy" || !this.ctx!.isIdle()) {
      this.idleSince = undefined;
      return;
    }
    this.idleSince ??= now;
    if (now - this.idleSince < this.graceMs) return;
    const active = this.active();
    if (active?.state === "running") {
      // Without our own abort, an idle gap may be a retry backoff; keep waiting for settle.
      if (this.abortRequestedAt === undefined) return;
      this.onSettled();
      return;
    }
    if (!this.pendingDelivery && !this.status.activeAssignmentId) {
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
  private checkDroppedMessages(now: number): void {
    const queuedPrompt = this.pendingDelivery?.queued
      ? this.pendingDelivery
      : undefined;
    const ctx = this.ctx!;
    if (
      (this.pendingSteers.size === 0 && !queuedPrompt) ||
      !ctx.isIdle() ||
      ctx.hasPendingMessages?.() !== false
    ) {
      this.quietSince = undefined;
      return;
    }
    this.quietSince ??= now;
    if (now - this.quietSince < this.graceMs) return;
    this.quietSince = undefined;
    const dropped = {
      source: "lifecycle" as const,
      result:
        "Pi discarded this message before the model received it (the run ended or was aborted first). It was not re-sent.",
    };
    for (const id of this.pendingSteers) {
      const steer = this.find(id);
      if (steer && !isTerminalAssignmentState(steer.state))
        this.terminal(steer, "cancelled", dropped);
    }
    this.pendingSteers.clear();
    if (queuedPrompt) this.finishActive("cancelled", dropped, queuedPrompt.id);
    else this.flush();
  }

  private settleOutcome(active: ChildAssignment): {
    state: TerminalAssignmentState;
    outcome: ManagedOutcome;
    modelError: boolean;
  } {
    const run = this.run;
    if (run.timedOut) {
      return {
        state: "timedOut",
        outcome: { source: "lifecycle", result: run.timedOut },
        modelError: false,
      };
    }
    if (run.yielded) {
      const result = capped(run.yielded.result, MANAGED_RESULT_PREVIEW_BYTES);
      return {
        state: run.yielded.status,
        outcome: {
          source: "yield",
          result: result.value,
          ...(result.truncated ? { truncated: true } : {}),
          ...(run.yielded.artifacts
            ? { artifacts: run.yielded.artifacts }
            : {}),
        },
        modelError: false,
      };
    }
    if (run.stopReason === "error" || run.stopReason === "aborted") {
      const result = capped(
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
        modelError: run.stopReason === "error" && !active.toolActivity,
      };
    }
    const result = capped(
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

  private finishActive(
    state: TerminalAssignmentState,
    outcome: ManagedOutcome,
    id: string,
    continueQueue = true,
  ): void {
    const assignment = this.find(id);
    if (assignment && !isTerminalAssignmentState(assignment.state))
      this.terminal(assignment, state, outcome);
    for (const merged of this.status.assignments) {
      if (merged.mergedInto === id && !isTerminalAssignmentState(merged.state))
        this.terminal(merged, state, outcome);
    }
    if (this.pendingDelivery?.id === id) this.pendingDelivery = undefined;
    if (this.status.activeAssignmentId === id) {
      delete this.status.activeAssignmentId;
      this.watchdog?.stop();
      this.watchdog = undefined;
      this.run = {};
    }
    const initial = this.status.assignments[0]?.id === id;
    if (
      this.options.holdOnInitialModelError &&
      initial &&
      assignment?.modelError &&
      !this.status.toolActivity
    ) {
      this.status.state = "held";
    } else if (continueQueue) {
      this.deliverNext();
    }
    this.flush();
  }

  private terminal(
    assignment: ChildAssignment,
    state: TerminalAssignmentState,
    outcome: ManagedOutcome,
  ): ChildAssignment {
    assignment.state = state;
    assignment.outcome = outcome;
    assignment.endedAt = this.now();
    try {
      if (this.status.sessionId)
        writeArchivedAssignment(
          this.paths.dir,
          this.status.sessionId,
          assignment,
        );
    } catch {
      this.status.lastError =
        "Could not persist the assignment result archive.";
    }
    return assignment;
  }

  /** Ends every unfinished assignment honestly: started work is interrupted, the rest cancelled. */
  private terminalizeAll(reason: string): void {
    for (const assignment of this.status.assignments) {
      if (isTerminalAssignmentState(assignment.state)) continue;
      if (assignment.state === "running")
        this.terminal(assignment, "interrupted", {
          source: "lifecycle",
          result: `${reason} before this assignment finished; it was not replayed.`,
        });
      else
        this.terminal(assignment, "cancelled", {
          source: "lifecycle",
          result: `${reason} before this assignment started; it was not delivered.`,
        });
    }
    this.status.queue = [];
    delete this.status.activeAssignmentId;
    this.pendingDelivery = undefined;
    this.pendingSteers.clear();
    this.watchdog?.stop();
    this.watchdog = undefined;
    this.run = {};
  }

  private armWatchdog(): void {
    this.watchdog?.stop();
    const { limits } = this.options;
    this.watchdog = createSubagentExecutionWatchdog(limits, (reason) => {
      this.run.timedOut = formatSubagentTimeoutMessage(reason, limits);
      this.abortRequestedAt = this.now();
      this.ctx?.abort();
    });
  }

  private beginShutdown(): void {
    if (this.status.state === "stopping" || this.stopped) return;
    this.status.state = "stopping";
    this.flush();
    // Interactive Pi defers shutdown until a run ends, so stop the run first.
    if (this.ctx && !this.ctx.isIdle()) this.ctx.abort();
    this.ctx?.shutdown();
  }

  private pushAssignment(assignment: ChildAssignment): void {
    this.status.assignments.push(assignment);
    const overflow =
      this.status.assignments.length - MANAGED_STATUS_ASSIGNMENT_LIMIT;
    if (overflow <= 0) return;
    // Keep the initial assignment (fallback policy) and drop the oldest terminal ones.
    let remaining = overflow;
    this.status.assignments = this.status.assignments.filter((entry, index) => {
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

  private find(id: string): ChildAssignment | undefined {
    return this.status.assignments.find((entry) => entry.id === id);
  }

  private active(): ChildAssignment | undefined {
    const id = this.status.activeAssignmentId;
    return id ? this.find(id) : undefined;
  }

  /** A disposed bridge no longer owns the status file (a reloaded or replacing bridge does). */
  private flush(final = false): void {
    if (this.stopped && !final) return;
    this.status.updatedAt = this.now();
    try {
      writeJsonAtomic(this.paths.status, this.status);
    } catch {
      // The next state change retries; a failed status write must not crash the worker.
    }
  }
}

function parseNonNegativeInt(name: string, value: string): number {
  const trimmed = value.trim();
  const parsed = /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
  if (!Number.isSafeInteger(parsed))
    throw new Error(
      `Managed worker environment is invalid: ${name} must be a non-negative integer.`,
    );
  return parsed;
}

function parseFlag(name: string, value: string): boolean {
  const trimmed = value.trim();
  if (trimmed !== "0" && trimmed !== "1")
    throw new Error(
      `Managed worker environment is invalid: ${name} must be 0 or 1.`,
    );
  return trimmed === "1";
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
  const value = (key: string) => env[key]?.trim() ?? "";
  if (MANAGED_ENV_KEYS.every((key) => !value(key))) return undefined;
  const missing = MANAGED_ENV_KEYS.filter((key) => !value(key));
  if (missing.length > 0)
    throw new Error(
      `Managed worker environment is incomplete: missing ${missing.join(", ")}. Managed workers must be launched by the parent's subagent runtime; unset the PI_MANAGED_SUBAGENT_* variables to run Pi normally.`,
    );
  const parentPid = parseNonNegativeInt(
    MANAGED_PARENT_PID_ENV,
    value(MANAGED_PARENT_PID_ENV),
  );
  return {
    dir: value(MANAGED_DIR_ENV),
    bootId: value(MANAGED_BOOT_ID_ENV),
    pid: process.pid,
    ...(parentPid > 0 ? { parentPid } : {}),
    expectedSessionId: value(MANAGED_SESSION_ID_ENV),
    waitForActivation: true,
    resumeFloorSeq: parseNonNegativeInt(
      MANAGED_RESUME_FLOOR_ENV,
      value(MANAGED_RESUME_FLOOR_ENV),
    ),
    controlFloorSeq: parseNonNegativeInt(
      MANAGED_CONTROL_FLOOR_ENV,
      value(MANAGED_CONTROL_FLOOR_ENV),
    ),
    freshAttempt: parseFlag(
      MANAGED_FRESH_ATTEMPT_ENV,
      value(MANAGED_FRESH_ATTEMPT_ENV),
    ),
    holdOnInitialModelError: parseFlag(
      MANAGED_HOLD_ON_MODEL_ERROR_ENV,
      value(MANAGED_HOLD_ON_MODEL_ERROR_ENV),
    ),
    limits: {
      maxRuntimeMs: parseNonNegativeInt(
        MANAGED_MAX_RUNTIME_ENV,
        value(MANAGED_MAX_RUNTIME_ENV),
      ),
      maxInactivityMs: parseNonNegativeInt(
        MANAGED_MAX_INACTIVITY_ENV,
        value(MANAGED_MAX_INACTIVITY_ENV),
      ),
    },
    sendUserMessage,
  };
}

function registerManagedYield(pi: ExtensionAPI): void {
  pi.registerTool({
    name: SUBAGENT_YIELD_TOOL_NAME,
    label: "Yield",
    description:
      "Return the current managed assignment's structured result. Ends this assignment only; the worker stays available for later assignments.",
    promptSnippet: "Yield the current managed assignment's structured result",
    promptGuidelines: [
      "Use yield exactly once per managed assignment, as the final action for that assignment.",
      "Set status to completed only when the assignment is complete; use blocked when external input or access is required, and failed when it could not be completed.",
      "Put the complete concise handoff in result and include only useful artifact paths.",
    ],
    parameters: Type.Object({
      status: StringEnum(["completed", "blocked", "failed"] as const, {
        description: "Outcome of the current assignment",
      }),
      result: Type.String({
        description: "Complete concise result for the parent agent",
      }),
      artifacts: Type.Optional(
        Type.Array(Type.String({ maxLength: 4096 }), {
          description: "Optional paths to useful files or artifacts",
          maxItems: 20,
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      const details: SubagentYieldDetails = {
        status: params.status,
        result: params.result,
        ...(params.artifacts ? { artifacts: params.artifacts } : {}),
      };
      return {
        content: [
          {
            type: "text",
            text: `Yielded managed assignment: ${params.status}`,
          },
        ],
        details,
        terminate: true,
      };
    },
  });
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
  registerManagedYield(pi);
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
