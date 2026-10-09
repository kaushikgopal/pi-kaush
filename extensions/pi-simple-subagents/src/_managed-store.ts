/**
 * Durable file store shared by the managed-worker runtime (parent) and the
 * managed child bridge. Record shapes and parsers live in
 * `_managed-protocol.ts`; this module owns paths and I/O. Every file has
 * exactly one writer:
 *
 * - `config.json`        parent only: launch configuration and lifecycle intent.
 * - `inbox/*.json`       parent only: one immutable command file per message.
 * - `ready.json`         parent only: releases one boot (by id) to consume its inbox.
 * - `system-prompt.md`   parent only: written once at launch.
 * - `status.json`        child only: acknowledgements, assignment states, results.
 * - `assignments/*.json` child only: one archive per terminal assignment, keyed
 *                        by session and assignment id; the parent only reads them.
 *
 * Writes are atomic (unique temp file, fsync, rename) with private
 * permissions, and every read parses at the boundary so a torn or foreign
 * file is reported as missing or invalid instead of being trusted.
 */
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  type ChildAssignment,
  type ChildStatus,
  inboxFileName,
  inboxFileSeq,
  isManagedHandle,
  isTerminalAssignmentState,
  type ManagedConfig,
  type ManagedInboxMessage,
  parseActivation,
  parseAssignment,
  parseChildStatus,
  parseInboxMessage,
  parseManagedConfig,
} from "./_managed-protocol.ts";
import { errorText } from "./_parse.ts";
import { truncateUtf8Tail } from "./_text.ts";

// Re-exported so existing importers of the store keep working unchanged.
export {
  type ChildAssignment,
  type ChildAssignmentState,
  type ChildStatus,
  type ChildWorkerState,
  isManagedChildProcess,
  isManagedHandle,
  isTerminalAssignmentState,
  MANAGED_MESSAGE_PREVIEW_BYTES,
  type ManagedAttempt,
  type ManagedConfig,
  type ManagedDelivery,
  type ManagedIsolation,
  type ManagedLifecycle,
  type ManagedOutcome,
  type ManagedPlacement,
  parseManagedConfig,
} from "./_managed-protocol.ts";

// ------------------------------------------------------------------ paths

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

/** Worker handles under one parent directory, sorted; foreign entries are ignored. */
export function listManagedHandles(rootDir: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(rootDir);
  } catch {
    return [];
  }
  return names.filter(isManagedHandle).sort();
}

// ------------------------------------------------------------ atomic I/O

export function ensurePrivateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/**
 * Atomic private write. A unique temp name keeps concurrent writers from
 * sharing a temp file; the fsync before rename keeps a crash from publishing
 * an empty file under the final name.
 */
export function writeFileAtomic(filePath: string, content: string): void {
  ensurePrivateDir(path.dirname(filePath));
  const tmp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(tmp, "wx", 0o600);
    try {
      fs.writeFileSync(fd, content);
      try {
        fs.fsyncSync(fd);
      } catch {
        // Best effort: some file systems reject fsync; the rename stays atomic.
      }
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, filePath);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }
}

export function writeJsonAtomic(filePath: string, value: unknown): void {
  writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

/** Outcome of reading one store file; only `ok` carries a trusted value. */
export type ManagedRead<T> =
  | { readonly kind: "missing" }
  | { readonly kind: "invalid"; readonly reason: string }
  | { readonly kind: "ok"; readonly value: T };

function readJsonFile(filePath: string): ManagedRead<unknown> {
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    const code =
      error instanceof Error && "code" in error ? error.code : undefined;
    return code === "ENOENT" || code === "ENOTDIR"
      ? { kind: "missing" }
      : { kind: "invalid", reason: `unreadable: ${errorText(error)}` };
  }
  try {
    return { kind: "ok", value: JSON.parse(content) as unknown };
  } catch (error) {
    return { kind: "invalid", reason: `not JSON: ${errorText(error)}` };
  }
}

function readParsed<T>(
  filePath: string,
  parse: (value: unknown) => T | undefined,
  label: string,
): ManagedRead<T> {
  const read = readJsonFile(filePath);
  if (read.kind !== "ok") return read;
  const value = parse(read.value);
  return value === undefined
    ? { kind: "invalid", reason: `not a valid ${label}` }
    : { kind: "ok", value };
}

function okValue<T>(read: ManagedRead<T>): T | undefined {
  return read.kind === "ok" ? read.value : undefined;
}

// ------------------------------------------------------------- activation

export function isManagedBootActivated(
  filePath: string,
  bootId: string,
): boolean {
  return (
    okValue(readParsed(filePath, parseActivation, "activation"))?.bootId ===
    bootId
  );
}

// ------------------------------------------------------------------ inbox

export function writeInboxMessage(
  inboxDir: string,
  message: ManagedInboxMessage,
): void {
  writeJsonAtomic(path.join(inboxDir, inboxFileName(message)), message);
}

export interface ReadInboxOptions {
  /** Skips files at or below this sequence by name, before reading them. */
  readonly afterSeq?: number;
}

/** Inbox messages ordered by sequence. Unparseable files are skipped, never guessed. */
export function readInbox(
  inboxDir: string,
  options: ReadInboxOptions = {},
): ManagedInboxMessage[] {
  let names: string[];
  try {
    names = fs.readdirSync(inboxDir);
  } catch {
    return [];
  }
  const afterSeq = options.afterSeq ?? Number.NEGATIVE_INFINITY;
  const messages: ManagedInboxMessage[] = [];
  for (const name of names.sort()) {
    const seq = inboxFileSeq(name);
    if (seq === undefined || seq <= afterSeq) continue;
    const message = okValue(
      readParsed(path.join(inboxDir, name), parseInboxMessage, "inbox message"),
    );
    if (message) messages.push(message);
  }
  return messages;
}

/** A command before the store assigns it the next inbox sequence. */
export type ManagedInboxCommand =
  | Omit<Extract<ManagedInboxMessage, { kind: "assignment" }>, "seq">
  | Omit<Extract<ManagedInboxMessage, { kind: "shutdown" }>, "seq">;

export type ManagedEnqueueResult =
  | { readonly kind: "enqueued"; readonly message: ManagedInboxMessage }
  /** Nothing reached the inbox; `config` still holds the advanced sequence in memory. */
  | { readonly kind: "configWriteFailed"; readonly error: unknown }
  /** The sequence is spent (config is durable); the child never sees this command. */
  | {
      readonly kind: "inboxWriteFailed";
      readonly message: ManagedInboxMessage;
      readonly error: unknown;
    };

/**
 * Parent-only. Allocates `config.nextSeq`, persists the config, then writes
 * the inbox file. Config goes first so a crash between the two leaves a gap,
 * never a reused sequence. Mutates `config` in place (callers keep using the
 * same object); an assignment also becomes `lastAssignmentId`. Callers
 * serialize per handle because `config.json` has a single writer.
 */
export function enqueueInbox(
  dir: string,
  config: ManagedConfig,
  command: ManagedInboxCommand,
  now: number,
): ManagedEnqueueResult {
  const seq = config.nextSeq;
  config.nextSeq = seq + 1;
  if (command.kind === "assignment")
    config.lastAssignmentId = command.assignmentId;
  try {
    writeManagedConfig(dir, config, now);
  } catch (error) {
    return { kind: "configWriteFailed", error };
  }
  const message: ManagedInboxMessage = { ...command, seq };
  try {
    writeInboxMessage(managedPaths(dir).inbox, message);
  } catch (error) {
    return { kind: "inboxWriteFailed", message, error };
  }
  return { kind: "enqueued", message };
}

// ----------------------------------------------------------------- status

export function readChildStatusResult(
  statusPath: string,
): ManagedRead<ChildStatus> {
  return readParsed(statusPath, parseChildStatus, "child status");
}

export function readChildStatus(statusPath: string): ChildStatus | undefined {
  return okValue(readChildStatusResult(statusPath));
}

// --------------------------------------------------------------- archives

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

/** Child-only. */
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
  const assignment = okValue(
    readParsed(
      assignmentArchivePath(dir, sessionId, assignmentId),
      parseAssignment,
      "assignment archive",
    ),
  );
  return assignment?.id === assignmentId &&
    isTerminalAssignmentState(assignment.state)
    ? assignment
    : undefined;
}

// ----------------------------------------------------------------- config

/** Parent-only. Stamps `updatedAt` with `now` before writing. */
export function writeManagedConfig(
  dir: string,
  config: ManagedConfig,
  now: number,
): void {
  config.updatedAt = now;
  writeJsonAtomic(managedPaths(dir).config, config);
}

export function readManagedConfigResult(
  configPath: string,
): ManagedRead<ManagedConfig> {
  return readParsed(configPath, parseManagedConfig, "managed config");
}

export function readManagedConfig(
  configPath: string,
): ManagedConfig | undefined {
  return okValue(readManagedConfigResult(configPath));
}

// ------------------------------------------------------------ diagnostics

/**
 * The last `maxBytes` of a log, never splitting a code point. Reads only the
 * tail, so a large log costs one bounded read. Missing or unreadable is "".
 */
export function readStderrTail(filePath: string, maxBytes: number): string {
  let fd: number;
  try {
    fd = fs.openSync(filePath, "r");
  } catch {
    return "";
  }
  try {
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, Math.max(0, maxBytes));
    const buffer = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const bytes = fs.readSync(
        fd,
        buffer,
        read,
        length - read,
        size - length + read,
      );
      if (bytes === 0) break;
      read += bytes;
    }
    let start = 0;
    // A cut inside the file may land on UTF-8 continuation bytes (10xxxxxx).
    if (length < size)
      while (
        start < Math.min(read, 3) &&
        ((buffer[start] ?? 0) & 0xc0) === 0x80
      )
        start++;
    // Invalid bytes decode to wider replacement characters; re-bound the text.
    return truncateUtf8Tail(
      buffer.subarray(start, read).toString("utf8"),
      maxBytes,
    ).value;
  } catch {
    return "";
  } finally {
    fs.closeSync(fd);
  }
}
