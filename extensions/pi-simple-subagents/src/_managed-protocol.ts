/**
 * Wire protocol shared by the managed-worker runtime (parent) and the managed
 * child bridge: environment keys, boot environment encoding, file record
 * shapes, and the parsers that turn untrusted JSON into those shapes.
 *
 * Pure: no file system access. `_managed-store.ts` owns paths and I/O.
 */
import {
  booleanValue,
  finiteNumber,
  isPlainRecord,
  oneOf,
  stringArray,
  stringValue,
} from "./_parse.ts";
import { emptyUsage, type UsageStats } from "./_usage.ts";

// ------------------------------------------------------------ environment

export const MANAGED_DIR_ENV = "PI_MANAGED_SUBAGENT_DIR";
export const MANAGED_BOOT_ID_ENV = "PI_MANAGED_SUBAGENT_BOOT_ID";
export const MANAGED_PARENT_PID_ENV = "PI_MANAGED_SUBAGENT_PARENT_PID";
export const MANAGED_RESUME_FLOOR_ENV = "PI_MANAGED_SUBAGENT_RESUME_FLOOR";
export const MANAGED_HOLD_ON_MODEL_ERROR_ENV =
  "PI_MANAGED_SUBAGENT_HOLD_ON_MODEL_ERROR";
export const MANAGED_MAX_RUNTIME_ENV = "PI_MANAGED_SUBAGENT_MAX_RUNTIME_MS";
export const MANAGED_MAX_INACTIVITY_ENV =
  "PI_MANAGED_SUBAGENT_MAX_INACTIVITY_MS";
/** Shutdown commands at or below this sequence were meant for an earlier boot. */
export const MANAGED_CONTROL_FLOOR_ENV = "PI_MANAGED_SUBAGENT_CONTROL_FLOOR";
/** "1" when this boot is a fresh model attempt in a new session that starts the inbox over. */
export const MANAGED_FRESH_ATTEMPT_ENV = "PI_MANAGED_SUBAGENT_FRESH_ATTEMPT";
/** Session id the parent launched this boot with; any other session is a replaced session. */
export const MANAGED_SESSION_ID_ENV = "PI_MANAGED_SUBAGENT_SESSION_ID";

/** Every variable the parent sets for a managed boot; a partial set is a configuration error. */
export const MANAGED_ENV_KEYS = [
  MANAGED_DIR_ENV,
  MANAGED_BOOT_ID_ENV,
  MANAGED_PARENT_PID_ENV,
  MANAGED_RESUME_FLOOR_ENV,
  MANAGED_CONTROL_FLOOR_ENV,
  MANAGED_FRESH_ATTEMPT_ENV,
  MANAGED_HOLD_ON_MODEL_ERROR_ENV,
  MANAGED_MAX_RUNTIME_ENV,
  MANAGED_MAX_INACTIVITY_ENV,
  MANAGED_SESSION_ID_ENV,
] as const;

export type ManagedEnvKey = (typeof MANAGED_ENV_KEYS)[number];

/** True inside a Pi process launched as a managed worker. */
export function isManagedChildProcess(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return Boolean(env[MANAGED_DIR_ENV]?.trim());
}

/** Launch parameters the parent hands one managed boot through its environment. */
export interface ManagedBoot {
  readonly dir: string;
  readonly bootId: string;
  /** Absent when the parent pid is unknown (encoded as 0). */
  readonly parentPid?: number;
  /** Session the parent launched; any other session means it was replaced. */
  readonly expectedSessionId: string;
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
}

const flag = (value: boolean): "0" | "1" => (value ? "1" : "0");

/** The exact variables a managed boot receives; `decodeManagedBootEnv` reverses it. */
export function encodeManagedBootEnv(
  boot: ManagedBoot,
): Record<ManagedEnvKey, string> {
  return {
    [MANAGED_DIR_ENV]: boot.dir,
    [MANAGED_BOOT_ID_ENV]: boot.bootId,
    [MANAGED_PARENT_PID_ENV]: String(boot.parentPid ?? 0),
    [MANAGED_RESUME_FLOOR_ENV]: String(boot.resumeFloorSeq),
    [MANAGED_CONTROL_FLOOR_ENV]: String(boot.controlFloorSeq),
    [MANAGED_HOLD_ON_MODEL_ERROR_ENV]: flag(boot.holdOnInitialModelError),
    [MANAGED_FRESH_ATTEMPT_ENV]: flag(boot.freshAttempt),
    [MANAGED_MAX_RUNTIME_ENV]: String(boot.limits.maxRuntimeMs),
    [MANAGED_MAX_INACTIVITY_ENV]: String(boot.limits.maxInactivityMs),
    [MANAGED_SESSION_ID_ENV]: boot.expectedSessionId,
  };
}

export type ManagedBootDecode =
  /** No managed variable is set: an ordinary Pi process. */
  | { readonly kind: "absent" }
  /** A partial or malformed set; `message` is safe to show the user. */
  | { readonly kind: "invalid"; readonly message: string }
  | { readonly kind: "ok"; readonly boot: ManagedBoot };

/**
 * Parses the managed boot environment. A partial set is invalid rather than
 * absent: running such a process as an ordinary Pi would silently drop the
 * parent's assignments.
 */
export function decodeManagedBootEnv(
  env: Readonly<Record<string, string | undefined>>,
): ManagedBootDecode {
  const value = (key: ManagedEnvKey) => env[key]?.trim() ?? "";
  if (MANAGED_ENV_KEYS.every((key) => !value(key))) return { kind: "absent" };
  const missing = MANAGED_ENV_KEYS.filter((key) => !value(key));
  if (missing.length > 0)
    return {
      kind: "invalid",
      message: `Managed worker environment is incomplete: missing ${missing.join(", ")}. Managed workers must be launched by the parent's subagent runtime; unset the PI_MANAGED_SUBAGENT_* variables to run Pi normally.`,
    };
  // The first malformed variable, in decode order, is the one reported.
  let invalid: string | undefined;
  const int = (key: ManagedEnvKey): number => {
    const raw = value(key);
    const parsed = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
    if (Number.isSafeInteger(parsed)) return parsed;
    invalid ??= `Managed worker environment is invalid: ${key} must be a non-negative integer.`;
    return 0;
  };
  const bool = (key: ManagedEnvKey): boolean => {
    const raw = value(key);
    if (raw === "0" || raw === "1") return raw === "1";
    invalid ??= `Managed worker environment is invalid: ${key} must be 0 or 1.`;
    return false;
  };
  const parentPid = int(MANAGED_PARENT_PID_ENV);
  const boot: ManagedBoot = {
    dir: value(MANAGED_DIR_ENV),
    bootId: value(MANAGED_BOOT_ID_ENV),
    ...(parentPid > 0 ? { parentPid } : {}),
    expectedSessionId: value(MANAGED_SESSION_ID_ENV),
    resumeFloorSeq: int(MANAGED_RESUME_FLOOR_ENV),
    controlFloorSeq: int(MANAGED_CONTROL_FLOOR_ENV),
    freshAttempt: bool(MANAGED_FRESH_ATTEMPT_ENV),
    holdOnInitialModelError: bool(MANAGED_HOLD_ON_MODEL_ERROR_ENV),
    limits: {
      maxRuntimeMs: int(MANAGED_MAX_RUNTIME_ENV),
      maxInactivityMs: int(MANAGED_MAX_INACTIVITY_ENV),
    },
  };
  return invalid === undefined
    ? { kind: "ok", boot }
    : { kind: "invalid", message: invalid };
}

// ---------------------------------------------------------------- records

/** Bounded copies kept in status files; the child session file keeps everything. */
export const MANAGED_RESULT_PREVIEW_BYTES = 64 * 1024;
export const MANAGED_MESSAGE_PREVIEW_BYTES = 2 * 1024;
export const MANAGED_STATUS_ASSIGNMENT_LIMIT = 100;

const HANDLE_PATTERN = /^mw-[a-z0-9]{6,32}$/;

export function isManagedHandle(value: string): boolean {
  return HANDLE_PATTERN.test(value);
}

function opt<K extends string, V>(
  key: K,
  value: V | undefined,
): { [P in K]?: V } {
  // SAFETY: the returned object either has exactly `key: value` or is empty.
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}

function parseUsage(value: unknown): UsageStats {
  const usage = emptyUsage();
  if (!isPlainRecord(value)) return usage;
  // SAFETY: Object.keys of a fresh UsageStats yields exactly its own keys.
  for (const key of Object.keys(usage) as (keyof UsageStats)[]) {
    usage[key] = finiteNumber(value[key]) ?? 0;
  }
  return usage;
}

/** `ready.json`: the parent's release of one boot to begin consuming its inbox. */
export function parseActivation(
  value: unknown,
): { readonly bootId: string } | undefined {
  if (!isPlainRecord(value)) return undefined;
  const bootId = stringValue(value.bootId);
  return bootId === undefined ? undefined : { bootId };
}

// ------------------------------------------------------------------ inbox

export type ManagedDelivery = "auto" | "followUp";

export type ManagedInboxMessage =
  | {
      readonly kind: "assignment";
      readonly seq: number;
      readonly id: string;
      readonly assignmentId: string;
      readonly delivery: ManagedDelivery;
      readonly text: string;
      readonly createdAt: number;
    }
  | {
      readonly kind: "shutdown";
      readonly seq: number;
      readonly id: string;
      readonly createdAt: number;
    };

const INBOX_FILE = /^(\d{10})-[A-Za-z0-9_-]+\.json$/;

/** Zero-padded so lexical order is sequence order. */
export function inboxFileName(message: ManagedInboxMessage): string {
  return `${String(message.seq).padStart(10, "0")}-${message.id}.json`;
}

/** Sequence encoded in an inbox file name, or undefined for a foreign file. */
export function inboxFileSeq(name: string): number | undefined {
  const match = INBOX_FILE.exec(name);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

export function parseInboxMessage(
  value: unknown,
): ManagedInboxMessage | undefined {
  if (!isPlainRecord(value)) return undefined;
  const seq = finiteNumber(value.seq);
  const id = stringValue(value.id);
  const createdAt = finiteNumber(value.createdAt);
  if (seq === undefined || !id || createdAt === undefined) return undefined;
  if (value.kind === "shutdown")
    return { kind: "shutdown", seq, id, createdAt };
  const assignmentId = stringValue(value.assignmentId);
  const delivery = oneOf(value.delivery, ["auto", "followUp"] as const);
  const text = stringValue(value.text);
  if (
    value.kind !== "assignment" ||
    !assignmentId ||
    !delivery ||
    text === undefined
  )
    return undefined;
  return {
    kind: "assignment",
    seq,
    id,
    assignmentId,
    delivery,
    text,
    createdAt,
  };
}

// ----------------------------------------------------------------- status

export const TERMINAL_ASSIGNMENT_STATES = [
  "completed",
  "blocked",
  "failed",
  "timedOut",
  "aborted",
  "interrupted",
  "cancelled",
] as const;
export type TerminalAssignmentState =
  (typeof TERMINAL_ASSIGNMENT_STATES)[number];
export type ChildAssignmentState =
  | "accepted"
  | "delivering"
  | "running"
  | TerminalAssignmentState;

const CHILD_ASSIGNMENT_STATES: readonly ChildAssignmentState[] = [
  "accepted",
  "delivering",
  "running",
  ...TERMINAL_ASSIGNMENT_STATES,
];

export function isTerminalAssignmentState(
  state: string,
): state is TerminalAssignmentState {
  return (TERMINAL_ASSIGNMENT_STATES as readonly string[]).includes(state);
}

export interface ManagedOutcome {
  readonly source: "yield" | "assistant" | "error" | "lifecycle";
  readonly result: string;
  readonly truncated?: boolean;
  readonly artifacts?: readonly string[];
}

export interface ChildAssignment {
  id: string;
  seq: number;
  state: ChildAssignmentState;
  disposition: "prompt" | "steer" | "followUp";
  preview: string;
  acceptedAt: number;
  mergedInto?: string;
  startedAt?: number;
  endedAt?: number;
  outcome?: ManagedOutcome;
  usage: UsageStats;
  toolActivity: boolean;
  model?: string;
  modelError?: boolean;
}

export type ChildWorkerState =
  | "starting"
  | "idle"
  | "busy"
  | "held"
  | "stopping"
  | "exited";

export interface ChildStatus {
  v: 1;
  bootId: string;
  pid: number;
  state: ChildWorkerState;
  sessionId?: string;
  sessionFile?: string;
  ackedSeq: number;
  activeAssignmentId?: string;
  queue: string[];
  assignments: ChildAssignment[];
  usage: UsageStats;
  toolActivity: boolean;
  model?: string;
  lastError?: string;
  updatedAt: number;
}

function parseOutcome(value: unknown): ManagedOutcome | undefined {
  if (!isPlainRecord(value)) return undefined;
  const source = oneOf(value.source, [
    "yield",
    "assistant",
    "error",
    "lifecycle",
  ] as const);
  const result = stringValue(value.result);
  if (!source || result === undefined) return undefined;
  return {
    source,
    result,
    ...opt("truncated", booleanValue(value.truncated)),
    ...opt("artifacts", stringArray(value.artifacts)),
  };
}

export function parseAssignment(value: unknown): ChildAssignment | undefined {
  if (!isPlainRecord(value)) return undefined;
  const id = stringValue(value.id);
  const seq = finiteNumber(value.seq);
  const state = oneOf(value.state, CHILD_ASSIGNMENT_STATES);
  const disposition = oneOf(value.disposition, [
    "prompt",
    "steer",
    "followUp",
  ] as const);
  const acceptedAt = finiteNumber(value.acceptedAt);
  if (
    !id ||
    seq === undefined ||
    !state ||
    !disposition ||
    acceptedAt === undefined
  )
    return undefined;
  return {
    id,
    seq,
    state,
    disposition,
    preview: stringValue(value.preview) ?? "",
    acceptedAt,
    usage: parseUsage(value.usage),
    toolActivity: booleanValue(value.toolActivity) ?? false,
    ...opt("mergedInto", stringValue(value.mergedInto)),
    ...opt("startedAt", finiteNumber(value.startedAt)),
    ...opt("endedAt", finiteNumber(value.endedAt)),
    ...opt("outcome", parseOutcome(value.outcome)),
    ...opt("model", stringValue(value.model)),
    ...opt("modelError", booleanValue(value.modelError)),
  };
}

export function parseChildStatus(value: unknown): ChildStatus | undefined {
  if (!isPlainRecord(value) || value.v !== 1) return undefined;
  const bootId = stringValue(value.bootId);
  const pid = finiteNumber(value.pid);
  const state = oneOf(value.state, [
    "starting",
    "idle",
    "busy",
    "held",
    "stopping",
    "exited",
  ] as const);
  const ackedSeq = finiteNumber(value.ackedSeq);
  const updatedAt = finiteNumber(value.updatedAt);
  if (
    !bootId ||
    pid === undefined ||
    !state ||
    ackedSeq === undefined ||
    updatedAt === undefined
  )
    return undefined;
  const assignments = Array.isArray(value.assignments)
    ? value.assignments.flatMap((item) => parseAssignment(item) ?? [])
    : [];
  return {
    v: 1,
    bootId,
    pid,
    state,
    ackedSeq,
    queue: stringArray(value.queue) ?? [],
    assignments,
    usage: parseUsage(value.usage),
    toolActivity: booleanValue(value.toolActivity) ?? false,
    updatedAt,
    ...opt("sessionId", stringValue(value.sessionId)),
    ...opt("sessionFile", stringValue(value.sessionFile)),
    ...opt("activeAssignmentId", stringValue(value.activeAssignmentId)),
    ...opt("model", stringValue(value.model)),
    ...opt("lastError", stringValue(value.lastError)),
  };
}

// ----------------------------------------------------------------- config

export interface ManagedIsolation {
  readonly noExtensions?: boolean;
  readonly noSkills?: boolean;
  readonly noContextFiles?: boolean;
  readonly noPromptTemplates?: boolean;
}

export interface StoredLaunch {
  readonly agent: {
    readonly name: string;
    readonly emoji?: string;
    readonly source: "user" | "project";
    readonly tools?: readonly string[];
  };
  readonly profile?: string;
  readonly modelCandidates: readonly string[];
  readonly cwd: string;
  readonly trace: {
    readonly rootSessionId: string;
    readonly parentSessionId: string;
    readonly parentToolCallId: string;
    readonly depth: number;
  };
  readonly isolation: ManagedIsolation;
  readonly taskPreview: string;
}

export type ManagedPlacement =
  | { readonly kind: "rpc"; readonly pid?: number }
  | {
      readonly kind: "herdr";
      readonly tabId: string;
      readonly paneId: string;
      /** Missing is a legacy worker tab; new native workers use a split pane. */
      readonly layout?: "tab" | "split";
    };

export type ManagedLifecycle =
  | "starting"
  | "running"
  | "suspended"
  | "stopped"
  | "exited"
  | "failed";

export interface ManagedAttempt {
  readonly candidateIndex: number;
  readonly model?: string;
  readonly sessionId: string;
  readonly error?: string;
}

export interface ManagedConfig {
  v: 1;
  handle: string;
  parentSessionId: string;
  createdAt: number;
  launch: StoredLaunch;
  lifecycle: ManagedLifecycle;
  candidateIndex: number;
  sessionId: string;
  attempts: ManagedAttempt[];
  nextSeq: number;
  lastAssignmentId: string;
  placement?: ManagedPlacement;
  lastError?: string;
  updatedAt: number;
}

function parsePlacement(value: unknown): ManagedPlacement | undefined {
  if (!isPlainRecord(value)) return undefined;
  if (value.kind === "rpc")
    return { kind: "rpc", ...opt("pid", finiteNumber(value.pid)) };
  const tabId = stringValue(value.tabId);
  const paneId = stringValue(value.paneId);
  const layout = oneOf(value.layout, ["tab", "split"] as const);
  return value.kind === "herdr" && tabId && paneId
    ? { kind: "herdr", tabId, paneId, ...opt("layout", layout) }
    : undefined;
}

function parseLaunch(value: unknown): StoredLaunch | undefined {
  if (
    !isPlainRecord(value) ||
    !isPlainRecord(value.agent) ||
    !isPlainRecord(value.trace)
  )
    return undefined;
  const name = stringValue(value.agent.name);
  const source = oneOf(value.agent.source, ["user", "project"] as const);
  const cwd = stringValue(value.cwd);
  const candidates = stringArray(value.modelCandidates);
  const rootSessionId = stringValue(value.trace.rootSessionId);
  const parentSessionId = stringValue(value.trace.parentSessionId);
  const parentToolCallId = stringValue(value.trace.parentToolCallId);
  const depth = finiteNumber(value.trace.depth);
  if (
    !name ||
    !source ||
    !cwd ||
    !candidates ||
    !rootSessionId ||
    !parentSessionId ||
    parentToolCallId === undefined ||
    depth === undefined
  )
    return undefined;
  const isolation = isPlainRecord(value.isolation) ? value.isolation : {};
  return {
    agent: {
      name,
      source,
      ...opt("emoji", stringValue(value.agent.emoji)),
      ...opt("tools", stringArray(value.agent.tools)),
    },
    modelCandidates: candidates,
    cwd,
    trace: { rootSessionId, parentSessionId, parentToolCallId, depth },
    isolation: {
      ...opt("noExtensions", booleanValue(isolation.noExtensions)),
      ...opt("noSkills", booleanValue(isolation.noSkills)),
      ...opt("noContextFiles", booleanValue(isolation.noContextFiles)),
      ...opt("noPromptTemplates", booleanValue(isolation.noPromptTemplates)),
    },
    taskPreview: stringValue(value.taskPreview) ?? "",
    ...opt("profile", stringValue(value.profile)),
  };
}

export function parseManagedConfig(value: unknown): ManagedConfig | undefined {
  if (!isPlainRecord(value) || value.v !== 1) return undefined;
  const handle = stringValue(value.handle);
  const parentSessionId = stringValue(value.parentSessionId);
  const createdAt = finiteNumber(value.createdAt);
  const launch = parseLaunch(value.launch);
  const lifecycle = oneOf(value.lifecycle, [
    "starting",
    "running",
    "suspended",
    "stopped",
    "exited",
    "failed",
  ] as const);
  const candidateIndex = finiteNumber(value.candidateIndex);
  const sessionId = stringValue(value.sessionId);
  const nextSeq = finiteNumber(value.nextSeq);
  const lastAssignmentId = stringValue(value.lastAssignmentId);
  const updatedAt = finiteNumber(value.updatedAt);
  if (
    !handle ||
    !isManagedHandle(handle) ||
    !parentSessionId ||
    createdAt === undefined ||
    !launch ||
    !lifecycle ||
    candidateIndex === undefined ||
    !sessionId ||
    nextSeq === undefined ||
    !lastAssignmentId ||
    updatedAt === undefined
  )
    return undefined;
  const attempts = Array.isArray(value.attempts)
    ? value.attempts.flatMap((item): ManagedAttempt[] => {
        if (!isPlainRecord(item)) return [];
        const index = finiteNumber(item.candidateIndex);
        const attemptSession = stringValue(item.sessionId);
        if (index === undefined || !attemptSession) return [];
        return [
          {
            candidateIndex: index,
            sessionId: attemptSession,
            ...opt("model", stringValue(item.model)),
            ...opt("error", stringValue(item.error)),
          },
        ];
      })
    : [];
  return {
    v: 1,
    handle,
    parentSessionId,
    createdAt,
    launch,
    lifecycle,
    candidateIndex,
    sessionId,
    attempts,
    nextSeq,
    lastAssignmentId,
    updatedAt,
    ...opt("placement", parsePlacement(value.placement)),
    ...opt("lastError", stringValue(value.lastError)),
  };
}
