/**
 * Durable file protocol shared by the managed-worker runtime (parent) and the
 * managed child bridge. Every file has exactly one writer:
 *
 * - `config.json`  parent only: launch configuration and lifecycle intent.
 * - `inbox/*.json` parent only: one immutable command file per message.
 * - `status.json`  child only: acknowledgements, assignment states, results.
 *
 * Writes are atomic (unique temp file + rename) with private permissions, and
 * every read parses at the boundary so a torn or foreign file is reported as
 * absent instead of being trusted.
 */
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

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

/** Bounded copies kept in status files; the child session file keeps everything. */
export const MANAGED_RESULT_PREVIEW_BYTES = 64 * 1024;
export const MANAGED_MESSAGE_PREVIEW_BYTES = 2 * 1024;
export const MANAGED_STATUS_ASSIGNMENT_LIMIT = 100;

const HANDLE_PATTERN = /^mw-[a-z0-9]{6,32}$/;

/** True inside a Pi process launched as a managed worker. */
export function isManagedChildProcess(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return Boolean(env[MANAGED_DIR_ENV]?.trim());
}

export function isManagedHandle(value: string): boolean {
  return HANDLE_PATTERN.test(value);
}

export function managedParentDir(
  agentDir: string,
  parentSessionId: string,
): string {
  const hash = createHash("sha256")
    .update(parentSessionId)
    .digest("hex")
    .slice(0, 16);
  return path.join(agentDir, "managed-subagents", hash);
}

export interface ManagedPaths {
  readonly dir: string;
  readonly config: string;
  readonly status: string;
  readonly activation: string;
  readonly inbox: string;
  readonly sessionDir: string;
  readonly systemPrompt: string;
  readonly stderr: string;
}

export function managedPaths(dir: string): ManagedPaths {
  return {
    dir,
    config: path.join(dir, "config.json"),
    status: path.join(dir, "status.json"),
    activation: path.join(dir, "ready.json"),
    inbox: path.join(dir, "inbox"),
    sessionDir: path.join(dir, "session"),
    systemPrompt: path.join(dir, "system-prompt.md"),
    stderr: path.join(dir, "stderr.log"),
  };
}

export function ensurePrivateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/** Atomic private write. A unique temp name keeps concurrent writers from sharing a temp file. */
export function writeFileAtomic(filePath: string, content: string): void {
  ensurePrivateDir(path.dirname(filePath));
  const tmp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, content, { mode: 0o600, flag: "wx" });
    fs.renameSync(tmp, filePath);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }
}

export function writeJsonAtomic(filePath: string, value: unknown): void {
  writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(filePath: string): unknown {
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(content) as unknown;
  } catch {
    return undefined;
  }
}

export function isManagedBootActivated(
  filePath: string,
  bootId: string,
): boolean {
  const value = readJson(filePath);
  return isRecord(value) && value.bootId === bootId;
}

// ---------------------------------------------------------------- parsing

type Rec = Record<string, unknown>;

function isRecord(value: unknown): value is Rec {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}
function bool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}
function strArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? (value as string[])
    : undefined;
}
function oneOf<T extends string>(
  value: unknown,
  options: readonly T[],
): T | undefined {
  return typeof value === "string" &&
    (options as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}
function opt<K extends string, V>(
  key: K,
  value: V | undefined,
): { [P in K]?: V } {
  // SAFETY: the returned object either has exactly `key: value` or is empty.
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}

// ------------------------------------------------------------------ usage

export interface ManagedUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
  contextTokens: number;
}

export function emptyUsage(): ManagedUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    turns: 0,
    contextTokens: 0,
  };
}

function parseUsage(value: unknown): ManagedUsage {
  const usage = emptyUsage();
  if (!isRecord(value)) return usage;
  for (const key of Object.keys(usage) as (keyof ManagedUsage)[]) {
    usage[key] = num(value[key]) ?? 0;
  }
  return usage;
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

function parseInboxMessage(value: unknown): ManagedInboxMessage | undefined {
  if (!isRecord(value)) return undefined;
  const seq = num(value.seq);
  const id = str(value.id);
  const createdAt = num(value.createdAt);
  if (seq === undefined || !id || createdAt === undefined) return undefined;
  if (value.kind === "shutdown")
    return { kind: "shutdown", seq, id, createdAt };
  const assignmentId = str(value.assignmentId);
  const delivery = oneOf(value.delivery, ["auto", "followUp"] as const);
  const text = str(value.text);
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

export function writeInboxMessage(
  inboxDir: string,
  message: ManagedInboxMessage,
): void {
  const name = `${String(message.seq).padStart(10, "0")}-${message.id}.json`;
  writeJsonAtomic(path.join(inboxDir, name), message);
}

/** Inbox messages ordered by sequence. Unparseable files are skipped, never guessed. */
export function readInbox(inboxDir: string): ManagedInboxMessage[] {
  let names: string[];
  try {
    names = fs.readdirSync(inboxDir);
  } catch {
    return [];
  }
  const messages: ManagedInboxMessage[] = [];
  for (const name of names.filter((entry) => INBOX_FILE.test(entry)).sort()) {
    const message = parseInboxMessage(readJson(path.join(inboxDir, name)));
    if (message) messages.push(message);
  }
  return messages;
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
  usage: ManagedUsage;
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
  usage: ManagedUsage;
  toolActivity: boolean;
  model?: string;
  lastError?: string;
  updatedAt: number;
}

function parseOutcome(value: unknown): ManagedOutcome | undefined {
  if (!isRecord(value)) return undefined;
  const source = oneOf(value.source, [
    "yield",
    "assistant",
    "error",
    "lifecycle",
  ] as const);
  const result = str(value.result);
  if (!source || result === undefined) return undefined;
  return {
    source,
    result,
    ...opt("truncated", bool(value.truncated)),
    ...opt("artifacts", strArray(value.artifacts)),
  };
}

function assignmentArchivePath(
  dir: string,
  sessionId: string,
  assignmentId: string,
): string {
  const key = createHash("sha256")
    .update(`${sessionId}:${assignmentId}`)
    .digest("hex");
  return path.join(dir, "assignments", `${key}.json`);
}

export function writeArchivedAssignment(
  dir: string,
  sessionId: string,
  assignment: ChildAssignment,
): void {
  writeJsonAtomic(
    assignmentArchivePath(dir, sessionId, assignment.id),
    assignment,
  );
}

export function readArchivedAssignment(
  dir: string,
  sessionId: string,
  assignmentId: string,
): ChildAssignment | undefined {
  const assignment = parseAssignment(
    readJson(assignmentArchivePath(dir, sessionId, assignmentId)),
  );
  return assignment?.id === assignmentId &&
    isTerminalAssignmentState(assignment.state)
    ? assignment
    : undefined;
}

function parseAssignment(value: unknown): ChildAssignment | undefined {
  if (!isRecord(value)) return undefined;
  const id = str(value.id);
  const seq = num(value.seq);
  const state = oneOf(value.state, CHILD_ASSIGNMENT_STATES);
  const disposition = oneOf(value.disposition, [
    "prompt",
    "steer",
    "followUp",
  ] as const);
  const acceptedAt = num(value.acceptedAt);
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
    preview: str(value.preview) ?? "",
    acceptedAt,
    usage: parseUsage(value.usage),
    toolActivity: bool(value.toolActivity) ?? false,
    ...opt("mergedInto", str(value.mergedInto)),
    ...opt("startedAt", num(value.startedAt)),
    ...opt("endedAt", num(value.endedAt)),
    ...opt("outcome", parseOutcome(value.outcome)),
    ...opt("model", str(value.model)),
    ...opt("modelError", bool(value.modelError)),
  };
}

export function parseChildStatus(value: unknown): ChildStatus | undefined {
  if (!isRecord(value) || value.v !== 1) return undefined;
  const bootId = str(value.bootId);
  const pid = num(value.pid);
  const state = oneOf(value.state, [
    "starting",
    "idle",
    "busy",
    "held",
    "stopping",
    "exited",
  ] as const);
  const ackedSeq = num(value.ackedSeq);
  const updatedAt = num(value.updatedAt);
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
    queue: strArray(value.queue) ?? [],
    assignments,
    usage: parseUsage(value.usage),
    toolActivity: bool(value.toolActivity) ?? false,
    updatedAt,
    ...opt("sessionId", str(value.sessionId)),
    ...opt("sessionFile", str(value.sessionFile)),
    ...opt("activeAssignmentId", str(value.activeAssignmentId)),
    ...opt("model", str(value.model)),
    ...opt("lastError", str(value.lastError)),
  };
}

export function readChildStatus(statusPath: string): ChildStatus | undefined {
  return parseChildStatus(readJson(statusPath));
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
  if (!isRecord(value)) return undefined;
  if (value.kind === "rpc")
    return { kind: "rpc", ...opt("pid", num(value.pid)) };
  const tabId = str(value.tabId);
  const paneId = str(value.paneId);
  const layout = oneOf(value.layout, ["tab", "split"] as const);
  return value.kind === "herdr" && tabId && paneId
    ? { kind: "herdr", tabId, paneId, ...opt("layout", layout) }
    : undefined;
}

function parseLaunch(value: unknown): StoredLaunch | undefined {
  if (!isRecord(value) || !isRecord(value.agent) || !isRecord(value.trace))
    return undefined;
  const name = str(value.agent.name);
  const source = oneOf(value.agent.source, ["user", "project"] as const);
  const cwd = str(value.cwd);
  const candidates = strArray(value.modelCandidates);
  const rootSessionId = str(value.trace.rootSessionId);
  const parentSessionId = str(value.trace.parentSessionId);
  const parentToolCallId = str(value.trace.parentToolCallId);
  const depth = num(value.trace.depth);
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
  const isolation = isRecord(value.isolation) ? value.isolation : {};
  return {
    agent: {
      name,
      source,
      ...opt("emoji", str(value.agent.emoji)),
      ...opt("tools", strArray(value.agent.tools)),
    },
    modelCandidates: candidates,
    cwd,
    trace: { rootSessionId, parentSessionId, parentToolCallId, depth },
    isolation: {
      ...opt("noExtensions", bool(isolation.noExtensions)),
      ...opt("noSkills", bool(isolation.noSkills)),
      ...opt("noContextFiles", bool(isolation.noContextFiles)),
      ...opt("noPromptTemplates", bool(isolation.noPromptTemplates)),
    },
    taskPreview: str(value.taskPreview) ?? "",
    ...opt("profile", str(value.profile)),
  };
}

export function parseManagedConfig(value: unknown): ManagedConfig | undefined {
  if (!isRecord(value) || value.v !== 1) return undefined;
  const handle = str(value.handle);
  const parentSessionId = str(value.parentSessionId);
  const createdAt = num(value.createdAt);
  const launch = parseLaunch(value.launch);
  const lifecycle = oneOf(value.lifecycle, [
    "starting",
    "running",
    "suspended",
    "stopped",
    "exited",
    "failed",
  ] as const);
  const candidateIndex = num(value.candidateIndex);
  const sessionId = str(value.sessionId);
  const nextSeq = num(value.nextSeq);
  const lastAssignmentId = str(value.lastAssignmentId);
  const updatedAt = num(value.updatedAt);
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
        if (!isRecord(item)) return [];
        const index = num(item.candidateIndex);
        const attemptSession = str(item.sessionId);
        if (index === undefined || !attemptSession) return [];
        return [
          {
            candidateIndex: index,
            sessionId: attemptSession,
            ...opt("model", str(item.model)),
            ...opt("error", str(item.error)),
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
    ...opt("lastError", str(value.lastError)),
  };
}

export function readManagedConfig(
  configPath: string,
): ManagedConfig | undefined {
  return parseManagedConfig(readJson(configPath));
}
