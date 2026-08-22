/**
 * Socket client for the pi-browser daemon. Spawns the daemon on demand and
 * proxies calls. All browser state lives daemon-side; a client request never
 * triggers a new browser connection (and its consent prompt) of its own.
 */

import { spawn } from "node:child_process";
import { existsSync, lstatSync, unlinkSync, type Stats } from "node:fs";
import net from "node:net";
import { fileURLToPath } from "node:url";
import type { CdpSender } from "./cdp.ts";
import { splitNdjsonFrames } from "./ndjson.ts";

const SOCKET_PATH =
  process.env["PI_BROWSER_SOCKET"] ??
  `/tmp/pi-browser-daemon-${process.getuid?.() ?? 0}.sock`;
const DAEMON_BIN = fileURLToPath(
  new URL("../../bin/pi-browser-daemon.mjs", import.meta.url),
);
const SPAWN_WAIT_MS = 15_000;
const RETRY_DELAY_MS = 200;

let sock: net.Socket | null = null;
let connecting: Promise<void> | null = null;
let buffer = "";
let nextId = 1;
const pending = new Map<
  number,
  {
    resolve: (v: unknown) => void;
    reject: (e: Error) => void;
    timer: NodeJS.Timeout;
  }
>();

const daemonBinExists = (): boolean => existsSync(DAEMON_BIN);

const spawnDaemon = (): void => {
  if (!daemonBinExists())
    throw new Error(`daemon entry missing at ${DAEMON_BIN}`);
  spawn(process.execPath, [DAEMON_BIN], {
    detached: true,
    stdio: "ignore",
  }).unref();
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const assertSafeSocket = (stat: Stats): void => {
  if (!stat.isSocket())
    throw new Error(`daemon path is not a socket: ${SOCKET_PATH}`);
  const uid = process.getuid?.();
  if (uid !== undefined && stat.uid !== uid)
    throw new Error(`daemon socket is not owned by the current user`);
  if ((stat.mode & 0o077) !== 0)
    throw new Error(
      `daemon socket permissions must not allow group/world access`,
    );
};

const inspectSocket = (): Stats | null => {
  try {
    const stat = lstatSync(SOCKET_PATH);
    assertSafeSocket(stat);
    return stat;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
};

const sameInode = (left: Stats, right: Stats): boolean =>
  left.dev === right.dev && left.ino === right.ino;

const connectOnce = (): Promise<net.Socket> =>
  new Promise((resolve, reject) => {
    const candidate = net.createConnection(SOCKET_PATH);
    const onConnect = (): void => {
      candidate.off("error", onError);
      resolve(candidate);
    };
    const onError = (error: Error): void => {
      candidate.off("connect", onConnect);
      candidate.destroy();
      reject(error);
    };
    candidate.once("connect", onConnect);
    candidate.once("error", onError);
  });

const connectToDaemon = async (): Promise<net.Socket> => {
  const deadline = Date.now() + SPAWN_WAIT_MS;
  let spawned = false;

  while (true) {
    const identity = inspectSocket();
    if (!identity) {
      if (!spawned) {
        spawnDaemon();
        spawned = true;
      }
    } else {
      try {
        return await connectOnce();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ECONNREFUSED")
          throw error;

        const currentIdentity = inspectSocket();
        if (currentIdentity && sameInode(identity, currentIdentity)) {
          // Another client may have just replaced the stale socket with a
          // live daemon's freshly bound one: only unlink an inode that still
          // refuses a fresh probe connection right now.
          let stillStale: boolean;
          try {
            (await connectOnce()).destroy();
            stillStale = false;
          } catch (probeError) {
            if ((probeError as NodeJS.ErrnoException).code !== "ECONNREFUSED")
              throw probeError;
            const latest = inspectSocket();
            stillStale = latest !== null && sameInode(latest, currentIdentity);
          }
          if (stillStale) {
            unlinkSync(SOCKET_PATH);
            if (!spawned) {
              spawnDaemon();
              spawned = true;
            }
          }
        }
      }
    }

    if (Date.now() >= deadline)
      throw new Error("daemon did not start (no socket after 15s)");
    await sleep(RETRY_DELAY_MS);
  }
};

const handleData = (s: net.Socket, chunk: Buffer | string): void => {
  buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
  let frames: string[];
  try {
    const split = splitNdjsonFrames(buffer);
    frames = split.frames;
    buffer = split.remainder;
  } catch {
    buffer = "";
    s.destroy();
    return;
  }

  for (const line of frames) {
    if (!line.trim()) continue;
    try {
      const res = JSON.parse(line) as {
        id: number;
        ok: boolean;
        result?: unknown;
        error?: string;
      };
      const p = pending.get(res.id);
      if (!p) continue;
      pending.delete(res.id);
      clearTimeout(p.timer);
      if (res.ok) p.resolve(res.result);
      else p.reject(new Error(res.error ?? "daemon error"));
    } catch {
      // malformed line; skip
    }
  }
};

const connect = async (): Promise<void> => {
  const connected = await connectToDaemon();
  connected.on("data", (chunk) => handleData(connected, chunk));
  connected.on("close", () => {
    if (sock === connected) sock = null;
    buffer = "";
    for (const [, p] of pending) {
      clearTimeout(p.timer);
      p.reject(new Error("daemon connection closed"));
    }
    pending.clear();
  });
  connected.on("error", () => {
    // post-connect errors surface through close
  });
  sock = connected;
};

const ensureConnection = (): Promise<void> => {
  if (sock && !sock.destroyed) return Promise.resolve();
  if (!connecting) {
    connecting = connect().finally(() => {
      connecting = null;
    });
  }
  return connecting;
};

/** Call a daemon method. The first call spawns the daemon if needed. */
export const request = <T = unknown>(
  method: string,
  params?: Record<string, unknown>,
  timeoutMs = 60_000,
): Promise<T> =>
  ensureConnection().then(
    () =>
      new Promise<T>((resolve, reject) => {
        const id = nextId++;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(
            new Error(
              `daemon request "${method}" timed out after ${timeoutMs}ms`,
            ),
          );
        }, timeoutMs);
        pending.set(id, {
          resolve: (v) => resolve(v as T),
          reject,
          timer,
        });
        sock!.write(
          JSON.stringify({ id, method, params: params ?? {} }) + "\n",
        );
      }),
  );

/** Raw-CDP sender bound to the daemon's current page (ensures a tab exists). */
export const cdp = (): CdpSender => ({
  send: <T = unknown>(method: string, params?: object) =>
    request<T>("cdp", { method, params: params ?? {} }),
});

export const evaluate = (expression: string): Promise<unknown> =>
  request("evaluate", { expression });
