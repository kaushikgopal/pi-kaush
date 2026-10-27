/**
 * Selects the host for the current environment: Herdr, then Rex, then the
 * headless RPC fallback. Herdr wins when both are present: a Herdr server
 * started from a Rex terminal passes REX_* to its panes, so Herdr is the
 * innermost multiplexer that holds the caller.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { defaultSleep, type ManagedHostPort } from "./_managed-host.ts";
import {
  createHerdrHost,
  execHerdrText,
  managedPaneForwardEnvironment,
} from "./_managed-host-herdr.ts";
import { createRexHost, execRexText } from "./_managed-host-rex.ts";
import { createRpcHost } from "./_managed-host-rpc.ts";
import { isPidAlive, type SubagentProcessRegistry } from "./_process-tree.ts";

function executableAvailable(bin: string, env: NodeJS.ProcessEnv): boolean {
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

/** Rex sets REX_BIN_DIR in its terminals; PATH is the fallback. */
function rexExecutable(env: NodeJS.ProcessEnv): string | undefined {
  const binDir = env.REX_BIN_DIR?.trim();
  const candidates = binDir ? [path.join(binDir, "rex"), "rex"] : ["rex"];
  return candidates.find((candidate) => executableAvailable(candidate, env));
}

export function detectManagedHost(
  env: NodeJS.ProcessEnv,
  registry: SubagentProcessRegistry,
  pollMs: number,
): ManagedHostPort {
  const sleep = (ms: number, signal?: AbortSignal) => defaultSleep(ms, signal);
  const forwardEnv = managedPaneForwardEnvironment(env);
  const workspaceId = env.HERDR_WORKSPACE_ID?.trim();
  const parentPaneId = env.HERDR_PANE_ID?.trim();
  const tabId = env.HERDR_TAB_ID?.trim();
  const herdrBin = env.HERDR_BIN_PATH?.trim() || "herdr";
  if (
    env.HERDR_ENV === "1" &&
    workspaceId &&
    parentPaneId &&
    tabId &&
    executableAvailable(herdrBin, env)
  ) {
    return createHerdrHost({
      parentPaneId,
      tabId,
      bin: herdrBin,
      exec: execHerdrText,
      registry,
      isPidAlive,
      sleep,
      pollMs,
      forwardEnv,
    });
  }
  const rexSession = env.REX_SESSION?.trim();
  const rexBlock = env.REX_BLOCK?.trim();
  const rexBin = rexSession && rexBlock ? rexExecutable(env) : undefined;
  if (rexSession && rexBlock && rexBin) {
    return createRexHost({
      sessionId: rexSession,
      parentBlockId: rexBlock,
      bin: rexBin,
      exec: execRexText,
      registry,
      isPidAlive,
      sleep,
      pollMs,
      forwardEnv,
    });
  }
  return createRpcHost(registry);
}
