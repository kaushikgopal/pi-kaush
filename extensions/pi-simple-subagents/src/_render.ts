/**
 * TUI rendering for the `subagent` tool: the call header and the result views
 * for managed spawns and bounded single, chain, and parallel runs.
 */
import type { Message } from "@earendil-works/pi-ai";
import {
  type AgentToolResult,
  getMarkdownTheme,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Container,
  Markdown,
  Spacer,
  Text,
} from "@earendil-works/pi-tui";
import {
  formatResultAgentName,
  isActiveResult,
  isFailedResult,
  parsePersistedResult,
  shortenHomePath,
  type SingleResult,
} from "./_bounded-runner.ts";
import type { SubagentConcurrencyStatus } from "./_concurrency.ts";
import { type AgentScope, discoverAgents } from "./_definition.ts";
import type { DelegationTrace } from "./_delegation.ts";
import {
  type AgentIdentity,
  formatProfileDisplayName,
  resolveAgentDisplayName,
} from "./_display.ts";
import { finiteNumber, isPlainRecord, oneOf, stringValue } from "./_parse.ts";
import type { BoundedMode } from "./_subagent-command.ts";
import { truncateUtf8Head } from "./_text.ts";
import { formatUsageCompact, type UsageSummary } from "./_usage.ts";
import { SUBAGENT_YIELD_TOOL_NAME } from "./_yield.ts";

const COLLAPSED_ITEM_COUNT = 10;
const COLLAPSED_OUTPUT_PREVIEW_BYTES = 4 * 1024;

export type RenderTheme = Pick<Theme, "fg" | "bold">;

export interface SubagentDetails {
  mode: BoundedMode;
  agentScope: AgentScope;
  projectAgentsDir: string | null;
  trace: DelegationTrace;
  concurrency: SubagentConcurrencyStatus;
  results: SingleResult[];
  managedSpawn?: {
    readonly started: number;
    readonly failed: number;
    readonly manualOpen?: boolean;
  };
}

const MODES = ["single", "parallel", "chain"] as const;

/**
 * Reads session details. A `managedSpawn` field marks a managed spawn; bounded
 * runs carry `results`, which may have been persisted by an older version.
 */
export function parseSubagentDetails(
  value: unknown,
): SubagentDetails | undefined {
  if (!isPlainRecord(value)) return undefined;
  // SAFETY: details are written by this tool's execute; the fields read
  // defensively below are the ones whose shape changed across versions.
  const details = value as unknown as SubagentDetails;
  return {
    ...details,
    mode: oneOf(value.mode, MODES) ?? "single",
    results: Array.isArray(value.results)
      ? value.results.flatMap((entry) => {
          const result = parsePersistedResult(entry);
          return result ? [result] : [];
        })
      : [],
  };
}

interface AgentDisplayCache {
  cwd: string;
  scope: AgentScope;
  agents: AgentIdentity[];
}

export interface SubagentRenderState {
  agentDisplayCache?: AgentDisplayCache;
}

function getRenderAgents(
  cwd: string,
  scope: AgentScope,
  state: SubagentRenderState,
): readonly AgentIdentity[] {
  const cached = state.agentDisplayCache;
  if (cached?.cwd === cwd && cached.scope === scope) return cached.agents;

  let agents: AgentIdentity[];
  try {
    agents = discoverAgents(cwd, scope).agents.map(({ name, emoji }) => ({
      name,
      ...(emoji ? { emoji } : {}),
    }));
  } catch {
    // A metadata lookup must never break rendering; execution will surface discovery errors.
    agents = [];
  }
  state.agentDisplayCache = { cwd, scope, agents };
  return agents;
}

function formatToolCall(
  toolName: string,
  args: Readonly<Record<string, unknown>>,
  theme: RenderTheme,
): string {
  const fg = theme.fg.bind(theme);
  const pathArg = (fallback: string) =>
    shortenHomePath(
      stringValue(args.file_path) || stringValue(args.path) || fallback,
    );
  switch (toolName) {
    case "bash": {
      const command = stringValue(args.command) || "...";
      const preview =
        command.length > 60 ? `${command.slice(0, 60)}...` : command;
      return fg("muted", "$ ") + fg("toolOutput", preview);
    }
    case "read": {
      const offset = finiteNumber(args.offset);
      const limit = finiteNumber(args.limit);
      let text = fg("accent", pathArg("..."));
      if (offset !== undefined || limit !== undefined) {
        const startLine = offset ?? 1;
        const endLine = limit !== undefined ? startLine + limit - 1 : "";
        text += fg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
      }
      return fg("muted", "read ") + text;
    }
    case "write": {
      const lines = (stringValue(args.content) || "").split("\n").length;
      let text = fg("muted", "write ") + fg("accent", pathArg("..."));
      if (lines > 1) text += fg("dim", ` (${lines} lines)`);
      return text;
    }
    case "edit":
      return fg("muted", "edit ") + fg("accent", pathArg("..."));
    case "ls":
      return (
        fg("muted", "ls ") +
        fg("accent", shortenHomePath(stringValue(args.path) || "."))
      );
    case "find":
      return (
        fg("muted", "find ") +
        fg("accent", stringValue(args.pattern) || "*") +
        fg("dim", ` in ${shortenHomePath(stringValue(args.path) || ".")}`)
      );
    case "grep":
      return (
        fg("muted", "grep ") +
        fg("accent", `/${stringValue(args.pattern) || ""}/`) +
        fg("dim", ` in ${shortenHomePath(stringValue(args.path) || ".")}`)
      );
    default: {
      const argsStr = JSON.stringify(args);
      const preview =
        argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
      return fg("accent", toolName) + fg("dim", ` ${preview}`);
    }
  }
}

type DisplayItem =
  | { type: "text"; text: string }
  | { type: "toolCall"; name: string; args: Readonly<Record<string, unknown>> };

function getDisplayItems(messages: readonly Message[]): DisplayItem[] {
  const items: DisplayItem[] = [];
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    for (const part of msg.content) {
      if (part.type === "text") items.push({ type: "text", text: part.text });
      else if (
        part.type === "toolCall" &&
        part.name !== SUBAGENT_YIELD_TOOL_NAME
      )
        items.push({ type: "toolCall", name: part.name, args: part.arguments });
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

function aggregateUsage(results: readonly SingleResult[]): UsageSummary {
  const total = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    turns: 0,
  };
  for (const r of results) {
    total.input += r.usage.input;
    total.output += r.usage.output;
    total.cacheRead += r.usage.cacheRead;
    total.cacheWrite += r.usage.cacheWrite;
    total.cost += r.usage.cost;
    total.turns += r.usage.turns;
  }
  return total;
}

function resultUsage(result: SingleResult): string {
  return formatUsageCompact(
    result.usage,
    result.model ?? result.requestedModel,
  );
}

function formatProfileBadge(
  profile: string | undefined,
  theme: RenderTheme,
): string {
  const label = formatProfileDisplayName(profile);
  return label ? ` ${theme.fg("muted", label)}` : "";
}

function formatTraceSuffix(
  result: SingleResult,
  trace: DelegationTrace,
): string {
  const parts = [`depth ${trace.depth}`];
  if (result.sessionId) parts.unshift(`session ${result.sessionId}`);
  return ` · ${parts.join(" · ")}`;
}

function outcomeIcon(failed: boolean, theme: RenderTheme): string {
  return failed ? theme.fg("error", "✗") : theme.fg("success", "✓");
}

function renderDisplayItems(
  items: readonly DisplayItem[],
  limit: number,
  expanded: boolean,
  theme: RenderTheme,
): string {
  const toShow = items.slice(-limit);
  const skipped = items.length > limit ? items.length - limit : 0;
  let text = "";
  if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
  for (const item of toShow) {
    if (item.type === "text") {
      const preview = expanded
        ? item.text
        : item.text.split("\n").slice(0, 3).join("\n");
      text += `${theme.fg("toolOutput", preview)}\n`;
    } else {
      text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme)}\n`;
    }
  }
  return text.trimEnd();
}

function appendTranscriptInfo(
  container: Container,
  result: SingleResult,
  theme: RenderTheme,
): void {
  const line = (color: "muted" | "dim" | "warning", text: string) =>
    container.addChild(new Text(theme.fg(color, text), 0, 0));
  if (result.yieldStatus)
    line("muted", `Structured yield: ${result.yieldStatus}`);
  for (const artifact of result.yieldArtifacts ?? [])
    line("dim", `Yield artifact: ${shortenHomePath(artifact)}`);
  const bounded: string[] = [];
  if (result.outputTruncated) bounded.push("output");
  if (result.traceTruncated) bounded.push("recent trace");
  if (result.stderrTruncated) bounded.push("stderr");
  if (result.errorTruncated) bounded.push("error");
  if (bounded.length > 0)
    line("muted", `Bounded preview: ${bounded.join(", ")}`);
  if (result.transcriptPath)
    line("dim", `Full transcript: ${shortenHomePath(result.transcriptPath)}`);
  if (result.transcriptError)
    line("warning", `Transcript write error: ${result.transcriptError}`);
  if (result.sessionId) line("dim", `Resume: pi --session ${result.sessionId}`);
  if (result.sessionFilePath)
    line(
      "dim",
      `Live view: tail -f ${shortenHomePath(result.sessionFilePath)}`,
    );
  for (const attempt of result.attempts ?? []) {
    if (
      !attempt.transcriptPath ||
      attempt.transcriptPath === result.transcriptPath
    )
      continue;
    const model = attempt.model ?? attempt.requestedModel ?? "unknown model";
    line(
      "dim",
      `Attempt transcript (${model}): ${shortenHomePath(attempt.transcriptPath)}`,
    );
  }
}

/** A standalone single run, or one member of a chain or parallel run under `heading`. */
type BlockLayout =
  | { readonly kind: "standalone" }
  | { readonly kind: "member"; readonly heading: string };

/** The expanded view of one result. */
function renderResultBlock(
  container: Container,
  result: SingleResult,
  trace: DelegationTrace,
  layout: BlockLayout,
  theme: RenderTheme,
): void {
  const failed = isFailedResult(result);
  const items = getDisplayItems(result.messages);
  const badge = formatProfileBadge(result.profile, theme);
  const name = formatResultAgentName(result);
  const traceSuffix = formatTraceSuffix(result, trace);
  switch (layout.kind) {
    case "standalone": {
      let header = `${outcomeIcon(failed, theme)} ${theme.fg("toolTitle", theme.bold(name))}${badge}${theme.fg("muted", ` (${result.agentSource})${traceSuffix}`)}`;
      if (failed && result.stopReason)
        header += ` ${theme.fg("error", `[${result.stopReason}]`)}`;
      container.addChild(new Text(header, 0, 0));
      if (failed && result.errorMessage)
        container.addChild(
          new Text(theme.fg("error", `Error: ${result.errorMessage}`), 0, 0),
        );
      container.addChild(new Spacer(1));
      container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
      container.addChild(new Text(theme.fg("dim", result.task), 0, 0));
      container.addChild(new Spacer(1));
      container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
      if (items.length === 0 && !result.output)
        container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
      break;
    }
    case "member":
      container.addChild(new Spacer(1));
      container.addChild(
        new Text(
          `${theme.fg("muted", layout.heading) + theme.fg("accent", name)}${badge} ${outcomeIcon(failed, theme)}${theme.fg("muted", traceSuffix)}`,
          0,
          0,
        ),
      );
      container.addChild(
        new Text(
          theme.fg("muted", "Task: ") + theme.fg("dim", result.task),
          0,
          0,
        ),
      );
      break;
  }

  for (const item of items)
    if (item.type === "toolCall")
      container.addChild(
        new Text(
          theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme),
          0,
          0,
        ),
      );
  if (result.output) {
    container.addChild(new Spacer(1));
    container.addChild(
      new Markdown(result.output.trim(), 0, 0, getMarkdownTheme()),
    );
  }
  const usage = resultUsage(result);
  if (usage) {
    if (layout.kind === "standalone") container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("dim", usage), 0, 0));
  }
  appendTranscriptInfo(container, result, theme);
}

/** The collapsed view of one chain step or parallel task. */
function renderCollapsedMember(
  result: SingleResult,
  heading: string,
  icon: string,
  /** Shown in place of output while the task has not settled. */
  pendingText: string | undefined,
  expanded: boolean,
  theme: RenderTheme,
): string {
  const items = getDisplayItems(result.messages);
  let text = `\n\n${theme.fg("muted", heading)}${theme.fg("accent", formatResultAgentName(result))}${formatProfileBadge(result.profile, theme)} ${icon}`;
  if (items.length > 0)
    text += `\n${renderDisplayItems(items, 5, expanded, theme)}`;
  else if (pendingText) text += `\n${theme.fg("muted", pendingText)}`;
  else if (result.output)
    text += `\n${theme.fg("toolOutput", getCollapsedOutput(result.output))}`;
  else text += `\n${theme.fg("muted", "(no output)")}`;
  return text;
}

function renderSingle(
  result: SingleResult,
  trace: DelegationTrace,
  expanded: boolean,
  theme: RenderTheme,
): Component {
  if (expanded) {
    const container = new Container();
    renderResultBlock(container, result, trace, { kind: "standalone" }, theme);
    return container;
  }
  const failed = isFailedResult(result);
  const items = getDisplayItems(result.messages);
  let text = `${outcomeIcon(failed, theme)} ${theme.fg("toolTitle", theme.bold(formatResultAgentName(result)))}${formatProfileBadge(result.profile, theme)}${theme.fg("muted", ` (${result.agentSource})`)}`;
  if (failed && result.stopReason)
    text += ` ${theme.fg("error", `[${result.stopReason}]`)}`;
  if (failed && result.errorMessage)
    text += `\n${theme.fg("error", `Error: ${result.errorMessage}`)}`;
  else if (items.length > 0) {
    text += `\n${renderDisplayItems(items, COLLAPSED_ITEM_COUNT, expanded, theme)}`;
    if (items.length > COLLAPSED_ITEM_COUNT)
      text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
  } else if (result.output)
    text += `\n${theme.fg("toolOutput", getCollapsedOutput(result.output))}`;
  else text += `\n${theme.fg("muted", "(no output)")}`;
  const usage = resultUsage(result);
  if (usage) text += `\n${theme.fg("dim", usage)}`;
  return new Text(text, 0, 0);
}

function totalUsageLine(results: readonly SingleResult[]): string {
  return formatUsageCompact(aggregateUsage(results));
}

function appendTotalUsage(
  container: Container,
  results: readonly SingleResult[],
  theme: RenderTheme,
): void {
  const usage = totalUsageLine(results);
  if (!usage) return;
  container.addChild(new Spacer(1));
  container.addChild(new Text(theme.fg("dim", `Total: ${usage}`), 0, 0));
}

function renderChain(
  details: SubagentDetails,
  expanded: boolean,
  theme: RenderTheme,
): Component {
  const { results } = details;
  const successCount = results.filter((r) => !isFailedResult(r)).length;
  const header = `${outcomeIcon(successCount !== results.length, theme)} ${theme.fg("toolTitle", theme.bold("chain "))}${theme.fg("accent", `${successCount}/${results.length} steps`)}`;
  const heading = (r: SingleResult) => `─── Step ${r.step}: `;

  if (expanded) {
    const container = new Container();
    container.addChild(new Text(header, 0, 0));
    for (const r of results)
      renderResultBlock(
        container,
        r,
        details.trace,
        { kind: "member", heading: heading(r) },
        theme,
      );
    appendTotalUsage(container, results, theme);
    return container;
  }

  let text = header;
  for (const r of results)
    text += renderCollapsedMember(
      r,
      heading(r),
      outcomeIcon(isFailedResult(r), theme),
      undefined,
      expanded,
      theme,
    );
  const usage = totalUsageLine(results);
  if (usage) text += `\n\n${theme.fg("dim", `Total: ${usage}`)}`;
  text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
  return new Text(text, 0, 0);
}

function renderParallel(
  details: SubagentDetails,
  expanded: boolean,
  theme: RenderTheme,
): Component {
  const { results } = details;
  const running = results.filter(isActiveResult).length;
  const settled = results.filter((r) => !isActiveResult(r));
  const successCount = settled.filter((r) => !isFailedResult(r)).length;
  const failCount = settled.length - successCount;
  const isRunning = running > 0;
  const icon = isRunning
    ? theme.fg("warning", "⏳")
    : failCount > 0
      ? theme.fg("warning", "◐")
      : theme.fg("success", "✓");
  const status = isRunning
    ? `${settled.length}/${results.length} done, ${running} running`
    : `${successCount}/${results.length} tasks`;
  const header = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;

  if (expanded && !isRunning) {
    const container = new Container();
    container.addChild(new Text(header, 0, 0));
    for (const r of results)
      renderResultBlock(
        container,
        r,
        details.trace,
        { kind: "member", heading: "─── " },
        theme,
      );
    appendTotalUsage(container, results, theme);
    return container;
  }

  let text = header;
  for (const r of results) {
    const active = isActiveResult(r);
    text += renderCollapsedMember(
      r,
      "─── ",
      active
        ? theme.fg("warning", "⏳")
        : outcomeIcon(isFailedResult(r), theme),
      active ? "(running...)" : undefined,
      expanded,
      theme,
    );
  }
  if (!isRunning) {
    const usage = totalUsageLine(results);
    if (usage) text += `\n\n${theme.fg("dim", `Total: ${usage}`)}`;
  }
  if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
  return new Text(text, 0, 0);
}

function contentText(result: AgentToolResult<unknown>): string {
  const text = result.content[0];
  return text?.type === "text" ? text.text : "(no output)";
}

export function renderSubagentResult(
  result: AgentToolResult<unknown>,
  options: { readonly expanded: boolean },
  theme: RenderTheme,
): Component {
  const { expanded } = options;
  const details = parseSubagentDetails(result.details);
  if (details?.managedSpawn && !expanded) {
    const { started, failed, manualOpen } = details.managedSpawn;
    const summary = `${started} background worker${started === 1 ? "" : "s"} started${failed ? ` · ${failed} launch${failed === 1 ? "" : "es"} failed` : ""}${manualOpen ? " · manual open only" : ""}`;
    return new Text(
      theme.fg(failed || manualOpen ? "warning" : "muted", summary),
      0,
      0,
    );
  }
  if (!details || details.results.length === 0)
    return new Text(contentText(result), 0, 0);

  const [only] = details.results;
  if (details.mode === "single" && details.results.length === 1 && only)
    return renderSingle(only, details.trace, expanded, theme);
  if (details.mode === "chain") return renderChain(details, expanded, theme);
  if (details.mode === "parallel")
    return renderParallel(details, expanded, theme);
  return new Text(contentText(result), 0, 0);
}

interface CallItem {
  readonly agent: string;
  readonly task: string;
  readonly profile?: string;
  readonly model?: string;
}

/** The parts of the tool arguments the call header shows. */
export interface SubagentCallArgs {
  readonly agentScope?: string;
  readonly chain?: readonly CallItem[];
  readonly tasks?: readonly CallItem[];
  readonly agent?: string;
  readonly task?: string;
  readonly profile?: string;
  readonly model?: string;
}

export function renderSubagentCall(
  args: SubagentCallArgs,
  theme: RenderTheme,
  context: { readonly cwd: string; readonly state: SubagentRenderState },
): Text {
  const scope: AgentScope =
    args.agentScope === "project" || args.agentScope === "both"
      ? args.agentScope
      : "user";
  const agents = getRenderAgents(context.cwd, scope, context.state);
  const displayAgentName = (name: string) =>
    resolveAgentDisplayName(name, agents);
  // An explicit model overrides any profile, so the badge would mislead.
  const badge = (value: { profile?: string; model?: string }) =>
    formatProfileBadge(value.model ? undefined : value.profile, theme);
  const title = theme.fg("toolTitle", theme.bold("subagent "));
  const scopeLabel = theme.fg("muted", ` [${scope}]`);
  const more = (count: number) =>
    count > 3 ? `\n  ${theme.fg("muted", `... +${count - 3} more`)}` : "";

  if (args.chain && args.chain.length > 0) {
    let text =
      title +
      theme.fg("accent", `chain (${args.chain.length} steps)`) +
      scopeLabel;
    for (const [index, step] of args.chain.slice(0, 3).entries()) {
      // Clean up {previous} placeholder for display
      const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
      const preview =
        cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
      text +=
        "\n  " +
        theme.fg("muted", `${index + 1}.`) +
        " " +
        theme.fg("accent", displayAgentName(step.agent)) +
        badge(step) +
        theme.fg("dim", ` ${preview}`);
    }
    return new Text(text + more(args.chain.length), 0, 0);
  }
  if (args.tasks && args.tasks.length > 0) {
    let text =
      title +
      theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
      scopeLabel;
    for (const t of args.tasks.slice(0, 3)) {
      const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
      text += `\n  ${theme.fg("accent", displayAgentName(t.agent))}${badge(t)}${theme.fg("dim", ` ${preview}`)}`;
    }
    return new Text(text + more(args.tasks.length), 0, 0);
  }
  const agentName = args.agent || "...";
  const preview = args.task
    ? args.task.length > 60
      ? `${args.task.slice(0, 60)}...`
      : args.task
    : "...";
  const text =
    title +
    theme.fg("accent", displayAgentName(agentName)) +
    badge(args) +
    scopeLabel +
    `\n  ${theme.fg("dim", preview)}`;
  return new Text(text, 0, 0);
}
