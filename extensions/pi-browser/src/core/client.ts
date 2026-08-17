/**
 * Socket client for the pi-browser daemon. Spawns the daemon on demand and
 * proxies calls. All browser state lives daemon-side; a client request never
 * triggers a new browser connection (and its consent prompt) of its own.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import net from "node:net";
import { fileURLToPath } from "node:url";
import type { CdpSender } from "./cdp.ts";

const SOCKET_PATH =
  process.env["PI_BROWSER_SOCKET"] ??
  `/tmp/pi-browser-daemon-${process.getuid?.() ?? 0}.sock`;
const DAEMON_BIN = fileURLToPath(
  new URL("../../bin/pi-browser-daemon.mjs", import.meta.url),
);
const SPAWN_WAIT_MS = 15_000;

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

const waitForSocket = async (): Promise<void> => {
  const deadline = Date.now() + SPAWN_WAIT_MS;
  while (Date.now() < deadline) {
    if (existsSync(SOCKET_PATH)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("daemon did not start (no socket after 15s)");
};

const connect = async (): Promise<void> => {
  if (!existsSync(SOCKET_PATH)) {
    if (!daemonBinExists())
      throw new Error(`daemon entry missing at ${DAEMON_BIN}`);
    spawn(process.execPath, [DAEMON_BIN], {
      detached: true,
      stdio: "ignore",
    }).unref();
    await waitForSocket();
  }
  await new Promise<void>((resolve, reject) => {
    const s = net.createConnection(SOCKET_PATH);
    s.once("connect", () => resolve());
    s.once("error", async (err) => {
      // Stale socket from a dead daemon: remove, respawn, retry once.
      if (!existsSync(DAEMON_BIN)) return reject(err);
      try {
        const { unlinkSync } = await import("node:fs");
        unlinkSync(SOCKET_PATH);
      } catch {
        // already gone
      }
      spawn(process.execPath, [DAEMON_BIN], {
        detached: true,
        stdio: "ignore",
      }).unref();
      await waitForSocket().then(() => resolve(), reject);
    });
    s.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
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
    });
    s.on("close", () => {
      sock = null;
      for (const [, p] of pending) {
        clearTimeout(p.timer);
        p.reject(new Error("daemon connection closed"));
      }
      pending.clear();
    });
    s.on("error", () => {
      // connect-time errors handled above; later errors surface via close
    });
    sock = s;
  });
};

const ensureConnection = (): Promise<void> => {
  if (sock) return Promise.resolve();
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
