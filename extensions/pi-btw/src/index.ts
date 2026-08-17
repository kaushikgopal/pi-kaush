import {
  SessionManager,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";

const HERDR_TIMEOUT_MS = 15_000;
const HERDR_BUSY_RETRIES = 30;
const HERDR_BUSY_DELAY_MS = 100;

type ExecResult = Awaited<ReturnType<ExtensionAPI["exec"]>>;

type HerdrLaunchResult =
  | { ok: true; target: string }
  | { ok: false; reason: string };

type HerdrSessionTarget = {
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
  const output = `${result.stderr}\n${result.stdout}`;
  if (output.includes("agent_pane_busy")) return true;
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

async function launchHerdr(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  sessionTarget: HerdrSessionTarget,
  prompt: string,
): Promise<HerdrLaunchResult> {
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
        "Herdr is unavailable, so /btw switched to a fork. The original session is saved but dormant; use /resume to return.",
        "info",
      );
      await child.sendUserMessage(prompt);
    },
  });

  if (result.cancelled) {
    ctx.ui.notify("The side-session fork was cancelled.", "warning");
  }
}

function snapshotAt(sessionFile: string, leafId: string): HerdrSessionTarget {
  const snapshot =
    SessionManager.open(sessionFile).createBranchedSession(leafId);
  if (!snapshot) {
    throw new Error("Pi did not create a persisted side-session snapshot.");
  }
  return { flag: "--session", path: snapshot };
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
  if (process.env.HERDR_ENV !== "1") {
    if (!ctx.isIdle()) {
      ctx.ui.notify(
        "Wait for the current response to finish before using /btw outside Herdr.",
        "warning",
      );
      return;
    }
    await switchToFork(ctx, prompt);
    return;
  }

  const sessionFile = ctx.sessionManager.getSessionFile();
  if (!sessionFile || !existsSync(sessionFile)) {
    ctx.ui.notify(
      "/btw needs at least one completed response before it can fork context.",
      "warning",
    );
    return;
  }

  let sessionTarget: HerdrSessionTarget = {
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
      return;
    }
    try {
      sessionTarget = snapshotAt(sessionFile, checkpointLeafId);
    } catch (error) {
      ctx.ui.notify(
        `Failed to snapshot the last completed response: ${errorMessage(error)}`,
        "error",
      );
      return;
    }
  }

  const result = await launchHerdr(pi, ctx, sessionTarget, prompt);
  if (!result.ok) {
    ctx.ui.notify(`Failed to open side session: ${result.reason}`, "error");
    return;
  }

  ctx.ui.notify(
    `Opened a Herdr side session (${result.target}) and sent the question.`,
    "info",
  );
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
