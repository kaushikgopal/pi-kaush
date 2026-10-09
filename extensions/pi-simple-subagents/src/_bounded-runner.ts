/**
 * Runs bounded single, parallel, and chain plans: one child `pi --mode json`
 * process per attempt, streamed into a `SingleResult` whose `status` records
 * where in its lifecycle the child is. Aborts come back as `aborted` results;
 * only the tool boundary turns them into thrown errors.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Message } from "@earendil-works/pi-ai";
import {
  getAgentDir,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import type { ModelProfilesConfig } from "@pi-kaush/pi-model-profiles";
import {
  type ChildEvent,
  isDelegatedToolActivity,
  parseChildEventLine,
} from "./_child-events.ts";
import type { SessionConcurrencyGate } from "./_concurrency.ts";
import type { AgentConfig } from "./_definition.ts";
import {
  buildChildSessionName,
  buildDelegatedSystemPrompt,
  buildSharedTaskPrompt,
  buildSubagentEnvironment,
  type DelegationTrace,
  resolveRequestedModel,
} from "./_delegation.ts";
import { formatAgentDisplayName } from "./_display.ts";
import {
  buildSubagentIsolationArgs,
  createSubagentExecutionWatchdog,
  formatSubagentTimeoutMessage,
  getPiInvocation,
  type SubagentIsolationOptions,
  type SubagentTimeoutReason,
} from "./_execution.ts";
import type { SubagentLimitsConfig } from "./_limits.ts";
import {
  booleanValue,
  errorText,
  finiteNumber,
  isPlainRecord,
  oneOf,
  stringValue,
} from "./_parse.ts";
import {
  type SubagentProcessRegistry,
  shouldIsolateSubagentProcess,
} from "./_process-tree.ts";
import { planProfileAttempts } from "./_profile-attempts.ts";
import { formatProfileAttemptSummaries } from "./_profiles.ts";
import type {
  BoundedItem,
  BoundedMode,
  BoundedPlan,
} from "./_subagent-command.ts";
import {
  appendBoundedJsonValue,
  truncateUtf8Head,
  truncateUtf8Tail,
  utf8ByteLength,
} from "./_text.ts";
import {
  createTranscriptArtifact,
  resolveSessionFilePath,
  SUBAGENT_OUTPUT_PREVIEW_BYTES,
  SUBAGENT_STDERR_PREVIEW_BYTES,
  SUBAGENT_TRACE_PREVIEW_BYTES,
  type TranscriptArtifact,
} from "./_transcript.ts";
import { addTurnUsage, emptyUsage, type UsageStats } from "./_usage.ts";
import {
  applySubagentYield,
  includeSubagentYieldTool,
  type SubagentYieldStatus,
} from "./_yield.ts";

const SUBAGENT_EXTENSION_ENTRYPOINT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "index.ts",
);
const PER_TASK_OUTPUT_CAP = 50 * 1024;

/** Where a child run is in its lifecycle. */
export type RunStatus =
  /** Not yet admitted (parallel placeholder). */
  | { readonly kind: "pending" }
  /** Admitted and streaming. */
  | { readonly kind: "running" }
  /** Pre-flight failure: unknown agent, unavailable model, or bad profile. */
  | { readonly kind: "invalid"; readonly reason: string }
  /** Refused admission (shutdown or the concurrency gate); never started. */
  | { readonly kind: "rejected"; readonly reason: string }
  | { readonly kind: "exited"; readonly code: number }
  /** Killed by the watchdog. Results persisted before `status` existed carry no reason. */
  | { readonly kind: "timedOut"; readonly reason?: SubagentTimeoutReason }
  /** Killed by the caller's abort signal or by session shutdown. */
  | { readonly kind: "aborted"; readonly cause: "abort" | "shutdown" };

export interface ModelAttempt {
  requestedModel?: string;
  model?: string;
  exitCode: number;
  stopReason?: string;
  errorMessage?: string;
  errorTruncated?: boolean;
  transcriptPath?: string;
  transcriptError?: string;
}

export interface SingleResult {
  agent: string;
  agentEmoji?: string;
  agentSource: "user" | "project" | "unknown";
  task: string;
  status: RunStatus;
  messages: Message[];
  output: string;
  stderr: string;
  stderrTruncated?: boolean;
  outputTruncated?: boolean;
  traceTruncated?: boolean;
  transcriptPath?: string;
  transcriptError?: string;
  hadDelegatedToolActivity?: boolean;
  usage: UsageStats;
  requestedModel?: string;
  model?: string;
  sessionId?: string;
  sessionFilePath?: string;
  /** Child-reported stop reason; also "error" for rejected and timed-out runs. */
  stopReason?: string;
  errorMessage?: string;
  errorTruncated?: boolean;
  yieldStatus?: SubagentYieldStatus;
  yieldArtifacts?: string[];
  step?: number;
  profile?: string;
  attempts?: ModelAttempt[];
}

export function isActiveResult(result: SingleResult): boolean {
  return result.status.kind === "pending" || result.status.kind === "running";
}

export function isFailedResult(result: SingleResult): boolean {
  const { status } = result;
  const statusFailed =
    status.kind === "invalid" ||
    status.kind === "rejected" ||
    status.kind === "timedOut" ||
    status.kind === "aborted" ||
    (status.kind === "exited" && status.code !== 0);
  return (
    statusFailed ||
    result.stopReason === "error" ||
    result.stopReason === "aborted" ||
    result.yieldStatus === "blocked" ||
    result.yieldStatus === "failed"
  );
}

/** Process exit code reported for attempts and transcripts; 1 for runs that never exited on their own. */
function exitCodeOf(status: RunStatus): number {
  switch (status.kind) {
    case "exited":
      return status.code;
    case "pending":
    case "running":
      return 0;
    case "invalid":
    case "rejected":
    case "timedOut":
    case "aborted":
      return 1;
  }
}

function getResultOutput(result: SingleResult): string {
  if (isFailedResult(result)) {
    return (
      result.errorMessage || result.stderr || result.output || "(no output)"
    );
  }
  return result.output || "(no output)";
}

export function formatResultAgentName(result: SingleResult): string {
  return formatAgentDisplayName({
    name: result.agent,
    ...(result.agentEmoji ? { emoji: result.agentEmoji } : {}),
  });
}

/** Replaces a leading home directory with `~`. */
export function shortenHomePath(filePath: string): string {
  const home = os.homedir();
  return filePath.startsWith(`${home}${path.sep}`)
    ? `~${filePath.slice(home.length)}`
    : filePath;
}

function formatYieldArtifacts(result: SingleResult): string {
  if (!result.yieldArtifacts || result.yieldArtifacts.length === 0) return "";
  return `\n\nArtifacts:\n${result.yieldArtifacts.map((artifact) => `- ${shortenHomePath(artifact)}`).join("\n")}`;
}

function formatTranscriptReference(result: SingleResult): string {
  const paths = new Set<string>();
  const errors = new Set<string>();
  if (result.transcriptPath) paths.add(result.transcriptPath);
  if (result.transcriptError) errors.add(result.transcriptError);
  for (const attempt of result.attempts ?? []) {
    if (attempt.transcriptPath) paths.add(attempt.transcriptPath);
    if (attempt.transcriptError) errors.add(attempt.transcriptError);
  }
  const lines: string[] = [];
  if (paths.size > 0) {
    const label = paths.size === 1 ? "Full transcript" : "Full transcripts";
    lines.push(`${label}: ${[...paths].map(shortenHomePath).join(", ")}`);
  }
  if (errors.size > 0) {
    const label =
      paths.size > 0 ? "Transcript write error" : "Transcript unavailable";
    lines.push(`${label}: ${[...errors].join("; ")}`);
  }
  return lines.length > 0 ? `\n\n${lines.join("\n")}` : "";
}

/** Bounds output, stderr, and error text for session details. */
export function toPersistedResult(result: SingleResult): SingleResult {
  const output = truncateUtf8Head(result.output, SUBAGENT_OUTPUT_PREVIEW_BYTES);
  const stderr = truncateUtf8Tail(result.stderr, SUBAGENT_STDERR_PREVIEW_BYTES);
  const error = result.errorMessage
    ? truncateUtf8Head(result.errorMessage, SUBAGENT_OUTPUT_PREVIEW_BYTES)
    : undefined;
  const attempts = result.attempts?.map((attempt) => {
    const attemptError = attempt.errorMessage
      ? truncateUtf8Head(attempt.errorMessage, SUBAGENT_OUTPUT_PREVIEW_BYTES)
      : undefined;
    const errorTruncated =
      attempt.errorTruncated || attemptError?.truncated || undefined;
    return {
      ...attempt,
      ...(attemptError ? { errorMessage: attemptError.value } : {}),
      ...(errorTruncated !== undefined ? { errorTruncated } : {}),
    };
  });
  const outputTruncated =
    result.outputTruncated || output.truncated || undefined;
  const stderrTruncated =
    result.stderrTruncated || stderr.truncated || undefined;
  const errorTruncated = result.errorTruncated || error?.truncated || undefined;
  return {
    ...result,
    output: output.value,
    ...(outputTruncated !== undefined ? { outputTruncated } : {}),
    stderr: stderr.value,
    ...(stderrTruncated !== undefined ? { stderrTruncated } : {}),
    ...(error ? { errorMessage: error.value } : {}),
    ...(errorTruncated !== undefined ? { errorTruncated } : {}),
    ...(attempts ? { attempts } : {}),
  };
}

const TIMEOUT_REASONS = ["runtime", "inactivity"] as const;

function parseRunStatus(value: unknown): RunStatus | undefined {
  if (!isPlainRecord(value)) return undefined;
  switch (value.kind) {
    case "pending":
    case "running":
      return { kind: value.kind };
    case "invalid":
    case "rejected":
      return { kind: value.kind, reason: stringValue(value.reason) ?? "" };
    case "exited": {
      const code = finiteNumber(value.code);
      return code === undefined ? undefined : { kind: "exited", code };
    }
    case "timedOut": {
      const reason = oneOf(value.reason, TIMEOUT_REASONS);
      return reason ? { kind: "timedOut", reason } : { kind: "timedOut" };
    }
    case "aborted":
      return {
        kind: "aborted",
        cause: value.cause === "shutdown" ? "shutdown" : "abort",
      };
    default:
      return undefined;
  }
}

/**
 * Derives a status for results persisted before `status` existed, which
 * encoded it as `exitCode` (-1 meant still running) plus the `spawnBlocked`
 * and `executionTimedOut` flags.
 */
function legacyRunStatus(raw: Readonly<Record<string, unknown>>): RunStatus {
  const exitCode = finiteNumber(raw.exitCode) ?? 0;
  if (exitCode === -1) return { kind: "pending" };
  if (booleanValue(raw.spawnBlocked))
    return {
      kind: "rejected",
      reason: stringValue(raw.errorMessage) ?? stringValue(raw.stderr) ?? "",
    };
  if (booleanValue(raw.executionTimedOut)) return { kind: "timedOut" };
  return { kind: "exited", code: exitCode };
}

/** Reads a result from session details, including ones persisted by older versions. */
export function parsePersistedResult(value: unknown): SingleResult | undefined {
  if (!isPlainRecord(value)) return undefined;
  const status = parseRunStatus(value.status) ?? legacyRunStatus(value);
  const {
    exitCode: _exitCode,
    spawnBlocked: _spawnBlocked,
    executionTimedOut: _executionTimedOut,
    ...rest
  } = value;
  // SAFETY: details are written by this extension via toPersistedResult; only
  // the lifecycle fields changed shape across versions, and they are rebuilt here.
  const result = { ...rest, status } as unknown as SingleResult;
  return {
    ...result,
    messages: Array.isArray(result.messages) ? result.messages : [],
    output: stringValue(result.output) ?? "",
    stderr: stringValue(result.stderr) ?? "",
    usage: isPlainRecord(result.usage) ? result.usage : emptyUsage(),
  };
}

export interface ChildArgsInput {
  readonly agent: AgentConfig;
  readonly task: string;
  readonly requestedModel?: string;
  readonly tools?: readonly string[];
  readonly isolation?: SubagentIsolationOptions;
  readonly promptPath: string;
  readonly depth: number;
  readonly limits: Pick<
    SubagentLimitsConfig,
    "persistChildSessions" | "maxDepth"
  >;
  readonly extensionEntrypoint?: string;
}

/** The child `pi` argv, excluding the executable. */
export function buildChildArgs(input: ChildArgsInput): string[] {
  const { agent, limits } = input;
  const args: string[] = ["--mode", "json", "-p"];
  if (limits.persistChildSessions)
    args.push(
      "--name",
      buildChildSessionName(formatAgentDisplayName(agent), input.task),
    );
  else args.push("--no-session");
  args.push(
    ...buildSubagentIsolationArgs(
      input.isolation,
      input.extensionEntrypoint ?? SUBAGENT_EXTENSION_ENTRYPOINT,
    ),
  );
  if (input.requestedModel) args.push("--model", input.requestedModel);
  const tools = input.tools ?? agent.tools;
  if (tools && tools.length > 0)
    args.push("--tools", includeSubagentYieldTool([...tools]).join(","));
  if (input.depth >= limits.maxDepth) args.push("--exclude-tools", "subagent");
  args.push("--append-system-prompt", input.promptPath);
  args.push(`Task: ${input.task}`);
  return args;
}

/** Everything a bounded run shares across its children. */
export interface RunContext {
  readonly defaultCwd: string;
  readonly agents: readonly AgentConfig[];
  readonly profiles: ModelProfilesConfig;
  /** Lower-cased `provider/id` references Pi can currently run. */
  readonly availableModels: ReadonlySet<string>;
  readonly resolveModel: (spec: string) => string | undefined;
  readonly trace: DelegationTrace;
  readonly limits: SubagentLimitsConfig;
  readonly concurrency: SessionConcurrencyGate;
  readonly processes: SubagentProcessRegistry;
  readonly signal?: AbortSignal;
}

/** One child to run, with its final task text. */
export interface RunRequest {
  readonly item: BoundedItem;
  readonly step?: number;
  /** Receives a fresh snapshot whenever the streamed result changes. */
  readonly onUpdate?: (result: SingleResult) => void;
}

/** The model and profile one attempt runs with. */
interface Attempt {
  readonly model?: string;
  readonly profile?: string;
}

function snapshot(result: SingleResult): SingleResult {
  return {
    ...result,
    messages: [...result.messages],
    usage: { ...result.usage },
    ...(result.attempts ? { attempts: [...result.attempts] } : {}),
    ...(result.yieldArtifacts
      ? { yieldArtifacts: [...result.yieldArtifacts] }
      : {}),
  };
}

function invalidResult(
  ctx: RunContext,
  request: RunRequest,
  profile: string | undefined,
  reason: string,
): SingleResult {
  const agent = ctx.agents.find(
    (candidate) => candidate.name === request.item.agent,
  );
  return {
    agent: request.item.agent,
    ...(agent?.emoji ? { agentEmoji: agent.emoji } : {}),
    agentSource: agent?.source ?? "unknown",
    task: request.item.task,
    status: { kind: "invalid", reason },
    messages: [],
    output: "",
    stderr: reason,
    usage: emptyUsage(),
    ...(request.step !== undefined ? { step: request.step } : {}),
    ...(profile !== undefined ? { profile } : {}),
  };
}

function reject(result: SingleResult, reason: string): SingleResult {
  result.status = { kind: "rejected", reason };
  result.stopReason = "error";
  result.errorMessage = reason;
  result.stderr = reason;
  return result;
}

/** Folds one child event into the streamed result; true when it changed. */
function applyChildEvent(result: SingleResult, event: ChildEvent): boolean {
  if (event._tag === "session") {
    result.sessionId = event.sessionId;
    return true;
  }
  if (event._tag === "other") return false;

  const msg = event.message;
  if (event._tag === "toolResultEnd") result.hadDelegatedToolActivity = true;
  else result.hadDelegatedToolActivity ||= isDelegatedToolActivity(msg);
  if (
    appendBoundedJsonValue(
      result.messages,
      // SAFETY: the child is Pi's own `--mode json`; its messages are Pi `Message`s.
      msg.raw as Message,
      SUBAGENT_TRACE_PREVIEW_BYTES,
    )
  )
    result.traceTruncated = true;
  applySubagentYield(result, msg);
  if (event._tag === "messageEnd" && msg.role === "assistant") {
    const output = msg.textParts[0];
    if (output !== undefined) result.output = output;
    addTurnUsage(result.usage, msg.usage);
    if (msg.model) result.model = msg.model;
    if (msg.stopReason) result.stopReason = msg.stopReason;
    if (msg.errorMessage) result.errorMessage = msg.errorMessage;
  }
  return true;
}

type Termination = "abort" | "shutdown" | SubagentTimeoutReason;

interface ChildProcessSpec {
  readonly args: readonly string[];
  readonly cwd: string;
}

/** Spawns the child and streams it into `result` until it closes. */
function streamChild(
  ctx: RunContext,
  spec: ChildProcessSpec,
  result: SingleResult,
  transcript: TranscriptArtifact,
  emitUpdate: () => void,
): Promise<{ code: number; termination?: Termination }> {
  const { signal, limits, trace } = ctx;
  let termination: Termination | undefined;
  return new Promise((resolve) => {
    const invocation = getPiInvocation([...spec.args]);
    const isolatedProcessGroup = shouldIsolateSubagentProcess(trace.depth);
    const proc = spawn(invocation.command, invocation.args, {
      cwd: spec.cwd,
      env: buildSubagentEnvironment(trace),
      detached: isolatedProcessGroup,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const activeProcess = ctx.processes.register(proc, isolatedProcessGroup);
    let buffer = "";
    let settled = false;
    let abortListener: (() => void) | undefined;
    let watchdog:
      | ReturnType<typeof createSubagentExecutionWatchdog>
      | undefined;

    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      watchdog?.stop();
      if (signal && abortListener)
        signal.removeEventListener("abort", abortListener);
      void transcript.close(termination ? 1 : code).then(() => {
        if (transcript.error) result.transcriptError = transcript.error;
        resolve(termination ? { code, termination } : { code });
      });
    };
    const requestTermination = (reason: "abort" | SubagentTimeoutReason) => {
      if (termination || settled) return;
      termination = reason;
      watchdog?.stop();
      activeProcess.terminate();
    };
    watchdog = createSubagentExecutionWatchdog(limits, requestTermination);

    const processLine = (line: string) => {
      if (applyChildEvent(result, parseChildEventLine(line))) emitUpdate();
    };

    proc.stdout.on("data", (data) => {
      watchdog?.recordActivity();
      const chunk = data.toString();
      if (!transcript.append("stdout", chunk)) {
        proc.stdout.pause();
        transcript.resumeWhenWritable(() => proc.stdout.resume());
      }
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) processLine(line);
    });

    proc.stderr.on("data", (data) => {
      watchdog?.recordActivity();
      const chunk = data.toString();
      if (!transcript.append("stderr", chunk)) {
        proc.stderr.pause();
        transcript.resumeWhenWritable(() => proc.stderr.resume());
      }
      const stderr = truncateUtf8Tail(
        result.stderr + chunk,
        SUBAGENT_STDERR_PREVIEW_BYTES,
      );
      result.stderr = stderr.value;
      result.stderrTruncated ||= stderr.truncated;
    });

    proc.on("exit", () => activeProcess.complete());

    proc.on("close", (code) => {
      if (buffer.trim()) processLine(buffer);
      if (!termination && activeProcess.shutdownRequested)
        termination = "shutdown";
      activeProcess.complete();
      finish(code ?? 0);
    });

    proc.on("error", (error) => {
      result.errorMessage = `Could not start subagent (${invocation.command}): ${error.message}`;
      result.stderr = result.errorMessage;
      activeProcess.complete();
      finish(1);
    });

    if (signal) {
      abortListener = () => requestTermination("abort");
      if (signal.aborted) abortListener();
      else signal.addEventListener("abort", abortListener, { once: true });
    }
  });
}

async function writePromptToTempFile(
  agentName: string,
  prompt: string,
): Promise<{ dir: string; filePath: string }> {
  const tmpDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "pi-subagent-"),
  );
  const safeName = agentName.replace(/[^\w.-]+/g, "_");
  const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
  await withFileMutationQueue(filePath, async () => {
    await fs.promises.writeFile(filePath, prompt, {
      encoding: "utf-8",
      mode: 0o600,
    });
  });
  return { dir: tmpDir, filePath };
}

function removeQuietly(remove: () => void): void {
  try {
    remove();
  } catch {
    /* ignore */
  }
}

/** Applies how the child ended to its result. */
function settleResult(
  result: SingleResult,
  outcome: { code: number; termination?: Termination },
  limits: SubagentLimitsConfig,
): void {
  switch (outcome.termination) {
    case undefined:
      result.status = { kind: "exited", code: outcome.code };
      return;
    case "abort":
      result.status = { kind: "aborted", cause: "abort" };
      result.stopReason = "aborted";
      result.errorMessage = "Subagent was aborted";
      return;
    case "shutdown":
      result.status = { kind: "aborted", cause: "shutdown" };
      result.stopReason = "aborted";
      result.errorMessage =
        "Subagent stopped because the session is shutting down";
      return;
    case "runtime":
    case "inactivity":
      result.status = { kind: "timedOut", reason: outcome.termination };
      result.stopReason = "error";
      result.errorMessage = formatSubagentTimeoutMessage(
        outcome.termination,
        limits,
      );
      return;
  }
}

async function runSingleAgent(
  ctx: RunContext,
  request: RunRequest,
  attempt: Attempt,
): Promise<SingleResult> {
  const { item, step } = request;
  const { limits, trace } = ctx;
  const agent = ctx.agents.find((candidate) => candidate.name === item.agent);
  if (!agent) {
    const available =
      ctx.agents.map((candidate) => `"${candidate.name}"`).join(", ") || "none";
    return invalidResult(
      ctx,
      request,
      attempt.profile,
      `Unknown agent: "${item.agent}". Available agents: ${available}.`,
    );
  }

  const requestedModelSpec = attempt.model?.trim() || agent.model?.trim();
  const requestedModel = resolveRequestedModel(
    attempt.model,
    agent.model,
    ctx.resolveModel,
  );
  if (requestedModelSpec && !requestedModel)
    return invalidResult(
      ctx,
      request,
      attempt.profile,
      `Model "${requestedModelSpec}" is not available in Pi's model catalog or its provider has no authentication.`,
    );

  const cwd = item.cwd ?? ctx.defaultCwd;
  const result: SingleResult = {
    agent: item.agent,
    agentSource: agent.source,
    task: item.task,
    status: { kind: "pending" },
    messages: [],
    output: "",
    stderr: "",
    usage: emptyUsage(),
    ...(agent.emoji ? { agentEmoji: agent.emoji } : {}),
    ...(requestedModel !== undefined ? { requestedModel } : {}),
    ...(step !== undefined ? { step } : {}),
    ...(attempt.profile !== undefined ? { profile: attempt.profile } : {}),
  };
  const emitUpdate = () => request.onUpdate?.(snapshot(result));

  let prompt: { dir: string; filePath: string } | undefined;
  let transcript: TranscriptArtifact | undefined;
  let releaseConcurrency: (() => void) | undefined;
  const shutdownMessage =
    "Subagent did not start because the session is shutting down.";
  try {
    if (ctx.processes.isShuttingDown) return reject(result, shutdownMessage);
    try {
      releaseConcurrency = await ctx.concurrency.acquire(ctx.signal);
    } catch (error) {
      return reject(result, errorText(error));
    }
    if (ctx.processes.isShuttingDown) return reject(result, shutdownMessage);

    prompt = await writePromptToTempFile(
      agent.name,
      buildDelegatedSystemPrompt(agent.systemPrompt, trace, limits),
    );
    const args = buildChildArgs({
      agent,
      task: item.task,
      ...(requestedModel !== undefined ? { requestedModel } : {}),
      ...(item.tools !== undefined ? { tools: item.tools } : {}),
      ...(item.isolation !== undefined ? { isolation: item.isolation } : {}),
      promptPath: prompt.filePath,
      depth: trace.depth,
      limits,
    });
    transcript = createTranscriptArtifact(getAgentDir(), {
      rootSessionId: trace.rootSessionId,
      parentSessionId: trace.parentSessionId,
      parentToolCallId: trace.parentToolCallId,
      depth: trace.depth,
      agent: item.agent,
      task: item.task,
    });
    if (transcript.path) result.transcriptPath = transcript.path;
    if (transcript.error) result.transcriptError = transcript.error;

    result.status = { kind: "running" };
    const outcome = await streamChild(
      ctx,
      { args, cwd },
      result,
      transcript,
      emitUpdate,
    );
    if (limits.persistChildSessions && result.sessionId) {
      const sessionFilePath = resolveSessionFilePath(
        getAgentDir(),
        cwd,
        result.sessionId,
      );
      if (sessionFilePath) result.sessionFilePath = sessionFilePath;
    }
    settleResult(result, outcome, limits);
    return result;
  } finally {
    releaseConcurrency?.();
    // A no-op after streamChild closed it; covers failures before the child ran.
    if (transcript) await transcript.close(exitCodeOf(result.status));
    if (prompt) {
      const { dir, filePath } = prompt;
      removeQuietly(() => fs.unlinkSync(filePath));
      removeQuietly(() => fs.rmdirSync(dir));
    }
  }
}

function summarizeModelAttempt(result: SingleResult): ModelAttempt {
  return {
    exitCode: exitCodeOf(result.status),
    ...(result.requestedModel !== undefined
      ? { requestedModel: result.requestedModel }
      : {}),
    ...(result.model !== undefined ? { model: result.model } : {}),
    ...(result.stopReason !== undefined
      ? { stopReason: result.stopReason }
      : {}),
    ...(result.errorMessage !== undefined
      ? { errorMessage: result.errorMessage }
      : {}),
    ...(result.transcriptPath !== undefined
      ? { transcriptPath: result.transcriptPath }
      : {}),
    ...(result.transcriptError !== undefined
      ? { transcriptError: result.transcriptError }
      : {}),
  };
}

/**
 * True when a profile candidate's result is decisive. Later candidates would
 * not help after a success, a refusal, a timeout, an abort, or once the child
 * acted on the workspace.
 */
function shouldStopProfileLadder(result: SingleResult): boolean {
  const kind = result.status.kind;
  return (
    kind === "rejected" ||
    kind === "timedOut" ||
    kind === "aborted" ||
    !isFailedResult(result) ||
    result.hadDelegatedToolActivity === true
  );
}

function planFor(ctx: RunContext, item: BoundedItem) {
  return planProfileAttempts({
    agentName: item.agent,
    agent: ctx.agents.find((candidate) => candidate.name === item.agent),
    ...(item.model !== undefined ? { model: item.model } : {}),
    ...(item.profile !== undefined ? { profile: item.profile } : {}),
    profiles: ctx.profiles,
    availableModels: ctx.availableModels,
  });
}

async function runAgentWithProfile(
  ctx: RunContext,
  request: RunRequest,
): Promise<SingleResult> {
  const plan = planFor(ctx, request.item);
  switch (plan.kind) {
    case "rejected":
      return invalidResult(ctx, request, plan.profile, plan.reason);
    case "direct":
      return runSingleAgent(
        ctx,
        request,
        plan.model !== undefined ? { model: plan.model } : {},
      );
    case "ladder":
      break;
  }

  const attempts: ModelAttempt[] = [];
  let finalResult: SingleResult | undefined;
  for (const model of plan.candidates) {
    const result = await runSingleAgent(ctx, request, {
      model,
      profile: plan.profile,
    });
    attempts.push(summarizeModelAttempt(result));
    result.attempts = [...attempts];
    finalResult = result;
    if (shouldStopProfileLadder(result)) return result;
  }
  // SAFETY: a ladder plan always has at least one candidate.
  const exhausted = finalResult!;
  if (attempts.length > 1)
    exhausted.errorMessage = formatProfileAttemptSummaries(
      plan.profile,
      attempts,
    );
  return exhausted;
}

/** The model and profile a parallel task will most likely start with, for its placeholder. */
function previewAttempt(
  ctx: RunContext,
  item: BoundedItem,
): { requestedModel?: string; profile?: string } {
  const plan = planFor(ctx, item);
  switch (plan.kind) {
    case "direct": {
      const agent = ctx.agents.find(
        (candidate) => candidate.name === item.agent,
      );
      const requestedModel = resolveRequestedModel(
        plan.model,
        agent?.model,
        ctx.resolveModel,
      );
      return requestedModel !== undefined ? { requestedModel } : {};
    }
    case "ladder":
      return {
        profile: plan.profile,
        ...(plan.candidates[0] !== undefined
          ? { requestedModel: plan.candidates[0] }
          : {}),
      };
    case "rejected":
      return { profile: plan.profile };
  }
}

async function mapWithConcurrencyLimit<TIn, TOut>(
  items: readonly TIn[],
  concurrency: number,
  fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results: TOut[] = new Array(items.length);
  let nextIndex = 0;
  const workers = new Array(limit).fill(null).map(async () => {
    while (true) {
      const current = nextIndex++;
      if (current >= items.length) return;
      results[current] = await fn(items[current]!, current);
    }
  });
  await Promise.all(workers);
  return results;
}

function truncateParallelOutput(
  output: string,
  transcriptPath?: string,
): string {
  const byteLength = utf8ByteLength(output);
  if (byteLength <= PER_TASK_OUTPUT_CAP) return output;

  const truncated = truncateUtf8Head(output, PER_TASK_OUTPUT_CAP).value;
  const artifact = transcriptPath
    ? ` Full output is available in: ${shortenHomePath(transcriptPath)}`
    : "";
  return `${truncated}\n\n[Output truncated: ${byteLength - utf8ByteLength(truncated)} bytes omitted.${artifact}]`;
}

export interface BoundedProgress {
  readonly mode: BoundedMode;
  readonly text: string;
  readonly results: readonly SingleResult[];
}

export type BoundedOutcome =
  | {
      readonly kind: "completed";
      readonly mode: BoundedMode;
      readonly text: string;
      readonly isError: boolean;
      readonly results: readonly SingleResult[];
    }
  /** A child was aborted; the tool reports this by throwing. */
  | { readonly kind: "aborted"; readonly message: string };

function abortedOutcome(result: SingleResult): BoundedOutcome | undefined {
  if (result.status.kind !== "aborted") return undefined;
  return {
    kind: "aborted",
    message:
      result.status.cause === "abort"
        ? "Subagent was aborted"
        : "Subagent stopped because the session is shutting down",
  };
}

async function runSingle(
  ctx: RunContext,
  item: BoundedItem,
  onProgress: ((progress: BoundedProgress) => void) | undefined,
): Promise<BoundedOutcome> {
  const result = await runAgentWithProfile(ctx, {
    item,
    ...(onProgress
      ? {
          onUpdate: (partial: SingleResult) =>
            onProgress({
              mode: "single",
              text: partial.output || "(running...)",
              results: [partial],
            }),
        }
      : {}),
  });
  const aborted = abortedOutcome(result);
  if (aborted) return aborted;
  const isError = isFailedResult(result);
  const text = isError
    ? `Agent ${result.stopReason || "failed"}: ${getResultOutput(result)}${formatYieldArtifacts(result)}${formatTranscriptReference(result)}`
    : `${result.output || "(no output)"}${formatYieldArtifacts(result)}`;
  return {
    kind: "completed",
    mode: "single",
    text,
    isError,
    results: [result],
  };
}

async function runChain(
  ctx: RunContext,
  steps: readonly BoundedItem[],
  onProgress: ((progress: BoundedProgress) => void) | undefined,
): Promise<BoundedOutcome> {
  const results: SingleResult[] = [];
  let previousOutput = "";
  for (const [index, step] of steps.entries()) {
    const result = await runAgentWithProfile(ctx, {
      item: {
        ...step,
        task: step.task.replace(/\{previous\}/g, previousOutput),
      },
      step: index + 1,
      ...(onProgress
        ? {
            onUpdate: (partial: SingleResult) =>
              onProgress({
                mode: "chain",
                text: partial.output || "(running...)",
                results: [...results, partial],
              }),
          }
        : {}),
    });
    const aborted = abortedOutcome(result);
    if (aborted) return aborted;
    results.push(result);
    if (isFailedResult(result))
      return {
        kind: "completed",
        mode: "chain",
        text: `Chain stopped at step ${index + 1} (${step.agent}): ${getResultOutput(result)}${formatYieldArtifacts(result)}${formatTranscriptReference(result)}`,
        isError: true,
        results,
      };
    previousOutput = result.output;
  }
  // SAFETY: the parser only builds chain plans with at least one step.
  const finalResult = results[results.length - 1]!;
  return {
    kind: "completed",
    mode: "chain",
    text: `${finalResult.output || "(no output)"}${formatYieldArtifacts(finalResult)}`,
    isError: false,
    results,
  };
}

function parallelPlaceholder(ctx: RunContext, item: BoundedItem): SingleResult {
  const agent = ctx.agents.find((candidate) => candidate.name === item.agent);
  return {
    agent: item.agent,
    ...(agent?.emoji ? { agentEmoji: agent.emoji } : {}),
    agentSource: agent?.source ?? "unknown",
    task: item.task,
    status: { kind: "pending" },
    messages: [],
    output: "",
    stderr: "",
    ...previewAttempt(ctx, item),
    usage: emptyUsage(),
  };
}

function formatParallelSummary(result: SingleResult): string {
  const failed = isFailedResult(result);
  const output = truncateParallelOutput(
    getResultOutput(result),
    result.transcriptPath,
  );
  const status = result.yieldStatus
    ? result.yieldStatus
    : failed
      ? `failed${result.stopReason && result.stopReason !== "end" ? ` (${result.stopReason})` : ""}`
      : "completed";
  const transcript = failed ? formatTranscriptReference(result) : "";
  return `### [${formatResultAgentName(result)}] ${status}\n\n${output}${formatYieldArtifacts(result)}${transcript}`;
}

async function runParallel(
  ctx: RunContext,
  items: readonly BoundedItem[],
  context: string | undefined,
  onProgress: ((progress: BoundedProgress) => void) | undefined,
): Promise<BoundedOutcome> {
  if (items.length > ctx.limits.maxChildrenPerCall)
    return {
      kind: "completed",
      mode: "parallel",
      text: `Too many parallel tasks (${items.length}). Max is ${ctx.limits.maxChildrenPerCall}.`,
      isError: false,
      results: [],
    };

  const live = items.map((item) => parallelPlaceholder(ctx, item));
  const emitProgress = () => {
    if (!onProgress) return;
    const running = live.filter(isActiveResult).length;
    onProgress({
      mode: "parallel",
      text: `Parallel: ${live.length - running}/${live.length} done, ${running} running...`,
      results: [...live],
    });
  };

  // Aborted children come back as results, so every sibling settles before
  // the abort is reported; a pending abort makes the rest fail admission.
  const results = await mapWithConcurrencyLimit(
    items,
    ctx.limits.maxConcurrency,
    async (item, index) => {
      const result = await runAgentWithProfile(ctx, {
        item: { ...item, task: buildSharedTaskPrompt(item.task, context) },
        ...(onProgress
          ? {
              onUpdate: (partial: SingleResult) => {
                live[index] = { ...partial, task: item.task };
                emitProgress();
              },
            }
          : {}),
      });
      result.task = item.task;
      live[index] = result;
      emitProgress();
      return result;
    },
  );

  for (const result of results) {
    const aborted = abortedOutcome(result);
    if (aborted) return aborted;
  }
  const successCount = results.filter(
    (result) => !isFailedResult(result),
  ).length;
  return {
    kind: "completed",
    mode: "parallel",
    text: `Parallel: ${successCount}/${results.length} succeeded\n\n${results.map(formatParallelSummary).join("\n\n---\n\n")}`,
    isError: false,
    results,
  };
}

export function runBoundedPlan(
  ctx: RunContext,
  plan: BoundedPlan,
  onProgress?: (progress: BoundedProgress) => void,
): Promise<BoundedOutcome> {
  switch (plan.kind) {
    case "single":
      return runSingle(ctx, plan.item, onProgress);
    case "chain":
      return runChain(ctx, plan.steps, onProgress);
    case "parallel":
      return runParallel(ctx, plan.items, plan.context, onProgress);
  }
}
