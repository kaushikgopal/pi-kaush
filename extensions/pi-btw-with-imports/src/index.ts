import {
  SessionManager,
  UserMessageSelectorComponent,
  buildSessionContext,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type NewSessionOptions,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { existsSync, promises as fs, realpathSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const GHOSTTY_SPLIT_SCRIPT = `on run argv
	set targetCwd to item 1 of argv
	set startupInput to item 2 of argv
	tell application "Ghostty"
		set cfg to new surface configuration
		set initial working directory of cfg to targetCwd
		set initial input of cfg to startupInput
		if (count of windows) > 0 then
			try
				set frontWindow to front window
				set targetTerminal to focused terminal of selected tab of frontWindow
				split targetTerminal direction right with configuration cfg
			on error
				new window with configuration cfg
			end try
		else
			new window with configuration cfg
		end if
		activate
	end tell
end run`;

// Constant internal command handed to a Herdr child as its first input. The
// real prompt lives in the child session marker (SPLIT_CHILD_TYPE) so it never
// appears in process argv. The child's /btw --launch handler dispatches it.
const BTW_LAUNCH_COMMAND = "/btw --launch";

type LaunchResult =
  | { ok: true; backend: "herdr" | "ghostty"; target?: string }
  | {
      ok: false;
      backend: "herdr" | "ghostty";
      reason: string;
      canDeleteSession: boolean;
    };

type SplitBackend = LaunchResult["backend"];

type PiSessionLaunch = {
  args: string[];
};

type HostResolution =
  | { ok: true; backend: SplitBackend }
  | { ok: false; reason: string };

type ExecResult = Awaited<ReturnType<ExtensionAPI["exec"]>>;

type ForkMessage = {
  entryId: string;
  text: string;
};

type ForkSession = {
  sessionFile: string;
};

// Marker appended to every child session. The prompt is embedded here so the
// Herdr launch can submit a constant `/btw --launch` command instead of the
// user prompt.
type SplitChild = {
  prompt?: string;
};

const SPLIT_CHILD_TYPE = "split-fork-child";
const HERDR_EXEC_TIMEOUT_MS = 15000;
const HERDR_AGENT_START_RETRY_DELAY_MS = 100;
const HERDR_AGENT_START_MAX_ATTEMPTS = 30;

// Messages that SessionManager.appendMessage accepts. buildSessionContext
// returns the resolved AgentMessage view; at first turn these are plain
// messages plus coding-agent custom messages, never compaction/branch
// summaries (those are resolved views, not real entries).
type AppendableMessage = Parameters<SessionManager["appendMessage"]>[0];

function shellQuote(value: string): string {
  if (value.length === 0) return "''";
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

const THIS_EXTENSION_PATH = realpathSync(fileURLToPath(import.meta.url));

function canonicalExistingPath(value: string): string | undefined {
  try {
    return realpathSync(path.resolve(value));
  } catch {
    return undefined;
  }
}

// A package-installed child discovers this extension normally. A local
// `pi -e path/to/index.ts` child does not, so propagate only a CLI extension
// argument that resolves to this exact source file.
function getMatchingExplicitExtensionArgs(): string[] {
  for (let index = 2; index < process.argv.length; index++) {
    const arg = process.argv[index];
    if (!arg) continue;
    if (arg === "-e" || arg === "--extension") {
      const candidate = process.argv[index + 1];
      if (
        candidate &&
        canonicalExistingPath(candidate) === THIS_EXTENSION_PATH
      ) {
        return [arg, candidate];
      }
      index++;
      continue;
    }
    if (arg.startsWith("--extension=")) {
      const candidate = arg.slice("--extension=".length);
      if (canonicalExistingPath(candidate) === THIS_EXTENSION_PATH) {
        return [arg];
      }
    }
  }
  return [];
}

function getPiInvocationParts(): string[] {
  const currentScript = process.argv[1];
  if (currentScript && existsSync(currentScript)) {
    return [process.execPath, currentScript];
  }

  const execName = path.basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) {
    return [process.execPath];
  }

  return ["pi"];
}

function buildPiSessionLaunch(sessionFile: string): PiSessionLaunch {
  // Args handed to `pi` itself. Herdr's `agent start --kind pi` invokes the
  // executable, so these must not include the `pi`/node prefix. The first
  // input is submitted separately: a constant `/btw --launch` for Herdr (the
  // real prompt is embedded in the child marker), or the raw prompt for
  // Ghostty (permitted to keep argv initial-input behavior).
  return {
    args: [...getMatchingExplicitExtensionArgs(), "--session", sessionFile],
  };
}

function buildStartupInput(commandParts: string[]): string {
  return `${commandParts.map(shellQuote).join(" ")}\n`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function execFailure(result: ExecResult, fallback: string): string | undefined {
  if (result.killed) return result.stderr?.trim() || `${fallback} timed out`;
  if (result.code === 0) return undefined;
  return result.stderr?.trim() || result.stdout?.trim() || fallback;
}

function isHerdrAgentPaneBusy(result: ExecResult): boolean {
  for (const output of [result.stderr, result.stdout]) {
    const message = output?.trim();
    if (!message) continue;
    try {
      const parsed = JSON.parse(message) as { error?: { code?: unknown } };
      if (parsed.error?.code === "agent_pane_busy") return true;
    } catch {
      // Some Herdr transports may not preserve the structured JSON error.
    }
    if (message.includes("agent_pane_busy")) return true;
  }
  return false;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: string; text: string } => {
      return (
        !!part &&
        typeof part === "object" &&
        (part as { type?: unknown }).type === "text"
      );
    })
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .join("");
}

function getForkMessages(ctx: ExtensionContext): ForkMessage[] {
  return ctx.sessionManager
    .getBranch()
    .flatMap((entry) => {
      if (entry.type !== "message" || entry.message.role !== "user") return [];
      return [
        { entryId: entry.id, text: extractMessageText(entry.message.content) },
      ];
    })
    .filter((message) => message.text.trim().length > 0);
}

async function chooseForkMessage(
  ctx: ExtensionContext,
  messages: ForkMessage[],
): Promise<ForkMessage | undefined> {
  if (!ctx.hasUI || ctx.mode !== "tui") {
    ctx.ui.notify("/btw without args requires the interactive UI.", "warning");
    return undefined;
  }

  const initialSelectedId = messages[messages.length - 1]?.entryId;
  const selectedEntryId = await ctx.ui.custom<string | undefined>(
    (tui, _theme, _keybindings, done) => {
      const selector = new UserMessageSelectorComponent(
        messages.map((message) => ({
          id: message.entryId,
          text: message.text,
        })),
        (entryId) => done(entryId),
        () => done(undefined),
        initialSelectedId,
      );
      const list = selector.getMessageList();
      return {
        render: (width: number) => selector.render(width),
        invalidate: () => selector.invalidate(),
        handleInput: (data: string) => {
          list.handleInput(data);
          tui.requestRender();
        },
      };
    },
  );

  return selectedEntryId
    ? messages.find((message) => message.entryId === selectedEntryId)
    : undefined;
}

async function ensureSessionFileWritten(
  sessionManager: SessionManager,
  sessionFile: string,
): Promise<void> {
  if (existsSync(sessionFile)) return;

  const header = sessionManager.getHeader();
  if (!header) throw new Error("Forked session is missing a header");

  const lines =
    [
      JSON.stringify(header),
      ...sessionManager.getEntries().map((entry) => JSON.stringify(entry)),
    ].join("\n") + "\n";
  await fs.mkdir(path.dirname(sessionFile), { recursive: true });
  await fs.writeFile(sessionFile, lines, "utf8");
}

async function deleteSplitSessionFile(
  sessionFile: string,
): Promise<string | undefined> {
  try {
    await fs.unlink(sessionFile);
    return undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return errorMessage(error);
  }
}

function buildChildData(prompt: string): SplitChild {
  return { prompt };
}

function isSplitChild(
  entry: SessionEntry,
): entry is SessionEntry & { type: "custom"; data: SplitChild } {
  if (entry.type !== "custom" || entry.customType !== SPLIT_CHILD_TYPE)
    return false;
  const data = entry.data as Partial<SplitChild> | undefined;
  return !!data && typeof data === "object";
}

function getSplitChildData(ctx: ExtensionContext): SplitChild | undefined {
  const branch = ctx.sessionManager.getBranch();
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (entry && isSplitChild(entry)) return entry.data;
  }
  return undefined;
}

async function createForkSession(
  ctx: ExtensionContext,
  sourceSessionFile: string,
  leafId: string | null,
  prompt: string,
): Promise<ForkSession> {
  const sessionDir = ctx.sessionManager.getSessionDir();
  const sessionManager = leafId
    ? SessionManager.open(sourceSessionFile, sessionDir)
    : SessionManager.create(ctx.cwd, sessionDir, {
        parentSession: sourceSessionFile,
      });
  const sessionFile = leafId
    ? sessionManager.createBranchedSession(leafId)
    : sessionManager.getSessionFile();
  if (!sessionFile) throw new Error("Failed to create split session");
  try {
    sessionManager.appendCustomEntry(SPLIT_CHILD_TYPE, buildChildData(prompt));
    await ensureSessionFileWritten(sessionManager, sessionFile);
  } catch (error) {
    const cleanupError = await deleteSplitSessionFile(sessionFile);
    throw new Error(
      cleanupError
        ? `${errorMessage(error)}; session cleanup failed: ${cleanupError}`
        : errorMessage(error),
    );
  }
  return { sessionFile };
}

// First-turn snapshot: the source session is not persisted (in-memory), so we
// cannot branch from a leaf. Instead, project the public in-memory context via
// buildSessionContext into a normal persisted child, preserving exact messages
// and the current model/thinking state. No pi-vcc, no lossy summary.
async function createSnapshotForkSession(
  ctx: ExtensionContext,
  sourceSessionFile: string | undefined,
  forkLeafId: string | null,
  prompt: string,
): Promise<ForkSession> {
  const sessionDir = ctx.sessionManager.getSessionDir();
  const entries = ctx.sessionManager.getEntries();
  // `null` is a meaningful boundary: it selects no source entries. Passing
  // undefined would incorrectly fall back to the latest in-flight entry.
  const context = buildSessionContext(entries, forkLeafId);
  const unsupportedSummary = context.messages.find((message) => {
    const role = (message as { role?: string }).role;
    return role === "branchSummary" || role === "compactionSummary";
  });
  if (unsupportedSummary) {
    throw new Error(
      `Cannot snapshot ${String((unsupportedSummary as { role?: string }).role)} context into a side session`,
    );
  }

  const parentSession =
    typeof sourceSessionFile === "string" && existsSync(sourceSessionFile)
      ? sourceSessionFile
      : undefined;
  const options: NewSessionOptions = parentSession ? { parentSession } : {};
  const child = SessionManager.create(ctx.cwd, sessionDir, options);
  const sessionFile = child.getSessionFile();
  if (!sessionFile) throw new Error("Failed to create snapshot split session");
  try {
    for (const message of context.messages) {
      child.appendMessage(message as AppendableMessage);
    }
    // Settings must trail the copied messages so they remain the final state
    // even when an inherited assistant message carries an older model.
    if (context.model) {
      child.appendModelChange(context.model.provider, context.model.modelId);
    }
    child.appendThinkingLevelChange(context.thinkingLevel);

    child.appendCustomEntry(SPLIT_CHILD_TYPE, buildChildData(prompt));
    await ensureSessionFileWritten(child, sessionFile);
    return { sessionFile };
  } catch (error) {
    const cleanupError = await deleteSplitSessionFile(sessionFile);
    throw new Error(
      cleanupError
        ? `${errorMessage(error)}; session cleanup failed: ${cleanupError}`
        : errorMessage(error),
    );
  }
}

function promptedForkLeaf(ctx: ExtensionContext): string | null {
  const branch = ctx.sessionManager.getBranch();
  let boundary = ctx.sessionManager.getLeafId();
  let seenSettledAssistant = false;
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (!entry) continue;
    if (
      entry.type === "message" &&
      entry.message.role === "assistant" &&
      entry.message.stopReason === "stop"
    ) {
      seenSettledAssistant = true;
    } else if (
      entry.type === "message" &&
      entry.message.role === "user" &&
      !seenSettledAssistant
    ) {
      boundary = entry.parentId;
    }
  }
  return boundary;
}

async function launchHerdrSplit(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  launch: PiSessionLaunch,
  agentName: string,
): Promise<LaunchResult> {
  const herdrBin = process.env.HERDR_BIN_PATH || "herdr";
  const paneId = process.env.HERDR_PANE_ID;
  if (!paneId) {
    return {
      ok: false,
      backend: "herdr",
      reason: "missing Herdr pane identity",
      canDeleteSession: true,
    };
  }
  // Step 1: split the current pane to the right. A definite failure here
  // happens before any child exists, so the copied session can be deleted.
  let splitResult: ExecResult;
  try {
    splitResult = await pi.exec(
      herdrBin,
      [
        "pane",
        "split",
        "--pane",
        paneId,
        "--direction",
        "right",
        "--cwd",
        ctx.cwd,
        "--env",
        "HERDR_AGENT=pi",
        "--focus",
      ],
      { timeout: HERDR_EXEC_TIMEOUT_MS },
    );
  } catch (error) {
    return {
      ok: false,
      backend: "herdr",
      reason: errorMessage(error),
      canDeleteSession: true,
    };
  }

  const splitFailure = execFailure(splitResult, "Herdr pane split failed");
  if (splitFailure) {
    return {
      ok: false,
      backend: "herdr",
      reason: splitFailure,
      canDeleteSession: !splitResult.killed,
    };
  }

  // Step 2: parse the new pane id. If the split returned but the id cannot be
  // parsed, the pane may already exist, so retain the copied session.
  let newPaneId: string;
  try {
    const parsed = JSON.parse(splitResult.stdout) as {
      result?: { pane?: { pane_id?: unknown } };
    };
    const candidate = parsed?.result?.pane?.pane_id;
    if (typeof candidate !== "string" || candidate.length === 0) {
      throw new Error("missing .result.pane.pane_id");
    }
    newPaneId = candidate;
  } catch (error) {
    return {
      ok: false,
      backend: "herdr",
      reason: `could not parse split pane id: ${errorMessage(error)}`,
      canDeleteSession: false,
    };
  }

  // Step 3: start the pi agent in the new pane. A successful pane split can
  // return before its shell reaches the interactive prompt required by
  // `agent start`, so retry only that transient structured failure.
  const agentStartArgs = [
    "agent",
    "start",
    agentName,
    "--kind",
    "pi",
    "--pane",
    newPaneId,
    "--timeout",
    "10000",
    "--",
    ...launch.args,
  ];
  let startResult: ExecResult;
  try {
    startResult = await pi.exec(herdrBin, agentStartArgs, {
      timeout: HERDR_EXEC_TIMEOUT_MS,
    });
    for (
      let attempt = 1;
      attempt < HERDR_AGENT_START_MAX_ATTEMPTS &&
      !startResult.killed &&
      startResult.code !== 0 &&
      isHerdrAgentPaneBusy(startResult);
      attempt++
    ) {
      await wait(HERDR_AGENT_START_RETRY_DELAY_MS);
      startResult = await pi.exec(herdrBin, agentStartArgs, {
        timeout: HERDR_EXEC_TIMEOUT_MS,
      });
    }
  } catch (error) {
    return {
      ok: false,
      backend: "herdr",
      reason: errorMessage(error),
      canDeleteSession: false,
    };
  }

  const startFailure = execFailure(startResult, "Herdr agent start failed");
  if (startFailure) {
    if (startResult.killed) {
      // Ambiguous timeout: the agent may still be starting. Retain the pane
      // and the copied session so the launch stays recoverable.
      return {
        ok: false,
        backend: "herdr",
        reason: startFailure,
        canDeleteSession: false,
      };
    }
    // Definite nonzero failure after pane creation: best-effort close the new
    // pane. Delete the copied session only when the pane close is definite.
    let closeFailure: string | undefined;
    try {
      const closeResult = await pi.exec(
        herdrBin,
        ["pane", "close", newPaneId],
        { timeout: 5000 },
      );
      closeFailure = execFailure(closeResult, "Herdr pane close failed");
    } catch (error) {
      closeFailure = errorMessage(error);
    }
    if (closeFailure) {
      return {
        ok: false,
        backend: "herdr",
        reason: `${startFailure}; pane cleanup retained: ${closeFailure}`,
        canDeleteSession: false,
      };
    }
    return {
      ok: false,
      backend: "herdr",
      reason: startFailure,
      canDeleteSession: true,
    };
  }

  // Step 4: submit the constant launch command. The real prompt is embedded in
  // the child session marker and dispatched by /btw --launch, so it never
  // appears in process argv.
  let promptResult: ExecResult;
  try {
    promptResult = await pi.exec(
      herdrBin,
      ["agent", "prompt", agentName, BTW_LAUNCH_COMMAND],
      { timeout: HERDR_EXEC_TIMEOUT_MS },
    );
  } catch (error) {
    return {
      ok: false,
      backend: "herdr",
      reason: errorMessage(error),
      canDeleteSession: false,
    };
  }

  const promptFailure = execFailure(promptResult, "Herdr agent prompt failed");
  if (promptFailure) {
    return {
      ok: false,
      backend: "herdr",
      reason: promptFailure,
      canDeleteSession: false,
    };
  }

  return { ok: true, backend: "herdr", target: agentName };
}

async function launchGhosttySplit(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  launch: PiSessionLaunch,
  prompt: string,
): Promise<LaunchResult> {
  if (process.platform !== "darwin") {
    return {
      ok: false,
      backend: "ghostty",
      reason: "Ghostty split requires macOS",
      canDeleteSession: true,
    };
  }

  // Ghostty is permitted to keep the raw prompt as initial input argv.
  const startupInput = buildStartupInput([
    ...getPiInvocationParts(),
    ...launch.args,
    prompt,
  ]);
  let result: ExecResult;
  try {
    result = await pi.exec(
      "osascript",
      ["-e", GHOSTTY_SPLIT_SCRIPT, "--", ctx.cwd, startupInput],
      {
        timeout: 10000,
      },
    );
  } catch (error) {
    return {
      ok: false,
      backend: "ghostty",
      reason: errorMessage(error),
      canDeleteSession: false,
    };
  }

  const failure = execFailure(result, "unknown osascript error");
  return failure
    ? {
        ok: false,
        backend: "ghostty",
        reason: failure,
        canDeleteSession: false,
      }
    : { ok: true, backend: "ghostty" };
}

async function resolveSplitHost(pi: ExtensionAPI): Promise<HostResolution> {
  if (process.env.HERDR_ENV === "1") {
    if (!process.env.HERDR_PANE_ID) {
      return {
        ok: false,
        reason: "Herdr is active but its pane identity is missing.",
      };
    }
    return { ok: true, backend: "herdr" };
  }

  if (process.platform !== "darwin") {
    return {
      ok: false,
      reason: "A split requires an active Herdr session or Ghostty on macOS.",
    };
  }

  try {
    const result = await pi.exec("open", ["-Ra", "Ghostty"], { timeout: 5000 });
    const failure = execFailure(result, "Ghostty is not installed");
    return failure
      ? { ok: false, reason: "Ghostty is not installed or cannot be opened." }
      : { ok: true, backend: "ghostty" };
  } catch {
    return {
      ok: false,
      reason: "Ghostty is not installed or cannot be opened.",
    };
  }
}

async function launchSplit(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  backend: SplitBackend,
  launch: PiSessionLaunch,
  prompt: string,
  agentName: string,
): Promise<LaunchResult> {
  if (backend === "herdr") return launchHerdrSplit(pi, ctx, launch, agentName);
  return launchGhosttySplit(pi, ctx, launch, prompt);
}

// Internal: dispatched inside a freshly launched child. Reads the embedded
// prompt from the child marker and submits it as the first user message, so
// the prompt never traveled through process argv.
async function runBtwLaunch(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const child = getSplitChildData(ctx);
  if (!child) {
    ctx.ui.notify(
      "/btw --launch can only run inside a side split created by /btw.",
      "warning",
    );
    return;
  }
  const prompt = child.prompt;
  if (!prompt) {
    ctx.ui.notify("Side session has no embedded prompt to launch.", "warning");
    return;
  }
  await ctx.waitForIdle();
  pi.sendUserMessage(prompt);
  ctx.ui.notify("Started the side task in this split.", "info");
}

async function runBtwSplit(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  promptArg: string,
): Promise<void> {
  if (getSplitChildData(ctx)) {
    ctx.ui.notify(
      "Cannot start a nested /btw split from inside a side split.",
      "warning",
    );
    return;
  }
  const prompt = promptArg.trim();
  const sourceSessionFile = ctx.sessionManager.getSessionFile();
  const sourcePersisted = !!sourceSessionFile && existsSync(sourceSessionFile);

  const host = await resolveSplitHost(pi);
  if (!host.ok) {
    ctx.ui.notify(`Cannot split: ${host.reason}`, "error");
    return;
  }

  const herdrAgentName = `pi-btw-${randomUUID().slice(0, 8)}`;

  let splitSessionFile: string | undefined;
  let launchPrompt = "";
  let launchAttempted = false;

  try {
    let piLaunch: PiSessionLaunch;
    let forkedBeforeInFlight = false;

    if (prompt.length > 0) {
      const forkLeafId = promptedForkLeaf(ctx);
      forkedBeforeInFlight = forkLeafId !== ctx.sessionManager.getLeafId();
      if (sourcePersisted) {
        if (!forkLeafId) {
          ctx.ui.notify(
            "Wait for the first response to finish before splitting.",
            "warning",
          );
          return;
        }
        ({ sessionFile: splitSessionFile } = await createForkSession(
          ctx,
          sourceSessionFile!,
          forkLeafId,
          prompt,
        ));
      } else {
        // First turn: the source session is not persisted. Snapshot the
        // in-memory context into a normal persisted child.
        ({ sessionFile: splitSessionFile } = await createSnapshotForkSession(
          ctx,
          sourceSessionFile,
          forkLeafId,
          prompt,
        ));
      }
      piLaunch = buildPiSessionLaunch(splitSessionFile!);
      launchPrompt = prompt;
    } else {
      const messages = getForkMessages(ctx);
      if (messages.length === 0) {
        ctx.ui.notify("No messages to split from.", "warning");
        return;
      }
      const selected = await chooseForkMessage(ctx, messages);
      if (!selected) return;
      const selectedEntry = ctx.sessionManager.getEntry(selected.entryId);
      if (
        !selectedEntry ||
        selectedEntry.type !== "message" ||
        selectedEntry.message.role !== "user"
      ) {
        ctx.ui.notify("Invalid message selected for split", "error");
        return;
      }
      const forkLeafId = selectedEntry.parentId;
      if (sourcePersisted) {
        ({ sessionFile: splitSessionFile } = await createForkSession(
          ctx,
          sourceSessionFile!,
          forkLeafId,
          selected.text,
        ));
      } else {
        ({ sessionFile: splitSessionFile } = await createSnapshotForkSession(
          ctx,
          sourceSessionFile,
          forkLeafId,
          selected.text,
        ));
      }
      piLaunch = buildPiSessionLaunch(splitSessionFile!);
      launchPrompt = selected.text;
    }

    if (!splitSessionFile) throw new Error("Failed to create split session");
    launchAttempted = true;
    const launch = await launchSplit(
      pi,
      ctx,
      host.backend,
      piLaunch,
      launchPrompt,
      herdrAgentName,
    );
    if (!launch.ok) {
      let reason = launch.reason;
      if (launch.canDeleteSession) {
        const cleanupError = await deleteSplitSessionFile(splitSessionFile);
        if (cleanupError) reason += `; session cleanup failed: ${cleanupError}`;
      } else {
        reason += `; copied session kept at ${splitSessionFile}`;
      }
      ctx.ui.notify(`Failed to launch split: ${reason}`, "error");
      return;
    }

    const herdrTarget = launch.backend === "herdr" ? launch.target : undefined;
    const target = herdrTarget ? ` (${herdrTarget})` : "";
    ctx.ui.notify(
      `Opened split in a ${launch.backend} right split${target} and sent prompt.`,
      "info",
    );
    if (forkedBeforeInFlight) {
      ctx.ui.notify(
        "Split from last settled state; in-flight turn continues here.",
        "info",
      );
    }
  } catch (error) {
    let reason = errorMessage(error);
    if (splitSessionFile && !launchAttempted) {
      const cleanupError = await deleteSplitSessionFile(splitSessionFile);
      if (cleanupError) reason += `; session cleanup failed: ${cleanupError}`;
    }
    ctx.ui.notify(`Failed to launch split: ${reason}`, "error");
  }
}

export default function btwWithImports(pi: ExtensionAPI) {
  pi.registerCommand("btw", {
    description:
      "Fork into a right-hand side session (`/btw <goal>`) or choose a previous user message (`/btw`).",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      if (trimmed === "--launch") return runBtwLaunch(pi, ctx);
      if (trimmed === "merge" || trimmed.startsWith("merge ")) {
        // Removed in the launch-only simplification; refuse instead of
        // launching a side session whose goal is the literal "/btw merge".
        ctx.ui.notify(
          "Side-session merging was removed; /btw merge is no longer supported.",
          "warning",
        );
        return;
      }
      return runBtwSplit(pi, ctx, trimmed);
    },
  });
}
