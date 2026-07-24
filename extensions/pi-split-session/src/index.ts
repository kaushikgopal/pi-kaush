import {
  SessionManager,
  UserMessageSelectorComponent,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import * as path from "node:path";

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

type LaunchResult =
  | { ok: true; backend: "herdr" | "ghostty"; target?: string }
  | {
      ok: false;
      backend: "herdr" | "ghostty";
      reason: string;
      canDeleteSession: boolean;
    };

type SplitBackend = LaunchResult["backend"];

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
const SPLIT_RESULT_MESSAGE_TYPE = "split-fork-result";
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
};

type SplitChild = {
  baseLeafId: string | null;
};

type SplitImport = {
  sessionFile: string;
  answerEntryId: string;
  format: "transcript" | "summary";
};

type SplitTranscript = {
  answerEntryId: string;
  text: string;
};

function shellQuote(value: string): string {
  if (value.length === 0) return "''";
  return `'${value.replace(/'/g, `'"'"'`)}'`;
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

function buildPiSessionArgs(sessionFile: string, prompt: string): string[] {
  // Args handed to `pi` itself. Herdr's `agent start --kind pi` invokes the
  // executable, so these must not include the `pi`/node prefix. Ghostty
  // reconstructs the full command by prepending the invocation parts.
  return ["--session", sessionFile, prompt];
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

function herdrPaneId(result: ExecResult): string | undefined {
  try {
    const response = JSON.parse(result.stdout) as {
      result?: { pane?: { pane_id?: unknown } };
    };
    const paneId = response.result?.pane?.pane_id;
    return typeof paneId === "string" && paneId.length > 0
      ? paneId
      : undefined;
  } catch {
    return undefined;
  }
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
    ctx.ui.notify(
      "/split without args requires the interactive UI.",
      "warning",
    );
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

async function createForkSession(
  ctx: ExtensionContext,
  sourceSessionFile: string,
  leafId: string | null,
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
    sessionManager.appendCustomEntry(SPLIT_CHILD_TYPE, {
      baseLeafId,
    } satisfies SplitChild);
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

async function createForkAtSelectedMessage(
  ctx: ExtensionContext,
  sourceSessionFile: string,
  entryId: string,
): Promise<ForkSession> {
  const selectedEntry = ctx.sessionManager.getEntry(entryId);
  if (
    !selectedEntry ||
    selectedEntry.type !== "message" ||
    selectedEntry.message.role !== "user"
  ) {
    throw new Error("Invalid message selected for split");
  }
  return createForkSession(ctx, sourceSessionFile, selectedEntry.parentId);
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
  piArgs: string[],
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
  const agentName = `pi-split-${randomUUID().slice(0, 8)}`;

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
      { timeout: 10000 },
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
  // pane creation, so the child may exist and the copied session is retained.
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
        ...piArgs,
      ],
      { timeout: 10000 },
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
    return {
      ok: false,
      backend: "herdr",
      reason: startFailure,
      canDeleteSession: false,
    };
  }

  return { ok: true, backend: "herdr", target: agentName };
}

async function launchGhosttySplit(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  piArgs: string[],
): Promise<LaunchResult> {
  if (process.platform !== "darwin") {
    return {
      ok: false,
      backend: "ghostty",
      reason: "Ghostty split requires macOS",
      canDeleteSession: true,
    };
  }

  const startupInput = buildStartupInput([
    ...getPiInvocationParts(),
    ...piArgs,
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
  piArgs: string[],
): Promise<LaunchResult> {
  if (backend === "herdr") return launchHerdrSplit(pi, ctx, piArgs);
  return launchGhosttySplit(pi, ctx, piArgs);
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
    typeof data.label === "string"
  );
}

function isSplitChild(
  entry: SessionEntry,
): entry is SessionEntry & { type: "custom"; data: SplitChild } {
  if (entry.type !== "custom" || entry.customType !== SPLIT_CHILD_TYPE)
    return false;
  const data = entry.data as Partial<SplitChild> | undefined;
  return (
    !!data && (data.baseLeafId === null || typeof data.baseLeafId === "string")
  );
}

function getSplitImport(entry: SessionEntry): SplitImport | undefined {
  if (
    entry.type !== "custom_message" ||
    entry.customType !== SPLIT_RESULT_MESSAGE_TYPE
  )
    return undefined;
  const details = entry.details as Partial<SplitImport> | undefined;
  return details &&
    typeof details.sessionFile === "string" &&
    typeof details.answerEntryId === "string" &&
    (details.format === "transcript" || details.format === "summary")
    ? {
        sessionFile: details.sessionFile,
        answerEntryId: details.answerEntryId,
        format: details.format,
      }
    : undefined;
}

function getSplitRecords(ctx: ExtensionContext): SplitRecord[] {
  return ctx.sessionManager
    .getBranch()
    .filter(isSplitRecord)
    .map((entry) => entry.data);
}

async function chooseSplitRecord(
  ctx: ExtensionCommandContext,
): Promise<SplitRecord | undefined> {
  const records = getSplitRecords(ctx);
  if (records.length === 0) {
    ctx.ui.notify("No split sessions recorded in this branch.", "warning");
    return undefined;
  }
  if (records.length === 1) return records[0];
  if (!ctx.hasUI) {
    ctx.ui.notify(
      "Multiple split sessions are available; choose one in the interactive UI.",
      "warning",
    );
    return undefined;
  }

  const newestFirst = [...records].reverse();
  const choices = newestFirst.map(
    (record, index) => `${index + 1}. ${record.label}`,
  );
  const selected = await ctx.ui.select("Choose a split to import", choices);
  if (!selected) return undefined;
  return newestFirst[choices.indexOf(selected)];
}

function hasImportedSplitAnswer(
  ctx: ExtensionContext,
  sessionFile: string,
  answerEntryId: string,
  format: SplitImport["format"],
): boolean {
  return ctx.sessionManager
    .getBranch()
    .map(getSplitImport)
    .filter((entry): entry is SplitImport => entry !== undefined)
    .some(
      (entry) =>
        entry.sessionFile === sessionFile &&
        entry.answerEntryId === answerEntryId &&
        entry.format === format,
    );
}

function recordSplit(
  pi: ExtensionAPI,
  sessionFile: string,
  baseLeafId: string | null,
  label: string,
): string | undefined {
  try {
    pi.appendEntry(SPLIT_RECORD_TYPE, {
      sessionFile,
      baseLeafId,
      label: label.replace(/\s+/g, " ").trim().slice(0, 80),
    } satisfies SplitRecord);
    return undefined;
  } catch (error) {
    return errorMessage(error);
  }
}

function splitConversationEntries(
  record: SplitRecord,
  sessionDir: string,
): SessionEntry[] {
  const child = SessionManager.open(record.sessionFile, sessionDir);
  const branch = child.getBranch();
  let startIndex = 0;

  if (record.baseLeafId) {
    const baseIndex = branch.findIndex(
      (entry) => entry.id === record.baseLeafId,
    );
    if (baseIndex < 0)
      throw new Error("Split session boundary is missing; refusing to import.");
    startIndex = baseIndex + 1;
  }

  return branch.slice(startIndex).filter((entry) => entry.type === "message");
}

function splitTranscript(
  record: SplitRecord,
  sessionDir: string,
): SplitTranscript | undefined {
  const entries = splitConversationEntries(record, sessionDir);
  const lastEntry = entries[entries.length - 1];
  if (
    !lastEntry ||
    lastEntry.type !== "message" ||
    lastEntry.message.role !== "assistant"
  )
    return undefined;
  if (lastEntry.message.stopReason !== "stop") return undefined;

  const sections = entries.flatMap((entry) => {
    if (entry.type !== "message") return [];
    const message = entry.message;
    if (!("content" in message)) return [];
    const text = extractMessageText(message.content).trim();
    if (!text) return [];
    const role =
      message.role === "user"
        ? "User"
        : message.role === "assistant"
          ? "Assistant"
          : "Tool result";
    return [`## ${role}\n${text}`];
  });
  return sections.length > 0
    ? { answerEntryId: lastEntry.id, text: sections.join("\n\n") }
    : undefined;
}

function splitHandoffSummary(
  record: SplitRecord,
  sessionDir: string,
): SplitTranscript | undefined {
  const entries = splitConversationEntries(record, sessionDir);
  const lastEntry = entries.at(-1);
  if (
    !lastEntry ||
    lastEntry.type !== "message" ||
    lastEntry.message.role !== "assistant"
  )
    return undefined;
  if (lastEntry.message.stopReason !== "stop") return undefined;

  let lastUserText: string | undefined;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry?.type === "message" && entry.message.role === "user") {
      lastUserText = extractMessageText(entry.message.content).trim();
      break;
    }
  }
  if (lastUserText !== SPLIT_HANDOFF_PROMPT) return undefined;

  const text = extractMessageText(lastEntry.message.content).trim();
  return text ? { answerEntryId: lastEntry.id, text } : undefined;
}

function formatSplitImportMessage(
  content: string,
  format: "transcript" | "summary",
): string {
  const title =
    format === "transcript"
      ? "Transcript from side split"
      : "Summary from side split";
  return `${title}\n\n---\n\n${content}`;
}

async function runSplitImport(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  args: string,
  format: "transcript" | "summary",
): Promise<void> {
  const record = await chooseSplitRecord(ctx);
  if (!record) return;

  let result: SplitTranscript | undefined;
  try {
    result =
      format === "summary"
        ? splitHandoffSummary(record, ctx.sessionManager.getSessionDir())
        : splitTranscript(record, ctx.sessionManager.getSessionDir());
  } catch (error) {
    ctx.ui.notify(
      error instanceof Error ? error.message : String(error),
      "error",
    );
    return;
  }

  if (!result) {
    ctx.ui.notify(
      format === "summary"
        ? "No completed side-agent handoff found. Run /split-handoff in the side split first."
        : "Split session has no completed final answer to import yet.",
      "warning",
    );
    return;
  }
  const prompt = args.trim();
  const alreadyImported = hasImportedSplitAnswer(
    ctx,
    record.sessionFile,
    result.answerEntryId,
    format,
  );
  if (alreadyImported && !prompt) {
    ctx.ui.notify("No new split result to import.", "warning");
    return;
  }

  await ctx.waitForIdle();
  if (!alreadyImported) {
    pi.sendMessage({
      customType: SPLIT_RESULT_MESSAGE_TYPE,
      content: formatSplitImportMessage(result.text, format),
      display: true,
      details: {
        sessionFile: record.sessionFile,
        answerEntryId: result.answerEntryId,
        format,
      } satisfies SplitImport,
    });
  }
  if (prompt) pi.sendUserMessage(prompt);
  ctx.ui.notify(
    alreadyImported
      ? "Split result was already imported; sent the follow-up to the main agent."
      : "Split import queued. The side split stays open; close it manually when you're done.",
    "info",
  );
}

async function runSplitHandoff(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
): Promise<void> {
  if (!ctx.sessionManager.getBranch().some(isSplitChild)) {
    ctx.ui.notify(
      "/split-handoff can only run inside a side split created by /split.",
      "warning",
    );
    return;
  }

  await ctx.waitForIdle();
  pi.sendUserMessage(SPLIT_HANDOFF_PROMPT);
  ctx.ui.notify("Asked this side agent to prepare its final handoff.", "info");
}

async function runSplit(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  args: string,
): Promise<void> {
  const wasBusy = !ctx.isIdle();
  const prompt = args.trim();
  const sourceSessionFile = ctx.sessionManager.getSessionFile();
  if (!sourceSessionFile) {
    ctx.ui.notify("Cannot split: current session is not persisted.", "error");
    return;
  }
  if (!existsSync(sourceSessionFile)) {
    ctx.ui.notify(
      wasBusy
        ? "Wait for the first response to finish before splitting."
        : "Send a message before splitting.",
      "warning",
    );
    return;
  }
  const forkLeafId = prompt.length > 0 ? promptedForkLeaf(ctx) : undefined;
  if (prompt.length > 0 && !forkLeafId) {
    ctx.ui.notify(
      "Wait for the first response to finish before splitting.",
      "warning",
    );
    return;
  }
  const host = await resolveSplitHost(pi);
  if (!host.ok) {
    ctx.ui.notify(`Cannot split: ${host.reason}`, "error");
    return;
  }

  let splitSessionFile: string | undefined;
  let launchAttempted = false;
  try {
    let piArgs: string[];
    let baseLeafId: string | null;
    let recordLabel: string;
    let forkedBeforeInFlight = false;

    if (prompt.length > 0) {
      forkedBeforeInFlight = forkLeafId !== ctx.sessionManager.getLeafId();
      ({ sessionFile: splitSessionFile, baseLeafId } = await createForkSession(
        ctx,
        sourceSessionFile,
        forkLeafId!,
      ));
      piArgs = buildPiSessionArgs(splitSessionFile, prompt);
      recordLabel = prompt;
    } else {
      const messages = getForkMessages(ctx);
      if (messages.length === 0) {
        ctx.ui.notify("No messages to split from.", "warning");
        return;
      }

      const selected = await chooseForkMessage(ctx, messages);
      if (!selected) return;
      ({ sessionFile: splitSessionFile, baseLeafId } =
        await createForkAtSelectedMessage(
          ctx,
          sourceSessionFile,
          selected.entryId,
        ));
      recordLabel = selected.text;
      piArgs = buildPiSessionArgs(splitSessionFile, selected.text);
    }

    if (!splitSessionFile) throw new Error("Failed to create split session");
    launchAttempted = true;
    const launch = await launchSplit(pi, ctx, host.backend, piArgs);
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

    const target =
      launch.backend === "herdr" && launch.target ? ` (${launch.target})` : "";
    const trackingError = recordSplit(
      pi,
      splitSessionFile,
      baseLeafId,
      recordLabel,
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

export default function splitSession(pi: ExtensionAPI) {
  pi.registerCommand("split", {
    description: "Fork this session into a right-hand Herdr or Ghostty split.",
    handler: async (args, ctx) => {
      await runSplit(pi, ctx, args);
    },
  });

  pi.registerCommand("split-handoff", {
    description:
      "Ask this side agent to prepare the clean summary imported by the main session.",
    handler: async (_args, ctx) => {
      await runSplitHandoff(pi, ctx);
    },
  });

  pi.registerCommand("split-import", {
    description:
      "Import the side agent's clean handoff, then optionally ask the main agent a follow-up question.",
    handler: async (args, ctx) => {
      await runSplitImport(pi, ctx, args, "summary");
    },
  });

  pi.registerCommand("split-import-full", {
    description:
      "Import the full split transcript, then optionally ask the main agent a follow-up question.",
    handler: async (args, ctx) => {
      await runSplitImport(pi, ctx, args, "transcript");
    },
  });
}
