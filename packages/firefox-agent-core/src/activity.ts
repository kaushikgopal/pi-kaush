import { randomUUID, createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  createFirefoxStateStore,
  FirefoxStateError,
  getFirefoxProcessIdentity,
  type StateJson,
} from "./state-store.js";

type ProcessIdentity = NonNullable<
  Awaited<ReturnType<typeof getFirefoxProcessIdentity>>
>;
type ActivityOwner = { pid: number; uid?: number; start?: string };
type Activity = {
  readers: Record<string, ActivityOwner>;
  writer: (ActivityOwner & { token: string }) | null;
};

export function createFirefoxActivityGate(options: {
  path: string;
  timeoutMs?: number;
  getProcessIdentity?: (pid: number) => Promise<ProcessIdentity | null>;
}) {
  const timeout = options.timeoutMs ?? 120_000;
  const identify = options.getProcessIdentity ?? getFirefoxProcessIdentity;
  const store = createFirefoxStateStore({
    path: options.path,
    lockTimeoutMs: timeout,
  });
  async function currentOwner(): Promise<ActivityOwner> {
    let identity: ProcessIdentity | null;
    try {
      identity = await identify(process.pid);
    } catch {
      identity = null;
    }
    if (
      !identity ||
      !Number.isSafeInteger(identity.uid) ||
      identity.uid < 0 ||
      typeof identity.start !== "string" ||
      identity.start.length === 0
    )
      throw new FirefoxStateError(
        "activity_owner_unknown",
        "The Firefox process identity cannot be verified.",
      );
    return { pid: process.pid, uid: identity.uid, start: identity.start };
  }
  async function update<T>(operation: (state: Activity) => T): Promise<T> {
    return store.withEntry("activity", async (raw) => {
      const state = parse(raw);
      for (const [token, owner] of Object.entries(state.readers))
        if ((await isDead(owner, identify)) === true)
          delete state.readers[token];
      if (state.writer && (await isDead(state.writer, identify)) === true)
        state.writer = null;
      const result = operation(state);
      return { entry: json(state), result };
    });
  }
  async function waitUntil(
    operation: () => Promise<boolean>,
    signal?: AbortSignal,
  ) {
    const deadline = Date.now() + timeout;
    do {
      if (signal?.aborted)
        throw new FirefoxStateError(
          "aborted",
          "Browser coordination was cancelled.",
        );
      if (await operation()) return;
      if (Date.now() >= deadline) break;
      await delay(25, undefined, signal ? { signal } : undefined);
    } while (Date.now() < deadline);
    throw new FirefoxStateError(
      "browser_busy",
      "Other Firefox operations are still active.",
    );
  }
  async function run<T>(
    kind: "read" | "write",
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const owner = await currentOwner();
    const token = randomUUID();
    if (kind === "read") {
      await waitUntil(
        () =>
          update((state) => {
            if (state.writer) return false;
            if (Object.keys(state.readers).length >= 1024)
              throw new FirefoxStateError(
                "browser_busy",
                "Too many Firefox operations are active.",
              );
            state.readers[token] = owner;
            return true;
          }),
        signal,
      );
      try {
        return await operation();
      } finally {
        await update((state) => {
          delete state.readers[token];
        });
      }
    }
    // Only a writer waits for readers; existing readers can always release their tokens.
    return store.withEntry(
      "writer",
      async () => {
        try {
          await waitUntil(
            () =>
              update((state) => {
                if (state.writer && state.writer.token !== token) return false;
                state.writer = { ...owner, token };
                return Object.keys(state.readers).length === 0;
              }),
            signal,
          );
          return { entry: undefined, result: await operation() };
        } finally {
          await update((state) => {
            if (state.writer?.token === token) state.writer = null;
          });
        }
      },
      signal ? { signal } : undefined,
    );
  }
  async function withSessionLane<T>(
    key: string,
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const digest = createHash("sha256").update(key).digest("hex");
    return store.withEntry(
      `lane:${digest}`,
      async () => ({ entry: undefined, result: await operation() }),
      signal ? { signal } : undefined,
    );
  }
  return { run, withSessionLane };
}

async function isDead(
  owner: ActivityOwner,
  identify: (pid: number) => Promise<ProcessIdentity | null>,
): Promise<boolean | null> {
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? true : null;
  }
  if (owner.uid === undefined || owner.start === undefined) return null;
  let current: ProcessIdentity | null;
  try {
    current = await identify(owner.pid);
  } catch {
    current = null;
  }
  if (!current) return null;
  if (current.state === "Z" || current.state === "X") return true;
  if (current.start !== owner.start) return true;
  if (current.uid !== owner.uid) return null;
  return false;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function parseOwner(value: unknown): ActivityOwner | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0)
    return { pid: value };
  if (
    !object(value) ||
    typeof value.pid !== "number" ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 0 ||
    (value.uid !== undefined &&
      (typeof value.uid !== "number" ||
        !Number.isSafeInteger(value.uid) ||
        value.uid < 0)) ||
    (value.start !== undefined &&
      (typeof value.start !== "string" || value.start.length === 0))
  )
    return null;
  return {
    pid: value.pid,
    ...(value.uid !== undefined ? { uid: value.uid } : {}),
    ...(value.start !== undefined ? { start: value.start } : {}),
  };
}
function parse(raw: StateJson | undefined): Activity {
  if (raw === undefined) return { readers: {}, writer: null };
  if (
    !object(raw) ||
    !object(raw.readers) ||
    Object.keys(raw.readers).length > 1024
  )
    throw invalid();
  const readers: Activity["readers"] = {};
  for (const [key, value] of Object.entries(raw.readers)) {
    const owner = parseOwner(value);
    if (!/^[a-f0-9-]{36}$/u.test(key) || !owner) throw invalid();
    readers[key] = owner;
  }
  let writer: Activity["writer"] = null;
  if (raw.writer !== null) {
    if (
      !object(raw.writer) ||
      typeof raw.writer.token !== "string" ||
      !/^[a-f0-9-]{36}$/u.test(raw.writer.token)
    )
      throw invalid();
    const owner = parseOwner(raw.writer);
    if (!owner) throw invalid();
    writer = { ...owner, token: raw.writer.token };
  }
  return { readers, writer };
}
function json(state: Activity): StateJson {
  return {
    readers: Object.fromEntries(
      Object.entries(state.readers).map(([token, owner]) => [
        token,
        { ...owner },
      ]),
    ),
    writer: state.writer ? { ...state.writer } : null,
  };
}
function invalid() {
  return new FirefoxStateError(
    "invalid_activity_state",
    "Firefox coordination state is invalid; it was not reset.",
  );
}
