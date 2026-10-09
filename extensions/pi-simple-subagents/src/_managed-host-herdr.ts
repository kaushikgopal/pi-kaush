/**
 * Herdr host: each worker is a native interactive Pi in an extension-owned
 * pane stacked below the caller. Also selects the host for the current
 * environment, falling back to RPC outside Herdr.
 */
import { execFile, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createKeyedMutex } from "./_concurrency.ts";
import {
  defaultSleep,
  ManagedError,
  type ManagedHostLaunch,
  type ManagedHostPort,
  ManagedStartupError,
} from "./_managed-host.ts";
import { createRpcHost } from "./_managed-host-rpc.ts";
import { errorText } from "./_parse.ts";
import { isPidAlive, type SubagentProcessRegistry } from "./_process-tree.ts";
import { truncateUtf8Head } from "./_text.ts";

/** Tracks a worker PID that this process did not spawn (Herdr pane children). */
function registerForeignPid(registry: SubagentProcessRegistry, pid: number) {
  // SAFETY: SubagentProcessRegistry.register reads only `proc.pid`; the pane
  // shell owns the real ChildProcess. Replace with a registerPid API if added.
  return registry.register({ pid } as ChildProcess, false);
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

/** Focus failures surface as runtime errors: a vanished pane means the worker is gone. */
function herdrFocusError(error: unknown): ManagedError {
  if (error instanceof ManagedError) return error;
  const missing =
    error instanceof HerdrCommandError &&
    (error.code === "pane_not_found" || error.code === "agent_not_found");
  return new ManagedError(
    missing ? "not_running" : "unsupported",
    errorText(error),
  );
}

/** Herdr placement: extension-owned panes stacked below the caller. */
export function createHerdrHost(options: HerdrHostOptions): ManagedHostPort {
  const allocationLock = createKeyedMutex();
  const pendingPanes: string[] = [];
  const forgetPendingPane = (paneId: string) => {
    const index = pendingPanes.indexOf(paneId);
    if (index >= 0) pendingPanes.splice(index, 1);
  };
  const allocatePane = (request: ManagedHostLaunch) =>
    allocationLock("allocation", async () => {
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
          if (pid === undefined) pid = request.readBootPid?.();
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
      try {
        await options.exec(options.bin, ["agent", "focus", placement.paneId]);
      } catch (error) {
        throw herdrFocusError(error);
      }
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
