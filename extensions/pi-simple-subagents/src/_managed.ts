/**
 * Persistent managed workers: addressable, reusable Pi children that keep a
 * session between assignments. The runtime is held on `globalThis` so it
 * survives extension reloads; it owns only the workers it launched, persists
 * parent-side state in `config.json`/inbox files, and reads child-owned
 * `status.json` (see `_managed-store.ts`).
 *
 * Hosting: in Herdr (HERDR_ENV=1 with a caller workspace) each worker is a
 * native interactive Pi in an unfocused extension-owned tab; elsewhere it is a
 * portable `pi --mode rpc` subprocess whose open stdin keeps it alive. Both
 * load the `_managed-child.ts` bridge, so control never depends on terminal
 * keystrokes or terminal text.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import type { SessionConcurrencyGate } from "./_concurrency.ts";
import type { AgentConfig } from "./_definition.ts";
import {
  buildChildSessionName,
  buildSubagentEnvironment,
  currentDelegationDepth,
  type DelegationTrace,
} from "./_delegation.ts";
import { formatAgentDisplayName } from "./_display.ts";
import { getPiInvocation } from "./_execution.ts";
import type { SubagentLimitsConfig } from "./_limits.ts";
import {
  type ChildAssignment,
  type ChildAssignmentState,
  type ChildStatus,
  type ChildWorkerState,
  emptyUsage,
  ensurePrivateDir,
  isManagedHandle,
  isTerminalAssignmentState,
  MANAGED_BOOT_ID_ENV,
  MANAGED_CONTROL_FLOOR_ENV,
  MANAGED_DIR_ENV,
  MANAGED_FRESH_ATTEMPT_ENV,
  MANAGED_HOLD_ON_MODEL_ERROR_ENV,
  MANAGED_MAX_INACTIVITY_ENV,
  MANAGED_MAX_RUNTIME_ENV,
  MANAGED_MESSAGE_PREVIEW_BYTES,
  MANAGED_PARENT_PID_ENV,
  MANAGED_RESUME_FLOOR_ENV,
  MANAGED_SESSION_ID_ENV,
  type ManagedAttempt,
  type ManagedConfig,
  type ManagedDelivery,
  type ManagedIsolation,
  type ManagedLifecycle,
  type ManagedOutcome,
  type ManagedPaths,
  type ManagedPlacement,
  type ManagedUsage,
  managedParentDir,
  managedPaths,
  readArchivedAssignment,
  readChildStatus,
  readInbox,
  readManagedConfig,
  writeFileAtomic,
  writeInboxMessage,
  writeJsonAtomic,
} from "./_managed-store.ts";
import { SubagentProcessRegistry } from "./_process-tree.ts";
import { truncateUtf8Head, truncateUtf8Tail } from "./_transcript.ts";
import { includeSubagentYieldTool } from "./_yield.ts";

export type {
  ManagedDelivery,
  ManagedIsolation,
  ManagedLifecycle,
  ManagedOutcome,
  ManagedPlacement,
  ManagedUsage,
} from "./_managed-store.ts";
export { isManagedChildProcess } from "./_managed-store.ts";

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

export type ManagedErrorCode =
  | "capacity"
  | "depth"
  | "ownership"
  | "not_found"
  | "not_running"
  | "invalid"
  | "launch"
  | "unsupported"
  | "aborted";

export class ManagedError extends Error {
  constructor(
    readonly code: ManagedErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ManagedError";
  }
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
  readonly usage: ManagedUsage;
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
  readonly usage: ManagedUsage;
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

export interface ManagedHostLaunch {
  readonly handle: string;
  readonly bootId: string;
  readonly label: string;
  readonly cwd: string;
  readonly command: string;
  readonly args: readonly string[];
  /** Pi CLI arguments alone; hosts that launch the installed `pi` themselves use these. */
  readonly piArgs: readonly string[];
  /** Managed and delegation variables only; hosts add their own base environment. */
  readonly env: Record<string, string>;
  readonly paths: ManagedPaths;
  /** Other live worker placements, used only to stack Herdr panes below owned siblings. */
  readonly ownedPlacements?: readonly ManagedPlacement[];
  /** Aborts a launch that is still waiting on the host. */
  readonly signal?: AbortSignal;
}

export interface ManagedHostProcess {
  readonly placement: ManagedPlacement;
  /** Resolves once the worker process is gone. */
  readonly exited: Promise<void>;
  /** Forced, idempotent process-tree and placement cleanup. */
  terminate(): Promise<void>;
  /**
   * Graceful stop the host can deliver itself (RPC: close stdin, which Pi
   * treats as shutdown even when the bridge's own shutdown request is deferred).
   */
  requestStop?(): void;
  /** The host already confirmed Pi reached its interactive prompt. */
  readonly readyConfirmed?: boolean;
}

/** Startup failures that a different model cannot fix are not retried on the next candidate. */
export class ManagedStartupError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "ManagedStartupError";
  }
}

/**
 * Whether `pid` is still the process that reported it at `aliveAt`: `match`
 * when it is alive and started no later than that report (a PID names one
 * process at a time), `other` when it started afterwards (PID reuse), `gone`
 * when nothing runs under it, `unknown` when that cannot be checked.
 */
export type ManagedProcessIdentity = "match" | "other" | "gone" | "unknown";

export interface ManagedHostPort {
  readonly kind: "herdr" | "rpc";
  launch(request: ManagedHostLaunch): Promise<ManagedHostProcess>;
  focus(placement: ManagedPlacement): Promise<void>;
}

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
  readonly live: boolean;
  /** Boot of the live worker; recognizes a child whose session was replaced. */
  readonly liveBootId?: string;
  readonly assignmentId: string;
}): ManagedAssignmentView | undefined {
  const { config, live, assignmentId } = input;
  const raw = input.status;
  // The live boot reporting a session the parent did not launch, or stopping
  // itself with an error (for example after /new or /resume in its tab), has
  // detached; its work is never pending.
  const sameBoot =
    live &&
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

// ---------------------------------------------------------------- hosts

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: unknown }).code === "EPERM";
  }
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ManagedError("aborted", "Managed wait was aborted."));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    const onAbort = () => {
      clearTimeout(timer);
      reject(new ManagedError("aborted", "Managed wait was aborted."));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Tracks a worker PID that this process did not spawn (Herdr pane children). */
function registerForeignPid(registry: SubagentProcessRegistry, pid: number) {
  // SAFETY: SubagentProcessRegistry.register reads only `proc.pid`; the pane
  // shell owns the real ChildProcess. Replace with a registerPid API if added.
  return registry.register({ pid } as ChildProcess, false);
}

function withoutHerdrEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result = { ...env };
  for (const key of Object.keys(result)) {
    if (key.toUpperCase().startsWith("HERDR_")) delete result[key];
  }
  return result;
}

const RPC_DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);
const RPC_RECORD_PREFIXES = [
  '{"type":"extension_ui_request"',
  '{"type":"extension_error"',
];
const RPC_PREFIX_PROBE = Math.max(
  ...RPC_RECORD_PREFIXES.map((prefix) => prefix.length),
);
// Dialog requests can carry an editor prefill; anything larger is not a record we act on.
const RPC_MAX_RECORD_CHARS = 1024 * 1024;
const RPC_DIAGNOSTIC_ENTRY_BYTES = 512;
const RPC_DIAGNOSTIC_TOTAL_BYTES = 64 * 1024;

/**
 * Strict LF-delimited JSONL reader for Pi RPC stdout. Readline is unsuitable
 * because JSON strings may contain U+2028/U+2029. Only records the host acts
 * on are buffered and parsed; transcript events stream past unkept.
 */
export function createRpcRecordReader(
  onRecord: (record: Record<string, unknown>) => void,
): { push(chunk: Buffer | string): void; end(): void } {
  const decoder = new StringDecoder("utf8");
  let line = "";
  let skipping = false;
  const wanted = (text: string) =>
    RPC_RECORD_PREFIXES.some((prefix) => text.startsWith(prefix));
  const finish = () => {
    const text = line.endsWith("\r") ? line.slice(0, -1) : line;
    const keep = !skipping && wanted(text);
    line = "";
    skipping = false;
    if (!keep) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      onRecord(parsed as Record<string, unknown>);
  };
  const consume = (text: string) => {
    let start = 0;
    for (;;) {
      const newline = text.indexOf("\n", start);
      if (!skipping) {
        line += newline === -1 ? text.slice(start) : text.slice(start, newline);
        if (
          line.length > RPC_MAX_RECORD_CHARS ||
          (line.length >= RPC_PREFIX_PROBE && !wanted(line))
        ) {
          line = "";
          skipping = true;
        }
      }
      if (newline === -1) return;
      finish();
      start = newline + 1;
    }
  };
  return {
    push: (chunk) =>
      consume(typeof chunk === "string" ? chunk : decoder.write(chunk)),
    end: () => {
      consume(decoder.end());
      if (line) finish();
      line = "";
      skipping = false;
    },
  };
}

/** Bounded diagnostics appended to the worker's stderr log, which startup and exit errors quote. */
function createDiagnosticLog(file: string): (entry: string) => void {
  let written = 0;
  return (entry) => {
    if (written >= RPC_DIAGNOSTIC_TOTAL_BYTES) return;
    const text = truncateUtf8Head(
      entry.replace(/\s+/g, " "),
      RPC_DIAGNOSTIC_ENTRY_BYTES,
    ).value;
    const line = `[managed rpc] ${text}\n`;
    written += Buffer.byteLength(line);
    try {
      fs.appendFileSync(file, line, { mode: 0o600 });
    } catch {
      // Diagnostics are best effort.
    }
  };
}

/**
 * Acts on RPC records a headless worker would otherwise hang on or hide:
 * dialogs are cancelled (never approved) and extension errors are logged.
 * Notification and dialog contents are not copied anywhere.
 */
export function handleRpcRecord(
  record: Record<string, unknown>,
  respond: (response: Record<string, unknown>) => void,
  log: (entry: string) => void,
): void {
  if (record.type === "extension_error") {
    const where = [
      typeof record.event === "string" ? `in ${record.event}` : "",
      typeof record.extensionPath === "string"
        ? `(${path.basename(record.extensionPath)})`
        : "",
    ]
      .filter(Boolean)
      .join(" ");
    const error =
      typeof record.error === "string" ? record.error : "unknown error";
    log(`extension error${where ? ` ${where}` : ""}: ${error}`);
    return;
  }
  if (record.type !== "extension_ui_request" || typeof record.id !== "string")
    return;
  const method = typeof record.method === "string" ? record.method : "";
  if (RPC_DIALOG_METHODS.has(method)) {
    respond({ type: "extension_ui_response", id: record.id, cancelled: true });
    log(`cancelled a ${method} dialog; managed workers cannot answer prompts`);
    return;
  }
  if (method === "notify" && record.notifyType === "error")
    log("an extension reported an error notification");
}

/** JSONL writer that honors stdin backpressure and drops output once the pipe fails. */
function createStdinWriter(stdin: NodeJS.WritableStream | null | undefined): {
  send(value: unknown): void;
  end(): void;
} {
  const queue: string[] = [];
  let waiting = false;
  let ending = false;
  let closed = !stdin;
  const pump = () => {
    if (!stdin || closed) {
      queue.length = 0;
      return;
    }
    while (!waiting && queue.length > 0) {
      if (!stdin.write(queue.shift()!)) {
        waiting = true;
        stdin.once("drain", () => {
          waiting = false;
          pump();
        });
      }
    }
    if (!waiting && ending) {
      closed = true;
      stdin.end();
    }
  };
  stdin?.on("error", () => {
    closed = true;
    queue.length = 0;
  });
  stdin?.on("close", () => {
    closed = true;
  });
  return {
    send(value) {
      if (closed || ending) return;
      queue.push(`${JSON.stringify(value)}\n`);
      pump();
    },
    end() {
      if (closed || ending) return;
      ending = true;
      pump();
    },
  };
}

export function createRpcHost(
  registry: SubagentProcessRegistry,
): ManagedHostPort {
  return {
    kind: "rpc",
    async launch(request) {
      if (request.signal?.aborted)
        throw new ManagedError("aborted", "Managed worker launch was aborted.");
      const stderrFd = fs.openSync(request.paths.stderr, "a", 0o600);
      const isolated = process.platform !== "win32";
      let proc: ChildProcess;
      try {
        proc = spawn(request.command, [...request.args], {
          cwd: request.cwd,
          env: { ...withoutHerdrEnvironment(process.env), ...request.env },
          detached: isolated,
          shell: false,
          // Open stdin keeps RPC mode alive; EOF (including parent death) is its shutdown request.
          stdio: ["pipe", "pipe", stderrFd],
        });
      } finally {
        fs.closeSync(stderrFd);
      }
      const writer = createStdinWriter(proc.stdin);
      const log = createDiagnosticLog(request.paths.stderr);
      const reader = createRpcRecordReader((record) =>
        handleRpcRecord(record, (response) => writer.send(response), log),
      );
      // Consuming stdout keeps Pi from blocking on a full pipe.
      proc.stdout?.on("data", (chunk: Buffer) => reader.push(chunk));
      proc.stdout?.on("end", () => reader.end());
      proc.stdout?.on("error", () => {});
      const registered = registry.register(proc, isolated);
      const exited = new Promise<void>((resolve) => {
        proc.once("close", () => resolve());
        proc.once("error", () => resolve());
      }).then(() => registered.complete());
      return {
        placement: {
          kind: "rpc",
          ...(proc.pid !== undefined ? { pid: proc.pid } : {}),
        },
        exited,
        requestStop: () => writer.end(),
        async terminate() {
          writer.end();
          registered.terminate();
          await Promise.race([exited, registered.done]);
          await registered.done;
        },
      };
    },
    async focus() {
      throw new ManagedError(
        "unsupported",
        "Native TUI attachment is only available when Pi runs inside Herdr.",
      );
    },
  };
}

export interface HerdrExecOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface HerdrHostOptions {
  readonly parentPaneId: string;
  readonly tabId: string;
  readonly bin: string;
  readonly exec: (
    bin: string,
    args: readonly string[],
    options?: HerdrExecOptions,
  ) => Promise<string>;
  readonly registry: SubagentProcessRegistry;
  readonly isPidAlive: (pid: number) => boolean;
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly pollMs: number;
  /**
   * Non-secret parent configuration the pane needs; pane shells inherit the
   * Herdr server's environment, not this process's.
   */
  readonly forwardEnv?: Readonly<Record<string, string>>;
  /** `herdr agent start --timeout`: how long Pi may take to reach its prompt. */
  readonly startTimeoutMs?: number;
}

const HERDR_START_TIMEOUT_MS = 15_000;
const HERDR_PANE_BUSY_RETRIES = 30;
const HERDR_PANE_BUSY_DELAY_MS = 100;

/**
 * Pi configuration safe to forward into a pane. Provider credentials and
 * per-session variables stay out: Herdr `--env` values are visible in process
 * listings and persisted in the pane's shell.
 */
const HERDR_FORWARD_ENV_KEYS = [
  "PI_CODING_AGENT_DIR",
  "PI_PACKAGE_DIR",
  "PI_OFFLINE",
  "PI_SKIP_VERSION_CHECK",
  "PI_TELEMETRY",
  "PI_CACHE_RETENTION",
] as const;

export function herdrForwardEnvironment(
  env: NodeJS.ProcessEnv,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of HERDR_FORWARD_ENV_KEYS) {
    const value = env[key];
    if (value) result[key] = value;
  }
  return result;
}

/** Herdr's structured failure (`{"error":{"code","message"}}`); raw command lines are never quoted. */
export class HerdrCommandError extends Error {
  constructor(
    readonly code: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = "HerdrCommandError";
  }
}

export function parseHerdrError(
  output: string,
): { code: string; message: string } | undefined {
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const error = (
        JSON.parse(trimmed) as {
          error?: { code?: unknown; message?: unknown };
        }
      )?.error;
      if (typeof error?.code === "string" && typeof error.message === "string")
        return {
          code: error.code,
          message: truncateUtf8Head(error.message, 500).value,
        };
    } catch {
      // Not a Herdr response line.
    }
  }
  return undefined;
}

/** Herdr agent names: a lowercase letter, then up to 31 of `[a-z0-9_-]`. */
export function herdrAgentName(handle: string, bootId: string): string {
  const clean = (value: string) =>
    value.toLowerCase().replace(/[^a-z0-9]/g, "");
  return `mw-${clean(handle.replace(/^mw-/, "")).slice(0, 12)}-${clean(bootId).slice(0, 12)}`.slice(
    0,
    32,
  );
}

function herdrStartupError(error: unknown, timeoutMs: number): Error {
  if (error instanceof ManagedError) return error;
  const code = error instanceof HerdrCommandError ? error.code : undefined;
  if (code === "agent_start_failed")
    return new ManagedStartupError(
      `Pi exited before it was ready. ${errorText(error)}`,
      true,
    );
  if (code === "agent_not_ready")
    return new ManagedStartupError(
      "Pi is blocked during startup, for example on a trust or permission prompt. Managed workers never approve prompts; run pi once in this directory to resolve it, then retry.",
      false,
    );
  if (code === "timeout")
    return new ManagedStartupError(
      `Pi did not reach its prompt within ${Math.round(timeoutMs / 1000)} s.`,
      false,
    );
  return new ManagedStartupError(errorText(error), false);
}

function parseHerdrPane(
  stdout: string,
  fallbackTabId: string,
): { tabId: string; paneId: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error("herdr pane split returned non-JSON output");
  }
  const pane = (
    parsed as { result?: { pane?: { pane_id?: unknown; tab_id?: unknown } } }
  )?.result?.pane;
  const paneId = pane?.pane_id;
  const tabId = pane?.tab_id ?? fallbackTabId;
  if (typeof paneId !== "string" || !paneId)
    throw new Error("herdr pane split did not return a pane ID");
  if (typeof tabId !== "string" || !tabId)
    throw new Error("herdr pane split did not identify its tab");
  return { tabId, paneId };
}

function isMissingHerdrPane(error: unknown): boolean {
  return error instanceof HerdrCommandError && error.code === "pane_not_found";
}

function isHerdrPaneBusy(error: unknown): boolean {
  return error instanceof HerdrCommandError && error.code === "agent_pane_busy";
}

/** Herdr placement: extension-owned panes stacked below the caller. */
export function createHerdrHost(options: HerdrHostOptions): ManagedHostPort {
  let allocationTail: Promise<void> = Promise.resolve();
  const pendingPanes: string[] = [];
  const serializeAllocation = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = allocationTail.then(operation, operation);
    allocationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const forgetPendingPane = (paneId: string) => {
    const index = pendingPanes.indexOf(paneId);
    if (index >= 0) pendingPanes.splice(index, 1);
  };
  const allocatePane = (request: ManagedHostLaunch) =>
    serializeAllocation(async () => {
      const owned = (request.ownedPlacements ?? []).flatMap((placement) =>
        placement.kind === "herdr" && placement.tabId === options.tabId
          ? [placement.paneId]
          : [],
      );
      const ownedSet = new Set(owned);
      // Keep split order even when agent readiness completes out of order.
      const issued = new Set(pendingPanes);
      const inherited = owned.filter((paneId) => !issued.has(paneId));
      const anchors = [...inherited, ...pendingPanes].reverse();
      anchors.push(options.parentPaneId);
      const env = { ...options.forwardEnv, ...request.env };
      const envArgs = Object.entries(env).flatMap(([key, value]) => [
        "--env",
        `${key}=${value}`,
      ]);
      let lastMissingAnchor: unknown;
      for (const anchorPaneId of anchors) {
        let stdout: string;
        try {
          stdout = await options.exec(
            options.bin,
            [
              "pane",
              "split",
              "--pane",
              anchorPaneId,
              "--direction",
              "down",
              "--cwd",
              request.cwd,
              "--no-focus",
              ...envArgs,
            ],
            request.signal ? { signal: request.signal } : {},
          );
        } catch (error) {
          if (!isMissingHerdrPane(error)) throw error;
          lastMissingAnchor = error;
          forgetPendingPane(anchorPaneId);
          continue;
        }
        // A successful split must return a new pane, never the parent or an existing child.
        const pane = parseHerdrPane(stdout, options.tabId);
        if (
          pane.paneId === options.parentPaneId ||
          ownedSet.has(pane.paneId) ||
          pendingPanes.includes(pane.paneId)
        )
          throw new Error("herdr pane split did not return a new pane ID");
        if (pane.tabId !== options.tabId) {
          await options
            .exec(options.bin, ["pane", "close", pane.paneId])
            .catch(() => undefined);
          throw new Error("herdr pane split returned a pane in another tab");
        }
        pendingPanes.push(pane.paneId);
        return { kind: "herdr", ...pane, layout: "split" as const };
      }
      throw (
        lastMissingAnchor ?? new Error("no valid Herdr split anchor remains")
      );
    });
  return {
    kind: "herdr",
    async launch(request) {
      const startTimeoutMs = options.startTimeoutMs ?? HERDR_START_TIMEOUT_MS;
      let pane: { tabId: string; paneId: string; layout: "split" };
      try {
        pane = await allocatePane(request);
      } catch (error) {
        throw herdrStartupError(error, startTimeoutMs);
      }
      const closePane = () =>
        options.exec(options.bin, ["pane", "close", pane.paneId]).then(
          () => undefined,
          () => undefined,
        );
      const startArgs = [
        "agent",
        "start",
        herdrAgentName(request.handle, request.bootId),
        "--kind",
        "pi",
        "--pane",
        pane.paneId,
        "--timeout",
        String(startTimeoutMs),
        "--",
        ...request.piArgs,
      ];
      try {
        // Keep the activation handshake before the parent delivers its first assignment.
        for (let attempt = 0; attempt < HERDR_PANE_BUSY_RETRIES; attempt++) {
          if (request.signal?.aborted)
            throw new ManagedError(
              "aborted",
              "Managed worker launch was aborted.",
            );
          try {
            await options.exec(options.bin, startArgs, {
              timeoutMs: startTimeoutMs + 10_000,
              ...(request.signal ? { signal: request.signal } : {}),
            });
            break;
          } catch (error) {
            if (
              !isHerdrPaneBusy(error) ||
              attempt === HERDR_PANE_BUSY_RETRIES - 1
            )
              throw error;
            await options.sleep(HERDR_PANE_BUSY_DELAY_MS, request.signal);
          }
        }
      } catch (error) {
        forgetPendingPane(pane.paneId);
        await closePane();
        throw herdrStartupError(error, startTimeoutMs);
      }
      let pid: number | undefined;
      let finished = false;
      let resolveExited = () => {};
      let terminatePromise: Promise<void> | undefined;
      const exited = new Promise<void>((resolve) => {
        resolveExited = () => {
          finished = true;
          resolve();
        };
      });
      // The bridge reports its own PID; liveness is that process, not terminal text.
      void (async () => {
        while (!finished) {
          if (pid === undefined) {
            const status = readChildStatus(request.paths.status);
            if (status?.bootId === request.bootId) pid = status.pid;
          }
          if (pid !== undefined && !options.isPidAlive(pid)) {
            forgetPendingPane(pane.paneId);
            resolveExited();
            return;
          }
          await options.sleep(options.pollMs);
        }
      })();
      return {
        placement: { kind: "herdr", ...pane },
        readyConfirmed: true,
        exited,
        async terminate() {
          if (terminatePromise) return terminatePromise;
          terminatePromise = (async () => {
            if (pid !== undefined && options.isPidAlive(pid)) {
              const registered = registerForeignPid(options.registry, pid);
              registered.terminate();
              await registered.done;
            }
            forgetPendingPane(pane.paneId);
            await closePane();
            resolveExited();
          })();
          await terminatePromise;
        },
      };
    },
    async focus(placement) {
      if (placement.kind !== "herdr")
        throw new ManagedError("unsupported", "Worker is not hosted in Herdr.");
      await options.exec(options.bin, ["agent", "focus", placement.paneId]);
    },
  };
}

function execFileText(
  bin: string,
  args: readonly string[],
  options: HerdrExecOptions = {},
): Promise<string> {
  const what = `herdr ${args.slice(0, 2).join(" ")}`;
  const aborted = () =>
    new ManagedError("aborted", "Managed worker launch was aborted.");
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(aborted());
      return;
    }
    execFile(
      bin,
      [...args],
      {
        encoding: "utf8",
        timeout: options.timeoutMs ?? 15_000,
        maxBuffer: 4 * 1024 * 1024,
        ...(options.signal ? { signal: options.signal } : {}),
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve(stdout);
          return;
        }
        if (options.signal?.aborted) {
          reject(aborted());
          return;
        }
        const parsed = parseHerdrError(stderr) ?? parseHerdrError(stdout);
        if (parsed) {
          reject(
            new HerdrCommandError(
              parsed.code,
              `${what} failed: ${parsed.message}`,
            ),
          );
          return;
        }
        // Node's own message quotes the command line, which carries --env values.
        const failure = error as { killed?: boolean; code?: unknown };
        reject(
          failure.killed
            ? new HerdrCommandError("timeout", `${what} timed out.`)
            : new HerdrCommandError(
                undefined,
                `${what} failed${typeof failure.code === "string" || typeof failure.code === "number" ? ` (${failure.code})` : ""}.`,
              ),
        );
      },
    );
  });
}

/** Parses `ps -o etime` (`[[dd-]hh:]mm:ss`) into seconds. */
export function parseElapsedSeconds(text: string): number | undefined {
  const match = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/.exec(text.trim());
  if (!match) return undefined;
  const [, days, hours, minutes, seconds] = match;
  return (
    Number(days ?? 0) * 86_400 +
    Number(hours ?? 0) * 3_600 +
    Number(minutes) * 60 +
    Number(seconds)
  );
}

/**
 * Pi rewrites its process title, so the command line cannot identify a
 * worker. Its start time can: the process that reported `pid` at `aliveAt`
 * must have started before then; a reused PID starts afterwards.
 */
async function defaultProcessIdentity(
  pid: number,
  aliveAt: number,
): Promise<ManagedProcessIdentity> {
  if (!isPidAlive(pid)) return "gone";
  if (process.platform === "win32") return "unknown";
  const elapsed = await new Promise<number | undefined>((resolve) => {
    execFile(
      "ps",
      ["-o", "etime=", "-p", String(pid)],
      {
        encoding: "utf8",
        timeout: 5_000,
        env: { ...process.env, LC_ALL: "C" },
      },
      (error, stdout) =>
        resolve(error ? undefined : parseElapsedSeconds(stdout)),
    );
  });
  if (elapsed === undefined) return isPidAlive(pid) ? "unknown" : "gone";
  // etime has one-second resolution.
  const startedAt = Date.now() - (elapsed + 1) * 1000;
  return startedAt <= aliveAt ? "match" : "other";
}

function herdrExecutableAvailable(
  bin: string,
  env: NodeJS.ProcessEnv,
): boolean {
  const candidates =
    path.isAbsolute(bin) || bin.includes(path.sep)
      ? [bin]
      : (env.PATH ?? process.env.PATH ?? "")
          .split(path.delimiter)
          .map((directory) => path.join(directory, bin));
  return candidates.some((candidate) => {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

export function detectManagedHost(
  env: NodeJS.ProcessEnv,
  registry: SubagentProcessRegistry,
  pollMs: number,
): ManagedHostPort {
  const workspaceId = env.HERDR_WORKSPACE_ID?.trim();
  const parentPaneId = env.HERDR_PANE_ID?.trim();
  const tabId = env.HERDR_TAB_ID?.trim();
  const bin = env.HERDR_BIN_PATH?.trim() || "herdr";
  if (
    env.HERDR_ENV === "1" &&
    workspaceId &&
    parentPaneId &&
    tabId &&
    herdrExecutableAvailable(bin, env)
  ) {
    return createHerdrHost({
      parentPaneId,
      tabId,
      bin,
      exec: execFileText,
      registry,
      isPidAlive,
      sleep: (ms, signal) => defaultSleep(ms, signal),
      pollMs,
      forwardEnv: herdrForwardEnvironment(env),
    });
  }
  return createRpcHost(registry);
}

// ---------------------------------------------------------------- runtime

interface LiveWorker {
  readonly bootId: string;
  readonly process: ManagedHostProcess;
  release: () => void;
  /** Planned exits (stop/suspend/fallback) set the lifecycle themselves. */
  planned: boolean;
  /** The worker began stopping on its own and the host was asked to finish it. */
  stopRequested: boolean;
  /** Why the parent forced this worker down, reported instead of a generic exit. */
  killReason?: string;
  readonly exitHandled: Promise<void>;
}

interface LaunchMode {
  /** Idle resume: never redeliver earlier messages, never fall back. */
  readonly idleResume: boolean;
  /** Fresh model attempt: the child starts its inbox from zero in a new session. */
  readonly fresh: boolean;
}

function attemptSessionId(handle: string, candidateIndex: number): string {
  return candidateIndex === 0 ? handle : `${handle}-m${candidateIndex}`;
}

class ManagedRuntimeImpl implements ManagedRuntime {
  private readonly live = new Map<string, LiveWorker>();
  private readonly locks = new Map<string, Promise<unknown>>();
  /** Handles between a held model error and the next candidate's launch. */
  private readonly relaunching = new Set<string>();
  /** Terminal results never change, so a worker's list is reused until its files or liveness do. */
  private readonly resultCache = new Map<
    string,
    { readonly key: string; readonly results: ManagedResultView[] }
  >();
  private readonly parentDir: string;

  constructor(
    readonly parentSessionId: string,
    private readonly agentDir: string,
    private limits: SubagentLimitsConfig,
    private gate: SessionConcurrencyGate,
    private readonly env: NodeJS.ProcessEnv,
    private ports: ManagedRuntimePorts,
    private usesDefaultHost: boolean,
  ) {
    this.parentDir = managedParentDir(agentDir, parentSessionId);
  }

  /** Replace only a detected default adapter; running processes keep their closures. */
  refreshDefaultHost(host: ManagedHostPort): void {
    if (this.usesDefaultHost) this.ports = { ...this.ports, host };
  }

  bind(gate: SessionConcurrencyGate, limits: SubagentLimitsConfig): void {
    this.limits = limits;
    if (gate === this.gate) return;
    this.gate = gate;
    for (const worker of this.live.values()) {
      worker.release();
      // acquire() reserves synchronously when a slot is free; the release
      // function arrives one microtask later.
      const pending = gate.acquire();
      worker.release = () =>
        void pending.then(
          (release) => release(),
          () => {},
        );
    }
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

    const release = await this.reserveSlot(signal);
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
      nextSeq: 2,
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
      this.writeConfig(config);
      writeInboxMessage(paths.inbox, {
        kind: "assignment",
        seq: 1,
        id: `m-${this.ports.randomId()}`,
        assignmentId,
        delivery: "auto",
        text: launch.task,
        createdAt: now,
      });
    } catch (error) {
      release();
      throw new ManagedError(
        "launch",
        `Could not create managed worker store: ${errorText(error)}`,
      );
    }
    await this.withLock(handle, () =>
      this.launch(config, release, { idleResume: false, fresh: false }, signal),
    );
    return { handle, assignmentId };
  }

  list(): ManagedWorkerView[] {
    return this.configs()
      .map((config) => this.view(config))
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  status(handle: string): ManagedWorkerView {
    return this.view(this.ownedConfig(handle));
  }

  listResults(): ManagedResultView[] {
    return this.configs()
      .sort((a, b) => a.createdAt - b.createdAt)
      .flatMap((config) => this.workerResults(config));
  }

  private workerResults(config: ManagedConfig): ManagedResultView[] {
    // The failed attempt's results must not escape while a fallback still owes the work.
    if (this.isRelaunching(config)) return [];
    const paths = managedPaths(this.dirOf(config.handle));
    const status = readChildStatus(paths.status);
    const live = this.live.get(config.handle);
    const key = [
      config.updatedAt,
      config.nextSeq,
      config.lifecycle,
      config.sessionId,
      status?.bootId,
      status?.updatedAt,
      live?.bootId,
    ].join("\0");
    const cached = this.resultCache.get(config.handle);
    if (cached?.key === key) return cached.results;

    const messages = new Map<string, { seq: number; text: string }>();
    for (const message of readInbox(paths.inbox))
      if (message.kind === "assignment")
        messages.set(message.assignmentId, {
          seq: message.seq,
          text: message.text,
        });
    const views: ManagedAssignmentView[] = [];
    for (const assignmentId of messages.keys()) {
      const archivedAssignment = readArchivedAssignment(
        paths.dir,
        config.sessionId,
        assignmentId,
      );
      const recorded =
        archivedAssignment !== undefined ||
        (status?.sessionId === config.sessionId &&
          status.assignments.some((entry) => entry.id === assignmentId));
      // A launch failure was already returned by the spawn or resume call.
      if (config.lifecycle === "failed" && !recorded) continue;
      const view = deriveAssignmentView({
        config,
        status,
        ...(archivedAssignment ? { archivedAssignment } : {}),
        inboxText: (id) => messages.get(id),
        live: live !== undefined,
        ...(live ? { liveBootId: live.bootId } : {}),
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
    if (!this.live.has(handle) || config.lifecycle !== "running")
      throw new ManagedError(
        "not_running",
        `Managed worker ${handle} is ${config.lifecycle}; resume it before sending.`,
      );
    const assignmentId = `a-${this.ports.randomId()}`;
    const seq = config.nextSeq;
    config.nextSeq = seq + 1;
    config.lastAssignmentId = assignmentId;
    this.writeConfig(config);
    writeInboxMessage(managedPaths(this.dirOf(handle)).inbox, {
      kind: "assignment",
      seq,
      id: `m-${this.ports.randomId()}`,
      assignmentId,
      delivery,
      text: message,
      createdAt: this.ports.now(),
    });
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
      const config = this.ownedConfig(handle);
      const view = this.assignment(config, assignmentId);
      if (!view)
        throw new ManagedError(
          "not_found",
          `Unknown assignment ${assignmentId} for ${handle}.`,
        );
      // A worker relaunching on a fallback model still owes this assignment,
      // so the failed attempt's terminal state must not escape, even on timeout.
      const relaunching = view.terminal && this.isRelaunching(config);
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
      if (!this.live.has(handle))
        await this.resumeIdle(this.ownedConfig(handle));
      return this.status(handle);
    });
  }

  async suspendAll(): Promise<void> {
    await Promise.all(
      [...this.live.keys()].map((handle) =>
        this.withLock(handle, () => this.shutdown(handle, "suspended")),
      ),
    );
  }

  async restore(): Promise<ManagedRestoreResult[]> {
    const results: ManagedRestoreResult[] = [];
    for (const config of this.configs()) {
      if (this.live.has(config.handle)) continue;
      if (!["running", "suspended", "starting"].includes(config.lifecycle))
        continue;
      try {
        await this.withLock(config.handle, async () => {
          if (!this.live.has(config.handle))
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
    if (!this.live.has(handle) || config.placement?.kind !== "herdr")
      throw new ManagedError(
        "unsupported",
        `Managed worker ${handle} has no live Herdr tab to open.`,
      );
    await this.ports.host.focus(config.placement);
  }

  // ----------------------------------------------------------- internals

  private async reserveSlot(signal?: AbortSignal): Promise<() => void> {
    // Fail fast: an idle worker holds its slot indefinitely, so waiting could never end.
    if (this.gate.status.available < 1)
      throw new ManagedError(
        "capacity",
        `No subagent slot is free (${this.gate.status.active}/${this.gate.status.limit} in use). Stop a managed worker or wait for bounded work to finish.`,
      );
    try {
      return await this.gate.acquire(signal);
    } catch (error) {
      throw new ManagedError("capacity", errorText(error));
    }
  }

  private async resumeIdle(config: ManagedConfig): Promise<void> {
    const release = await this.reserveSlot();
    try {
      await this.awaitPreviousBootExit(config);
    } catch (error) {
      release();
      throw error;
    }
    await this.launch(config, release, { idleResume: true, fresh: false });
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
    const seq = config.nextSeq;
    config.nextSeq = seq + 1;
    this.writeConfig(config);
    try {
      writeInboxMessage(paths.inbox, {
        kind: "shutdown",
        seq,
        id: `m-${this.ports.randomId()}`,
        createdAt: this.ports.now(),
      });
    } catch {
      // The wait below fails safely if the survivor never sees the request.
    }
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
    config: ManagedConfig,
    release: () => void,
    mode: LaunchMode,
    signal?: AbortSignal,
  ): Promise<void> {
    const paths = managedPaths(this.dirOf(config.handle));
    const firstAttempt = config.attempts.length;
    let fresh = mode.fresh;
    for (;;) {
      const candidates = config.launch.modelCandidates;
      const model = candidates[config.candidateIndex];
      const hold =
        !mode.idleResume && config.candidateIndex < candidates.length - 1;
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
      const floor = String(Math.max(0, config.nextSeq - 1));
      const env: Record<string, string> = {
        ...traceEnvironment(config.launch.trace),
        [MANAGED_DIR_ENV]: paths.dir,
        [MANAGED_BOOT_ID_ENV]: bootId,
        [MANAGED_PARENT_PID_ENV]: String(this.ports.parentPid),
        [MANAGED_RESUME_FLOOR_ENV]: mode.idleResume ? floor : "0",
        [MANAGED_CONTROL_FLOOR_ENV]: floor,
        [MANAGED_HOLD_ON_MODEL_ERROR_ENV]: hold ? "1" : "0",
        [MANAGED_FRESH_ATTEMPT_ENV]: fresh ? "1" : "0",
        [MANAGED_MAX_RUNTIME_ENV]: String(this.limits.maxRuntimeMs),
        [MANAGED_MAX_INACTIVITY_ENV]: String(this.limits.maxInactivityMs),
        [MANAGED_SESSION_ID_ENV]: config.sessionId,
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
          ownedPlacements: [...this.live.values()].map(
            (worker) => worker.process.placement,
          ),
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
        this.track(config.handle, bootId, proc, release);
        config.lifecycle = "running";
        config.placement = proc.placement;
        delete config.lastError;
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
      config.attempts.push({
        candidateIndex: config.candidateIndex,
        sessionId: config.sessionId,
        error: failure,
        ...(model ? { model } : {}),
      });
      if (
        !mode.idleResume &&
        !aborted &&
        retryable &&
        !ran &&
        config.candidateIndex + 1 < candidates.length
      ) {
        config.candidateIndex++;
        config.sessionId = attemptSessionId(
          config.handle,
          config.candidateIndex,
        );
        fresh = true;
        this.writeConfig(config);
        continue;
      }
      release();
      config.lifecycle = "failed";
      config.lastError = failure;
      this.writeConfig(config);
      const tried = config.attempts.slice(firstAttempt);
      const detail =
        tried.length > 1
          ? tried
              .map(
                (attempt) =>
                  `${attempt.model ?? "default model"}: ${attempt.error}`,
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
    release: () => void,
  ): void {
    let resolveHandled = () => {};
    const exitHandled = new Promise<void>((resolve) => {
      resolveHandled = resolve;
    });
    const worker: LiveWorker = {
      bootId,
      process: proc,
      release,
      planned: false,
      stopRequested: false,
      exitHandled,
    };
    this.live.set(handle, worker);
    void proc.exited.then(() => {
      if (this.live.get(handle) === worker) this.live.delete(handle);
      worker.release();
      if (!worker.planned) {
        const config = this.readOwned(handle);
        if (config && config.lifecycle === "running") {
          const status = readChildStatus(
            managedPaths(this.dirOf(handle)).status,
          );
          const ownStatus = status?.bootId === bootId ? status : undefined;
          // The child recorded its own orderly shutdown (for example /quit in its tab).
          const cleanExit =
            worker.killReason === undefined &&
            ownStatus?.state === "exited" &&
            ownStatus.sessionId === config.sessionId &&
            ownStatus.lastError === undefined;
          config.lifecycle = "exited";
          if (cleanExit) delete config.lastError;
          else
            config.lastError =
              worker.killReason ??
              ownStatus?.lastError ??
              `Worker process exited unexpectedly.${stderrTail(managedPaths(this.dirOf(handle)))}`;
          this.writeConfig(config);
        }
      }
      resolveHandled();
    });
    void this.watchWorker(handle, worker);
  }

  /**
   * Parent-side backstop while a worker lives: completes a stop the child
   * began itself, and terminates a worker whose own runtime watchdog failed.
   */
  private async watchWorker(handle: string, worker: LiveWorker): Promise<void> {
    const paths = managedPaths(this.dirOf(handle));
    while (this.live.get(handle) === worker) {
      const status = readChildStatus(paths.status);
      let running = false;
      if (status?.bootId === worker.bootId && !worker.planned) {
        if (
          (status.state === "stopping" || status.state === "exited") &&
          !worker.stopRequested
        ) {
          // RPC Pi acts on the bridge's shutdown only after its next command; EOF completes it.
          worker.stopRequested = true;
          worker.process.requestStop?.();
        }
        const active = status.activeAssignmentId
          ? status.assignments.find(
              (entry) => entry.id === status.activeAssignmentId,
            )
          : undefined;
        const limit = this.limits.maxRuntimeMs;
        if (active?.state === "running" && active.startedAt !== undefined) {
          running = true;
          if (
            limit > 0 &&
            this.ports.now() >
              active.startedAt + limit + this.ports.watchdogGraceMs
          ) {
            worker.killReason = `Worker exceeded the ${limit} ms runtime limit and did not stop itself; the parent terminated it.`;
            await worker.process.terminate().catch(() => {});
            return;
          }
          const inactivity = this.limits.maxInactivityMs;
          if (
            inactivity > 0 &&
            this.ports.now() >
              status.updatedAt + inactivity + this.ports.watchdogGraceMs
          ) {
            worker.killReason = `Worker exceeded the ${inactivity} ms inactivity limit and did not stop itself; the parent terminated it.`;
            await worker.process.terminate().catch(() => {});
            return;
          }
        }
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
    lifecycle: "stopped" | "suspended" | "starting",
    keepSlot = false,
  ): Promise<(() => void) | undefined> {
    const config = this.ownedConfig(handle);
    const worker = this.live.get(handle);
    if (!worker) {
      if (config.lifecycle !== "stopped") {
        config.lifecycle = lifecycle;
        this.writeConfig(config);
      }
      return undefined;
    }
    worker.planned = true;
    let kept: (() => void) | undefined;
    if (keepSlot) {
      kept = worker.release;
      worker.release = () => {};
    }
    const seq = config.nextSeq;
    config.nextSeq = seq + 1;
    config.lifecycle = lifecycle;
    this.writeConfig(config);
    try {
      writeInboxMessage(managedPaths(this.dirOf(handle)).inbox, {
        kind: "shutdown",
        seq,
        id: `m-${this.ports.randomId()}`,
        createdAt: this.ports.now(),
      });
    } catch {
      // Forced cleanup below still runs.
    }
    worker.process.requestStop?.();
    const graceful = await Promise.race([
      worker.process.exited.then(() => true),
      this.ports.sleep(this.ports.graceMs).then(() => false),
    ]);
    if (!graceful || worker.process.placement.kind === "herdr")
      await worker.process.terminate().catch(() => {});
    await worker.process.exited;
    await worker.exitHandled;
    return kept;
  }

  private async watchInitialAssignment(
    handle: string,
    bootId: string,
  ): Promise<void> {
    const paths = managedPaths(this.dirOf(handle));
    while (this.live.get(handle)?.bootId === bootId) {
      const status = readChildStatus(paths.status);
      if (status?.bootId === bootId) {
        if (status.state === "held") {
          // Visible to wait() before the lock is taken, so no stale terminal view escapes.
          this.relaunching.add(handle);
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
      if (this.live.get(handle)?.bootId !== bootId || status.toolActivity)
        return;
      const config = this.ownedConfig(handle);
      const first = status.assignments[0];
      // "starting" is durable: a reader that misses the in-memory mark still waits.
      const release = await this.shutdown(handle, "starting", true);
      if (!release) return;
      const failed = this.ownedConfig(handle);
      const model =
        config.launch.modelCandidates[config.candidateIndex] ?? status.model;
      failed.attempts.push({
        candidateIndex: config.candidateIndex,
        sessionId: config.sessionId,
        error:
          first?.outcome?.result ?? "Model error before any tool activity.",
        ...(model ? { model } : {}),
      });
      failed.candidateIndex++;
      failed.sessionId = attemptSessionId(handle, failed.candidateIndex);
      failed.lifecycle = "starting";
      this.writeConfig(failed);
      await this.launch(failed, release, { idleResume: false, fresh: true });
    } finally {
      this.relaunching.delete(handle);
    }
  }

  /** A held worker or one starting its next model candidate still owes the initial assignment. */
  private isRelaunching(config: ManagedConfig): boolean {
    if (this.relaunching.has(config.handle) || config.lifecycle === "starting")
      return true;
    const worker = this.live.get(config.handle);
    if (!worker) return false;
    const status = readChildStatus(
      managedPaths(this.dirOf(config.handle)).status,
    );
    return status?.bootId === worker.bootId && status.state === "held";
  }

  private assignment(
    config: ManagedConfig,
    assignmentId: string,
  ): ManagedAssignmentView | undefined {
    const paths = managedPaths(this.dirOf(config.handle));
    const archivedAssignment = readArchivedAssignment(
      paths.dir,
      config.sessionId,
      assignmentId,
    );
    return deriveAssignmentView({
      config,
      status: readChildStatus(paths.status),
      ...(archivedAssignment ? { archivedAssignment } : {}),
      inboxText: (id) => {
        const message = readInbox(paths.inbox).find(
          (entry) => entry.kind === "assignment" && entry.assignmentId === id,
        );
        return message?.kind === "assignment"
          ? { seq: message.seq, text: message.text }
          : undefined;
      },
      live: this.live.has(config.handle),
      ...(this.live.get(config.handle)
        ? { liveBootId: this.live.get(config.handle)!.bootId }
        : {}),
      assignmentId,
    });
  }

  private view(config: ManagedConfig): ManagedWorkerView {
    const paths = managedPaths(this.dirOf(config.handle));
    const raw = readChildStatus(paths.status);
    const status = raw?.sessionId === config.sessionId ? raw : undefined;
    const live = this.live.has(config.handle);
    const recent = (status?.assignments ?? [])
      .slice(-ASSIGNMENT_PREVIEW_COUNT)
      .flatMap((entry) => this.assignment(config, entry.id) ?? []);
    const model =
      status?.model ?? config.launch.modelCandidates[config.candidateIndex];
    // Pre-reload exit callbacks still write the old generic diagnostic.
    const cleanLegacyExit =
      !live &&
      config.lifecycle === "exited" &&
      status?.state === "exited" &&
      !status.lastError &&
      config.lastError?.startsWith("Worker process exited unexpectedly.");
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
    let names: string[];
    try {
      names = fs.readdirSync(this.parentDir);
    } catch {
      return [];
    }
    return names
      .filter(isManagedHandle)
      .flatMap((handle) => this.readOwned(handle) ?? []);
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
    config.updatedAt = this.ports.now();
    writeJsonAtomic(managedPaths(this.dirOf(config.handle)).config, config);
  }

  private withLock<T>(handle: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(handle) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    const settled = next.then(
      () => {},
      () => {},
    );
    this.locks.set(handle, settled);
    void settled.then(() => {
      if (this.locks.get(handle) === settled) this.locks.delete(handle);
    });
    return next;
  }
}

function traceEnvironment(trace: DelegationTrace): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(
    buildSubagentEnvironment(trace, {}),
  )) {
    if (typeof value === "string") env[key] = value;
  }
  return env;
}

function stderrTail(paths: ManagedPaths): string {
  try {
    const tail = truncateUtf8Tail(
      fs.readFileSync(paths.stderr, "utf8"),
      2048,
    ).value.trim();
    return tail ? ` stderr: ${tail}` : "";
  } catch {
    return "";
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ------------------------------------------------------------ composition

const RUNTIMES: unique symbol = Symbol.for(
  "pi-simple-subagents.managed-runtimes",
);
type RuntimeStore = typeof globalThis & {
  [RUNTIMES]?: Map<string, ManagedRuntime>;
};

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
    processIdentity: overrides.processIdentity ?? defaultProcessIdentity,
    orphanExitTimeoutMs: overrides.orphanExitTimeoutMs ?? 15_000,
    watchdogGraceMs: overrides.watchdogGraceMs ?? 30_000,
  };
}

/**
 * `/reload` re-evaluates this module, but the runtime survives on globalThis
 * with the previous module's prototype. Moving it onto the current class keeps
 * its live workers, gates, and closures while exposing current methods. Fields
 * added since that revision are created here; their initializers never ran.
 */
function adoptCurrentRevision(
  runtime: ManagedRuntime,
  options: ManagedRuntimeOptions,
  env: NodeJS.ProcessEnv,
): boolean {
  const changed =
    Object.getPrototypeOf(runtime) !== ManagedRuntimeImpl.prototype;
  if (changed) Object.setPrototypeOf(runtime, ManagedRuntimeImpl.prototype);
  const fields = runtime as unknown as {
    resultCache?: unknown;
    usesDefaultHost?: boolean;
  };
  if (!(fields.resultCache instanceof Map)) fields.resultCache = new Map();
  // Older runtime revisions did not record whether their host was injected.
  // A host supplied by this call remains an explicit override.
  if (fields.usesDefaultHost === undefined)
    fields.usesDefaultHost = options.ports?.host === undefined;
  if (changed && options.ports?.host === undefined) {
    const host = detectManagedHost(
      env,
      new SubagentProcessRegistry(),
      options.ports?.pollMs ?? 200,
    );
    (runtime as ManagedRuntimeImpl).refreshDefaultHost(host);
  }
  return changed;
}

/**
 * Returns the reload-surviving runtime for one parent session. Later calls
 * (for example after `/reload`) rebind the current gate and limits; default
 * host adapters are refreshed on module revision changes only.
 */
export function getManagedRuntime(
  options: ManagedRuntimeOptions,
): ManagedRuntime {
  const store = globalThis as RuntimeStore;
  const runtimes = (store[RUNTIMES] ??= new Map<string, ManagedRuntime>());
  const key = `${path.resolve(options.agentDir)}\0${options.parentSessionId}`;
  const existing = runtimes.get(key);
  const env = options.env ?? process.env;
  if (existing) {
    adoptCurrentRevision(existing, options, env);
    existing.bind(options.gate, options.limits);
    return existing;
  }
  const runtime = new ManagedRuntimeImpl(
    options.parentSessionId,
    options.agentDir,
    options.limits,
    options.gate,
    env,
    defaultPorts(env, options.ports ?? {}),
    options.ports?.host === undefined,
  );
  runtimes.set(key, runtime);
  return runtime;
}
