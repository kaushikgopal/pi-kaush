/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Supports three modes with optional execution profiles or model overrides:
 *   - Single: { agent: "name", task: "...", profile?: "name", model?: "provider/model" }
 *   - Parallel: { tasks: [{ agent: "name", task: "...", profile?: "name", model?: "provider/model" }, ...] }
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ...", profile?: "name", model?: "provider/model" }, ...] }
 *
 * Uses JSON mode to capture structured output from subagents.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	getAgentDir,
	getMarkdownTheme,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	buildChildSessionName,
	buildDelegatedSystemPrompt,
	buildSubagentEnvironment,
	buildSharedTaskPrompt,
	createDelegationTrace,
	currentDelegationDepth,
	createModelResolver,
	delegationModelCandidates,
	type DelegationTrace,
	hasDelegatedToolActivity,
	resolveRequestedModel,
	sessionIdFromJsonEvent,
} from "./_delegation.ts";
import {
	type AgentConfig,
	type AgentScope,
	discoverAgents,
	formatAgentList,
	shouldConfirmProjectAgent,
} from "./_definition.ts";
import {
	type AgentIdentity,
	formatAgentDisplayName,
	formatProfileDisplayName,
	resolveAgentDisplayName,
} from "./_display.ts";
import {
	createSubagentExecutionWatchdog,
	formatDuration,
	formatSubagentTimeoutMessage,
	type SubagentTimeoutReason,
} from "./_execution.ts";
import { SessionConcurrencyGate, type SubagentConcurrencyStatus } from "./_concurrency.ts";
import { loadSubagentLimits, type SubagentLimitsConfig } from "./_limits.ts";
import { SubagentProcessRegistry, shouldIsolateSubagentProcess } from "./_process-tree.ts";
import {
	formatProfileAttemptSummaries,
	formatProfileCandidate,
	formatProfileEligibilityError,
	formatProfileGuidance,
	loadSubagentProfiles,
	loadSubagentProfilesCurrent,
	resolveProfilesPath,
	type SubagentProfilesCache,
	type SubagentProfilesConfig,
} from "./_profiles.ts";
import {
	appendBoundedJsonValue,
	createTranscriptArtifact,
	resolveSessionFilePath,
	SUBAGENT_OUTPUT_PREVIEW_BYTES,
	SUBAGENT_STDERR_PREVIEW_BYTES,
	SUBAGENT_TRACE_PREVIEW_BYTES,
	truncateUtf8Head,
	truncateUtf8Tail,
} from "./_transcript.ts";
import {
	applySubagentYield,
	includeSubagentYieldTool,
	registerSubagentYield,
	SUBAGENT_YIELD_TOOL_NAME,
	type SubagentYieldStatus,
} from "./_yield.ts";

const COLLAPSED_ITEM_COUNT = 10;
const COLLAPSED_OUTPUT_PREVIEW_BYTES = 4 * 1024;
const PER_TASK_OUTPUT_CAP = 50 * 1024;

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string,
): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) {
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	}
	if (model) parts.push(model);
	return parts.join(" ");
}

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: any, text: string) => string,
): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = themeFg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "grep ") +
				themeFg("accent", `/${pattern}/`) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

function createEmptyUsage(): UsageStats {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		contextTokens: 0,
		turns: 0,
	};
}

interface ModelAttempt {
	requestedModel?: string;
	model?: string;
	exitCode: number;
	stopReason?: string;
	errorMessage?: string;
	errorTruncated?: boolean;
	transcriptPath?: string;
	transcriptError?: string;
}

interface SingleResult {
	agent: string;
	agentEmoji?: string;
	agentSource: "user" | "project" | "unknown";
	task: string;
	exitCode: number;
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
	stopReason?: string;
	errorMessage?: string;
	errorTruncated?: boolean;
	yieldStatus?: SubagentYieldStatus;
	yieldArtifacts?: string[];
	step?: number;
	profile?: string;
	attempts?: ModelAttempt[];
	spawnBlocked?: boolean;
	executionTimedOut?: boolean;
}

interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	trace: DelegationTrace;
	concurrency: SubagentConcurrencyStatus;
	results: SingleResult[];
}

interface AgentDisplayCache {
	cwd: string;
	scope: AgentScope;
	agents: AgentIdentity[];
}

interface SubagentRenderState {
	agentDisplayCache?: AgentDisplayCache;
}

function getRenderAgents(cwd: string, scope: AgentScope, state: SubagentRenderState): readonly AgentIdentity[] {
	const cached = state.agentDisplayCache;
	if (cached?.cwd === cwd && cached.scope === scope) return cached.agents;

	let agents: AgentIdentity[];
	try {
		agents = discoverAgents(cwd, scope).agents.map(({ name, emoji }) => ({ name, emoji }));
	} catch {
		// A metadata lookup must never break rendering; execution will surface discovery errors.
		agents = [];
	}
	state.agentDisplayCache = { cwd, scope, agents };
	return agents;
}

function formatResultAgentName(result: SingleResult): string {
	return formatAgentDisplayName({ name: result.agent, emoji: result.agentEmoji });
}

function formatProfileBadge(
	profile: string | undefined,
	theme: { fg(color: any, text: string): string },
): string {
	const label = formatProfileDisplayName(profile);
	return label ? ` ${theme.fg("muted", label)}` : "";
}

function formatTraceSuffix(result: SingleResult, trace: DelegationTrace): string {
	const parts = [`depth ${trace.depth}`];
	if (result.sessionId) parts.unshift(`session ${result.sessionId}`);
	return ` · ${parts.join(" · ")}`;
}

function isFailedResult(result: SingleResult): boolean {
	return (
		result.exitCode !== 0 ||
		result.stopReason === "error" ||
		result.stopReason === "aborted" ||
		result.yieldStatus === "blocked" ||
		result.yieldStatus === "failed"
	);
}

function getResultOutput(result: SingleResult): string {
	if (isFailedResult(result)) {
		return result.errorMessage || result.stderr || result.output || "(no output)";
	}
	return result.output || "(no output)";
}

function formatTranscriptPath(filePath: string): string {
	const home = os.homedir();
	return filePath.startsWith(`${home}${path.sep}`) ? `~${filePath.slice(home.length)}` : filePath;
}

function formatYieldArtifacts(result: SingleResult): string {
	if (!result.yieldArtifacts || result.yieldArtifacts.length === 0) return "";
	return `\n\nArtifacts:\n${result.yieldArtifacts.map((artifact) => `- ${formatTranscriptPath(artifact)}`).join("\n")}`;
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
		lines.push(`${label}: ${[...paths].map(formatTranscriptPath).join(", ")}`);
	}
	if (errors.size > 0) {
		const label = paths.size > 0 ? "Transcript write error" : "Transcript unavailable";
		lines.push(`${label}: ${[...errors].join("; ")}`);
	}
	return lines.length > 0 ? `\n\n${lines.join("\n")}` : "";
}

function toPersistedResult(result: SingleResult): SingleResult {
	const output = truncateUtf8Head(result.output, SUBAGENT_OUTPUT_PREVIEW_BYTES);
	const stderr = truncateUtf8Tail(result.stderr, SUBAGENT_STDERR_PREVIEW_BYTES);
	const error = result.errorMessage
		? truncateUtf8Head(result.errorMessage, SUBAGENT_OUTPUT_PREVIEW_BYTES)
		: undefined;
	const attempts = result.attempts?.map((attempt) => {
		const attemptError = attempt.errorMessage
			? truncateUtf8Head(attempt.errorMessage, SUBAGENT_OUTPUT_PREVIEW_BYTES)
			: undefined;
		return {
			...attempt,
			errorMessage: attemptError?.value,
			errorTruncated: attempt.errorTruncated || attemptError?.truncated || undefined,
		};
	});
	return {
		...result,
		output: output.value,
		outputTruncated: result.outputTruncated || output.truncated || undefined,
		stderr: stderr.value,
		stderrTruncated: result.stderrTruncated || stderr.truncated || undefined,
		errorMessage: error?.value,
		errorTruncated: result.errorTruncated || error?.truncated || undefined,
		attempts,
	};
}

function truncateParallelOutput(output: string, transcriptPath?: string): string {
	const byteLength = Buffer.byteLength(output, "utf8");
	if (byteLength <= PER_TASK_OUTPUT_CAP) return output;

	const truncated = truncateUtf8Head(output, PER_TASK_OUTPUT_CAP).value;
	const artifact = transcriptPath
		? ` Full output is available in: ${formatTranscriptPath(transcriptPath)}`
		: "";
	return `${truncated}\n\n[Output truncated: ${byteLength - Buffer.byteLength(truncated, "utf8")} bytes omitted.${artifact}]`;
}

type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> };

function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall" && part.name !== SUBAGENT_YIELD_TOOL_NAME) {
					items.push({ type: "toolCall", name: part.name, args: part.arguments });
				}
			}
		}
	}
	return items;
}

function getCollapsedOutput(output: string): string {
	const head = truncateUtf8Head(output, COLLAPSED_OUTPUT_PREVIEW_BYTES);
	const lines = head.value.split("\n");
	const preview = lines.slice(0, 3).join("\n");
	return head.truncated || lines.length > 3 ? `${preview}\n…` : preview;
}

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
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
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

async function runSingleAgent(
	defaultCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	invocationModel: string | undefined,
	profile: string | undefined,
	cwd: string | undefined,
	step: number | undefined,
	trace: DelegationTrace,
	limits: SubagentLimitsConfig,
	concurrency: SessionConcurrencyGate,
	activeProcesses: SubagentProcessRegistry,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
	resolveModel?: (spec: string) => string | undefined,
): Promise<SingleResult> {
	const agent = agents.find((a) => a.name === agentName);

	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return {
			agent: agentName,
			agentSource: "unknown",
			task,
			exitCode: 1,
			messages: [],
			output: "",
			stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
			usage: createEmptyUsage(),
			step,
			profile,
		};
	}

	const requestedModelSpec = invocationModel?.trim() || agent.model?.trim();
	const requestedModel = resolveRequestedModel(invocationModel, agent.model, resolveModel);
	if (requestedModelSpec && !requestedModel) {
		return {
			agent: agentName,
			agentSource: agent.source,
			task,
			exitCode: 1,
			messages: [],
			output: "",
			stderr: `Model "${requestedModelSpec}" is not available in the current Pi model scope.`,
			usage: createEmptyUsage(),
			agentEmoji: agent.emoji,
			step,
			profile,
		};
	}
	const args: string[] = ["--mode", "json", "-p"];
	if (limits.persistChildSessions) {
		args.push("--name", buildChildSessionName(formatAgentDisplayName(agent), task));
	} else {
		args.push("--no-session");
	}
	if (requestedModel) args.push("--model", requestedModel);
	if (agent.tools && agent.tools.length > 0) {
		args.push("--tools", includeSubagentYieldTool(agent.tools).join(","));
	}
	if (trace.depth >= limits.maxDepth) args.push("--exclude-tools", "subagent");

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;
	let transcript: ReturnType<typeof createTranscriptArtifact> | undefined;
	let releaseConcurrency: (() => void) | undefined;

	const currentResult: SingleResult = {
		agent: agentName,
		agentSource: agent.source,
		task,
		exitCode: 0,
		messages: [],
		output: "",
		stderr: "",
		usage: createEmptyUsage(),
		agentEmoji: agent.emoji,
		requestedModel,
		step,
		profile,
	};

	const emitUpdate = () => {
		if (onUpdate) {
			onUpdate({
				content: [{ type: "text", text: currentResult.output || "(running...)" }],
				details: makeDetails([currentResult]),
			});
		}
	};

	try {
		if (activeProcesses.isShuttingDown) {
			const message = "Subagent did not start because the session is shutting down.";
			currentResult.exitCode = 1;
			currentResult.stopReason = "error";
			currentResult.errorMessage = message;
			currentResult.stderr = message;
			currentResult.spawnBlocked = true;
			return currentResult;
		}
		try {
			releaseConcurrency = await concurrency.acquire(signal);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			currentResult.exitCode = 1;
			currentResult.stopReason = "error";
			currentResult.errorMessage = message;
			currentResult.stderr = message;
			currentResult.spawnBlocked = true;
			return currentResult;
		}
		if (activeProcesses.isShuttingDown) {
			const message = "Subagent did not start because the session is shutting down.";
			currentResult.exitCode = 1;
			currentResult.stopReason = "error";
			currentResult.errorMessage = message;
			currentResult.stderr = message;
			currentResult.spawnBlocked = true;
			return currentResult;
		}

		const delegatedPrompt = buildDelegatedSystemPrompt(agent.systemPrompt, trace, limits);
		const tmp = await writePromptToTempFile(agent.name, delegatedPrompt);
		tmpPromptDir = tmp.dir;
		tmpPromptPath = tmp.filePath;
		args.push("--append-system-prompt", tmpPromptPath);

		args.push(`Task: ${task}`);
		transcript = createTranscriptArtifact(getAgentDir(), {
			rootSessionId: trace.rootSessionId,
			parentSessionId: trace.parentSessionId,
			parentToolCallId: trace.parentToolCallId,
			depth: trace.depth,
			agent: agentName,
			task,
		});
		currentResult.transcriptPath = transcript.path;
		currentResult.transcriptError = transcript.error;
		let terminationReason: "abort" | "shutdown" | SubagentTimeoutReason | undefined;

		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const isolatedProcessGroup = shouldIsolateSubagentProcess(trace.depth);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: cwd ?? defaultCwd,
				env: buildSubagentEnvironment(trace),
				detached: isolatedProcessGroup,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
			const activeProcess = activeProcesses.register(proc, isolatedProcessGroup);
			let buffer = "";
			let settled = false;
			let abortListener: (() => void) | undefined;

			let watchdog: ReturnType<typeof createSubagentExecutionWatchdog> | undefined;
			const finish = (code: number): void => {
				if (settled) return;
				settled = true;
				watchdog?.stop();
				if (signal && abortListener) signal.removeEventListener("abort", abortListener);
				const artifactExitCode = terminationReason ? 1 : code;
				const closeTranscript = transcript ? transcript.close(artifactExitCode) : Promise.resolve();
				void closeTranscript.then(() => {
					if (transcript?.error) currentResult.transcriptError = transcript.error;
					resolve(code);
				});
			};
			const requestTermination = (reason: "abort" | SubagentTimeoutReason): void => {
				if (terminationReason || settled) return;
				terminationReason = reason;
				watchdog?.stop();
				activeProcess.terminate();
			};
			watchdog = createSubagentExecutionWatchdog(limits, (reason) => requestTermination(reason));

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				const sessionId = sessionIdFromJsonEvent(event);
				if (sessionId) {
					currentResult.sessionId = sessionId;
					emitUpdate();
					return;
				}

				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					currentResult.hadDelegatedToolActivity ||= hasDelegatedToolActivity([msg]);
					currentResult.traceTruncated =
						appendBoundedJsonValue(currentResult.messages, msg, SUBAGENT_TRACE_PREVIEW_BYTES) ||
						currentResult.traceTruncated;
					applySubagentYield(currentResult, msg);
					if (msg.role === "assistant") {
						const output = msg.content.find((part) => part.type === "text");
						if (output?.type === "text") currentResult.output = output.text;
						currentResult.usage.turns++;
						const usage = msg.usage;
						if (usage) {
							currentResult.usage.input += usage.input || 0;
							currentResult.usage.output += usage.output || 0;
							currentResult.usage.cacheRead += usage.cacheRead || 0;
							currentResult.usage.cacheWrite += usage.cacheWrite || 0;
							currentResult.usage.cost += usage.cost?.total || 0;
							currentResult.usage.contextTokens = usage.totalTokens || 0;
						}
						if (msg.model) currentResult.model = msg.provider ? `${msg.provider}/${msg.model}` : msg.model;
						if (msg.stopReason) currentResult.stopReason = msg.stopReason;
						if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
					}
					emitUpdate();
				}

				if (event.type === "tool_result_end" && event.message) {
					const msg = event.message as Message;
					currentResult.hadDelegatedToolActivity = true;
					currentResult.traceTruncated =
						appendBoundedJsonValue(currentResult.messages, msg, SUBAGENT_TRACE_PREVIEW_BYTES) ||
						currentResult.traceTruncated;
					applySubagentYield(currentResult, msg);
					emitUpdate();
				}
			};

			proc.stdout.on("data", (data) => {
				watchdog?.recordActivity();
				const chunk = data.toString();
				if (transcript && !transcript.append("stdout", chunk)) {
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
				if (transcript && !transcript.append("stderr", chunk)) {
					proc.stderr.pause();
					transcript.resumeWhenWritable(() => proc.stderr.resume());
				}
				const stderr = truncateUtf8Tail(currentResult.stderr + chunk, SUBAGENT_STDERR_PREVIEW_BYTES);
				currentResult.stderr = stderr.value;
				currentResult.stderrTruncated ||= stderr.truncated;
			});

			proc.on("exit", () => activeProcess.complete());

			proc.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				if (!terminationReason && activeProcess.shutdownRequested) terminationReason = "shutdown";
				activeProcess.complete();
				finish(code ?? 0);
			});

			proc.on("error", () => {
				activeProcess.complete();
				finish(1);
			});

			if (signal) {
				abortListener = () => requestTermination("abort");
				if (signal.aborted) abortListener();
				else signal.addEventListener("abort", abortListener, { once: true });
			}
		});

		currentResult.exitCode = exitCode;
		if (limits.persistChildSessions && currentResult.sessionId) {
			currentResult.sessionFilePath = resolveSessionFilePath(getAgentDir(), cwd ?? defaultCwd, currentResult.sessionId);
		}
		if (terminationReason === "abort") throw new Error("Subagent was aborted");
		if (terminationReason === "shutdown") throw new Error("Subagent stopped because the session is shutting down");
		if (terminationReason) {
			const message = formatSubagentTimeoutMessage(terminationReason, limits);
			currentResult.exitCode = 1;
			currentResult.stopReason = "error";
			currentResult.errorMessage = message;
			currentResult.executionTimedOut = true;
		}
		return currentResult;
	} finally {
		releaseConcurrency?.();
		if (transcript) await transcript.close(currentResult.exitCode);
		if (tmpPromptPath)
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		if (tmpPromptDir)
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
	}
}

function summarizeModelAttempt(result: SingleResult): ModelAttempt {
	return {
		requestedModel: result.requestedModel,
		model: result.model,
		exitCode: result.exitCode,
		stopReason: result.stopReason,
		errorMessage: result.errorMessage,
		transcriptPath: result.transcriptPath,
		transcriptError: result.transcriptError,
	};
}

function profileFailureResult(
	agents: AgentConfig[],
	agentName: string,
	task: string,
	profile: string,
	message: string,
	step: number | undefined,
): SingleResult {
	const agent = agents.find((candidate) => candidate.name === agentName);
	return {
		agent: agentName,
		agentEmoji: agent?.emoji,
		agentSource: agent?.source ?? "unknown",
		task,
		exitCode: 1,
		messages: [],
		output: "",
		stderr: message,
		usage: createEmptyUsage(),
		step,
		profile,
	};
}

async function runAgentWithProfile(
	defaultCwd: string,
	agents: AgentConfig[],
	profiles: SubagentProfilesConfig,
	getAvailableModelReferences: () => Promise<ReadonlySet<string>>,
	agentName: string,
	task: string,
	invocationModel: string | undefined,
	profileName: string | undefined,
	cwd: string | undefined,
	step: number | undefined,
	trace: DelegationTrace,
	limits: SubagentLimitsConfig,
	concurrency: SessionConcurrencyGate,
	activeProcesses: SubagentProcessRegistry,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
	resolveModel?: (spec: string) => string | undefined,
): Promise<SingleResult> {
	if (invocationModel?.trim() || !profileName) {
		return runSingleAgent(
			defaultCwd,
			agents,
			agentName,
			task,
			invocationModel,
			undefined,
			cwd,
			step,
			trace,
			limits,
			concurrency,
			activeProcesses,
			signal,
			onUpdate,
			makeDetails,
			resolveModel,
		);
	}

	const profile = profiles.profiles[profileName];
	if (!profile) {
		return profileFailureResult(
			agents,
			agentName,
			task,
			profileName,
			`Unknown subagent profile "${profileName}". Available profiles: ${Object.keys(profiles.profiles).join(", ")}.`,
			step,
		);
	}

	let availableModels: ReadonlySet<string>;
	try {
		availableModels = await getAvailableModelReferences();
	} catch (error) {
		return profileFailureResult(
			agents,
			agentName,
			task,
			profileName,
			`Could not resolve available models for profile "${profileName}": ${error instanceof Error ? error.message : error}`,
			step,
		);
	}

	const candidates = profile.candidates.filter((candidate) => availableModels.has(candidate.model.toLowerCase()));
	if (candidates.length === 0) {
		return profileFailureResult(
			agents,
			agentName,
			task,
			profileName,
			formatProfileEligibilityError(profileName, profile.candidates, availableModels, availableModels.size),
			step,
		);
	}

	const attempts: ModelAttempt[] = [];
	let finalResult: SingleResult | undefined;
	for (const candidate of candidates) {
		const result = await runSingleAgent(
			defaultCwd,
			agents,
			agentName,
			task,
			formatProfileCandidate(candidate),
			profileName,
			cwd,
			step,
			trace,
			limits,
			concurrency,
			activeProcesses,
			signal,
			onUpdate,
			makeDetails,
			resolveModel,
		);
		attempts.push(summarizeModelAttempt(result));
		result.attempts = [...attempts];
		finalResult = result;

		if (
			result.spawnBlocked ||
			result.executionTimedOut ||
			!isFailedResult(result) ||
			result.hadDelegatedToolActivity
		)
			return result;
	}

	if (!finalResult) {
		return profileFailureResult(agents, agentName, task, profileName, `Profile "${profileName}" did not run.`, step);
	}
	if (attempts.length > 1) {
		finalResult.errorMessage = formatProfileAttemptSummaries(profileName, attempts);
	}
	return finalResult;
}

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

function createSubagentParams(profiles: SubagentProfilesConfig, limits: SubagentLimitsConfig) {
	const profileNames = Object.keys(profiles.profiles) as [string, ...string[]];
	const profileDescription = `Execution profile configured in profiles.yaml. ${formatProfileGuidance(profiles)}`;
	const profileSchema = () => Type.Optional(StringEnum(profileNames, { description: profileDescription }));
	const modelSchema = (scope: string) =>
		Type.Optional(
			Type.String({ description: `Model pattern for ${scope}; overrides profile and agent configuration` }),
		);

	const agentSchema = () =>
		Type.String({
			description: "Agent name; selects behavior and tools. Profile separately selects compute.",
		});
	const TaskItem = Type.Object({
		agent: agentSchema(),
		task: Type.String({ description: "Task to delegate to the agent" }),
		profile: profileSchema(),
		model: modelSchema("this task"),
		cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	});

	const ChainItem = Type.Object({
		agent: agentSchema(),
		task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
		profile: profileSchema(),
		model: modelSchema("this step"),
		cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	});

	return Type.Object({
		agent: Type.Optional(agentSchema()),
		task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
		profile: profileSchema(),
		model: modelSchema("single mode"),
		context: Type.Optional(
			Type.String({ description: "Shared immutable context prepended to every task in parallel mode" }),
		),
		tasks: Type.Optional(
			Type.Array(TaskItem, {
				description: "Parallel tasks with optional per-task profiles or model overrides",
				maxItems: limits.maxChildrenPerCall,
			}),
		),
		chain: Type.Optional(
			Type.Array(ChainItem, {
				description: "Sequential steps with optional per-step profiles or model overrides",
				maxItems: limits.maxChildrenPerCall,
			}),
		),
		agentScope: Type.Optional(AgentScopeSchema),
		confirmProjectAgents: Type.Optional(
			Type.Boolean({
				description:
					"Prompt before running project-local agents. Overrides agent frontmatter; defaults to its value, then true.",
			}),
		),
		cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
	});
}

export function registerSubagent(pi: ExtensionAPI, extensionDir = path.dirname(fileURLToPath(import.meta.url))) {
	if (currentDelegationDepth() > 0) registerSubagentYield(pi);
	const profilesPath = resolveProfilesPath(getAgentDir());
	// Registration-time snapshot drives the tool schema (profile-name enum) and
	// description; call-time resolution reloads on file change so ladder edits
	// apply to long-running sessions without a restart.
	const profiles = loadSubagentProfiles(profilesPath);
	let profilesCache: SubagentProfilesCache | undefined;
	const loadCurrentProfiles = (): SubagentProfilesConfig => {
		profilesCache = loadSubagentProfilesCurrent(profilesPath, profilesCache);
		return profilesCache.config;
	};
	const limits = loadSubagentLimits(path.join(extensionDir, "limits.json"));
	const activeProcesses = new SubagentProcessRegistry();
	const concurrency = new SessionConcurrencyGate(limits.maxConcurrency);
	pi.on("session_shutdown", async () => {
		concurrency.close();
		await activeProcesses.terminateAll();
	});
	const initialUserAgents = discoverAgents(process.cwd(), "user").agents;
	const listedAgents = formatAgentList(initialUserAgents, 20);
	const agentGuidance = `${listedAgents.text}${listedAgents.remaining > 0 ? `; and ${listedAgents.remaining} more` : ""}`;
	const exampleAgent = initialUserAgents.find((agent) => agent.name === "redteam") ?? initialUserAgents[0];
	const exampleProfile = profiles.profiles.thinker ? "thinker" : Object.keys(profiles.profiles)[0];
	const compositionExample =
		exampleAgent && exampleProfile
			? ` Phrases "${exampleProfile} ${exampleAgent.name}" and "${exampleAgent.name} ${exampleProfile}" both mean agent "${exampleAgent.name}" with profile "${exampleProfile}".`
			: "";
	const SubagentParams = createSubagentParams(profiles, limits);
	const profileGuidance = formatProfileGuidance(profiles);
	const maxTreeChildren =
		limits.maxDepth === 1
			? limits.maxConcurrency
			: limits.maxConcurrency + limits.maxConcurrency ** 2;

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate bounded tasks to specialized subagents with isolated context; use agent \"bee\" (🐝) for general execution.",
			`Agents select behavior and tools; profiles select compute. They compose independently, and their order in the user's wording does not matter.${compositionExample}`,
			`Available user agents: ${agentGuidance}.`,
			"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
			"Parallel tasks may share one immutable context string that is prepended to every child task.",
			`Execution profiles: ${profileGuidance}`,
			`Hard delegation limits: depth ${limits.maxDepth}; ${limits.maxConcurrency} active child processes per Pi session; ${limits.maxChildrenPerCall} children per call; ${maxTreeChildren} maximum active descendants across a fully expanded root tree. Completed children release their concurrency slots.`,
			`Child execution limits: ${formatDuration(limits.maxRuntimeMs)} total runtime; ${formatDuration(limits.maxInactivityMs)} without output. These limits do not apply to the orchestrator.`,
			"Full child stdout/stderr transcripts are stored as private JSONL artifacts; session details retain bounded previews and artifact paths.",
			"Each invocation may choose a profile or an explicit model; an explicit model overrides the profile and agent definition.",
			`Default agent scope is "user" (from ${path.join(getAgentDir(), "agents")}).`,
			`To enable project-local agents in ${CONFIG_DIR_NAME}/agents, set agentScope: "both" (or "project").`,
			"Agent frontmatter may set confirmProjectAgents; the invocation parameter overrides it.",
		].join(" "),
		promptSnippet: "Delegate bounded work with isolated agents and optional execution profiles",
		promptGuidelines: [
			`For subagent, agent and profile are independent: agent selects behavior and tools; profile selects compute. When the user names both in either order, preserve both.${compositionExample}`,
			`When invoking subagent, select the least expensive profile that safely fits the task: ${profileGuidance}`,
			`Subagent delegation is capped at depth ${limits.maxDepth}, ${limits.maxConcurrency} active children per Pi session, and ${limits.maxChildrenPerCall} children per call. Completed children release their slots.`,
			"Use subagent model only for an exact model override; model takes precedence over profile.",
			"Use top-level context only for background or constraints shared by every parallel task.",
		],
		parameters: SubagentParams,

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const profiles = loadCurrentProfiles();
			const agentScope: AgentScope = params.agentScope ?? "user";
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;
			const trace = createDelegationTrace(ctx.sessionManager.getSessionId(), toolCallId);
			if (trace.depth > limits.maxDepth) {
				return {
					content: [
						{
							type: "text",
							text: `Subagent delegation blocked at depth ${trace.depth}; hard maximum is ${limits.maxDepth}.`,
						},
					],
					details: {
						mode: "single" as const,
						agentScope,
						projectAgentsDir: discovery.projectAgentsDir,
						trace,
						concurrency: concurrency.status,
						results: [],
					},
					isError: true,
				};
			}
			const delegationModels = delegationModelCandidates(ctx.scopedModels, ctx.modelRegistry.getAvailable());
			let availableModelReferences: Promise<ReadonlySet<string>> | undefined;
			const getAvailableModelReferences = (): Promise<ReadonlySet<string>> => {
				if (!availableModelReferences) {
					availableModelReferences = Promise.resolve(
						new Set(delegationModels.map((model) => `${model.provider}/${model.id}`.toLowerCase())) as ReadonlySet<string>,
					);
				}
				return availableModelReferences;
			};
			const resolveModel = createModelResolver(delegationModels);

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

			const makeDetails =
				(mode: "single" | "parallel" | "chain") =>
				(results: SingleResult[]): SubagentDetails => ({
					mode,
					agentScope,
					projectAgentsDir: discovery.projectAgentsDir,
					trace,
					results: results.map(toPersistedResult),
					concurrency: concurrency.status,
				});

			if (modeCount !== 1) {
				const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
				return {
					content: [
						{
							type: "text",
							text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
						},
					],
					details: makeDetails("single")([]),
				};
			}

			const sharedContext = params.context?.trim() || undefined;
			if (sharedContext !== undefined && !hasTasks) {
				return {
					content: [{ type: "text", text: "Invalid parameters. context is supported only with parallel tasks[]." }],
					details: makeDetails(hasChain ? "chain" : "single")([]),
					isError: true,
				};
			}

			if ((agentScope === "project" || agentScope === "both") && ctx.hasUI) {
				const requestedAgentNames = new Set<string>();
				if (params.chain) for (const step of params.chain) requestedAgentNames.add(step.agent);
				if (params.tasks) for (const t of params.tasks) requestedAgentNames.add(t.agent);
				if (params.agent) requestedAgentNames.add(params.agent);

				const projectAgentsRequiringConfirmation = Array.from(requestedAgentNames)
					.map((name) => agents.find((a) => a.name === name))
					.filter(
						(a): a is AgentConfig =>
							a?.source === "project" && shouldConfirmProjectAgent(a, params.confirmProjectAgents),
					);

				if (projectAgentsRequiringConfirmation.length > 0) {
					const names = projectAgentsRequiringConfirmation.map((a) => formatAgentDisplayName(a)).join(", ");
					const dir = discovery.projectAgentsDir ?? "(unknown)";
					const ok = await ctx.ui.confirm(
						"Run project-local agents?",
						`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
					);
					if (!ok)
						return {
							content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
							details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
						};
				}
			}

			if (params.chain && params.chain.length > 0) {
				const results: SingleResult[] = [];
				let previousOutput = "";

				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i];
					const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);

					// Create update callback that includes all previous results
					const chainUpdate: OnUpdateCallback | undefined = onUpdate
						? (partial) => {
								// Combine completed results with current streaming result
								const currentResult = partial.details?.results[0];
								if (currentResult) {
									const allResults = [...results, currentResult];
									onUpdate({
										content: partial.content,
										details: makeDetails("chain")(allResults),
									});
								}
							}
						: undefined;

					const result = await runAgentWithProfile(
						ctx.cwd,
						agents,
						profiles,
						getAvailableModelReferences,
						step.agent,
						taskWithContext,
						step.model,
						step.profile,
						step.cwd,
						i + 1,
						trace,
						limits,
						concurrency,
						activeProcesses,
						signal,
						chainUpdate,
						makeDetails("chain"),
						resolveModel,
					);
					results.push(result);

					const isError = isFailedResult(result);
					if (isError) {
						const errorMsg = getResultOutput(result);
						return {
							content: [
								{
									type: "text",
									text: `Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}${formatYieldArtifacts(result)}${formatTranscriptReference(result)}`,
								},
							],
							details: makeDetails("chain")(results),
							isError: true,
						};
					}
					previousOutput = result.output;
				}
				const finalResult = results[results.length - 1];
				return {
					content: [
						{ type: "text", text: `${finalResult.output || "(no output)"}${formatYieldArtifacts(finalResult)}` },
					],
					details: makeDetails("chain")(results),
				};
			}

			if (params.tasks && params.tasks.length > 0) {
				if (params.tasks.length > limits.maxChildrenPerCall)
					return {
						content: [
							{
								type: "text",
								text: `Too many parallel tasks (${params.tasks.length}). Max is ${limits.maxChildrenPerCall}.`,
							},
						],
						details: makeDetails("parallel")([]),
					};

				// Track all results for streaming updates
				const allResults: SingleResult[] = new Array(params.tasks.length);

				// Initialize placeholder results
				for (let i = 0; i < params.tasks.length; i++) {
					const task = params.tasks[i];
					const configuredAgent = agents.find((agent) => agent.name === task.agent);
					allResults[i] = {
						agent: task.agent,
						agentEmoji: configuredAgent?.emoji,
						agentSource: configuredAgent?.source ?? "unknown",
						task: task.task,
						exitCode: -1, // -1 = still running
						messages: [],
						output: "",
						stderr: "",
						requestedModel: task.model
							? resolveRequestedModel(task.model, configuredAgent?.model, resolveModel)
							: task.profile
								? formatProfileCandidate(profiles.profiles[task.profile].candidates[0])
								: resolveRequestedModel(undefined, configuredAgent?.model, resolveModel),
						profile: task.model ? undefined : task.profile,
						usage: createEmptyUsage(),
					};
				}

				const emitParallelUpdate = () => {
					if (onUpdate) {
						const running = allResults.filter((r) => r.exitCode === -1).length;
						const done = allResults.filter((r) => r.exitCode !== -1).length;
						onUpdate({
							content: [
								{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` },
							],
							details: makeDetails("parallel")([...allResults]),
						});
					}
				};

				const results = await mapWithConcurrencyLimit(params.tasks, limits.maxConcurrency, async (t, index) => {
					const executionTask = buildSharedTaskPrompt(t.task, sharedContext);
					const result = await runAgentWithProfile(
						ctx.cwd,
						agents,
						profiles,
						getAvailableModelReferences,
						t.agent,
						executionTask,
						t.model,
						t.profile,
						t.cwd,
						undefined,
						trace,
						limits,
						concurrency,
						activeProcesses,
						signal,
						// Per-task update callback
						(partial) => {
							if (partial.details?.results[0]) {
								allResults[index] = { ...partial.details.results[0], task: t.task };
								emitParallelUpdate();
							}
						},
						makeDetails("parallel"),
						resolveModel,
					);
					result.task = t.task;
					allResults[index] = result;
					emitParallelUpdate();
					return result;
				});

				const successCount = results.filter((r) => !isFailedResult(r)).length;
				const summaries = results.map((r) => {
					const output = truncateParallelOutput(getResultOutput(r), r.transcriptPath);
					const status = r.yieldStatus
						? r.yieldStatus
						: isFailedResult(r)
							? `failed${r.stopReason && r.stopReason !== "end" ? ` (${r.stopReason})` : ""}`
							: "completed";
					const transcript = isFailedResult(r) ? formatTranscriptReference(r) : "";
					return `### [${formatResultAgentName(r)}] ${status}\n\n${output}${formatYieldArtifacts(r)}${transcript}`;
				});
				return {
					content: [
						{
							type: "text",
							text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`,
						},
					],
					details: makeDetails("parallel")(results),
				};
			}

			if (params.agent && params.task) {
				const result = await runAgentWithProfile(
					ctx.cwd,
					agents,
					profiles,
					getAvailableModelReferences,
					params.agent,
					params.task,
					params.model,
					params.profile,
					params.cwd,
					undefined,
					trace,
					limits,
					concurrency,
					activeProcesses,
					signal,
					onUpdate,
					makeDetails("single"),
					resolveModel,
				);
				const isError = isFailedResult(result);
				if (isError) {
					const errorMsg = getResultOutput(result);
					return {
						content: [
							{
								type: "text",
								text: `Agent ${result.stopReason || "failed"}: ${errorMsg}${formatYieldArtifacts(result)}${formatTranscriptReference(result)}`,
							},
						],
						details: makeDetails("single")([result]),
						isError: true,
					};
				}
				return {
					content: [
						{ type: "text", text: `${result.output || "(no output)"}${formatYieldArtifacts(result)}` },
					],
					details: makeDetails("single")([result]),
				};
			}

			const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
			return {
				content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
				details: makeDetails("single")([]),
			};
		},

		renderCall(args, theme, context) {
			const scope: AgentScope =
				args.agentScope === "project" || args.agentScope === "both" ? args.agentScope : "user";
			const agents = getRenderAgents(context.cwd, scope, context.state as SubagentRenderState);
			const displayAgentName = (name: string) => resolveAgentDisplayName(name, agents);
			const requestedProfile = (value: { profile?: string; model?: string }) =>
				value.model ? undefined : value.profile;
			if (args.chain && args.chain.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `chain (${args.chain.length} steps)`) +
					theme.fg("muted", ` [${scope}]`);
				for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
					const step = args.chain[i];
					// Clean up {previous} placeholder for display
					const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
					const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
					text +=
						"\n  " +
						theme.fg("muted", `${i + 1}.`) +
						" " +
						theme.fg("accent", displayAgentName(step.agent)) +
						formatProfileBadge(requestedProfile(step), theme) +
						theme.fg("dim", ` ${preview}`);
				}
				if (args.chain.length > 3) text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			if (args.tasks && args.tasks.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
					theme.fg("muted", ` [${scope}]`);
				for (const t of args.tasks.slice(0, 3)) {
					const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
					text += `\n  ${theme.fg("accent", displayAgentName(t.agent))}${formatProfileBadge(requestedProfile(t), theme)}${theme.fg("dim", ` ${preview}`)}`;
				}
				if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			const agentName = args.agent || "...";
			const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
			let text =
				theme.fg("toolTitle", theme.bold("subagent ")) +
				theme.fg("accent", displayAgentName(agentName)) +
				formatProfileBadge(requestedProfile(args), theme) +
				theme.fg("muted", ` [${scope}]`);
			text += `\n  ${theme.fg("dim", preview)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as SubagentDetails | undefined;
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const mdTheme = getMarkdownTheme();

			const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
				const toShow = limit ? items.slice(-limit) : items;
				const skipped = limit && items.length > limit ? items.length - limit : 0;
				let text = "";
				if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
				for (const item of toShow) {
					if (item.type === "text") {
						const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
						text += `${theme.fg("toolOutput", preview)}\n`;
					} else {
						text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
					}
				}
				return text.trimEnd();
			};

			const appendTranscriptInfo = (container: Container, subagentResult: SingleResult): void => {
				if (subagentResult.yieldStatus) {
					container.addChild(
						new Text(theme.fg("muted", `Structured yield: ${subagentResult.yieldStatus}`), 0, 0),
					);
				}
				for (const artifact of subagentResult.yieldArtifacts ?? []) {
					container.addChild(
						new Text(theme.fg("dim", `Yield artifact: ${formatTranscriptPath(artifact)}`), 0, 0),
					);
				}
				const bounded: string[] = [];
				if (subagentResult.outputTruncated) bounded.push("output");
				if (subagentResult.traceTruncated) bounded.push("recent trace");
				if (subagentResult.stderrTruncated) bounded.push("stderr");
				if (subagentResult.errorTruncated) bounded.push("error");
				if (bounded.length > 0) {
					container.addChild(new Text(theme.fg("muted", `Bounded preview: ${bounded.join(", ")}`), 0, 0));
				}
				if (subagentResult.transcriptPath) {
					container.addChild(
						new Text(theme.fg("dim", `Full transcript: ${formatTranscriptPath(subagentResult.transcriptPath)}`), 0, 0),
					);
				}
				if (subagentResult.transcriptError) {
					container.addChild(
						new Text(theme.fg("warning", `Transcript write error: ${subagentResult.transcriptError}`), 0, 0),
					);
				}
				if (subagentResult.sessionId) {
					container.addChild(new Text(theme.fg("dim", `Resume: pi --session ${subagentResult.sessionId}`), 0, 0));
				}
				if (subagentResult.sessionFilePath) {
					container.addChild(
						new Text(theme.fg("dim", `Live view: tail -f ${formatTranscriptPath(subagentResult.sessionFilePath)}`), 0, 0),
					);
				}
				for (const attempt of subagentResult.attempts ?? []) {
					if (!attempt.transcriptPath || attempt.transcriptPath === subagentResult.transcriptPath) continue;
					const model = attempt.model ?? attempt.requestedModel ?? "unknown model";
					container.addChild(
						new Text(
							theme.fg("dim", `Attempt transcript (${model}): ${formatTranscriptPath(attempt.transcriptPath)}`),
							0,
							0,
						),
					);
				}
			};

			if (details.mode === "single" && details.results.length === 1) {
				const r = details.results[0];
				const isError = isFailedResult(r);
				const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
				const displayItems = getDisplayItems(r.messages);
				const finalOutput = r.output;

				if (expanded) {
					const container = new Container();
					let header = `${icon} ${theme.fg("toolTitle", theme.bold(formatResultAgentName(r)))}${formatProfileBadge(r.profile, theme)}${theme.fg("muted", ` (${r.agentSource})${formatTraceSuffix(r, details.trace)}`)}`;
					if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
					container.addChild(new Text(header, 0, 0));
					if (isError && r.errorMessage)
						container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
					container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
					if (displayItems.length === 0 && !finalOutput) {
						container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
					} else {
						for (const item of displayItems) {
							if (item.type === "toolCall")
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
						}
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}
					}
					const usageStr = formatUsageStats(r.usage, r.model ?? r.requestedModel);
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
					}
					appendTranscriptInfo(container, r);
					return container;
				}

				let text = `${icon} ${theme.fg("toolTitle", theme.bold(formatResultAgentName(r)))}${formatProfileBadge(r.profile, theme)}${theme.fg("muted", ` (${r.agentSource})`)}`;
				if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
				if (isError && r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
				else if (displayItems.length > 0) {
					text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
					if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				} else if (finalOutput) text += `\n${theme.fg("toolOutput", getCollapsedOutput(finalOutput))}`;
				else text += `\n${theme.fg("muted", "(no output)")}`;
				const usageStr = formatUsageStats(r.usage, r.model ?? r.requestedModel);
				if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
				return new Text(text, 0, 0);
			}

			const aggregateUsage = (results: SingleResult[]) => {
				const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
				for (const r of results) {
					total.input += r.usage.input;
					total.output += r.usage.output;
					total.cacheRead += r.usage.cacheRead;
					total.cacheWrite += r.usage.cacheWrite;
					total.cost += r.usage.cost;
					total.turns += r.usage.turns;
				}
				return total;
			};

			const appendExpandedResultOutput = (container: Container, result: SingleResult): void => {
				for (const item of getDisplayItems(result.messages)) {
					if (item.type !== "toolCall") continue;
					container.addChild(
						new Text(
							theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
							0,
							0,
						),
					);
				}

				const finalOutput = result.output;
				if (finalOutput) {
					container.addChild(new Spacer(1));
					container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
				}

				const usage = formatUsageStats(result.usage, result.model ?? result.requestedModel);
				if (usage) container.addChild(new Text(theme.fg("dim", usage), 0, 0));
				appendTranscriptInfo(container, result);
			};

			if (details.mode === "chain") {
				const successCount = details.results.filter((r) => !isFailedResult(r)).length;
				const icon = successCount === details.results.length ? theme.fg("success", "✓") : theme.fg("error", "✗");

				if (expanded) {
					const container = new Container();
					container.addChild(
						new Text(
							icon +
								" " +
								theme.fg("toolTitle", theme.bold("chain ")) +
								theme.fg("accent", `${successCount}/${details.results.length} steps`),
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = !isFailedResult(r) ? theme.fg("success", "✓") : theme.fg("error", "✗");

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(
								`${theme.fg("muted", `─── Step ${r.step}: `) + theme.fg("accent", formatResultAgentName(r))}${formatProfileBadge(r.profile, theme)} ${rIcon}${theme.fg("muted", formatTraceSuffix(r, details.trace))}`,
								0,
								0,
							),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));
						appendExpandedResultOutput(container, r);
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view
				let text =
					icon +
					" " +
					theme.fg("toolTitle", theme.bold("chain ")) +
					theme.fg("accent", `${successCount}/${details.results.length} steps`);
				for (const r of details.results) {
					const rIcon = !isFailedResult(r) ? theme.fg("success", "✓") : theme.fg("error", "✗");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", formatResultAgentName(r))}${formatProfileBadge(r.profile, theme)} ${rIcon}`;
					if (displayItems.length > 0) text += `\n${renderDisplayItems(displayItems, 5)}`;
					else if (r.output) text += `\n${theme.fg("toolOutput", getCollapsedOutput(r.output))}`;
					else text += `\n${theme.fg("muted", "(no output)")}`;
				}
				const usageStr = formatUsageStats(aggregateUsage(details.results));
				if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			if (details.mode === "parallel") {
				const running = details.results.filter((r) => r.exitCode === -1).length;
				const successCount = details.results.filter((r) => r.exitCode !== -1 && !isFailedResult(r)).length;
				const failCount = details.results.filter((r) => r.exitCode !== -1 && isFailedResult(r)).length;
				const isRunning = running > 0;
				const icon = isRunning
					? theme.fg("warning", "⏳")
					: failCount > 0
						? theme.fg("warning", "◐")
						: theme.fg("success", "✓");
				const status = isRunning
					? `${successCount + failCount}/${details.results.length} done, ${running} running`
					: `${successCount}/${details.results.length} tasks`;

				if (expanded && !isRunning) {
					const container = new Container();
					container.addChild(
						new Text(
							`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`,
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = isFailedResult(r) ? theme.fg("error", "✗") : theme.fg("success", "✓");

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(
								`${theme.fg("muted", "─── ") + theme.fg("accent", formatResultAgentName(r))}${formatProfileBadge(r.profile, theme)} ${rIcon}${theme.fg("muted", formatTraceSuffix(r, details.trace))}`,
								0,
								0,
							),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));
						appendExpandedResultOutput(container, r);
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view (or still running)
				let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
				for (const r of details.results) {
					const rIcon =
						r.exitCode === -1
							? theme.fg("warning", "⏳")
							: isFailedResult(r)
								? theme.fg("error", "✗")
								: theme.fg("success", "✓");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", formatResultAgentName(r))}${formatProfileBadge(r.profile, theme)} ${rIcon}`;
					if (displayItems.length > 0) text += `\n${renderDisplayItems(displayItems, 5)}`;
					else if (r.exitCode === -1) text += `\n${theme.fg("muted", "(running...)")}`;
					else if (r.output) text += `\n${theme.fg("toolOutput", getCollapsedOutput(r.output))}`;
					else text += `\n${theme.fg("muted", "(no output)")}`;
				}
				if (!isRunning) {
					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				}
				if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
		},
	});
}
