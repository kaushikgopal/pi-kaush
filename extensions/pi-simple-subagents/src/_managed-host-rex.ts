/**
 * Rex host: each worker is a native interactive Pi in an extension-owned
 * terminal block split below the caller, in the caller's Rex session. Rex has
 * no agent-start handshake, so readiness comes from the bridge status file
 * like the RPC host, and liveness from the PID the bridge reports.
 */
import { type ChildProcess, execFile } from "node:child_process";
import { createKeyedMutex } from "./_concurrency.ts";
import {
  ManagedError,
  type ManagedHostLaunch,
  type ManagedHostPort,
  ManagedStartupError,
} from "./_managed-host.ts";
import { errorText } from "./_parse.ts";
import type { SubagentProcessRegistry } from "./_process-tree.ts";
import { truncateUtf8Head } from "./_text.ts";

/** Tracks a worker PID that this process did not spawn (Rex block children). */
function registerForeignPid(registry: SubagentProcessRegistry, pid: number) {
  // SAFETY: SubagentProcessRegistry.register reads only `proc.pid`; the Rex
  // block owns the real ChildProcess. Replace with a registerPid API if added.
  return registry.register({ pid } as ChildProcess, false);
}

export interface RexExecOptions {
  /** 0 disables the timeout (`rex wait`). */
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface RexHostOptions {
  readonly sessionId: string;
  readonly parentBlockId: string;
  readonly bin: string;
  readonly exec: (
    bin: string,
    args: readonly string[],
    options?: RexExecOptions,
  ) => Promise<string>;
  readonly registry: SubagentProcessRegistry;
  readonly isPidAlive: (pid: number) => boolean;
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly pollMs: number;
  /**
   * Non-secret parent configuration the block needs; Rex starts commands with
   * its login shell's environment, not this process's.
   */
  readonly forwardEnv?: Readonly<Record<string, string>>;
}

/** A failed `rex` command; `missing` marks a target Rex could not find. */
export class RexCommandError extends Error {
  constructor(
    readonly missing: boolean,
    message: string,
  ) {
    super(message);
    this.name = "RexCommandError";
  }
}

/** Rex's own diagnostic from stderr (`Error: ...`); command lines are never quoted. */
export function parseRexError(stderr: string): string | undefined {
  const line = stderr
    .split("\n")
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0);
  if (!line) return undefined;
  return truncateUtf8Head(line.replace(/^Error:\s*/, ""), 500).value;
}

function parseRexSplit(stdout: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error("rex split returned non-JSON output");
  }
  const blockId = (parsed as { block_ids?: unknown[] } | null)?.block_ids?.[0];
  if (typeof blockId !== "string" || !blockId)
    throw new Error("rex split did not return a block ID");
  return blockId;
}

function isMissingRexTarget(error: unknown): boolean {
  return error instanceof RexCommandError && error.missing;
}

function rexStartupError(error: unknown): Error {
  if (error instanceof ManagedError || error instanceof ManagedStartupError)
    return error;
  return new ManagedStartupError(errorText(error), false);
}

/** Focus failures surface as runtime errors: a vanished block means the worker is gone. */
function rexFocusError(error: unknown): ManagedError {
  if (error instanceof ManagedError) return error;
  return new ManagedError(
    isMissingRexTarget(error) ? "not_running" : "unsupported",
    errorText(error),
  );
}

/** Rex placement: extension-owned blocks stacked below the caller. */
export function createRexHost(options: RexHostOptions): ManagedHostPort {
  const allocationLock = createKeyedMutex();
  const pendingBlocks: string[] = [];
  const forgetPendingBlock = (blockId: string) => {
    const index = pendingBlocks.indexOf(blockId);
    if (index >= 0) pendingBlocks.splice(index, 1);
  };
  const scope = ["-s", options.sessionId];
  const allocateBlock = (request: ManagedHostLaunch) =>
    allocationLock("allocation", async () => {
      const owned = (request.ownedPlacements ?? []).flatMap((placement) =>
        placement.kind === "rex" && placement.sessionId === options.sessionId
          ? [placement.blockId]
          : [],
      );
      const ownedSet = new Set(owned);
      // Keep split order even when bridge readiness completes out of order.
      const issued = new Set(pendingBlocks);
      const inherited = owned.filter((blockId) => !issued.has(blockId));
      const anchors = [...inherited, ...pendingBlocks].reverse();
      anchors.push(options.parentBlockId);
      const env = { ...options.forwardEnv, ...request.env };
      const command = [
        "env",
        ...Object.entries(env).map(([key, value]) => `${key}=${value}`),
        request.command,
        ...request.args,
      ];
      let lastMissingAnchor: unknown;
      for (const anchorBlockId of anchors) {
        let stdout: string;
        try {
          stdout = await options.exec(
            options.bin,
            [
              "split",
              ...scope,
              "-b",
              anchorBlockId,
              "--split=below",
              "--focus=false",
              "--label",
              request.label,
              "-c",
              request.cwd,
              "--json",
              "--",
              ...command,
            ],
            request.signal ? { signal: request.signal } : {},
          );
        } catch (error) {
          if (!isMissingRexTarget(error)) throw error;
          lastMissingAnchor = error;
          forgetPendingBlock(anchorBlockId);
          continue;
        }
        // A successful split must return a new block, never the parent or an existing child.
        const blockId = parseRexSplit(stdout);
        if (
          blockId === options.parentBlockId ||
          ownedSet.has(blockId) ||
          pendingBlocks.includes(blockId)
        )
          throw new Error("rex split did not return a new block ID");
        pendingBlocks.push(blockId);
        return blockId;
      }
      throw lastMissingAnchor ?? new Error("no valid Rex split anchor remains");
    });
  return {
    kind: "rex",
    async launch(request) {
      let blockId: string;
      try {
        blockId = await allocateBlock(request);
      } catch (error) {
        throw rexStartupError(error);
      }
      const closeBlock = () =>
        options.exec(options.bin, ["block", "close", ...scope, blockId]).then(
          () => undefined,
          () => undefined,
        );
      let pid: number | undefined;
      let finished = false;
      let blockEnded = false;
      let resolveExited = () => {};
      let terminatePromise: Promise<void> | undefined;
      const exited = new Promise<void>((resolve) => {
        resolveExited = () => {
          finished = true;
          resolve();
        };
      });
      // `rex wait` returns when the block's program exits or the block closes.
      // It only decides liveness before the bridge reports a PID: a crash during
      // startup then fails fast instead of waiting out the startup timeout.
      const waiter = new AbortController();
      void options
        .exec(options.bin, ["wait", ...scope, blockId, "--json"], {
          timeoutMs: 0,
          signal: waiter.signal,
        })
        .catch(() => undefined)
        .then(() => {
          blockEnded = true;
        });
      const finish = () => {
        waiter.abort();
        forgetPendingBlock(blockId);
        resolveExited();
      };
      void (async () => {
        while (!finished) {
          if (pid === undefined) pid = request.readBootPid?.();
          if (pid !== undefined ? !options.isPidAlive(pid) : blockEnded) {
            finish();
            return;
          }
          await options.sleep(options.pollMs);
        }
      })();
      return {
        placement: { kind: "rex", sessionId: options.sessionId, blockId },
        exited,
        async terminate() {
          if (terminatePromise) return terminatePromise;
          terminatePromise = (async () => {
            if (pid === undefined) pid = request.readBootPid?.();
            if (pid !== undefined && options.isPidAlive(pid)) {
              const registered = registerForeignPid(options.registry, pid);
              registered.terminate();
              await registered.done;
            }
            await closeBlock();
            finish();
          })();
          await terminatePromise;
        },
      };
    },
    async focus(placement) {
      if (placement.kind !== "rex")
        throw new ManagedError("unsupported", "Worker is not hosted in Rex.");
      try {
        await options.exec(options.bin, [
          "focus",
          "-s",
          placement.sessionId,
          placement.blockId,
        ]);
      } catch (error) {
        throw rexFocusError(error);
      }
    },
  };
}

export function execRexText(
  bin: string,
  args: readonly string[],
  options: RexExecOptions = {},
): Promise<string> {
  const what = `rex ${args[0] === "block" ? args.slice(0, 2).join(" ") : args[0]}`;
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
        // Node's own message quotes the command line, which carries env values.
        const failure = error as { killed?: boolean; code?: unknown };
        if (failure.killed) {
          reject(new RexCommandError(false, `${what} timed out.`));
          return;
        }
        const detail = parseRexError(stderr);
        reject(
          new RexCommandError(
            detail !== undefined && /\bnot found\b/i.test(detail),
            detail
              ? `${what} failed: ${detail}`
              : `${what} failed${typeof failure.code === "number" ? ` (${failure.code})` : ""}.`,
          ),
        );
      },
    );
  });
}
