/**
 * Persistent managed workers: addressable, reusable Pi children that keep a
 * session between assignments. Live workers, locks, and slot leases are held
 * on `globalThis` so they survive extension reloads; each module revision
 * builds a fresh runtime over them. The runtime owns only the workers it
 * launched, persists parent-side state in `config.json`/inbox files, and reads
 * child-owned `status.json` (see `_managed-store.ts`).
 *
 * Hosting: in Herdr (HERDR_ENV=1 with a caller workspace) each worker is a
 * native interactive Pi in an unfocused extension-owned tab; elsewhere it is a
 * portable `pi --mode rpc` subprocess whose open stdin keeps it alive. Both
 * load the `_managed-child.ts` bridge, so control never depends on terminal
 * keystrokes or terminal text. Hosts live in `_managed-host*.ts`; lifecycle
 * decisions in `_managed-policy.ts`.
 */
import { randomBytes } from "node:crypto";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createKeyedMutex,
  type KeyedMutex,
  type SessionConcurrencyGate,
} from "./_concurrency.ts";
import type { AgentConfig } from "./_definition.ts";
import {
  buildChildSessionName,
  currentDelegationDepth,
  type DelegationTrace,
  delegationTraceEnvironment,
} from "./_delegation.ts";
import { formatAgentDisplayName } from "./_display.ts";
import { getPiInvocation } from "./_execution.ts";
import type { SubagentLimitsConfig } from "./_limits.ts";
import {
  defaultSleep,
  ManagedError,
  type ManagedHostPort,
  type ManagedHostProcess,
  type ManagedProcessIdentity,
  ManagedStartupError,
} from "./_managed-host.ts";
import { detectManagedHost } from "./_managed-host-herdr.ts";
import { encodeManagedBootEnv } from "./_managed-protocol.ts";
import {
  attemptSessionId,
  classifyUnplannedExit,
  holdsForFallback,
  type LaunchKind,
  nextCandidateStep,
  transition,
  UNEXPECTED_EXIT_MESSAGE,
  watchdogVerdict,
} from "./_managed-policy.ts";
import {
  type ChildAssignment,
  type ChildAssignmentState,
  type ChildStatus,
  type ChildWorkerState,
  ensurePrivateDir,
  enqueueInbox,
  isManagedHandle,
  isTerminalAssignmentState,
  listManagedHandles,
  MANAGED_MESSAGE_PREVIEW_BYTES,
  type ManagedAttempt,
  type ManagedConfig,
  type ManagedDelivery,
  type ManagedEnqueueResult,
  type ManagedInboxCommand,
  type ManagedIsolation,
  type ManagedLifecycle,
  type ManagedOutcome,
  type ManagedPaths,
  type ManagedPlacement,
  managedParentDir,
  managedPaths,
  readArchivedAssignment,
  readChildStatus,
  readInbox,
  readManagedConfig,
  readStderrTail,
  writeFileAtomic,
  writeJsonAtomic,
  writeManagedConfig,
} from "./_managed-store.ts";
import { errorText } from "./_parse.ts";
import {
  processStartIdentity,
  SubagentProcessRegistry,
} from "./_process-tree.ts";
import { truncateUtf8Head } from "./_text.ts";
import { emptyUsage, type UsageStats } from "./_usage.ts";
import { includeSubagentYieldTool } from "./_yield.ts";

export type { ManagedDelivery, ManagedIsolation } from "./_managed-store.ts";
export { isManagedChildProcess } from "./_managed-store.ts";
export { ManagedError } from "./_managed-host.ts";

// ------------------------------------------------------------------ contract

/** Everything the parent resolves before launch: identity, compute, place, trace. */
export interface ManagedLaunch {
  readonly agent: Pick<AgentConfig, "name" | "source" | "systemPrompt"> & {
    readonly emoji?: string;
    readonly tools?: readonly string[];
  };
  readonly profile?: string;
  /** Ordered model refs (may carry a `:thinking` suffix). Empty uses Pi's default model. */
  readonly modelCandidates: readonly string[];
  readonly cwd: string;
  /** Must describe a depth-1 child of this runtime's parent session. */
  readonly trace: DelegationTrace;
  /** First assignment, delivered exactly once after the worker starts. */
  readonly task: string;
  readonly isolation?: ManagedIsolation;
}

export type ManagedAssignmentState = ChildAssignmentState | "queued";

export interface ManagedAssignmentView {
  readonly handle: string;
  readonly id: string;
  readonly state: ManagedAssignmentState;
  readonly terminal: boolean;
  readonly preview: string;
  readonly disposition?: ChildAssignment["disposition"];
  readonly mergedInto?: string;
  readonly outcome?: ManagedOutcome;
  readonly usage: UsageStats;
  readonly toolActivity: boolean;
  readonly model?: string;
  readonly startedAt?: number;
  readonly endedAt?: number;
  /** Set when `wait` returned because its own deadline passed. */
  readonly waitTimedOut?: boolean;
}

/** A terminal result for automatic reporting; merged steers fold into their root. */
export interface ManagedResultView extends ManagedAssignmentView {
  readonly mergedUpdates?: readonly string[];
}

export interface ManagedWorkerView {
  readonly handle: string;
  readonly label: string;
  readonly agent: {
    readonly name: string;
    readonly emoji?: string;
    readonly source: "user" | "project";
  };
  readonly profile?: string;
  readonly model?: string;
  readonly modelCandidates: readonly string[];
  readonly candidateIndex: number;
  readonly attempts: readonly ManagedAttempt[];
  readonly lifecycle: ManagedLifecycle;
  readonly live: boolean;
  readonly childState?: ChildWorkerState;
  readonly hostKind: "herdr" | "rpc";
  readonly placement?: ManagedPlacement;
  readonly cwd: string;
  readonly dir: string;
  readonly sessionId: string;
  readonly sessionFile?: string;
  readonly usage: UsageStats;
  readonly toolActivity: boolean;
  readonly activeAssignmentId?: string;
  readonly queued: number;
  readonly lastAssignmentId: string;
  readonly lastError?: string;
  readonly createdAt: number;
  readonly recentAssignments: readonly ManagedAssignmentView[];
}

export interface ManagedRestoreResult {
  readonly handle: string;
  readonly restored: boolean;
  readonly error?: string;
}

export interface ManagedWaitOptions {
  readonly assignmentId?: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface ManagedRuntime {
  readonly parentSessionId: string;
  spawn(
    launch: ManagedLaunch,
    signal?: AbortSignal,
  ): Promise<{ handle: string; assignmentId: string }>;
  list(): ManagedWorkerView[];
  /**
   * Every reportable terminal result across owned workers. Excludes merged
   * steers, launch failures the spawn or resume call already returned, and
   * workers whose initial assignment awaits a fallback model.
   */
  listResults(): ManagedResultView[];
  status(handle: string): ManagedWorkerView;
  send(
    handle: string,
    message: string,
    delivery?: ManagedDelivery,
  ): { assignmentId: string; state: "queued" };
  wait(
    handle: string,
    options?: ManagedWaitOptions,
  ): Promise<ManagedAssignmentView>;
  stop(handle: string): Promise<ManagedWorkerView>;
  resume(handle: string): Promise<ManagedWorkerView>;
  suspendAll(): Promise<void>;
  restore(): Promise<ManagedRestoreResult[]>;
  open(handle: string): Promise<void>;
  /** Rebind after reload: moves live workers' slots to the current gate. */
  bind(gate: SessionConcurrencyGate, limits: SubagentLimitsConfig): void;
}

// --------------------------------------------------------------------- ports

export interface ManagedRuntimePorts {
  readonly host: ManagedHostPort;
  readonly now: () => number;
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly randomId: () => string;
  readonly parentPid: number;
  readonly bridgePath: string;
  readonly invocation: (args: string[]) => { command: string; args: string[] };
  /** Graceful shutdown window before forced tree cleanup. */
  readonly graceMs: number;
  readonly startupTimeoutMs: number;
  readonly pollMs: number;
  readonly processIdentity: (
    pid: number,
    aliveAt: number,
  ) => Promise<ManagedProcessIdentity>;
  /** How long resume waits for a surviving earlier boot to exit after asking it to stop. */
  readonly orphanExitTimeoutMs: number;
  /** Extra time past the runtime limit before the parent terminates a stuck worker. */
  readonly watchdogGraceMs: number;
}

export interface ManagedRuntimeOptions {
  readonly parentSessionId: string;
  readonly agentDir: string;
  readonly limits: SubagentLimitsConfig;
  readonly gate: SessionConcurrencyGate;
  readonly env?: NodeJS.ProcessEnv;
  readonly ports?: Partial<ManagedRuntimePorts>;
}

// ------------------------------------------------------------- pure helpers

const ASSIGNMENT_PREVIEW_COUNT = 5;

export function buildManagedSystemPrompt(
  agentPrompt: string,
  trace: DelegationTrace,
  limits: Pick<
    SubagentLimitsConfig,
    "maxDepth" | "maxConcurrency" | "maxChildrenPerCall"
  >,
): string {
  const delegationRule =
    trace.depth < limits.maxDepth
      ? `- You may use Pi subagents for bounded work. This worker may run at most ${limits.maxConcurrency} children at once and list at most ${limits.maxChildrenPerCall} children in one call.`
      : `- Do not invoke Pi subagents. Delegation depth ${limits.maxDepth} is the hard maximum.`;
  const boundary = [
    "## Managed Pi worker boundary",
    `You are a reusable managed Pi worker at delegation depth ${trace.depth} of the hard maximum ${limits.maxDepth}. The parent chat remains the orchestrator and sends you assignments over time.`,
    "- Never invoke or control herdr: do not use its skill, CLI, panes, agents, or socket.",
    delegationRule,
    '- Each assignment arrives tagged "[Managed assignment <id>]". Finish each one by calling the "yield" tool exactly once. Yield ends that assignment only; this session stays open for later assignments.',
    '- Messages tagged "[Update for managed assignment <id>]" adjust the assignment in progress.',
    "- Complete only the assigned scope and report blockers or follow-up work clearly.",
  ].join("\n");
  const prompt = agentPrompt.trim();
  return prompt ? `${prompt}\n\n${boundary}` : boundary;
}

export function buildManagedChildArgs(input: {
  readonly hostKind: "herdr" | "rpc";
  readonly bridgePath: string;
  readonly paths: ManagedPaths;
  readonly sessionId: string;
  readonly sessionName: string;
  readonly model?: string;
  readonly tools?: readonly string[];
  readonly isolation: ManagedIsolation;
  readonly depth: number;
  readonly maxDepth: number;
}): string[] {
  const args: string[] = input.hostKind === "rpc" ? ["--mode", "rpc"] : [];
  if (input.isolation.noExtensions) args.push("--no-extensions");
  if (input.isolation.noSkills) args.push("--no-skills");
  if (input.isolation.noContextFiles) args.push("--no-context-files");
  if (input.isolation.noPromptTemplates) args.push("--no-prompt-templates");
  // The bridge is explicit so it loads even with --no-extensions.
  args.push("--extension", input.bridgePath);
  args.push(
    "--session-dir",
    input.paths.sessionDir,
    "--session-id",
    input.sessionId,
  );
  args.push("--name", input.sessionName);
  if (input.model) args.push("--model", input.model);
  if (input.tools && input.tools.length > 0)
    args.push("--tools", includeSubagentYieldTool(input.tools).join(","));
  if (input.depth >= input.maxDepth) args.push("--exclude-tools", "subagent");
  args.push("--append-system-prompt", input.paths.systemPrompt);
  return args;
}

function toAssignmentView(
  handle: string,
  assignment: ChildAssignment,
): ManagedAssignmentView {
  return {
    handle,
    id: assignment.id,
    state: assignment.state,
    terminal: isTerminalAssignmentState(assignment.state),
    preview: assignment.preview,
    disposition: assignment.disposition,
    usage: assignment.usage,
    toolActivity: assignment.toolActivity,
    ...(assignment.mergedInto ? { mergedInto: assignment.mergedInto } : {}),
    ...(assignment.outcome ? { outcome: assignment.outcome } : {}),
    ...(assignment.model ? { model: assignment.model } : {}),
    ...(assignment.startedAt !== undefined
      ? { startedAt: assignment.startedAt }
      : {}),
    ...(assignment.endedAt !== undefined
      ? { endedAt: assignment.endedAt }
      : {}),
  };
}

/**
 * Parent-side view of one assignment. The child status is authoritative while
 * the worker lives; when it is gone, unfinished work is reported as
 * interrupted (never silently pending) and unread messages as cancelled.
 */
export function deriveAssignmentView(input: {
  readonly config: ManagedConfig;
  readonly status: ChildStatus | undefined;
  readonly archivedAssignment?: ChildAssignment;
  readonly inboxText: (
    assignmentId: string,
  ) => { seq: number; text: string } | undefined;
  /** Boot of the live worker, absent when none lives; recognizes a child whose session was replaced. */
  readonly liveBootId?: string;
  readonly assignmentId: string;
}): ManagedAssignmentView | undefined {
  const { config, assignmentId } = input;
  const live = input.liveBootId !== undefined;
  const raw = input.status;
  // The live boot reporting a session the parent did not launch, or stopping
  // itself with an error (for example after /new or /resume in its tab), has
  // detached; its work is never pending.
  const sameBoot =
    raw !== undefined &&
    input.liveBootId !== undefined &&
    raw.bootId === input.liveBootId;
  const detached =
    sameBoot &&
    (raw.sessionId !== config.sessionId ||
      ((raw.state === "stopping" || raw.state === "exited") &&
        raw.lastError !== undefined));
  const status =
    raw?.sessionId === config.sessionId || detached ? raw : undefined;
  const found =
    status?.assignments.find((entry) => entry.id === assignmentId) ??
    input.archivedAssignment;
  if (found) {
    const view = toAssignmentView(config.handle, found);
    if (view.terminal || (live && !detached)) return view;
    const reason = detached
      ? (raw?.lastError ?? "Worker session was replaced.")
      : config.lastError;
    return {
      ...view,
      state: "interrupted",
      terminal: true,
      outcome: {
        source: "lifecycle",
        result: `Worker stopped before this assignment finished; it was not replayed.${reason ? ` ${reason}` : ""}`,
      },
    };
  }
  const message = input.inboxText(assignmentId);
  if (!message) return undefined;
  const base = {
    handle: config.handle,
    id: assignmentId,
    preview: truncateUtf8Head(message.text, MANAGED_MESSAGE_PREVIEW_BYTES)
      .value,
    usage: emptyUsage(),
    toolActivity: false,
  };
  if (detached)
    return {
      ...base,
      state: "cancelled",
      terminal: true,
      outcome: {
        source: "lifecycle",
        result: `${raw?.lastError ?? "Worker session was replaced."} This message was not delivered.`,
      },
    };
  if (live) return { ...base, state: "queued", terminal: false };
  if (config.lifecycle === "failed")
    return {
      ...base,
      state: "failed",
      terminal: true,
      outcome: {
        source: "error",
        result: config.lastError ?? "Managed worker failed to start.",
      },
    };
  return {
    ...base,
    state: "cancelled",
    terminal: true,
    outcome: {
      source: "lifecycle",
      result: "Worker is not running; this message was not delivered.",
    },
  };
}

// ---------------------------------------------------------------- runtime

/** One held subagent slot; moves to a new gate when the session rebinds after reload. */
interface SlotLease {
  /** Gives the slot back. Idempotent. */
  release(): void;
  /** Gives the slot back to its current gate and holds one in `gate` instead. */
  transferTo(gate: SessionConcurrencyGate): void;
}

function leaseSlot(
  release: () => void,
  outstanding: Set<SlotLease>,
): SlotLease {
  let current: (() => void) | undefined = release;
  const lease: SlotLease = {
    release() {
      if (!current) return;
      const giveBack = current;
      current = undefined;
      outstanding.delete(lease);
      giveBack();
    },
    transferTo(gate) {
      if (!current) return;
      current();
      // acquire() reserves synchronously when a slot is free; the release
      // function arrives one microtask later.
      const pending = gate.acquire();
      current = () =>
        void pending.then(
          (giveBack) => giveBack(),
          () => {},
        );
    },
  };
  outstanding.add(lease);
  return lease;
}

/** What the parent intends for a live worker's exit; decides who records the lifecycle. */
type ExitIntent =
  | { readonly kind: "none" }
  /** The worker began stopping on its own and the host was asked to finish it. */
  | { readonly kind: "selfStopRequested" }
  /**
   * Planned exits (stop/suspend/fallback) set the lifecycle themselves. A
   * fallback keeps the slot for the next candidate's launch.
   */
  | { readonly kind: "planned"; readonly slot: "release" | "keep" }
  /** Why the parent forced this worker down, reported instead of a generic exit. */
  | { readonly kind: "killed"; readonly reason: string };

interface LiveWorker {
  readonly bootId: string;
  readonly process: ManagedHostProcess;
  readonly lease: SlotLease;
  intent: ExitIntent;
  readonly exitHandled: Promise<void>;
}

/**
 * Plain state that must outlive `/reload`. Each module revision builds its
 * own runtime over it, while exit handlers and watch loops started by earlier
 * revisions keep working on the same maps. Changing this shape requires a new
 * `RUNTIME_STATES` key.
 */
interface DurableRuntimeState {
  readonly live: Map<string, LiveWorker>;
  readonly locks: Map<string, Promise<unknown>>;
  /** Handles between a held model error and the next candidate's launch. */
  readonly relaunching: Set<string>;
  /** Every slot this parent holds: live workers and launches still in flight. */
  readonly leases: Set<SlotLease>;
  /** Replaced on rebind; loops read it on every pass so limits stay current. */
  binding: {
    readonly gate: SessionConcurrencyGate;
    readonly limits: SubagentLimitsConfig;
  };
}

/** One read of a worker's files and liveness, shared by every derivation in an operation. */
interface WorkerSnapshot {
  readonly config: ManagedConfig;
  readonly paths: ManagedPaths;
  readonly status: ChildStatus | undefined;
  readonly liveBootId: string | undefined;
  readonly relaunchMarked: boolean;
}

/** A held worker or one starting its next model candidate still owes the initial assignment. */
function isRelaunching(snapshot: WorkerSnapshot): boolean {
  if (snapshot.relaunchMarked || snapshot.config.lifecycle === "starting")
    return true;
  return (
    snapshot.liveBootId !== undefined &&
    snapshot.status?.bootId === snapshot.liveBootId &&
    snapshot.status.state === "held"
  );
}

/** The current session's status already records this assignment, so its archive is irrelevant. */
function inCurrentSession(
  snapshot: WorkerSnapshot,
  assignmentId: string,
): boolean {
  const { config, status } = snapshot;
  return (
    status?.sessionId === config.sessionId &&
    status.assignments.some((entry) => entry.id === assignmentId)
  );
}

function inboxIndex(
  paths: ManagedPaths,
): Map<string, { seq: number; text: string }> {
  const messages = new Map<string, { seq: number; text: string }>();
  for (const message of readInbox(paths.inbox))
    if (message.kind === "assignment")
      messages.set(message.assignmentId, {
        seq: message.seq,
        text: message.text,
      });
  return messages;
}

/** Reads the inbox at most once, and only if a derivation needs it. */
function lazyInboxText(
  paths: ManagedPaths,
): (assignmentId: string) => { seq: number; text: string } | undefined {
  let index: Map<string, { seq: number; text: string }> | undefined;
  return (assignmentId) => (index ??= inboxIndex(paths)).get(assignmentId);
}

const HOST_KIND: unique symbol = Symbol.for(
  "pi-simple-subagents.managed-host-kind",
);

class ManagedRuntimeImpl implements ManagedRuntime {
  /** Terminal results never change, so a worker's list is reused until its files or liveness do. */
  private readonly resultCache = new Map<
    string,
    { readonly key: string; readonly results: ManagedResultView[] }
  >();
  private readonly parentDir: string;
  private readonly withLock: KeyedMutex;

  constructor(
    readonly parentSessionId: string,
    agentDir: string,
    private readonly env: NodeJS.ProcessEnv,
    private readonly ports: ManagedRuntimePorts,
    private readonly state: DurableRuntimeState,
  ) {
    this.parentDir = managedParentDir(agentDir, parentSessionId);
    this.withLock = createKeyedMutex(state.locks);
  }

  get [HOST_KIND](): "herdr" | "rpc" {
    return this.ports.host.kind;
  }

  private get limits(): SubagentLimitsConfig {
    return this.state.binding.limits;
  }

  bind(gate: SessionConcurrencyGate, limits: SubagentLimitsConfig): void {
    const previous = this.state.binding.gate;
    this.state.binding = { gate, limits };
    if (gate === previous) return;
    for (const lease of this.state.leases) lease.transferTo(gate);
  }

  async spawn(
    launch: ManagedLaunch,
    signal?: AbortSignal,
  ): Promise<{ handle: string; assignmentId: string }> {
    if (currentDelegationDepth(this.env) !== 0 || launch.trace.depth !== 1)
      throw new ManagedError(
        "depth",
        "Managed workers can only be started by a top-level (depth 0) Pi session.",
      );
    if (launch.trace.parentSessionId !== this.parentSessionId)
      throw new ManagedError(
        "ownership",
        "Launch trace belongs to a different parent session.",
      );
    if (!launch.task.trim())
      throw new ManagedError(
        "invalid",
        "Managed worker task must not be empty.",
      );
    if (!path.isAbsolute(launch.cwd))
      throw new ManagedError("invalid", "Managed worker cwd must be absolute.");

    const lease = await this.reserveSlot(signal);
    const handle = `mw-${this.ports.randomId()}`;
    const paths = managedPaths(path.join(this.parentDir, handle));
    const assignmentId = `a-${this.ports.randomId()}`;
    const now = this.ports.now();
    const config: ManagedConfig = {
      v: 1,
      handle,
      parentSessionId: this.parentSessionId,
      createdAt: now,
      launch: {
        agent: {
          name: launch.agent.name,
          source: launch.agent.source,
          ...(launch.agent.emoji ? { emoji: launch.agent.emoji } : {}),
          ...(launch.agent.tools ? { tools: [...launch.agent.tools] } : {}),
        },
        modelCandidates: [...launch.modelCandidates],
        cwd: launch.cwd,
        trace: { ...launch.trace },
        isolation: { ...launch.isolation },
        taskPreview: truncateUtf8Head(
          launch.task,
          MANAGED_MESSAGE_PREVIEW_BYTES,
        ).value,
        ...(launch.profile ? { profile: launch.profile } : {}),
      },
      lifecycle: "starting",
      candidateIndex: 0,
      sessionId: attemptSessionId(handle, 0),
      attempts: [],
      nextSeq: 1,
      lastAssignmentId: assignmentId,
      updatedAt: now,
    };
    try {
      ensurePrivateDir(paths.dir);
      ensurePrivateDir(paths.inbox);
      writeFileAtomic(
        paths.systemPrompt,
        buildManagedSystemPrompt(
          launch.agent.systemPrompt,
          launch.trace,
          this.limits,
        ),
      );
      const first = enqueueInbox(
        paths.dir,
        config,
        {
          kind: "assignment",
          id: `m-${this.ports.randomId()}`,
          assignmentId,
          delivery: "auto",
          text: launch.task,
          createdAt: now,
        },
        this.ports.now(),
      );
      if (first.kind !== "enqueued") throw first.error;
    } catch (error) {
      lease.release();
      throw new ManagedError(
        "launch",
        `Could not create managed worker store: ${errorText(error)}`,
      );
    }
    await this.withLock(handle, () =>
      this.launch(config, lease, "initial", signal),
    );
    return { handle, assignmentId };
  }

  list(): ManagedWorkerView[] {
    return this.configs()
      .map((config) => this.view(this.snapshot(config)))
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  status(handle: string): ManagedWorkerView {
    return this.view(this.snapshot(this.ownedConfig(handle)));
  }

  listResults(): ManagedResultView[] {
    return this.configs()
      .sort((a, b) => a.createdAt - b.createdAt)
      .flatMap((config) => this.workerResults(this.snapshot(config)));
  }

  private workerResults(snapshot: WorkerSnapshot): ManagedResultView[] {
    // The failed attempt's results must not escape while a fallback still owes the work.
    if (isRelaunching(snapshot)) return [];
    const { config, paths, status, liveBootId } = snapshot;
    const key = [
      config.updatedAt,
      config.nextSeq,
      config.lifecycle,
      config.sessionId,
      status?.bootId,
      status?.updatedAt,
      liveBootId,
    ].join("\0");
    const cached = this.resultCache.get(config.handle);
    if (cached?.key === key) return cached.results;

    const messages = inboxIndex(paths);
    const views: ManagedAssignmentView[] = [];
    for (const assignmentId of messages.keys()) {
      const recordedInStatus = inCurrentSession(snapshot, assignmentId);
      const archivedAssignment = recordedInStatus
        ? undefined
        : readArchivedAssignment(paths.dir, config.sessionId, assignmentId);
      const recorded = recordedInStatus || archivedAssignment !== undefined;
      // A launch failure was already returned by the spawn or resume call.
      if (config.lifecycle === "failed" && !recorded) continue;
      const view = deriveAssignmentView({
        config,
        status,
        ...(archivedAssignment ? { archivedAssignment } : {}),
        inboxText: (id) => messages.get(id),
        ...(liveBootId !== undefined ? { liveBootId } : {}),
        assignmentId,
      });
      if (view?.terminal) views.push(view);
    }
    const merged = new Map<string, string[]>();
    for (const view of views)
      if (view.mergedInto)
        merged.set(view.mergedInto, [
          ...(merged.get(view.mergedInto) ?? []),
          view.id,
        ]);
    const results = views.flatMap((view): ManagedResultView[] => {
      if (view.mergedInto) return [];
      const mergedUpdates = merged.get(view.id);
      return [mergedUpdates ? { ...view, mergedUpdates } : view];
    });
    this.resultCache.set(config.handle, { key, results });
    return results;
  }

  send(
    handle: string,
    message: string,
    delivery: ManagedDelivery = "auto",
  ): { assignmentId: string; state: "queued" } {
    const config = this.ownedConfig(handle);
    if (!message.trim())
      throw new ManagedError("invalid", "Message must not be empty.");
    if (!this.state.live.has(handle) || config.lifecycle !== "running")
      throw new ManagedError(
        "not_running",
        `Managed worker ${handle} is ${config.lifecycle}; resume it before sending.`,
      );
    const assignmentId = `a-${this.ports.randomId()}`;
    const enqueued = this.enqueue(config, {
      kind: "assignment",
      id: `m-${this.ports.randomId()}`,
      assignmentId,
      delivery,
      text: message,
      createdAt: this.ports.now(),
    });
    if (enqueued.kind === "inboxWriteFailed") throw enqueued.error;
    return { assignmentId, state: "queued" };
  }

  async wait(
    handle: string,
    options: ManagedWaitOptions = {},
  ): Promise<ManagedAssignmentView> {
    const initial = this.ownedConfig(handle);
    const assignmentId = options.assignmentId ?? initial.lastAssignmentId;
    const deadline =
      options.timeoutMs !== undefined
        ? this.ports.now() + options.timeoutMs
        : undefined;
    for (;;) {
      const snapshot = this.snapshot(this.ownedConfig(handle));
      const view = this.assignment(snapshot, assignmentId);
      if (!view)
        throw new ManagedError(
          "not_found",
          `Unknown assignment ${assignmentId} for ${handle}.`,
        );
      // A worker relaunching on a fallback model still owes this assignment,
      // so the failed attempt's terminal state must not escape, even on timeout.
      const relaunching = view.terminal && isRelaunching(snapshot);
      if (view.terminal && !relaunching) return view;
      if (deadline !== undefined && this.ports.now() >= deadline) {
        if (!relaunching) return { ...view, waitTimedOut: true };
        const { outcome: _outcome, endedAt: _endedAt, ...pending } = view;
        return {
          ...pending,
          state: "queued",
          terminal: false,
          waitTimedOut: true,
        };
      }
      if (options.signal?.aborted)
        throw new ManagedError("aborted", "Managed wait was aborted.");
      await this.ports.sleep(this.ports.pollMs, options.signal);
    }
  }

  stop(handle: string): Promise<ManagedWorkerView> {
    this.ownedConfig(handle);
    return this.withLock(handle, async () => {
      await this.shutdown(handle, "stopped");
      return this.status(handle);
    });
  }

  resume(handle: string): Promise<ManagedWorkerView> {
    this.ownedConfig(handle);
    return this.withLock(handle, async () => {
      if (!this.state.live.has(handle))
        await this.resumeIdle(this.ownedConfig(handle));
      return this.status(handle);
    });
  }

  async suspendAll(): Promise<void> {
    await Promise.all(
      [...this.state.live.keys()].map((handle) =>
        this.withLock(handle, () => this.shutdown(handle, "suspended")),
      ),
    );
  }

  async restore(): Promise<ManagedRestoreResult[]> {
    const results: ManagedRestoreResult[] = [];
    for (const config of this.configs()) {
      if (this.state.live.has(config.handle)) continue;
      if (!["running", "suspended", "starting"].includes(config.lifecycle))
        continue;
      try {
        await this.withLock(config.handle, async () => {
          if (!this.state.live.has(config.handle))
            await this.resumeIdle(this.ownedConfig(config.handle));
        });
        results.push({ handle: config.handle, restored: true });
      } catch (error) {
        results.push({
          handle: config.handle,
          restored: false,
          error: errorText(error),
        });
      }
    }
    return results;
  }

  async open(handle: string): Promise<void> {
    const config = this.ownedConfig(handle);
    if (!this.state.live.has(handle) || config.placement?.kind !== "herdr")
      throw new ManagedError(
        "unsupported",
        `Managed worker ${handle} has no live Herdr tab to open.`,
      );
    await this.ports.host.focus(config.placement);
  }

  // ----------------------------------------------------------- internals

  private async reserveSlot(signal?: AbortSignal): Promise<SlotLease> {
    const { gate } = this.state.binding;
    // Fail fast: an idle worker holds its slot indefinitely, so waiting could never end.
    if (gate.status.available < 1)
      throw new ManagedError(
        "capacity",
        `No subagent slot is free (${gate.status.active}/${gate.status.limit} in use). Stop a managed worker or wait for bounded work to finish.`,
      );
    let release: () => void;
    try {
      release = await gate.acquire(signal);
    } catch (error) {
      throw new ManagedError(
        signal?.aborted ? "aborted" : "capacity",
        errorText(error),
      );
    }
    return leaseSlot(release, this.state.leases);
  }

  private async resumeIdle(config: ManagedConfig): Promise<void> {
    const lease = await this.reserveSlot();
    try {
      await this.awaitPreviousBootExit(config);
    } catch (error) {
      lease.release();
      throw error;
    }
    await this.launch(config, lease, "resume");
  }

  /**
   * A worker from an earlier parent process can outlive it (Herdr panes do).
   * A second boot would give the session two writers, so the survivor is asked
   * to stop and must be verifiably gone before anything new starts. Its slot
   * is already reserved, so the cap counts it meanwhile.
   */
  private async awaitPreviousBootExit(config: ManagedConfig): Promise<void> {
    const paths = managedPaths(this.dirOf(config.handle));
    const status = readChildStatus(paths.status);
    if (!status || !Number.isSafeInteger(status.pid) || status.pid <= 0) return;
    const { pid } = status;
    const identity = () => this.ports.processIdentity(pid, status.updatedAt);
    const first = await identity();
    if (first === "gone" || first === "other") return;
    if (first === "unknown")
      throw new ManagedError(
        "launch",
        `The previous boot of ${config.handle} (pid ${pid}) may still be running and cannot be verified on this platform. Stop that process, then resume.`,
      );
    // An inbox write failure is tolerated: the wait below fails safely if the
    // survivor never sees the request.
    this.enqueue(config, {
      kind: "shutdown",
      id: `m-${this.ports.randomId()}`,
      createdAt: this.ports.now(),
    });
    const deadline = this.ports.now() + this.ports.orphanExitTimeoutMs;
    while (this.ports.now() < deadline) {
      await this.ports.sleep(this.ports.pollMs);
      const current = await identity();
      if (current === "gone" || current === "other") return;
    }
    throw new ManagedError(
      "launch",
      `The previous boot of ${config.handle} (pid ${pid}) is still running and did not stop within ${this.ports.orphanExitTimeoutMs} ms; not starting a second copy. Close its Herdr tab or stop pid ${pid}, then resume.`,
    );
  }

  /** Launches one worker, walking model candidates only while nothing could have run. */
  private async launch(
    initial: ManagedConfig,
    lease: SlotLease,
    kind: LaunchKind,
    signal?: AbortSignal,
  ): Promise<void> {
    let config = initial;
    const paths = managedPaths(this.dirOf(config.handle));
    const firstAttempt = config.attempts.length;
    // Idle resume: never redeliver earlier messages, never fall back.
    const idleResume = kind === "resume";
    // Fresh model attempt: the child starts its inbox from zero in a new session.
    let fresh = kind === "fallback";
    for (;;) {
      const candidates = config.launch.modelCandidates;
      const model = candidates[config.candidateIndex];
      const hold = holdsForFallback(
        kind,
        config.candidateIndex,
        candidates.length,
      );
      const bootId = this.ports.randomId();
      const label = `${formatAgentDisplayName(config.launch.agent)} ${config.handle.slice(3, 9)}`;
      const args = buildManagedChildArgs({
        hostKind: this.ports.host.kind,
        bridgePath: this.ports.bridgePath,
        paths,
        sessionId: config.sessionId,
        sessionName: buildChildSessionName(
          formatAgentDisplayName(config.launch.agent),
          config.launch.taskPreview,
        ),
        ...(model ? { model } : {}),
        ...(config.launch.agent.tools
          ? { tools: config.launch.agent.tools }
          : {}),
        isolation: config.launch.isolation,
        depth: config.launch.trace.depth,
        maxDepth: this.limits.maxDepth,
      });
      const invocation = this.ports.invocation(args);
      const floor = Math.max(0, config.nextSeq - 1);
      const env: Record<string, string> = {
        ...delegationTraceEnvironment(config.launch.trace),
        ...encodeManagedBootEnv({
          dir: paths.dir,
          bootId,
          parentPid: this.ports.parentPid,
          expectedSessionId: config.sessionId,
          resumeFloorSeq: idleResume ? floor : 0,
          controlFloorSeq: floor,
          freshAttempt: fresh,
          holdOnInitialModelError: hold,
          limits: {
            maxRuntimeMs: this.limits.maxRuntimeMs,
            maxInactivityMs: this.limits.maxInactivityMs,
          },
        }),
      };

      let failure: string;
      let retryable = true;
      let aborted = false;
      let proc: ManagedHostProcess | undefined;
      try {
        if (signal?.aborted)
          throw new ManagedError(
            "aborted",
            "Managed worker launch was aborted.",
          );
        proc = await this.ports.host.launch({
          handle: config.handle,
          bootId,
          label,
          cwd: config.launch.cwd,
          command: invocation.command,
          args: invocation.args,
          piArgs: args,
          env,
          paths,
          ownedPlacements: [...this.state.live.values()].map(
            (worker) => worker.process.placement,
          ),
          readBootPid: () => {
            const status = readChildStatus(paths.status);
            return status?.bootId === bootId ? status.pid : undefined;
          },
          ...(signal ? { signal } : {}),
        });
        ({ failure, retryable } = await this.waitReady(
          paths,
          bootId,
          proc,
          signal,
        ));
      } catch (error) {
        failure = errorText(error);
        aborted = error instanceof ManagedError && error.code === "aborted";
        // Only failures a different model could fix walk to the next candidate.
        retryable = error instanceof ManagedStartupError && error.retryable;
      }
      if (proc && !failure) {
        this.track(config.handle, bootId, proc, lease);
        config = transition(config, {
          kind: "started",
          placement: proc.placement,
        });
        this.writeConfig(config);
        // Herdr must observe an idle prompt before the first task starts.
        writeJsonAtomic(paths.activation, { bootId });
        if (hold) void this.watchInitialAssignment(config.handle, bootId);
        return;
      }

      if (proc) await proc.terminate().catch(() => {});
      const status = readChildStatus(paths.status);
      const ran =
        status?.bootId === bootId &&
        (status.ackedSeq > 0 || status.toolActivity);
      const attempt: ManagedAttempt = {
        candidateIndex: config.candidateIndex,
        sessionId: config.sessionId,
        error: failure,
        ...(model ? { model } : {}),
      };
      const step = nextCandidateStep({
        launchKind: kind,
        aborted,
        retryable,
        ran,
        candidateIndex: config.candidateIndex,
        candidateCount: candidates.length,
      });
      if (step.kind === "advance") {
        config = transition(config, { kind: "candidateAdvanced", attempt });
        fresh = true;
        this.writeConfig(config);
        continue;
      }
      lease.release();
      config = transition(config, {
        kind: "launchFailed",
        attempt,
        error: failure,
      });
      this.writeConfig(config);
      const tried = config.attempts.slice(firstAttempt);
      const detail =
        tried.length > 1
          ? tried
              .map(
                (entry) => `${entry.model ?? "default model"}: ${entry.error}`,
              )
              .join("; ")
          : failure;
      throw new ManagedError(
        aborted ? "aborted" : "launch",
        `Managed worker ${config.handle} did not start: ${detail}`,
      );
    }
  }

  private async waitReady(
    paths: ManagedPaths,
    bootId: string,
    proc: ManagedHostProcess,
    signal?: AbortSignal,
  ): Promise<{ failure: string; retryable: boolean }> {
    let exited = false;
    void proc.exited.then(() => {
      exited = true;
    });
    // A host that already saw Pi's prompt only waits for the bridge to load.
    const timeoutMs = proc.readyConfirmed
      ? Math.min(this.ports.startupTimeoutMs, 10_000)
      : this.ports.startupTimeoutMs;
    const deadline = this.ports.now() + timeoutMs;
    for (;;) {
      const status = readChildStatus(paths.status);
      if (status?.bootId === bootId && status.state !== "starting") {
        return status.state === "exited" || status.state === "stopping"
          ? {
              failure: `Worker shut down during startup.${status.lastError ? ` ${status.lastError}` : ""}`,
              retryable: true,
            }
          : { failure: "", retryable: true };
      }
      if (exited)
        return {
          failure: `Worker exited before it was ready.${stderrTail(paths)}`,
          retryable: true,
        };
      // A hang is not model-specific; retrying would repeat the whole wait per candidate.
      if (this.ports.now() >= deadline)
        return {
          failure: `Worker was not ready within ${timeoutMs} ms.${stderrTail(paths)}`,
          retryable: false,
        };
      await this.ports.sleep(this.ports.pollMs, signal);
    }
  }

  private track(
    handle: string,
    bootId: string,
    proc: ManagedHostProcess,
    lease: SlotLease,
  ): void {
    let resolveHandled = () => {};
    const exitHandled = new Promise<void>((resolve) => {
      resolveHandled = resolve;
    });
    const worker: LiveWorker = {
      bootId,
      process: proc,
      lease,
      intent: { kind: "none" },
      exitHandled,
    };
    this.state.live.set(handle, worker);
    void proc.exited.then(() => {
      if (this.state.live.get(handle) === worker)
        this.state.live.delete(handle);
      const { intent } = worker;
      if (intent.kind !== "planned" || intent.slot === "release")
        worker.lease.release();
      if (intent.kind !== "planned") this.recordUnplannedExit(handle, worker);
      resolveHandled();
    });
    void this.watchWorker(handle, worker);
  }

  private recordUnplannedExit(handle: string, worker: LiveWorker): void {
    const config = this.readOwned(handle);
    if (!config || config.lifecycle !== "running") return;
    const paths = managedPaths(this.dirOf(handle));
    const exit = classifyUnplannedExit({
      killReason:
        worker.intent.kind === "killed" ? worker.intent.reason : undefined,
      status: readChildStatus(paths.status),
      bootId: worker.bootId,
      sessionId: config.sessionId,
    });
    const lastError =
      exit.kind === "clean"
        ? undefined
        : exit.kind === "failed"
          ? exit.reason
          : `${UNEXPECTED_EXIT_MESSAGE}${stderrTail(paths)}`;
    this.writeConfig(
      transition(config, {
        kind: "exitedUnplanned",
        ...(lastError !== undefined ? { lastError } : {}),
      }),
    );
  }

  /**
   * Parent-side backstop while a worker lives: completes a stop the child
   * began itself, and terminates a worker whose own runtime watchdog failed.
   */
  private async watchWorker(handle: string, worker: LiveWorker): Promise<void> {
    const paths = managedPaths(this.dirOf(handle));
    while (this.state.live.get(handle) === worker) {
      const status = readChildStatus(paths.status);
      let running = false;
      if (
        status?.bootId === worker.bootId &&
        worker.intent.kind !== "planned"
      ) {
        if (
          (status.state === "stopping" || status.state === "exited") &&
          worker.intent.kind === "none"
        ) {
          // RPC Pi acts on the bridge's shutdown only after its next command; EOF completes it.
          worker.intent = { kind: "selfStopRequested" };
          worker.process.requestStop?.();
        }
        const verdict = watchdogVerdict(
          status,
          this.limits,
          this.ports.now(),
          this.ports.watchdogGraceMs,
        );
        if (verdict.kind === "terminate") {
          worker.intent = { kind: "killed", reason: verdict.reason };
          await worker.process.terminate().catch(() => {});
          return;
        }
        running = verdict.kind === "running";
      }
      // Idle workers are checked rarely; their only job is noticing a self-stop.
      await this.ports.sleep(
        running ? this.ports.pollMs : this.ports.pollMs * 5,
      );
    }
  }

  /** Graceful shutdown through the inbox, then forced tree cleanup after the grace window. */
  private async shutdown(
    handle: string,
    lifecycle: "stopped" | "suspended",
  ): Promise<void> {
    await this.stopWorker(handle, lifecycle, "release");
  }

  /**
   * Shuts a worker down for a fallback relaunch and hands its slot to the
   * caller; undefined when no worker was live.
   */
  private shutdownKeepingSlot(handle: string): Promise<SlotLease | undefined> {
    // "starting" is durable: a reader that misses the in-memory mark still waits.
    return this.stopWorker(handle, "starting", "keep");
  }

  private async stopWorker(
    handle: string,
    lifecycle: "stopped" | "suspended" | "starting",
    slot: "release" | "keep",
  ): Promise<SlotLease | undefined> {
    const current = this.ownedConfig(handle);
    const worker = this.state.live.get(handle);
    if (!worker) {
      const next = transition(current, { kind: "shutdownIdle", lifecycle });
      if (next !== current) this.writeConfig(next);
      return undefined;
    }
    worker.intent = { kind: "planned", slot };
    const config = transition(current, {
      kind: "shutdownRequested",
      lifecycle,
    });
    // An inbox write failure is tolerated: forced cleanup below still runs.
    this.enqueue(config, {
      kind: "shutdown",
      id: `m-${this.ports.randomId()}`,
      createdAt: this.ports.now(),
    });
    worker.process.requestStop?.();
    const graceful = await Promise.race([
      worker.process.exited.then(() => true),
      this.ports.sleep(this.ports.graceMs).then(() => false),
    ]);
    if (!graceful || worker.process.placement.kind === "herdr")
      await worker.process.terminate().catch(() => {});
    await worker.process.exited;
    await worker.exitHandled;
    return slot === "keep" ? worker.lease : undefined;
  }

  private async watchInitialAssignment(
    handle: string,
    bootId: string,
  ): Promise<void> {
    const paths = managedPaths(this.dirOf(handle));
    while (this.state.live.get(handle)?.bootId === bootId) {
      const status = readChildStatus(paths.status);
      if (status?.bootId === bootId) {
        if (status.state === "held") {
          // Visible to wait() before the lock is taken, so no stale terminal view escapes.
          this.state.relaunching.add(handle);
          await this.withLock(handle, () =>
            this.fallback(handle, bootId, status),
          ).catch(() => {});
          return;
        }
        const first = status.assignments[0];
        if (first && isTerminalAssignmentState(first.state)) return;
        if (status.toolActivity) return;
      }
      await this.ports.sleep(this.ports.pollMs);
    }
  }

  /** Relaunch on the next candidate. Only reachable before any tool activity. */
  private async fallback(
    handle: string,
    bootId: string,
    status: ChildStatus,
  ): Promise<void> {
    try {
      if (this.state.live.get(handle)?.bootId !== bootId || status.toolActivity)
        return;
      const config = this.ownedConfig(handle);
      const first = status.assignments[0];
      const lease = await this.shutdownKeepingSlot(handle);
      if (!lease) return;
      const model =
        config.launch.modelCandidates[config.candidateIndex] ?? status.model;
      const next = transition(this.ownedConfig(handle), {
        kind: "candidateAdvanced",
        attempt: {
          candidateIndex: config.candidateIndex,
          sessionId: config.sessionId,
          error:
            first?.outcome?.result ?? "Model error before any tool activity.",
          ...(model ? { model } : {}),
        },
      });
      this.writeConfig(next);
      await this.launch(next, lease, "fallback");
    } finally {
      this.state.relaunching.delete(handle);
    }
  }

  private snapshot(config: ManagedConfig): WorkerSnapshot {
    const paths = managedPaths(this.dirOf(config.handle));
    return {
      config,
      paths,
      status: readChildStatus(paths.status),
      liveBootId: this.state.live.get(config.handle)?.bootId,
      relaunchMarked: this.state.relaunching.has(config.handle),
    };
  }

  private assignment(
    snapshot: WorkerSnapshot,
    assignmentId: string,
    inboxText = lazyInboxText(snapshot.paths),
  ): ManagedAssignmentView | undefined {
    const { config, paths, status, liveBootId } = snapshot;
    const archivedAssignment = inCurrentSession(snapshot, assignmentId)
      ? undefined
      : readArchivedAssignment(paths.dir, config.sessionId, assignmentId);
    return deriveAssignmentView({
      config,
      status,
      ...(archivedAssignment ? { archivedAssignment } : {}),
      inboxText,
      ...(liveBootId !== undefined ? { liveBootId } : {}),
      assignmentId,
    });
  }

  private view(snapshot: WorkerSnapshot): ManagedWorkerView {
    const { config, paths } = snapshot;
    const raw = snapshot.status;
    const status = raw?.sessionId === config.sessionId ? raw : undefined;
    const live = snapshot.liveBootId !== undefined;
    const inboxText = lazyInboxText(paths);
    const recent = (status?.assignments ?? [])
      .slice(-ASSIGNMENT_PREVIEW_COUNT)
      .flatMap((entry) => this.assignment(snapshot, entry.id, inboxText) ?? []);
    const model =
      status?.model ?? config.launch.modelCandidates[config.candidateIndex];
    // Pre-reload exit callbacks still write the old generic diagnostic.
    const cleanLegacyExit =
      !live &&
      config.lifecycle === "exited" &&
      status?.state === "exited" &&
      !status.lastError &&
      config.lastError?.startsWith(UNEXPECTED_EXIT_MESSAGE);
    const lastError = cleanLegacyExit ? undefined : config.lastError;
    return {
      handle: config.handle,
      label: formatAgentDisplayName(config.launch.agent),
      agent: config.launch.agent,
      modelCandidates: config.launch.modelCandidates,
      candidateIndex: config.candidateIndex,
      attempts: config.attempts,
      lifecycle: config.lifecycle,
      live,
      hostKind: config.placement?.kind ?? this.ports.host.kind,
      cwd: config.launch.cwd,
      dir: paths.dir,
      sessionId: config.sessionId,
      usage: status?.usage ?? emptyUsage(),
      toolActivity: status?.toolActivity ?? false,
      queued: status?.queue.length ?? 0,
      lastAssignmentId: config.lastAssignmentId,
      createdAt: config.createdAt,
      recentAssignments: recent,
      ...(config.launch.profile ? { profile: config.launch.profile } : {}),
      ...(model ? { model } : {}),
      ...(live && status ? { childState: status.state } : {}),
      ...(config.placement ? { placement: config.placement } : {}),
      ...(status?.sessionFile ? { sessionFile: status.sessionFile } : {}),
      ...(status?.activeAssignmentId
        ? { activeAssignmentId: status.activeAssignmentId }
        : {}),
      ...(lastError ? { lastError } : {}),
    };
  }
  private configs(): ManagedConfig[] {
    return listManagedHandles(this.parentDir).flatMap(
      (handle) => this.readOwned(handle) ?? [],
    );
  }

  private readOwned(handle: string): ManagedConfig | undefined {
    const config = readManagedConfig(managedPaths(this.dirOf(handle)).config);
    return config &&
      config.handle === handle &&
      config.parentSessionId === this.parentSessionId
      ? config
      : undefined;
  }

  private ownedConfig(handle: string): ManagedConfig {
    if (!isManagedHandle(handle))
      throw new ManagedError(
        "invalid",
        `Invalid managed worker handle: ${handle}`,
      );
    const config = readManagedConfig(managedPaths(this.dirOf(handle)).config);
    if (!config)
      throw new ManagedError("not_found", `Unknown managed worker ${handle}.`);
    if (
      config.parentSessionId !== this.parentSessionId ||
      config.handle !== handle
    )
      throw new ManagedError(
        "ownership",
        `Managed worker ${handle} belongs to a different parent session.`,
      );
    return config;
  }

  private dirOf(handle: string): string {
    return path.join(this.parentDir, handle);
  }

  private writeConfig(config: ManagedConfig): void {
    writeManagedConfig(this.dirOf(config.handle), config, this.ports.now());
  }

  /**
   * Queues one inbox command. A config write failure throws because nothing
   * was queued; an inbox write failure is returned for the caller to decide.
   */
  private enqueue(
    config: ManagedConfig,
    command: ManagedInboxCommand,
  ): Exclude<ManagedEnqueueResult, { kind: "configWriteFailed" }> {
    const result = enqueueInbox(
      this.dirOf(config.handle),
      config,
      command,
      this.ports.now(),
    );
    if (result.kind === "configWriteFailed") throw result.error;
    return result;
  }
}

function stderrTail(paths: ManagedPaths): string {
  const tail = readStderrTail(paths.stderr, 2048).trim();
  return tail ? ` stderr: ${tail}` : "";
}

// ------------------------------------------------------------ composition

const RUNTIME_STATES: unique symbol = Symbol.for(
  "pi-simple-subagents.managed-runtime-states.v1",
);
type RuntimeStateStore = typeof globalThis & {
  [RUNTIME_STATES]?: Map<string, DurableRuntimeState>;
};

/** One runtime per durable state within this module revision; a reload starts empty. */
const runtimes = new WeakMap<DurableRuntimeState, ManagedRuntimeImpl>();

function defaultPorts(
  env: NodeJS.ProcessEnv,
  overrides: Partial<ManagedRuntimePorts>,
): ManagedRuntimePorts {
  const pollMs = overrides.pollMs ?? 200;
  return {
    host:
      overrides.host ??
      detectManagedHost(env, new SubagentProcessRegistry(), pollMs),
    now: overrides.now ?? Date.now,
    sleep: overrides.sleep ?? defaultSleep,
    randomId: overrides.randomId ?? (() => randomBytes(6).toString("hex")),
    parentPid: overrides.parentPid ?? process.pid,
    bridgePath:
      overrides.bridgePath ??
      fileURLToPath(new URL("./_managed-child.ts", import.meta.url)),
    invocation: overrides.invocation ?? getPiInvocation,
    graceMs: overrides.graceMs ?? 5_000,
    startupTimeoutMs: overrides.startupTimeoutMs ?? 60_000,
    pollMs,
    processIdentity:
      overrides.processIdentity ??
      ((pid, aliveAt) => processStartIdentity(pid, aliveAt)),
    orphanExitTimeoutMs: overrides.orphanExitTimeoutMs ?? 15_000,
    watchdogGraceMs: overrides.watchdogGraceMs ?? 30_000,
  };
}

/**
 * Returns the runtime for one parent session. Within a module revision later
 * calls return the same runtime and only rebind the current gate and limits.
 * After `/reload` the new revision builds a fresh runtime (with its own ports
 * and host detection) over the durable state its predecessor left behind.
 */
export function getManagedRuntime(
  options: ManagedRuntimeOptions,
): ManagedRuntime {
  const store = globalThis as RuntimeStateStore;
  const states = (store[RUNTIME_STATES] ??= new Map());
  const key = `${path.resolve(options.agentDir)}\0${options.parentSessionId}`;
  let state = states.get(key);
  if (!state) {
    state = {
      live: new Map(),
      locks: new Map(),
      relaunching: new Set(),
      leases: new Set(),
      binding: { gate: options.gate, limits: options.limits },
    };
    states.set(key, state);
  }
  let runtime = runtimes.get(state);
  if (!runtime) {
    const env = options.env ?? process.env;
    runtime = new ManagedRuntimeImpl(
      options.parentSessionId,
      options.agentDir,
      env,
      defaultPorts(env, options.ports ?? {}),
      state,
    );
    runtimes.set(state, runtime);
  }
  runtime.bind(options.gate, options.limits);
  return runtime;
}

/** Host kind of a runtime from any module revision; undefined for other implementations. */
export function managedRuntimeHostKind(
  runtime: ManagedRuntime,
): "herdr" | "rpc" | undefined {
  // SAFETY: reads one optional symbol-keyed property; any other value is rejected below.
  const kind = (runtime as { readonly [HOST_KIND]?: unknown })[HOST_KIND];
  return kind === "herdr" || kind === "rpc" ? kind : undefined;
}
