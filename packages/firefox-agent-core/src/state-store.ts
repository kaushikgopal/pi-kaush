import { createHash, randomUUID } from "node:crypto";
import {
  constants,
  type FileHandle,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
} from "node:fs/promises";
import { dirname, basename, join, resolve } from "node:path";

export type StateJson =
  | null
  | boolean
  | number
  | string
  | StateJson[]
  | { [key: string]: StateJson };

type StoreOptions = { path: string; lockTimeoutMs?: number };
type OperationValue<T> = {
  entry: StateJson | undefined;
  result: T;
};
type Owner = { pid: number; uid: number; start: string; token: string };
type StoreIndex = { version: 1; entries: Record<string, StateJson> };

const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const MAX_LOCK_TIMEOUT_MS = 120_000;
const MAX_INDEX_BYTES = 1_048_576;
const MAX_ENTRY_BYTES = 262_144;
const MAX_JSON_DEPTH = 64;

export class FirefoxStateError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "FirefoxStateError";
    this.code = code;
  }
}

function stateError(code: string, message: string): FirefoxStateError {
  return new FirefoxStateError(code, message);
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function currentUid(): number | null {
  return typeof process.getuid === "function" ? process.getuid() : null;
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw stateError("aborted", "The state operation was cancelled.");
  }
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  assertNotAborted(signal);
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolvePromise();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(stateError("aborted", "The state operation was cancelled."));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function validateKey(key: string): void {
  if (
    typeof key !== "string" ||
    key.length < 1 ||
    key.length > 512 ||
    /[\u0000-\u001f\u007f]/u.test(key)
  ) {
    throw stateError("invalid_key", "The state key is invalid.");
  }
}

function validateJson(
  value: unknown,
  depth = 0,
  seen = new Set<object>(),
): asserts value is StateJson {
  if (depth > MAX_JSON_DEPTH) {
    throw stateError(
      "invalid_state",
      "The state value exceeds the nesting limit.",
    );
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw stateError("invalid_state", "The state value is not valid JSON.");
    }
    return;
  }
  if (typeof value !== "object" || seen.has(value)) {
    throw stateError("invalid_state", "The state value is not valid JSON.");
  }

  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) validateJson(item, depth + 1, seen);
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw stateError(
        "invalid_state",
        "The state value is not a plain JSON object.",
      );
    }
    for (const item of Object.values(value))
      validateJson(item, depth + 1, seen);
  }
  seen.delete(value);
}

function jsonBytes(value: unknown, maxBytes: number, code: string): string {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw stateError("invalid_state", "The state value is not valid JSON.");
  }
  if (serialized === undefined) {
    throw stateError("invalid_state", "The state value is not valid JSON.");
  }
  if (Buffer.byteLength(serialized, "utf8") > maxBytes) {
    throw stateError(code, "The state value exceeds the storage limit.");
  }
  return serialized;
}

function cloneJson<T extends StateJson>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function emptyIndex(): StoreIndex {
  return {
    version: 1,
    entries: Object.create(null) as Record<string, StateJson>,
  };
}

function validateIndex(value: unknown): StoreIndex {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 2 ||
    !Object.hasOwn(value, "version") ||
    (value as { version?: unknown }).version !== 1 ||
    !Object.hasOwn(value, "entries")
  ) {
    throw stateError(
      "malformed_state",
      "The state file has an invalid format.",
    );
  }
  const entriesValue = (value as { entries?: unknown }).entries;
  if (
    typeof entriesValue !== "object" ||
    entriesValue === null ||
    Array.isArray(entriesValue)
  ) {
    throw stateError(
      "malformed_state",
      "The state file has an invalid format.",
    );
  }
  const entries = Object.create(null) as Record<string, StateJson>;
  for (const [key, entry] of Object.entries(entriesValue)) {
    try {
      validateKey(key);
      validateJson(entry);
      jsonBytes(entry, MAX_ENTRY_BYTES, "state_too_large");
    } catch (error) {
      if (
        error instanceof FirefoxStateError &&
        error.code === "state_too_large"
      ) {
        throw error;
      }
      throw stateError(
        "malformed_state",
        "The state file has an invalid format.",
      );
    }
    Object.defineProperty(entries, key, {
      value: cloneJson(entry),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return { version: 1, entries };
}

async function readFileHandle(
  path: string,
  maxBytes: number,
): Promise<Buffer | undefined> {
  let before;
  try {
    before = await lstat(path);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw stateError("io_error", "The state file could not be checked.");
  }
  if (before.isSymbolicLink() || !before.isFile()) {
    throw stateError("unsafe_path", "The state file must be a regular file.");
  }
  const uid = currentUid();
  if (uid !== null && before.uid !== uid) {
    throw stateError("unsafe_path", "The state file has an unsafe owner.");
  }
  if ((before.mode & 0o077) !== 0) {
    throw stateError(
      "unsafe_path",
      "The state file permissions are not private.",
    );
  }
  if (before.size > maxBytes) {
    throw stateError(
      "state_too_large",
      "The state file exceeds the storage limit.",
    );
  }

  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      (uid !== null && opened.uid !== uid) ||
      (opened.mode & 0o077) !== 0
    ) {
      throw stateError("unsafe_path", "The state file changed during access.");
    }
    if (opened.size > maxBytes) {
      throw stateError(
        "state_too_large",
        "The state file exceeds the storage limit.",
      );
    }
    const buffer = Buffer.alloc(maxBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        buffer.length - offset,
        null,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > maxBytes) {
      throw stateError(
        "state_too_large",
        "The state file exceeds the storage limit.",
      );
    }
    return buffer.subarray(0, offset);
  } catch (error) {
    if (error instanceof FirefoxStateError) throw error;
    throw stateError("io_error", "The state file could not be read.");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function readIndex(path: string): Promise<StoreIndex> {
  const bytes = await readFileHandle(path, MAX_INDEX_BYTES);
  if (!bytes) return emptyIndex();
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw stateError("malformed_state", "The state file has invalid JSON.");
  }
  try {
    return validateIndex(parsed);
  } catch (error) {
    if (error instanceof FirefoxStateError) throw error;
    throw stateError(
      "malformed_state",
      "The state file has an invalid format.",
    );
  }
}

async function ensureParent(
  path: string,
): Promise<{ path: string; lockRoot: string }> {
  const requested = resolve(path);
  const fileName = basename(requested);
  if (!fileName || fileName === "." || fileName === "..") {
    throw stateError("unsafe_path", "The state path is invalid.");
  }
  try {
    await mkdir(dirname(requested), { recursive: true, mode: 0o700 });
    const parent = await realpath(dirname(requested));
    const parentStat = await stat(parent);
    if (
      !parentStat.isDirectory() ||
      ((parentStat.mode & 0o022) !== 0 && (parentStat.mode & 0o1000) === 0)
    ) {
      throw stateError(
        "unsafe_path",
        "The state directory has unsafe permissions.",
      );
    }
    return {
      path: join(parent, fileName),
      lockRoot: join(parent, fileName + ".locks"),
    };
  } catch (error) {
    if (error instanceof FirefoxStateError) throw error;
    throw stateError("io_error", "The state directory could not be prepared.");
  }
}

async function ensureLockRoot(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw stateError(
        "io_error",
        "The state lock directory could not be prepared.",
      );
    }
  }
  try {
    const info = await lstat(path);
    const uid = currentUid();
    if (
      info.isSymbolicLink() ||
      !info.isDirectory() ||
      (uid !== null && info.uid !== uid) ||
      (info.mode & 0o077) !== 0
    ) {
      throw stateError(
        "unsafe_path",
        "The state lock directory is not private.",
      );
    }
  } catch (error) {
    if (error instanceof FirefoxStateError) throw error;
    throw stateError(
      "unsafe_path",
      "The state lock directory is not available.",
    );
  }
}

export async function getFirefoxProcessIdentity(
  pid: number,
): Promise<{ uid: number; start: string; state?: string } | null> {
  if (process.platform === "linux") {
    try {
      const [statText, statusText] = await Promise.all([
        readFile(`/proc/${pid}/stat`, "utf8"),
        readFile(`/proc/${pid}/status`, "utf8"),
      ]);
      const closeParen = statText.lastIndexOf(")");
      const fields = statText
        .slice(closeParen + 1)
        .trim()
        .split(/\s+/u);
      const state = fields[0];
      const start = fields[19];
      const uidText = /^Uid:\s+(\d+)/mu.exec(statusText)?.[1];
      if (!state || !start || !uidText) return null;
      return { uid: Number(uidText), start, state };
    } catch {
      return null;
    }
  }

  if (process.platform === "darwin") {
    try {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const run = promisify(execFile);
      const { stdout } = await run(
        "ps",
        ["-o", "uid=", "-o", "lstart=", "-p", String(pid)],
        { timeout: 2_000, maxBuffer: 8_192 },
      );
      const match = /^\s*(\d+)\s+(.+?)\s*$/u.exec(stdout);
      if (!match?.[1] || !match[2]) return null;
      return { uid: Number(match[1]), start: match[2] };
    } catch {
      return null;
    }
  }
  return null;
}

async function ownerIsDead(owner: Owner): Promise<boolean | null> {
  if (owner.uid !== currentUid()) return null;
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return true;
    return null;
  }
  const current = await getFirefoxProcessIdentity(owner.pid);
  if (!current) return null;
  if (current.state === "Z" || current.state === "X") return true;
  if (current.uid !== owner.uid) return true;
  return current.start !== owner.start;
}

async function readOwner(path: string): Promise<Owner | null> {
  try {
    const bytes = await readFileHandle(path, 4_096);
    if (!bytes) return null;
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    if (
      typeof value !== "object" ||
      value === null ||
      !Number.isSafeInteger((value as Owner).pid) ||
      !Number.isSafeInteger((value as Owner).uid) ||
      typeof (value as Owner).start !== "string" ||
      typeof (value as Owner).token !== "string"
    ) {
      return null;
    }
    return value as Owner;
  } catch {
    return null;
  }
}

async function writeOwner(path: string, owner: Owner): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, "wx", 0o600);
    await handle.writeFile(JSON.stringify(owner), "utf8");
    await handle.sync();
  } catch {
    throw stateError(
      "lock_owner_unknown",
      "The state lock owner is unavailable.",
    );
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function acquireLock(
  lockRoot: string,
  lockName: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<() => Promise<void>> {
  const lockPath = join(lockRoot, lockName);
  const ownerPath = join(lockPath, "owner.json");
  const startedAt = Date.now();

  while (true) {
    assertNotAborted(signal);
    try {
      await mkdir(lockPath, { mode: 0o700 });
      const ownerIdentity = await getFirefoxProcessIdentity(
        globalThis.process.pid,
      );
      const uid = currentUid();
      if (!ownerIdentity || uid === null || ownerIdentity.uid !== uid) {
        throw stateError(
          "lock_owner_unknown",
          "The state lock owner is unavailable.",
        );
      }
      const owner: Owner = {
        pid: globalThis.process.pid,
        uid,
        start: ownerIdentity.start,
        token: randomUUID(),
      };
      await writeOwner(ownerPath, owner);
      return async () => {
        try {
          const current = await readOwner(ownerPath);
          if (!current || current.token !== owner.token) return;
          await unlink(ownerPath);
          await rmdir(lockPath);
        } catch {
          // A failed cleanup leaves a lock that can be reclaimed after owner death.
        }
      };
    } catch (error) {
      if (error instanceof FirefoxStateError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw stateError("io_error", "The state lock could not be created.");
      }
    }

    try {
      const lockInfo = await lstat(lockPath);
      const uid = currentUid();
      if (
        lockInfo.isSymbolicLink() ||
        !lockInfo.isDirectory() ||
        (uid !== null && lockInfo.uid !== uid) ||
        (lockInfo.mode & 0o077) !== 0
      ) {
        throw stateError("unsafe_path", "The state lock is not private.");
      }
    } catch (error) {
      if (error instanceof FirefoxStateError) throw error;
      if (isMissing(error)) continue;
      throw stateError("unsafe_path", "The state lock is not available.");
    }

    const existing = await readOwner(ownerPath);
    let ownerStatus: boolean | null | undefined;
    if (existing) {
      ownerStatus = await ownerIsDead(existing);
      if (ownerStatus === true) {
        const reaperPath = join(lockPath, ".reaper");
        try {
          await mkdir(reaperPath, { mode: 0o700 });
          const ownerIdentity = await getFirefoxProcessIdentity(
            globalThis.process.pid,
          );
          const uid = currentUid();
          if (!ownerIdentity || uid === null || ownerIdentity.uid !== uid) {
            throw stateError(
              "lock_owner_unknown",
              "The state lock owner is unavailable.",
            );
          }
          await writeOwner(join(reaperPath, "owner.json"), {
            pid: globalThis.process.pid,
            uid,
            start: ownerIdentity.start,
            token: randomUUID(),
          });
          const confirmed = await readOwner(ownerPath);
          if (
            confirmed?.token === existing.token &&
            (await ownerIsDead(confirmed)) === true
          ) {
            const quarantine = `${lockPath}.stale-${randomUUID()}`;
            await rename(lockPath, quarantine);
            await rm(quarantine, { recursive: true, force: true });
            continue;
          }
        } catch (error) {
          if (error instanceof FirefoxStateError) throw error;
          // Another reaper won, or the stale lock could not be moved safely.
        }
      }
    }

    if (Date.now() - startedAt >= timeoutMs) {
      let lockStillExists = false;
      try {
        await lstat(lockPath);
        lockStillExists = true;
      } catch {
        // The lock may have been released during the timeout check.
      }
      const ownerUnknown = existing ? ownerStatus !== false : lockStillExists;
      throw stateError(
        ownerUnknown ? "lock_owner_unknown" : "lock_timeout",
        ownerUnknown
          ? "The state lock owner cannot be verified as dead."
          : "The state lock wait timed out.",
      );
    }
    await wait(
      Math.min(25, Math.max(1, timeoutMs - (Date.now() - startedAt))),
      signal,
    );
  }
}

function lockNameFor(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

export function createFirefoxStateStore(options: StoreOptions): {
  withEntry<T>(
    key: string,
    operation: (entry: StateJson | undefined) => Promise<OperationValue<T>>,
    options?: { signal?: AbortSignal },
  ): Promise<T>;
  list(options?: { signal?: AbortSignal }): Promise<Record<string, StateJson>>;
} {
  if (
    typeof options?.path !== "string" ||
    options.path.length === 0 ||
    (options.lockTimeoutMs !== undefined &&
      (!Number.isFinite(options.lockTimeoutMs) ||
        options.lockTimeoutMs < 0 ||
        options.lockTimeoutMs > MAX_LOCK_TIMEOUT_MS))
  ) {
    throw stateError("invalid_options", "The state store options are invalid.");
  }
  const timeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;

  async function withPreparedPath<T>(
    callback: (path: string, lockRoot: string) => Promise<T>,
  ): Promise<T> {
    const prepared = await ensureParent(options.path);
    await ensureLockRoot(prepared.lockRoot);
    return callback(prepared.path, prepared.lockRoot);
  }

  return {
    async withEntry<T>(
      key: string,
      operation: (entry: StateJson | undefined) => Promise<OperationValue<T>>,
      callOptions: { signal?: AbortSignal } = {},
    ): Promise<T> {
      validateKey(key);
      if (typeof operation !== "function") {
        throw stateError(
          "invalid_operation",
          "The state operation is invalid.",
        );
      }
      const signal = callOptions.signal;
      assertNotAborted(signal);
      return withPreparedPath(async (path, lockRoot) => {
        const releaseEntry = await acquireLock(
          lockRoot,
          lockNameFor(key),
          timeoutMs,
          signal,
        );
        try {
          const releaseRead = await acquireLock(
            lockRoot,
            "global",
            timeoutMs,
            signal,
          );
          let entry: StateJson | undefined;
          try {
            const index = await readIndex(path);
            entry = Object.hasOwn(index.entries, key)
              ? cloneJson(index.entries[key]!)
              : undefined;
          } finally {
            await releaseRead();
          }

          assertNotAborted(signal);
          const output = await operation(entry);
          if (
            typeof output !== "object" ||
            output === null ||
            !Object.hasOwn(output, "result") ||
            !Object.hasOwn(output, "entry")
          ) {
            throw stateError(
              "invalid_operation",
              "The state operation returned an invalid value.",
            );
          }
          if (output.entry !== undefined) {
            validateJson(output.entry);
            jsonBytes(output.entry, MAX_ENTRY_BYTES, "state_too_large");
          }
          assertNotAborted(signal);

          const releaseWrite = await acquireLock(
            lockRoot,
            "global",
            timeoutMs,
            signal,
          );
          try {
            const index = await readIndex(path);
            if (output.entry === undefined) {
              delete index.entries[key];
            } else {
              Object.defineProperty(index.entries, key, {
                value: cloneJson(output.entry),
                enumerable: true,
                configurable: true,
                writable: true,
              });
            }
            const serialized = jsonBytes(
              index,
              MAX_INDEX_BYTES,
              "state_too_large",
            );
            await writeIndex(path, serialized);
          } finally {
            await releaseWrite();
          }
          return output.result;
        } finally {
          await releaseEntry();
        }
      });
    },

    async list(callOptions: { signal?: AbortSignal } = {}) {
      const signal = callOptions.signal;
      assertNotAborted(signal);
      return withPreparedPath(async (path, lockRoot) => {
        const release = await acquireLock(
          lockRoot,
          "global",
          timeoutMs,
          signal,
        );
        try {
          const index = await readIndex(path);
          return cloneJson(index.entries);
        } finally {
          await release();
        }
      });
    },
  };
}

async function writeIndex(path: string, serialized: string): Promise<void> {
  await readIndex(path);
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${randomUUID()}.tmp`,
  );
  let handle: FileHandle | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    let directory: FileHandle | undefined;
    try {
      directory = await open(dirname(path), constants.O_RDONLY);
      await directory.sync();
    } catch {
      // The rename committed; do not report a retryable failure after the write.
    } finally {
      await directory?.close().catch(() => undefined);
    }
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    if (error instanceof FirefoxStateError) throw error;
    throw stateError("io_error", "The state file could not be written.");
  }
}
