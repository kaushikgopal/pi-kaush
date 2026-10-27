import {
  SessionManager,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { accessSync, constants, existsSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve, sep } from "node:path";

const HERDR_TIMEOUT_MS = 15_000;
const HERDR_BUSY_RETRIES = 30;
const HERDR_BUSY_DELAY_MS = 100;
const REX_TIMEOUT_MS = 15_000;
const REX_FORWARD_ENV_KEYS = [
  "PI_CODING_AGENT_DIR",
  "PI_PACKAGE_DIR",
  "PI_OFFLINE",
  "PI_SKIP_VERSION_CHECK",
  "PI_TELEMETRY",
  "PI_CACHE_RETENTION",
] as const;

type ExecResult = Awaited<ReturnType<ExtensionAPI["exec"]>>;

type LaunchResult =
  | { ok: true; target: string }
  | { ok: false; reason: string };

type SessionTarget = {
  flag: "--fork" | "--session";
  path: string;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function execFailure(result: ExecResult, fallback: string): string | undefined {
  if (result.killed) return result.stderr.trim() || `${fallback} timed out`;
  if (result.code === 0) return undefined;
  return result.stderr.trim() || result.stdout.trim() || fallback;
}

function isHerdrPaneBusy(result: ExecResult): boolean {
  try {
    const parsed = JSON.parse(result.stderr || result.stdout) as {
      error?: { code?: unknown };
    };
    return parsed.error?.code === "agent_pane_busy";
  } catch {
    return false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function executableAvailable(bin: string): boolean {
  const candidates =
    isAbsolute(bin) || bin.includes(sep)
      ? [bin]
      : (process.env.PATH ?? "")
          .split(delimiter)
          .map((directory) => join(directory, bin));
  return candidates.some((candidate) => {
    try {
      accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

function rexExecutable(): string | undefined {
  const binDir = process.env.REX_BIN_DIR?.trim();
  const candidates = binDir ? [join(binDir, "rex"), "rex"] : ["rex"];
  return candidates.find(executableAvailable);
}

function rexSession():
  | { bin: string; session: string; block: string }
  | undefined {
  const session = process.env.REX_SESSION?.trim();
  const block = process.env.REX_BLOCK?.trim();
  const bin = session && block ? rexExecutable() : undefined;
  return session && block && bin ? { bin, session, block } : undefined;
}

function rexForwardEnvironment(): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of REX_FORWARD_ENV_KEYS) {
    const value = process.env[key];
    if (value) result[key] = value;
  }
  return result;
}

function getPiInvocation(): { command: string; args: string[] } {
  const scriptPath = process.argv[1];
  if (existsSync(process.execPath) && scriptPath && existsSync(scriptPath)) {
    return { command: process.execPath, args: [resolve(scriptPath)] };
  }
  return { command: "pi", args: [] };
}

function rexPrompt(prompt: string): string {
  // Pi parses leading @ as a file argument even after --; whitespace keeps it text.
  return prompt.startsWith("@") ? ` ${prompt}` : prompt;
}

async function launchRex(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  host: { bin: string; session: string; block: string },
  sessionTarget: SessionTarget,
  prompt: string,
): Promise<LaunchResult> {
  const forwardEnv = rexForwardEnvironment();
  const invocation = getPiInvocation();
  const command = [
    "env",
    ...Object.entries(forwardEnv).map(([key, value]) => `${key}=${value}`),
    invocation.command,
    ...invocation.args,
    sessionTarget.flag,
    sessionTarget.path,
    "--",
    rexPrompt(prompt),
  ];

  let split: ExecResult;
  try {
    split = await pi.exec(
      host.bin,
      [
        "split",
        "-s",
        host.session,
        "-b",
        host.block,
        "--split=right",
        "--focus=false",
        "--label",
        "btw",
        "-c",
        ctx.cwd,
        "--json",
        "--",
        ...command,
      ],
      { timeout: REX_TIMEOUT_MS },
    );
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }

  const failure = execFailure(split, "Rex split failed");
  if (failure) return { ok: false, reason: failure };

  try {
    const response = JSON.parse(split.stdout) as {
      block_ids?: unknown;
    } | null;
    const blockIds = response?.block_ids;
    const blockId = Array.isArray(blockIds) ? blockIds[0] : undefined;
    if (typeof blockId !== "string" || !blockId) {
      throw new Error("Rex split did not return a block ID");
    }
    return { ok: true, target: blockId };
  } catch (error) {
    return {
      ok: false,
      reason:
        error instanceof SyntaxError
          ? "Rex split returned non-JSON output"
          : errorMessage(error),
    };
  }
}

async function launchHerdr(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  sessionTarget: SessionTarget,
  prompt: string,
): Promise<LaunchResult> {
  if (!process.env.HERDR_PANE_ID) {
    return {
      ok: false,
      reason: "Herdr is active but the current pane identity is missing.",
    };
  }

  const herdr = process.env.HERDR_BIN_PATH || "herdr";
  let split: ExecResult;
  try {
    split = await pi.exec(
      herdr,
      [
        "pane",
        "split",
        "--current",
        "--direction",
        "right",
        "--cwd",
        ctx.cwd,
        "--no-focus",
      ],
      { timeout: HERDR_TIMEOUT_MS },
    );
  } catch (error) {
    return { ok: false, reason: errorMessage(error) };
  }

  const splitFailure = execFailure(split, "Herdr pane split failed");
  if (splitFailure) return { ok: false, reason: splitFailure };

  let paneId: string;
  try {
    const response = JSON.parse(split.stdout) as {
      result?: { pane?: { pane_id?: unknown } };
    };
    if (typeof response.result?.pane?.pane_id !== "string") {
      throw new Error("missing .result.pane.pane_id");
    }
    paneId = response.result.pane.pane_id;
  } catch (error) {
    return {
      ok: false,
      reason: `Could not read the new Herdr pane id: ${errorMessage(error)}`,
    };
  }

  const agentName = `pi-btw-${randomUUID().slice(0, 8)}`;
  const startArgs = [
    "agent",
    "start",
    agentName,
    "--kind",
    "pi",
    "--pane",
    paneId,
    "--timeout",
    "10000",
    "--",
    sessionTarget.flag,
    sessionTarget.path,
  ];

  let start: ExecResult | undefined;
  try {
    for (let attempt = 0; attempt < HERDR_BUSY_RETRIES; attempt++) {
      start = await pi.exec(herdr, startArgs, { timeout: HERDR_TIMEOUT_MS });
      if (!isHerdrPaneBusy(start) || start.code === 0 || start.killed) break;
      await delay(HERDR_BUSY_DELAY_MS);
    }
  } catch (error) {
    return {
      ok: false,
      reason: `Pane ${paneId} was created, but Pi could not start: ${errorMessage(error)}`,
    };
  }

  const startFailure = execFailure(start!, "Herdr agent start failed");
  if (startFailure) {
    return {
      ok: false,
      reason: `Pane ${paneId} was created, but Pi could not start: ${startFailure}`,
    };
  }

  let submitted: ExecResult;
  try {
    submitted = await pi.exec(herdr, ["agent", "prompt", agentName, prompt], {
      timeout: HERDR_TIMEOUT_MS,
    });
  } catch (error) {
    return {
      ok: false,
      reason: `Pi started as ${agentName}, but the question was not sent: ${errorMessage(error)}`,
    };
  }

  const promptFailure = execFailure(submitted, "Herdr agent prompt failed");
  if (promptFailure) {
    return {
      ok: false,
      reason: `Pi started as ${agentName}, but the question was not sent: ${promptFailure}`,
    };
  }

  return { ok: true, target: agentName };
}

async function switchToFork(
  ctx: ExtensionCommandContext,
  prompt: string,
): Promise<void> {
  const leafId = ctx.sessionManager.getLeafId();
  if (!leafId) {
    ctx.ui.notify(
      "The current session has no conversation to fork yet.",
      "warning",
    );
    return;
  }

  const result = await ctx.fork(leafId, {
    position: "at",
    withSession: async (child) => {
      child.ui.notify(
        "Herdr or Rex is unavailable, so /btw switched to a fork. The original session is saved but dormant; use /resume to return.",
        "info",
      );
      await child.sendUserMessage(prompt);
    },
  });

  if (result.cancelled) {
    ctx.ui.notify("The side-session fork was cancelled.", "warning");
  }
}

function snapshotAt(sessionFile: string, leafId: string): SessionTarget {
  const snapshot =
    SessionManager.open(sessionFile).createBranchedSession(leafId);
  if (!snapshot) {
    throw new Error("Pi did not create a persisted side-session snapshot.");
  }
  return { flag: "--session", path: snapshot };
}

function getHostedSessionTarget(
  ctx: ExtensionCommandContext,
  activeRunBaseLeafId: string | null | undefined,
): SessionTarget | undefined {
  const sessionFile = ctx.sessionManager.getSessionFile();
  if (
    !sessionFile ||
    !existsSync(sessionFile) ||
    !ctx.sessionManager.getLeafId()
  ) {
    ctx.ui.notify(
      "/btw needs at least one completed response before it can fork context.",
      "warning",
    );
    return undefined;
  }

  let sessionTarget: SessionTarget = {
    flag: "--fork",
    path: sessionFile,
  };
  if (!ctx.isIdle()) {
    const checkpointLeafId =
      activeRunBaseLeafId === undefined
        ? ctx.sessionManager.getLeafId()
        : activeRunBaseLeafId;
    if (!checkpointLeafId) {
      ctx.ui.notify(
        "/btw needs at least one completed response before it can fork context.",
        "warning",
      );
      return undefined;
    }
    try {
      sessionTarget = snapshotAt(sessionFile, checkpointLeafId);
    } catch (error) {
      ctx.ui.notify(
        `Failed to snapshot the last completed response: ${errorMessage(error)}`,
        "error",
      );
      return undefined;
    }
  }
  return sessionTarget;
}

async function runBtw(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  args: string,
  activeRunBaseLeafId: string | null | undefined,
): Promise<void> {
  const prompt = args.trim();
  if (!prompt) {
    ctx.ui.notify("Usage: /btw <question>", "warning");
    return;
  }
  if (ctx.mode !== "tui") {
    ctx.ui.notify("/btw requires an interactive Pi session.", "warning");
    return;
  }
  const rex = process.env.HERDR_ENV === "1" ? undefined : rexSession();
  if (process.env.HERDR_ENV === "1" || rex) {
    const sessionTarget = getHostedSessionTarget(ctx, activeRunBaseLeafId);
    if (!sessionTarget) return;

    const hostName = rex ? "Rex" : "Herdr";
    const result = rex
      ? await launchRex(pi, ctx, rex, sessionTarget, prompt)
      : await launchHerdr(pi, ctx, sessionTarget, prompt);
    if (!result.ok) {
      ctx.ui.notify(`Failed to open side session: ${result.reason}`, "error");
      return;
    }

    ctx.ui.notify(
      `Opened a ${hostName} side session (${result.target}) and sent the question.`,
      "info",
    );
    return;
  }

  if (!ctx.isIdle()) {
    ctx.ui.notify(
      "Wait for the current response to finish before using /btw without Herdr or Rex.",
      "warning",
    );
    return;
  }
  await switchToFork(ctx, prompt);
}

export default function piBtw(pi: ExtensionAPI) {
  let activeRunBaseLeafId: string | null | undefined;

  pi.on("before_agent_start", (_event, ctx) => {
    activeRunBaseLeafId = ctx.sessionManager.getLeafId();
  });
  pi.on("agent_settled", () => {
    activeRunBaseLeafId = undefined;
  });

  pi.registerCommand("btw", {
    description: "Ask a question in a fork of the current Pi session.",
    handler: (args, ctx) => runBtw(pi, ctx, args, activeRunBaseLeafId),
  });
}
