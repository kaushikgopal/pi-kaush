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
  baseLeafId: string | null;
};

const SPLIT_RECORD_TYPE = "split-fork-record";
const SPLIT_CHILD_TYPE = "split-fork-child";
const SPLIT_MERGE_INTENT_TYPE = "split-merge-intent";
const SPLIT_MERGE_REQUEST_TYPE = "split-merge-request";
const SPLIT_MERGE_RESULT_TYPE = "split-merge-result";
const HERDR_EXEC_TIMEOUT_MS = 15000;

const SPLIT_HANDOFF_PROMPT = `Prepare the final handoff from this side split for the main coding-agent session.

Preserve:
- each distinct answer or outcome
- important files, commands, and evidence
- decisions and recommendations
- blockers, uncertainty, and follow-up work

Return only the clean, concise handoff. Do not collapse separate results into one, solve the task again, or mention these instructions.`;

type SplitRecord = {
  sessionFile: string;
  baseLeafId: string | null;
  label: string;
  // Optional Herdr agent name captured at launch so a later parent-side
  // `/btw merge` can dispatch to the live child without querying `agent list`.
  herdrTarget?: string;
};

// Marker appended to every child session. The prompt is embedded here so the
// Herdr launch can submit a constant `/btw --launch` command instead of the
// user prompt. parentPaneId lets a child refocus its parent on merge.
type SplitChild = {
  baseLeafId: string | null;
  prompt?: string;
  parentPaneId?: string;
};

// Durable intent written before the handoff prompt is submitted. If the child
// exits after the response but before finalization, session_start can recover
// the exact request from this record.
type MergeIntent = {
  requestId: string;
  handoffPrompt: string;
};

// Durable "pending merge" record written only after the intent's exact user
// prompt has a completed terminal assistant response.
type MergeRequest = {
  requestId: string;
  intentEntryId: string;
  promptEntryId: string;
  answerEntryId: string;
};

// Durable "processed merge" record written into the parent when a handoff is
// imported. Used to dedupe by requestId across resumes and manual imports.
type MergeResult = {
  requestId: string;
  sessionFile: string;
  answerEntryId: string;
};

type PendingMerge = {
  record: SplitRecord;
  requestId: string;
  requestEntryId: string;
  intentEntryId: string;
  promptEntryId: string;
  answerEntryId: string;
  sessionFile: string;
};

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

function buildChildData(
  baseLeafId: string | null,
  prompt: string,
  parentPaneId: string | undefined,
): SplitChild {
  const data: SplitChild = { baseLeafId, prompt };
  if (parentPaneId) data.parentPaneId = parentPaneId;
  return data;
}

async function createForkSession(
  ctx: ExtensionContext,
  sourceSessionFile: string,
  leafId: string | null,
  prompt: string,
  parentPaneId: string | undefined,
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
  const baseLeafId = sessionManager.getLeafId();
  try {
    sessionManager.appendCustomEntry(
      SPLIT_CHILD_TYPE,
      buildChildData(baseLeafId, prompt, parentPaneId),
    );
    await ensureSessionFileWritten(sessionManager, sessionFile);
  } catch (error) {
    const cleanupError = await deleteSplitSessionFile(sessionFile);
    throw new Error(
      cleanupError
        ? `${errorMessage(error)}; session cleanup failed: ${cleanupError}`
        : errorMessage(error),
    );
  }
  return { sessionFile, baseLeafId };
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
  parentPaneId: string | undefined,
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

    const baseLeafId = child.getLeafId();
    child.appendCustomEntry(
      SPLIT_CHILD_TYPE,
      buildChildData(baseLeafId, prompt, parentPaneId),
    );
    await ensureSessionFileWritten(child, sessionFile);
    return { sessionFile, baseLeafId };
  } catch (error) {
    const cleanupError = await deleteSplitSessionFile(sessionFile);
    throw new Error(
      cleanupError
        ? `${errorMessage(error)}; session cleanup failed: ${cleanupError}`
        : errorMessage(error),
    );
  }
}

async function createForkAtSelectedMessage(
  ctx: ExtensionContext,
  sourceSessionFile: string,
  entryId: string,
  prompt: string,
  parentPaneId: string | undefined,
): Promise<ForkSession> {
  const selectedEntry = ctx.sessionManager.getEntry(entryId);
  if (
    !selectedEntry ||
    selectedEntry.type !== "message" ||
    selectedEntry.message.role !== "user"
  ) {
    throw new Error("Invalid message selected for split");
  }
  return createForkSession(
    ctx,
    sourceSessionFile,
    selectedEntry.parentId,
    prompt,
    parentPaneId,
  );
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
  const agentName = `pi-btw-${randomUUID().slice(0, 8)}`;

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

  // Step 3: start the pi agent in the new pane. Any failure here happens after
  // pane creation, so the child may exist.
  let startResult: ExecResult;
  try {
    startResult = await pi.exec(
      herdrBin,
      [
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
      ],
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
): Promise<LaunchResult> {
  if (backend === "herdr") return launchHerdrSplit(pi, ctx, launch);
  return launchGhosttySplit(pi, ctx, launch, prompt);
}

function isSplitRecord(
  entry: SessionEntry,
): entry is SessionEntry & { type: "custom"; data: SplitRecord } {
  if (entry.type !== "custom" || entry.customType !== SPLIT_RECORD_TYPE)
    return false;
  const data = entry.data as Partial<SplitRecord> | undefined;
  return (
    !!data &&
    typeof data.sessionFile === "string" &&
    (data.baseLeafId === null || typeof data.baseLeafId === "string") &&
    typeof data.label === "string" &&
    (data.herdrTarget === undefined || typeof data.herdrTarget === "string")
  );
}

function isSplitChild(
  entry: SessionEntry,
): entry is SessionEntry & { type: "custom"; data: SplitChild } {
  if (entry.type !== "custom" || entry.customType !== SPLIT_CHILD_TYPE)
    return false;
  const data = entry.data as Partial<SplitChild> | undefined;
  return (
    !!data &&
    (data.baseLeafId === null || typeof data.baseLeafId === "string") &&
    (data.prompt === undefined || typeof data.prompt === "string") &&
    (data.parentPaneId === undefined || typeof data.parentPaneId === "string")
  );
}

function getMergeIntent(entry: SessionEntry): MergeIntent | undefined {
  if (entry.type !== "custom" || entry.customType !== SPLIT_MERGE_INTENT_TYPE)
    return undefined;
  const data = entry.data as Partial<MergeIntent> | undefined;
  return data &&
    typeof data.requestId === "string" &&
    typeof data.handoffPrompt === "string"
    ? { requestId: data.requestId, handoffPrompt: data.handoffPrompt }
    : undefined;
}

function getMergeRequest(entry: SessionEntry): MergeRequest | undefined {
  if (entry.type !== "custom" || entry.customType !== SPLIT_MERGE_REQUEST_TYPE)
    return undefined;
  const data = entry.data as Partial<MergeRequest> | undefined;
  return data &&
    typeof data.requestId === "string" &&
    typeof data.intentEntryId === "string" &&
    typeof data.promptEntryId === "string" &&
    typeof data.answerEntryId === "string"
    ? {
        requestId: data.requestId,
        intentEntryId: data.intentEntryId,
        promptEntryId: data.promptEntryId,
        answerEntryId: data.answerEntryId,
      }
    : undefined;
}

function getMergeResult(entry: SessionEntry): MergeResult | undefined {
  if (
    entry.type !== "custom_message" ||
    entry.customType !== SPLIT_MERGE_RESULT_TYPE
  )
    return undefined;
  const details = entry.details as Partial<MergeResult> | undefined;
  return details &&
    typeof details.requestId === "string" &&
    typeof details.sessionFile === "string" &&
    typeof details.answerEntryId === "string"
    ? {
        requestId: details.requestId,
        sessionFile: details.sessionFile,
        answerEntryId: details.answerEntryId,
      }
    : undefined;
}

function getSplitChildData(ctx: ExtensionContext): SplitChild | undefined {
  const branch = ctx.sessionManager.getBranch();
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (entry && isSplitChild(entry)) return entry.data;
  }
  return undefined;
}

function getSplitRecords(ctx: ExtensionContext): SplitRecord[] {
  return ctx.sessionManager
    .getBranch()
    .filter(isSplitRecord)
    .map((entry) => entry.data);
}

function getProcessedMergeRequestIds(ctx: ExtensionContext): Set<string> {
  const ids = new Set<string>();
  for (const entry of ctx.sessionManager.getBranch()) {
    const result = getMergeResult(entry);
    if (result) ids.add(result.requestId);
  }
  return ids;
}

type MessageEntry = Extract<SessionEntry, { type: "message" }>;

type CompletedHandoff = {
  promptEntry: MessageEntry;
  answerEntry: MessageEntry;
};

function findCompletedHandoffForIntent(
  branch: SessionEntry[],
  intentEntryId: string,
  intent: MergeIntent,
  endIndex = branch.length,
): CompletedHandoff | undefined {
  const intentIndex = branch.findIndex((entry) => entry.id === intentEntryId);
  if (intentIndex < 0 || intentIndex >= endIndex) return undefined;

  // The exact handoff must be the first user message after its intent. This
  // prevents an older answer or a later unrelated turn from satisfying it.
  let promptIndex = -1;
  for (let index = intentIndex + 1; index < endIndex; index++) {
    const entry = branch[index];
    if (entry?.type !== "message" || entry.message.role !== "user") continue;
    if (extractMessageText(entry.message.content) !== intent.handoffPrompt) {
      return undefined;
    }
    promptIndex = index;
    break;
  }
  if (promptIndex < 0) return undefined;

  let terminalMessage: MessageEntry | undefined;
  for (let index = promptIndex + 1; index < endIndex; index++) {
    const entry = branch[index];
    if (entry?.type !== "message") continue;
    if (entry.message.role === "user") return undefined;
    terminalMessage = entry;
  }
  if (
    !terminalMessage ||
    terminalMessage.message.role !== "assistant" ||
    terminalMessage.message.stopReason !== "stop"
  ) {
    return undefined;
  }

  return {
    promptEntry: branch[promptIndex] as MessageEntry,
    answerEntry: terminalMessage,
  };
}

function validateMergeRequestAssociation(
  branch: SessionEntry[],
  requestEntry: SessionEntry,
  request: MergeRequest,
): CompletedHandoff | undefined {
  const requestIndex = branch.findIndex(
    (entry) => entry.id === requestEntry.id,
  );
  if (requestIndex < 0) return undefined;
  const intentEntry = branch.find(
    (entry) => entry.id === request.intentEntryId,
  );
  if (!intentEntry) return undefined;
  const intent = getMergeIntent(intentEntry);
  if (!intent || intent.requestId !== request.requestId) return undefined;

  const completed = findCompletedHandoffForIntent(
    branch,
    request.intentEntryId,
    intent,
    requestIndex,
  );
  if (
    !completed ||
    completed.promptEntry.id !== request.promptEntryId ||
    completed.answerEntry.id !== request.answerEntryId
  ) {
    return undefined;
  }
  return completed;
}

// Scan each recorded child for its latest merge-request marker. Returns only
// requests the parent has not imported yet (dedupe by requestId). The latest
// request per child wins, so a re-merge supersedes an earlier pending one.
function collectPendingMerges(ctx: ExtensionContext): PendingMerge[] {
  const records = getSplitRecords(ctx);
  const processed = getProcessedMergeRequestIds(ctx);
  const sessionDir = ctx.sessionManager.getSessionDir();
  const pendings: PendingMerge[] = [];
  for (const record of records) {
    try {
      const child = SessionManager.open(record.sessionFile, sessionDir);
      let latest: { entryId: string; request: MergeRequest } | undefined;
      for (const entry of child.getBranch()) {
        const request = getMergeRequest(entry);
        if (request) latest = { entryId: entry.id, request };
      }
      if (latest && !processed.has(latest.request.requestId)) {
        pendings.push({
          record,
          requestId: latest.request.requestId,
          requestEntryId: latest.entryId,
          intentEntryId: latest.request.intentEntryId,
          promptEntryId: latest.request.promptEntryId,
          answerEntryId: latest.request.answerEntryId,
          sessionFile: record.sessionFile,
        });
      }
    } catch {
      // Child file missing or unreadable; skip it without failing the scan.
    }
  }
  return pendings;
}

async function choosePendingMerge(
  ctx: ExtensionContext,
  pendings: PendingMerge[],
): Promise<PendingMerge | undefined> {
  if (!ctx.hasUI) {
    ctx.ui.notify(
      "Multiple pending merges are available; choose one in the interactive UI.",
      "warning",
    );
    return undefined;
  }

  const newestFirst = [...pendings].reverse();
  const choices = newestFirst.map(
    (pending, index) => `${index + 1}. ${pending.record.label}`,
  );
  const selected = await ctx.ui.select("Choose a merge to import", choices);
  if (!selected) return undefined;
  return newestFirst[choices.indexOf(selected)];
}

type MergeCandidate = {
  record: SplitRecord;
  sessionFile: string;
  label: string;
};

// A recorded child is a merge candidate when it has a completed terminal
// assistant answer after its child marker and after its latest merge request,
// and no merge intent is still awaiting finalization (which would mean the
// child is already mid-handoff). This excludes already-requested children
// with no later side work and already-processed children whose latest entry is
// still the recorded request. The parent never imports the raw answer here;
// it only dispatches `/btw merge` so the child authors a clean handoff.
function childHasDispatchableSideWork(branch: SessionEntry[]): boolean {
  let childMarkerIndex = -1;
  let latestRequestIndex = -1;
  let latestIntentIndex = -1;
  for (let index = 0; index < branch.length; index++) {
    const entry = branch[index];
    if (!entry) continue;
    if (entry.type === "custom" && entry.customType === SPLIT_CHILD_TYPE) {
      childMarkerIndex = index;
    } else if (getMergeRequest(entry)) {
      latestRequestIndex = index;
    } else if (getMergeIntent(entry)) {
      latestIntentIndex = index;
    }
  }
  if (childMarkerIndex < 0) return false;
  // An intent without a following request means the child is already preparing
  // a handoff; never dispatch a second /btw merge into it.
  if (latestIntentIndex > latestRequestIndex) return false;
  const boundary = Math.max(childMarkerIndex, latestRequestIndex);
  let terminalMessage: MessageEntry | undefined;
  for (let index = boundary + 1; index < branch.length; index++) {
    const entry = branch[index];
    if (entry?.type === "message") terminalMessage = entry;
  }
  return (
    terminalMessage?.message.role === "assistant" &&
    terminalMessage.message.stopReason === "stop"
  );
}

function collectMergeCandidates(ctx: ExtensionContext): MergeCandidate[] {
  const records = getSplitRecords(ctx);
  const sessionDir = ctx.sessionManager.getSessionDir();
  const candidates: MergeCandidate[] = [];
  for (const record of records) {
    try {
      const child = SessionManager.open(record.sessionFile, sessionDir);
      if (!childHasDispatchableSideWork(child.getBranch())) continue;
      candidates.push({
        record,
        sessionFile: record.sessionFile,
        label: record.label,
      });
    } catch {
      // Child file missing or unreadable; skip it without failing the scan.
    }
  }
  return candidates;
}

async function chooseMergeCandidate(
  ctx: ExtensionContext,
  candidates: MergeCandidate[],
): Promise<MergeCandidate | undefined> {
  if (!ctx.hasUI) {
    ctx.ui.notify(
      "Multiple side sessions are ready to merge; choose one in the interactive UI.",
      "warning",
    );
    return undefined;
  }

  const newestFirst = [...candidates].reverse();
  const choices = newestFirst.map(
    (candidate, index) => `${index + 1}. ${candidate.label}`,
  );
  const selected = await ctx.ui.select(
    "Choose a side session to merge",
    choices,
  );
  if (!selected) return undefined;
  return newestFirst[choices.indexOf(selected)];
}

type HerdrAgentListEntry = {
  name?: string;
  pane_id?: string;
  agent_session?: { value?: unknown };
};

// Resolve a live Herdr agent target for a child session file. Prefer a target
// stored on the SplitRecord; otherwise query `herdr agent list` and match the
// reported `agent_session.value` to the child session file (legacy records).
async function resolveHerdrChildTarget(
  pi: ExtensionAPI,
  record: SplitRecord,
): Promise<string | undefined> {
  if (record.herdrTarget) return record.herdrTarget;
  if (process.env.HERDR_ENV !== "1") return undefined;
  const herdrBin = process.env.HERDR_BIN_PATH || "herdr";
  let result: ExecResult;
  try {
    result = await pi.exec(herdrBin, ["agent", "list"], {
      timeout: HERDR_EXEC_TIMEOUT_MS,
    });
  } catch {
    return undefined;
  }
  if (result.killed || result.code !== 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout) as unknown;
  } catch {
    return undefined;
  }
  const resultObj = (parsed ?? {}) as Record<string, unknown>;
  const resultField = resultObj.result as Record<string, unknown> | undefined;
  const agentsRaw = resultField?.agents ?? resultObj.agents;
  if (!Array.isArray(agentsRaw)) return undefined;
  const agents = agentsRaw as HerdrAgentListEntry[];
  const resolvedSession = canonicalExistingPath(record.sessionFile);
  for (const agent of agents) {
    const value = agent.agent_session?.value;
    if (typeof value !== "string" || value.length === 0) continue;
    const valueResolved = canonicalExistingPath(value);
    const matches =
      value === record.sessionFile ||
      (resolvedSession !== undefined && valueResolved === resolvedSession);
    if (!matches) continue;
    if (typeof agent.name === "string" && agent.name.length > 0)
      return agent.name;
    if (typeof agent.pane_id === "string" && agent.pane_id.length > 0)
      return agent.pane_id;
  }
  return undefined;
}

// Dispatch `/btw merge` to a live child so its own agent authors the handoff,
// finalizes, and refocuses/closes; the parent poll imports the result. The
// parent never imports the child's raw latest answer. Without a live Herdr
// child, fall back to a clear manual instruction.
async function dispatchMergeToChild(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  candidate: MergeCandidate,
): Promise<void> {
  if (process.env.HERDR_ENV !== "1") {
    ctx.ui.notify(
      `Open the side session "${candidate.label}" and run /btw merge there, then run /btw merge here to import it.`,
      "info",
    );
    return;
  }
  let target: string | undefined;
  try {
    target = await resolveHerdrChildTarget(pi, candidate.record);
  } catch {
    target = undefined;
  }
  if (!target) {
    ctx.ui.notify(
      `Could not find a live Herdr agent for "${candidate.label}". Run /btw merge inside that side session.`,
      "warning",
    );
    return;
  }
  const herdrBin = process.env.HERDR_BIN_PATH || "herdr";
  let result: ExecResult;
  try {
    result = await pi.exec(
      herdrBin,
      ["agent", "prompt", target, "/btw merge"],
      {
        timeout: HERDR_EXEC_TIMEOUT_MS,
      },
    );
  } catch (error) {
    ctx.ui.notify(
      `Could not ask the side session to merge: ${errorMessage(error)}`,
      "error",
    );
    return;
  }
  const failure = execFailure(result, "Herdr agent prompt failed");
  if (failure) {
    ctx.ui.notify(
      `Could not ask the side session to merge: ${failure}`,
      "error",
    );
    return;
  }
  ctx.ui.notify(
    `Asked the side session "${candidate.label}" to prepare its handoff. It will be imported here when ready.`,
    "info",
  );
}

function recordSplit(
  pi: ExtensionAPI,
  sessionFile: string,
  baseLeafId: string | null,
  label: string,
  herdrTarget?: string,
): string | undefined {
  try {
    const data: SplitRecord = {
      sessionFile,
      baseLeafId,
      label: label.replace(/\s+/g, " ").trim().slice(0, 80),
    };
    if (herdrTarget) data.herdrTarget = herdrTarget;
    pi.appendEntry(SPLIT_RECORD_TYPE, data);
    return undefined;
  } catch (error) {
    return errorMessage(error);
  }
}

function formatMergeImportMessage(content: string): string {
  return `Handoff from side split\n\n---\n\n${content}`;
}

async function importMerge(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  pending: PendingMerge,
  followUp: string | undefined,
  waitForIdle: (() => Promise<void>) | undefined,
): Promise<void> {
  const sessionDir = ctx.sessionManager.getSessionDir();
  let text: string;
  try {
    const child = SessionManager.open(pending.sessionFile, sessionDir);
    const branch = child.getBranch();
    const requestEntry = branch.find(
      (entry) => entry.id === pending.requestEntryId,
    );
    const request = requestEntry ? getMergeRequest(requestEntry) : undefined;
    const completed =
      requestEntry &&
      request &&
      request.requestId === pending.requestId &&
      request.intentEntryId === pending.intentEntryId &&
      request.promptEntryId === pending.promptEntryId &&
      request.answerEntryId === pending.answerEntryId
        ? validateMergeRequestAssociation(branch, requestEntry, request)
        : undefined;
    const answer = completed?.answerEntry;
    if (
      !answer ||
      answer.message.role !== "assistant" ||
      answer.message.stopReason !== "stop"
    ) {
      ctx.ui.notify(
        "The side handoff is not valid for its merge request; refusing to import.",
        "warning",
      );
      return;
    }
    text = extractMessageText(answer.message.content).trim();
  } catch (error) {
    ctx.ui.notify(
      `Could not read the side session: ${errorMessage(error)}`,
      "error",
    );
    return;
  }
  if (!text) {
    ctx.ui.notify("The side handoff is empty; nothing to import.", "warning");
    return;
  }

  if (waitForIdle) await waitForIdle();
  // A live poll or another command may have imported this request while the
  // manual command was waiting for the parent to settle.
  if (getProcessedMergeRequestIds(ctx).has(pending.requestId)) return;
  pi.sendMessage({
    customType: SPLIT_MERGE_RESULT_TYPE,
    content: formatMergeImportMessage(text),
    display: true,
    details: {
      requestId: pending.requestId,
      sessionFile: pending.sessionFile,
      answerEntryId: pending.answerEntryId,
    } satisfies MergeResult,
  });
  if (followUp) pi.sendUserMessage(followUp);
  ctx.ui.notify("Imported the side handoff.", "info");
}

// Parent-side manual merge. First process completed merge requests as today:
// exactly one imports automatically, multiple show a selector. When none exist,
// fall back to merge candidates — recorded child sessions with completed side
// work after their child marker/latest merge request. Exactly one dispatches
// `/btw merge` to the live child automatically; multiple show a selector. The
// child authors the handoff and the parent poll imports it; the parent never
// imports the raw latest answer.
async function runBtwMergeParent(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  followUp: string | undefined,
): Promise<void> {
  const pendings = collectPendingMerges(ctx);
  if (pendings.length > 0) {
    let chosen: PendingMerge | undefined;
    if (pendings.length === 1) {
      chosen = pendings[0];
    } else {
      chosen = await choosePendingMerge(ctx, pendings);
    }
    if (!chosen) return;
    await importMerge(pi, ctx, chosen, followUp, () => ctx.waitForIdle());
    return;
  }

  const candidates = collectMergeCandidates(ctx);
  if (candidates.length === 0) {
    ctx.ui.notify("No pending side-session merges to import.", "warning");
    return;
  }
  let chosenCandidate: MergeCandidate | undefined;
  if (candidates.length === 1) {
    chosenCandidate = candidates[0];
  } else {
    chosenCandidate = await chooseMergeCandidate(ctx, candidates);
  }
  if (!chosenCandidate) return;
  await dispatchMergeToChild(pi, ctx, chosenCandidate);
}

async function refocusParentAndCloseChild(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  child: SplitChild,
): Promise<void> {
  if (process.env.HERDR_ENV !== "1") return;
  const childPaneId = process.env.HERDR_PANE_ID;
  const parentPaneId = child.parentPaneId;
  if (!parentPaneId || !childPaneId) {
    ctx.ui.notify(
      "Merge handoff recorded, but Herdr pane identities are missing. The child pane was left open.",
      "warning",
    );
    return;
  }

  const herdrBin = process.env.HERDR_BIN_PATH || "herdr";
  let focusFailure: string | undefined;
  try {
    const result = await pi.exec(herdrBin, ["agent", "focus", parentPaneId], {
      timeout: HERDR_EXEC_TIMEOUT_MS,
    });
    focusFailure = execFailure(result, "Herdr parent refocus failed");
  } catch (error) {
    focusFailure = errorMessage(error);
  }
  if (focusFailure) {
    ctx.ui.notify(
      `Merge handoff recorded, but the parent could not be refocused: ${focusFailure}. The child pane was left open.`,
      "error",
    );
    return;
  }

  try {
    const result = await pi.exec(herdrBin, ["pane", "close", childPaneId], {
      timeout: HERDR_EXEC_TIMEOUT_MS,
    });
    const closeFailure = execFailure(result, "Herdr child pane close failed");
    if (closeFailure) {
      ctx.ui.notify(
        `The parent was refocused, but the child pane could not be closed: ${closeFailure}`,
        "error",
      );
    }
  } catch (error) {
    ctx.ui.notify(
      `The parent was refocused, but the child pane could not be closed: ${errorMessage(error)}`,
      "error",
    );
  }
}

// Finalize the newest durable intent only when its exact subsequent user
// prompt has a completed terminal assistant response. Called from
// agent_settled and session_start so a process exit cannot lose the handoff.
async function finalizePendingChildMerge(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  child: SplitChild,
): Promise<void> {
  const branch = ctx.sessionManager.getBranch();
  let intentEntry: SessionEntry | undefined;
  let intent: MergeIntent | undefined;
  for (let index = branch.length - 1; index >= 0; index--) {
    const candidate = branch[index];
    if (!candidate) continue;
    const parsed = getMergeIntent(candidate);
    if (parsed) {
      intentEntry = candidate;
      intent = parsed;
      break;
    }
  }
  if (!intentEntry || !intent) return;

  // Idempotent across duplicate events and session recovery.
  if (
    branch.some(
      (entry) => getMergeRequest(entry)?.requestId === intent!.requestId,
    )
  ) {
    return;
  }

  const completed = findCompletedHandoffForIntent(
    branch,
    intentEntry.id,
    intent,
  );
  if (!completed) return;

  try {
    pi.appendEntry(SPLIT_MERGE_REQUEST_TYPE, {
      requestId: intent.requestId,
      intentEntryId: intentEntry.id,
      promptEntryId: completed.promptEntry.id,
      answerEntryId: completed.answerEntry.id,
    } satisfies MergeRequest);
  } catch (error) {
    ctx.ui.notify(
      `Could not record the completed merge handoff: ${errorMessage(error)}`,
      "error",
    );
    return;
  }

  ctx.ui.notify(
    process.env.HERDR_ENV === "1"
      ? "Merge handoff recorded. The live main session will import it."
      : "Merge handoff recorded. Return to the main session and run /btw merge to import it.",
    "info",
  );
  await refocusParentAndCloseChild(pi, ctx, child);
}

// Child-side merge writes the durable intent before it submits the handoff.
// Finalization happens later from agent_settled, never by inspecting whatever
// answer happened to be present when sendUserMessage returned.
async function runBtwMergeChild(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  followUp: string | undefined,
): Promise<void> {
  const handoffPrompt = followUp
    ? `${SPLIT_HANDOFF_PROMPT}\n\nAdditional guidance from the user: ${followUp}`
    : SPLIT_HANDOFF_PROMPT;

  await ctx.waitForIdle();
  const requestId = randomUUID();
  try {
    pi.appendEntry(SPLIT_MERGE_INTENT_TYPE, {
      requestId,
      handoffPrompt,
    } satisfies MergeIntent);
  } catch (error) {
    ctx.ui.notify(
      `Cannot start the merge handoff: ${errorMessage(error)}`,
      "error",
    );
    return;
  }
  pi.sendUserMessage(handoffPrompt);
  ctx.ui.notify("Preparing the side-session handoff.", "info");
}

async function runBtwMerge(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  followUp: string | undefined,
): Promise<void> {
  const child = getSplitChildData(ctx);
  if (child) return runBtwMergeChild(pi, ctx, followUp);
  return runBtwMergeParent(pi, ctx, followUp);
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
  const parentPaneId =
    host.backend === "herdr" ? process.env.HERDR_PANE_ID : undefined;

  let splitSessionFile: string | undefined;
  let baseLeafId: string | null = null;
  let recordLabel = "";
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
        ({ sessionFile: splitSessionFile, baseLeafId } =
          await createForkSession(
            ctx,
            sourceSessionFile!,
            forkLeafId,
            prompt,
            parentPaneId,
          ));
      } else {
        // First turn: the source session is not persisted. Snapshot the
        // in-memory context into a normal persisted child.
        ({ sessionFile: splitSessionFile, baseLeafId } =
          await createSnapshotForkSession(
            ctx,
            sourceSessionFile,
            forkLeafId,
            prompt,
            parentPaneId,
          ));
      }
      piLaunch = buildPiSessionLaunch(splitSessionFile!);
      recordLabel = prompt;
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
        ({ sessionFile: splitSessionFile, baseLeafId } =
          await createForkAtSelectedMessage(
            ctx,
            sourceSessionFile!,
            selected.entryId,
            selected.text,
            parentPaneId,
          ));
      } else {
        ({ sessionFile: splitSessionFile, baseLeafId } =
          await createSnapshotForkSession(
            ctx,
            sourceSessionFile,
            forkLeafId,
            selected.text,
            parentPaneId,
          ));
      }
      piLaunch = buildPiSessionLaunch(splitSessionFile!);
      recordLabel = selected.text;
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
    );
    if (!launch.ok) {
      let reason = launch.reason;
      if (launch.canDeleteSession) {
        const cleanupError = await deleteSplitSessionFile(splitSessionFile);
        if (cleanupError) reason += `; session cleanup failed: ${cleanupError}`;
      } else {
        const trackingError = recordSplit(
          pi,
          splitSessionFile,
          baseLeafId,
          `[unconfirmed] ${recordLabel}`,
        );
        reason += `; copied session kept at ${splitSessionFile}`;
        reason += trackingError
          ? `; unconfirmed tracking failed: ${trackingError}`
          : "; an unconfirmed split record was added";
      }
      ctx.ui.notify(`Failed to launch split: ${reason}`, "error");
      return;
    }

    const herdrTarget = launch.backend === "herdr" ? launch.target : undefined;
    const target = herdrTarget ? ` (${herdrTarget})` : "";
    const trackingError = recordSplit(
      pi,
      splitSessionFile,
      baseLeafId,
      recordLabel,
      herdrTarget,
    );
    if (trackingError) {
      ctx.ui.notify(
        `Opened split${target}, but could not save its tracking record: ${trackingError}`,
        "error",
      );
      return;
    }
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

// Live merge detection runs only under Herdr. Ghostty remains an explicit
// switch-back-and-import workflow.
const MERGE_POLL_INTERVAL_MS = 2500;

// Decide what to do with the current pending merges. Exactly one new pending
// is auto-imported; multiple new pendings auto-show the selector. Request ids
// already presented in a prior selector are skipped so the unchanged remainder
// is never auto-imported without a fresh user choice (use /btw merge to
// revisit). Skips child sessions, busy parents, and sessions without records.
async function detectAndImportPendingMerges(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  presentedMergeRequestIds: Set<string>,
  isCurrentGeneration: () => boolean,
): Promise<void> {
  if (!isCurrentGeneration()) return;
  if (getSplitChildData(ctx)) return;
  if (getSplitRecords(ctx).length === 0) return;
  if (!ctx.isIdle()) return;
  const pendings = collectPendingMerges(ctx);
  if (pendings.length === 0) return;
  const unseenPendings = pendings.filter(
    (pending) => !presentedMergeRequestIds.has(pending.requestId),
  );
  if (unseenPendings.length === 0) return;
  if (pendings.length === 1) {
    if (!isCurrentGeneration()) return;
    await importMerge(pi, ctx, pendings[0]!, undefined, undefined);
    return;
  }
  // A newly completed handoff makes the pending set actionable again. Show
  // every still-pending split, including unchanged items from an earlier
  // chooser, instead of auto-importing only the new arrival.
  const chosen = await choosePendingMerge(ctx, pendings);
  if (!isCurrentGeneration()) return;
  // Whether chosen or cancelled, defer the remainder to manual /btw merge so
  // we never auto-import these without another user choice.
  for (const pending of pendings)
    presentedMergeRequestIds.add(pending.requestId);
  if (!chosen) return;
  await importMerge(pi, ctx, chosen, undefined, undefined);
}

export default function btwWithImports(pi: ExtensionAPI) {
  // Factory-local state prevents one extension instance from cancelling or
  // suppressing another. A generation token invalidates async selectors and
  // ticks that outlive a session switch.
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let pollActive = false;
  let pollGeneration = 0;
  let pollInFlightGeneration: number | undefined;
  let presentedMergeRequestIds = new Set<string>();

  const isCurrentGeneration = (generation: number) =>
    pollActive && pollGeneration === generation;

  const stopMergePoll = () => {
    pollActive = false;
    pollGeneration++;
    if (pollTimer !== undefined) {
      clearTimeout(pollTimer);
      pollTimer = undefined;
    }
  };

  const scheduleMergePoll = (
    ctx: ExtensionContext,
    generation: number,
    delay: number,
  ) => {
    if (!isCurrentGeneration(generation)) return;
    pollTimer = setTimeout(() => {
      pollTimer = undefined;
      void runMergePollTick(ctx, generation);
    }, delay);
  };

  const runMergePollTick = async (
    ctx: ExtensionContext,
    generation: number,
  ): Promise<void> => {
    if (!isCurrentGeneration(generation)) return;
    if (pollInFlightGeneration === generation) {
      scheduleMergePoll(ctx, generation, MERGE_POLL_INTERVAL_MS);
      return;
    }
    pollInFlightGeneration = generation;
    try {
      await detectAndImportPendingMerges(
        pi,
        ctx,
        presentedMergeRequestIds,
        () => isCurrentGeneration(generation),
      );
    } catch (error) {
      if (isCurrentGeneration(generation)) {
        ctx.ui.notify(`Merge poll failed: ${errorMessage(error)}`, "error");
      }
    } finally {
      if (pollInFlightGeneration === generation) {
        pollInFlightGeneration = undefined;
      }
      if (isCurrentGeneration(generation)) {
        scheduleMergePoll(ctx, generation, MERGE_POLL_INTERVAL_MS);
      }
    }
  };

  pi.registerCommand("btw", {
    description:
      "Fork into a right-hand side session (`/btw <goal>`), choose a previous user message (`/btw`), or process a side handoff (`/btw merge`).",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      if (trimmed === "--launch") return runBtwLaunch(pi, ctx);
      if (trimmed === "merge" || trimmed.startsWith("merge ")) {
        const followUp = trimmed.slice("merge".length).trim();
        return runBtwMerge(pi, ctx, followUp || undefined);
      }
      return runBtwSplit(pi, ctx, trimmed);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    stopMergePoll();
    // Fresh per-session state: a resumed session should re-evaluate multi
    // pending merges rather than inherit a prior suppression.
    presentedMergeRequestIds = new Set();
    const child = getSplitChildData(ctx);
    if (child) {
      await finalizePendingChildMerge(pi, ctx, child);
      return;
    }
    if (process.env.HERDR_ENV !== "1") return;
    pollActive = true;
    const generation = pollGeneration;
    // Immediate check on session start, then recurring live detection.
    void runMergePollTick(ctx, generation);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    const child = getSplitChildData(ctx);
    if (child) await finalizePendingChildMerge(pi, ctx, child);
  });

  pi.on("session_shutdown", () => {
    stopMergePoll();
  });
}
