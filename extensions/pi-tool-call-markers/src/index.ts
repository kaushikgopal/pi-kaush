import { homedir } from "node:os";
import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  AssistantMessageComponent,
  ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  sliceByColumn,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
  installBashBlockPatch,
  uninstallBashBlockPatch,
} from "./bash-block.ts";
import { runChatContainerHooks } from "./container-hooks.ts";
import {
  installInfoVisibility,
  uninstallInfoVisibility,
} from "./info-visibility.ts";
import {
  COLLAPSED_RAIL,
  fgCollapsed,
  paletteSample,
  withFaintCollapsedRail,
} from "./muted.ts";
import { isQuestionToolCall, renderQuestionBlock } from "./question-block.ts";
import { sanitizeInline } from "./sanitize.ts";

const OUTER_INSET = 2;
// Glyphless rows leave room for the glyph and its trailing space.
const SUBAGENT_LABEL_GAP = "  ";
// Collapsed rows anchor with a glyph instead of repeating the tool name;
// tools that read as one family share a glyph, and unmapped tools fall back
// to `*`. A single space separates the glyph from the call content: the
// anchor is punctuation enough without a joining colon.
const TOOL_CALL_GLYPHS: ReadonlyMap<string, string> = new Map([
  ["write", "+"],
  ["edit", "±"],
  ["grep", "○"],
  ["ffgrep", "○"],
  ["find", "○"],
  ["fffind", "○"],
  ["ls", "≡"],
  ["web_search", "↗"],
  ["fetch_content", "↗"],
  ["get_search_content", "↗"],
  ["codemode", "¢"],
]);
// Keep the historical slot so old, still-reachable delegates can be handed off.
const PRESENTATION_GENERATION = 4;
const PRESENTATION_PATCHED = Symbol.for("kg.pi.toolPresentation.v3");
const LEGACY_PRESENTATION_PATCHED = Symbol.for("kg.pi.toolPresentation.v2");
const GROUPING_PATCHED = Symbol.for("kg.pi.toolGrouping.v1");
const ANSI_RE = /\u001b\[[0-9;]*m/g;
const COLLAPSE_PARALLEL_ENV = "PI_TOOL_CALL_MARKERS_COLLAPSE_PARALLEL";
const EXPANDED_TOOLS_ENV = "PI_ALWAYS_EXPANDED_TOOL_CALL_MARKERS";

type ThemeLike = {
  bold(text: string): string;
  fg(color: string, text: string): string;
  getFgAnsi?(color: string): string;
  getColorMode?(): "truecolor" | "256color" | string;
};

type ComponentLike = {
  render(width: number): string[];
  invalidate(): void;
};

type ComponentContainer = ComponentLike & {
  children?: unknown[];
};

type ToolExecutionRow = {
  toolName?: string;
  args?: unknown;
  expanded?: boolean;
  isPartial?: boolean;
  result?: {
    isError?: boolean;
    content?: Array<{ type?: unknown; text?: unknown }>;
    details?: Record<string, unknown>;
  };
  rendererState?: {
    startedAt?: unknown;
    endedAt?: unknown;
    compactTitle?: unknown;
  };
  contentBox?: ComponentContainer;
  callRendererComponent?: ComponentLike;
  imageComponents?: unknown[];
  imageSpacers?: unknown[];
  getRenderShell?(): "default" | "self";
  getTextOutput?(): string;
  setExpanded?(expanded: boolean): void;
  handleMouse?(event: unknown): unknown;
};

type PresentationPatchState = {
  generation?: number;
  owners: number;
  // Set at the final owner's shutdown. A wrapper that another extension has
  // buried cannot be uninstalled, so it delegates instead of outliving its
  // owner; a later compatible install re-enables it.
  disabled?: boolean;
  theme?: ThemeLike;
  cwd: string;
  promptPaths: ReadonlySet<string>;
  collapseParallel: boolean;
  expandedTools: ReadonlySet<string>;
  groupCache: WeakMap<ToolExecutionRow, GroupRenderCache>;
  collapsedCache: WeakMap<ToolExecutionRow, CollapsedRenderCache>;
  rowVersions: WeakMap<ToolExecutionRow, number>;
  originalRender: (width: number) => string[];
  originalUpdateDisplay: () => void;
  originalHandleMouse?: (this: ToolExecutionRow, event: unknown) => unknown;
  patchedRender?: (width: number) => string[];
  patchedUpdateDisplay?: () => void;
  patchedHandleMouse?: (this: ToolExecutionRow, event: unknown) => unknown;
};

type GroupingPatchState = {
  owners: number;
  presentation: PresentationPatchState;
  originalRender: (width: number) => string[];
  patchedRender?: (width: number) => string[];
  disabled?: boolean;
};

type GroupMemberSnapshot = {
  readonly row: ToolExecutionRow;
  readonly version: number;
};

type GroupRenderCache = {
  lines: string[];
  // The first member absorbs the leading blank; each member owns its line.
  heights: Array<{ component: ToolExecutionRow; height: number }>;
  memberSnapshots: readonly GroupMemberSnapshot[];
  themeSample: string;
  width: number;
};

type CollapsedRenderCache = {
  lines: string[];
  signature: string;
  version: number;
  themeSample: string;
  width: number;
};

function envEnabled(name: string, defaultValue: boolean): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return defaultValue;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return defaultValue;
}

// Comma-separated tool names, e.g. `edit,write`. Blank entries and padding
// are ignored; an unset or empty variable yields no names.
function envToolNames(name: string): ReadonlySet<string> {
  const value = process.env[name]?.trim();
  if (!value) return new Set();
  return new Set(
    value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
}

function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

function hasVisibleContent(line: string): boolean {
  return stripAnsi(line).trim().length > 0;
}

// Shape fingerprint used in settled-row cache keys. It protects against
// direct state mutation followed by render without updateDisplay; real
// component display updates invalidate the cache through rowVersions.
function rowSignatureOf(row: ToolExecutionRow): string {
  return `${row.isPartial}|${row.expanded}|${row.result ? 1 : 0}|${row.result?.isError ? 1 : 0}`;
}

type InsetLayout = {
  contentWidth: number;
  left: number;
};

function insetLayout(width: number): InsetLayout {
  const max = Math.max(1, width);
  // Keep enough room for "% x → …" before spending columns on decoration.
  // Normal terminal widths receive the full two-column inset on both sides.
  const decoration = Math.min(OUTER_INSET * 2, Math.max(0, max - 8));
  const left = Math.min(OUTER_INSET, Math.ceil(decoration / 2));
  const right = decoration - left;
  return { contentWidth: Math.max(1, max - left - right), left };
}

function insetLines(lines: string[], width: number): string[] {
  const layout = insetLayout(width);
  const prefix = " ".repeat(layout.left);
  return lines.map(
    (line) => prefix + truncateToWidth(line, layout.contentWidth, "", false),
  );
}

// The MCP adapter reports outcomes in details.error but only promotes
// tool_error/call_failed to result.isError (see its toolErrorOverride);
// remaining codes are informational guidance (ambiguous, no_instructions,
// auth flows, ...). Keep the failure code list here so every presentation
// decision — singletons and groups — shares one classification.
const MCP_FAILURE_ERROR_CODES: ReadonlySet<string> = new Set([
  "tool_error",
  "call_failed",
  "tool_not_found",
  "tool_not_found_after_reconnect",
  "connect_failed",
  "not_found",
  "server_not_found",
  "server_disabled",
  "server_backoff",
  "server_not_connected",
  "init_failed",
  "init_timeout",
  "not_initialized",
  "server_unavailable",
  "not_connected",
  "timeout",
  "script_error",
  // Terminal rejections: the operation never executed (validation failures,
  // auth-flow failures, missing inputs), unlike continuing-guidance codes.
  "missing_server",
  "missing_input",
  "oauth_not_supported",
  "auth_start_failed",
  "not_authenticated",
  "auth_complete_failed",
  "query_too_long",
  "unsafe_pattern",
  "invalid_pattern",
  "empty_query",
]);

function rowHasFailed(row: ToolExecutionRow): boolean {
  if (row.result?.isError) return true;
  const code = row.result?.details?.error;
  return typeof code === "string" && MCP_FAILURE_ERROR_CODES.has(code);
}

function renderedErrorOutcome(row: ToolExecutionRow, theme: ThemeLike): string {
  const firstLine =
    resultText(row)
      .split(/\r\n|[\r\n]/)
      .map((line) => sanitizeInline(line).trim())
      .find((line) => line.length > 0) ?? "error";
  return `${theme.fg("error", "→")} ${theme.fg("error", firstLine)}`;
}

// Trim a failure tail to its quota of the budget, counting the appended
// ellipsis inside the cap, so the call label keeps the leftover columns
// plus the joining space instead of being truncated to nothing. A cap too
// small for the ellipsis keeps that many literal tail characters instead;
// a zero-column cap lets the tail disappear rather than spill an ellipsis
// outside its quota.
function capFailureTail(tail: string, cap: number, theme: ThemeLike): string {
  const tailWidth = visibleWidth(tail);
  if (tailWidth <= cap) return tail;
  const ellipsis = theme.fg("error", "…");
  const ellipsisWidth = visibleWidth(ellipsis);
  if (cap <= 0) return "";
  if (ellipsisWidth >= cap) return sliceByColumn(tail, 0, cap, true);
  return `${sliceByColumn(tail, 0, cap - ellipsisWidth, true)}${ellipsis}`;
}

function renderedGenericOutcome(theme: ThemeLike): string {
  return fgCollapsed(theme, "toolOutput", "→ done");
}

// The MCP adapter stashes its call's first line in renderer state before
// collapsing to an empty component, so prefer it over re-rendering the call.
function selfRenderedCallTitle(row: ToolExecutionRow): string | undefined {
  const title = row.rendererState?.compactTitle;
  return typeof title === "string" && title.trim().length > 0
    ? title.trim()
    : undefined;
}

// The MCP proxy passes tool arguments as a JSON-encoded string; parse and
// re-stringify so the summary shows compact JSON instead of escaped quotes.
function squashJsonish(value: unknown): string {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        const compact = JSON.stringify(JSON.parse(trimmed));
        return compact === "{}" ? "" : compact;
      } catch {
        return flattenNewlines(trimmed);
      }
    }
    return flattenNewlines(value);
  }
  return compactArgs(value);
}

// String fallbacks still feed the one-line "tool {args}" summary label;
// normalize embedded line breaks so a multiline argument cannot split it.
function flattenNewlines(text: string): string {
  return text.replace(/[\r\n]+/g, " ");
}

// Actions the mcp proxy dispatches before any mode selector (pi-mcp-adapter
// 2.26.0). Unknown action values fall through to other modes, so their shapes
// are shown raw instead of as a guessed operation.
const MCP_ACTIONS: ReadonlySet<string> = new Set([
  "ui-messages",
  "auth-start",
  "auth-complete",
]);
const MCP_MODE_KEYS = [
  "tool",
  "connect",
  "describe",
  "instructions",
  "action",
] as const;

// Only one valid selector can name an operation. Unknown or conflicting
// shapes stay raw because the adapter's dispatch order is internal.
function mcpProxySelectors(
  record: Record<string, unknown>,
): string[] | undefined {
  const selectors: string[] = [];
  // An empty search still runs a search; every other selector must be a
  // non-empty string to name an operation at all.
  if (record.search !== undefined) selectors.push("search");
  for (const key of MCP_MODE_KEYS) {
    const value = record[key];
    if (value === undefined) continue;
    // An empty selector cannot dispatch, and which fallback ran is adapter
    // internals, so the raw args are kept instead.
    if (typeof value !== "string" || value.length === 0) return undefined;
    selectors.push(key);
  }
  return selectors;
}

// Append compact arguments left after the selector to an MCP label.
function appendMcpRemainder(
  label: string,
  rest: Record<string, unknown>,
): string {
  const remainder = squashJsonish(rest);
  return remainder ? `${label} ${remainder}` : label;
}

// A concise one-line label for the adapter's "mcp" proxy from the call's
// shape alone. Ambiguous shapes keep their complete compact args.
function mcpProxyCallLabel(
  record: Record<string, unknown>,
): string | undefined {
  const selectors = mcpProxySelectors(record);
  if (!selectors) return undefined;

  const server =
    typeof record.server === "string" && record.server.length > 0
      ? record.server
      : undefined;
  const rest: Record<string, unknown> = { ...record };
  if (server !== undefined) delete rest.server;
  const serverSuffix = server === undefined ? "" : ` @ ${server}`;

  if (selectors.length === 0) {
    // No mode selector: the adapter lists a named server or reports status.
    const label = server === undefined ? "mcp status" : `mcp list ${server}`;
    return appendMcpRemainder(label, rest);
  }
  if (selectors.length !== 1) return undefined;

  const key = selectors[0]!;
  delete rest[key];

  if (key === "tool") {
    delete rest.args;
    const inner = squashJsonish(record.args);
    const target = `${String(record.tool)}${serverSuffix}`;
    return inner ? `${target} ${inner}` : target;
  }
  if (key === "search") {
    const label =
      `mcp search ${String(record.search)}`.trimEnd() + serverSuffix;
    return appendMcpRemainder(label, rest);
  }
  if (key === "action") {
    const name = String(record.action);
    if (!MCP_ACTIONS.has(name)) return undefined;
    let label = `mcp ${name}${serverSuffix}`;
    if (name === "auth-complete") {
      delete rest.args;
      const input = squashJsonish(record.args);
      if (input) label += ` ${input}`;
    }
    return appendMcpRemainder(label, rest);
  }
  // connect / describe / instructions: the adapter dispatches these modes
  // without params.server, so a server argument is shown raw rather than as
  // a scope suffix that implies an operation that never ran.
  const label = `mcp ${key} ${String(record[key])}`;
  return appendMcpRemainder(
    label,
    server === undefined ? rest : { ...rest, server },
  );
}

// Builds a one-line "tool {args}" label from the call arguments. The
// adapter's own title drops the arguments and its pretty-printed JSON spans
// many lines, so squash the JSON ourselves to keep the row at one line.
function selfRenderedCallLabel(row: ToolExecutionRow): string {
  const token = row.toolName ?? "tool";
  const args = row.args;
  // Only the adapter's "mcp" proxy tool uses these action shapes, so the
  // label is derived from the args' shape alone; the adapter's own
  // compactTitle drops parameters (limit/offset) and is not trusted here.
  if (
    token === "mcp" &&
    args &&
    typeof args === "object" &&
    !Array.isArray(args)
  ) {
    const record = args as Record<string, unknown>;
    const proxyLabel = mcpProxyCallLabel(record);
    // Unambiguous shapes get a concise name; anything else keeps the complete
    // compact args so the row never claims an operation that may not have run.
    if (proxyLabel) return proxyLabel;
    const json = squashJsonish(args);
    return json ? `mcp ${json}` : "mcp status";
  }
  // Pi's edit tool renders its own shell and carries { path, edits } args;
  // mirror Pi's native `edit <path>` call line instead of dumping the payload.
  if (
    token === "edit" &&
    args &&
    typeof args === "object" &&
    !Array.isArray(args)
  ) {
    const path = (args as Record<string, unknown>).path;
    if (typeof path === "string" && path.length > 0) return `${token} ${path}`;
  }
  const title = selfRenderedCallTitle(row);
  const json = squashJsonish(args);
  // Direct tools put only the bare name in their own title, so append the
  // args ourselves.
  if (title && title !== token) return title;
  if (json) return `${token} ${json}`;
  return title ?? token;
}

function isToolExecutionRow(
  component: unknown,
): component is ToolExecutionRow & ComponentLike {
  return component instanceof ToolExecutionComponent;
}

function isAssistantMessageRow(component: unknown): boolean {
  return component instanceof AssistantMessageComponent;
}

function hasImageResult(row: ToolExecutionRow): boolean {
  return (
    row.result?.content?.some((content) => content.type === "image") === true ||
    (row.imageComponents?.length ?? 0) > 0 ||
    (row.imageSpacers?.length ?? 0) > 0
  );
}

function formatDuration(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function bashDurationText(row: ToolExecutionRow): string | undefined {
  const startedAt = row.rendererState?.startedAt;
  const endedAt = row.rendererState?.endedAt;
  if (
    typeof startedAt !== "number" ||
    typeof endedAt !== "number" ||
    !Number.isFinite(startedAt) ||
    !Number.isFinite(endedAt)
  )
    return undefined;
  return formatDuration(Math.max(0, endedAt - startedAt));
}

function liveElapsedText(row: ToolExecutionRow): string | undefined {
  if (row.toolName !== "bash") return undefined;
  const startedAt = row.rendererState?.startedAt;
  if (typeof startedAt !== "number" || !Number.isFinite(startedAt))
    return undefined;
  return formatDuration(Math.max(0, Date.now() - startedAt));
}

function isPendingRow(row: ToolExecutionRow): boolean {
  return row.isPartial !== false || !row.result;
}

function isLiveRow(row: ToolExecutionRow): boolean {
  return row.expanded === false && isPendingRow(row) && !hasImageResult(row);
}

// Settled failures join groups like settled successes; the row's error
// color carries the failure, so the group stays visually unbroken.
function isCollapsibleRow(row: ToolExecutionRow): boolean {
  return (
    row.expanded === false &&
    row.isPartial === false &&
    !!row.result &&
    !hasImageResult(row)
  );
}

function isCollapsibleSuccess(row: ToolExecutionRow): boolean {
  return isCollapsibleRow(row) && !rowHasFailed(row);
}

function hasToolSiblingInAssistantBatch(
  children: unknown[],
  index: number,
  renderAt: (index: number) => string[],
): boolean {
  for (const direction of [-1, 1] as const) {
    for (
      let candidateIndex = index + direction;
      candidateIndex >= 0 && candidateIndex < children.length;
      candidateIndex += direction
    ) {
      const candidate = children[candidateIndex];
      if (isAssistantMessageRow(candidate)) break;
      if (isToolExecutionRow(candidate)) return true;
      if (renderAt(candidateIndex).some(hasVisibleContent)) break;
    }
  }
  return false;
}

// A self-rendered tool opts out of the transcript by drawing no lines. The
// singleton and grouped paths must agree on that, or grouping resurrects a
// row the tool deliberately hid.
function drawsNoRowLines(
  row: ToolExecutionRow,
  nativeLines: string[],
): boolean {
  return nativeLines.length === 0 && (row.imageComponents?.length ?? 0) === 0;
}

function isGroupableToolRow(
  row: ToolExecutionRow,
  children: unknown[],
  index: number,
  renderAt: (index: number) => string[],
  state: PresentationPatchState,
): boolean {
  if (row.toolName === "subagent") return false;
  if (isQuestionToolCall(row)) return false;
  if (drawsNoRowLines(row, renderAt(index))) return false;
  if (!isLiveRow(row) && !isCollapsibleRow(row)) return false;
  return (
    state.collapseParallel ||
    !hasToolSiblingInAssistantBatch(children, index, renderAt)
  );
}

function renderComponent(component: unknown, width: number): string[] {
  if (!component || typeof (component as ComponentLike).render !== "function")
    return [];
  return (component as ComponentLike).render(width);
}

function compactArgs(args: unknown): string {
  if (args === undefined || args === null) return "";
  try {
    const text = JSON.stringify(args);
    return text === "{}" ? "" : text;
  } catch {
    return String(args);
  }
}

function resultText(row: ToolExecutionRow): string {
  const contentText = row.result?.content?.find(
    (content) => content.type === "text" && typeof content.text === "string",
  )?.text;
  if (typeof contentText === "string") return contentText;
  return row.getTextOutput?.() ?? "";
}

function textLineCount(text: string): number {
  if (!text) return 0;
  const lines = text.split("\n");
  return text.endsWith("\n") ? lines.length - 1 : lines.length;
}

function resultCount(row: ToolExecutionRow, text: string): number {
  const totalMatched = row.result?.details?.totalMatched;
  if (typeof totalMatched === "number" && Number.isFinite(totalMatched))
    return Math.max(0, totalMatched);

  const trimmed = text.trim();
  if (
    !trimmed ||
    /^(?:No matches found|No files found|\(empty directory\))/i.test(trimmed)
  )
    return 0;

  if (row.toolName === "grep" || row.toolName === "ffgrep") {
    const lines = trimmed.split("\n");
    const matches = lines.filter(
      (line) => /^.+:\d+:/.test(line) || /^\s+\d+:/.test(line),
    ).length;
    if (matches > 0) return matches;
  }

  return trimmed
    .split("\n")
    .filter((line) => line.trim() && !/^\s*\[.*\]\s*$/.test(line)).length;
}

function readLineCount(row: ToolExecutionRow, text: string): number {
  const outputLines = (
    row.result?.details?.truncation as { outputLines?: unknown } | undefined
  )?.outputLines;
  if (typeof outputLines === "number" && Number.isFinite(outputLines))
    return Math.max(0, outputLines);

  const content = text.replace(
    /\n\n\[[^\n]*(?:more lines|showing lines)[^\n]*\]\s*$/i,
    "",
  );
  return textLineCount(content);
}

function diffCounts(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added++;
    if (line.startsWith("-") && !line.startsWith("---")) removed++;
  }
  return { added, removed };
}

// Pi's edit tool (renderShell "self") stores its display diff in
// result.details.diff; collapsed rows show only its +a/-b stat, while the
// full hunk returns with Ctrl+O.
function editDiffText(row: ToolExecutionRow): string | undefined {
  if (row.toolName !== "edit") return undefined;
  if (!row.result || row.isPartial !== false || rowHasFailed(row))
    return undefined;
  const diff = row.result.details?.diff;
  return typeof diff === "string" && diff.length > 0 ? diff : undefined;
}

function renderedEditDiffStat(row: ToolExecutionRow): string | undefined {
  const diff = editDiffText(row);
  if (diff === undefined) return undefined;
  const { added, removed } = diffCounts(diff);
  return added + removed === 0 ? "applied" : `+${added}/-${removed}`;
}

function outcomeSummary(row: ToolExecutionRow): string | undefined {
  // Self-rendered tools own their result framing; the built-in heuristics
  // (line counts, diff stats) describe default-shell rows only, so their
  // settled rows always fall back to the generic outcome.
  if (row.getRenderShell?.() === "self") return undefined;
  if (!isCollapsibleSuccess(row)) return undefined;

  const text = resultText(row);
  switch (row.toolName) {
    case "bash": {
      const duration = bashDurationText(row);
      return duration ? `done · ${duration}` : "done";
    }
    case "read": {
      const lines = readLineCount(row, text);
      return `${lines} ${lines === 1 ? "line" : "lines"}`;
    }
    case "write": {
      const content = (row.args as { content?: unknown } | undefined)?.content;
      if (typeof content !== "string") return "written";
      const lines = textLineCount(content);
      return `${lines} ${lines === 1 ? "line" : "lines"}`;
    }
    case "edit": {
      const diff = row.result?.details?.diff;
      if (typeof diff !== "string") return "applied";
      const { added, removed } = diffCounts(diff);
      return `+${added}/-${removed}`;
    }
    case "grep":
    case "ffgrep":
    case "find":
    case "fffind":
    case "ls": {
      const results = resultCount(row, text);
      return `${results} ${results === 1 ? "result" : "results"}`;
    }
    default:
      return undefined;
  }
}

function renderedOutcome(
  row: ToolExecutionRow,
  theme: ThemeLike,
): string | undefined {
  const summary = outcomeSummary(row);
  if (!summary) return undefined;
  return fgCollapsed(theme, "toolOutput", `→ ${summary}`);
}

// A budget too small for the suffix keeps literal styled text instead, so a
// one-column label never collapses into a bare ellipsis or loses its status.
function truncateStyled(text: string, width: number, suffix = "…"): string {
  const max = Math.max(0, width);
  if (visibleWidth(text) <= max) return text;

  const suffixWidth = visibleWidth(suffix);
  if (suffixWidth >= max) return sliceByColumn(text, 0, max, true);
  return truncateToWidth(text, max, suffix, false);
}

function fitSummary(summary: string, width: number, suffix = "…"): string {
  const max = Math.max(1, width);
  return visibleWidth(summary) <= max
    ? summary
    : truncateStyled(summary, max, suffix);
}

// Fits "head tail" into width while always reserving at least one literal
// head column plus the joining space; the tail takes what is left and
// disappears entirely when no columns remain.
function fitSummaryTail(
  head: string,
  tail: string,
  width: number,
  suffix = "…",
): string {
  const max = Math.max(1, width);
  const headWidth = visibleWidth(head);
  const tailWidth = visibleWidth(tail);
  if (headWidth + 1 + tailWidth <= max) return `${head.trimEnd()} ${tail}`;
  if (tailWidth === 0) return truncateStyled(head, max, suffix);
  if (headWidth === 0) return truncateStyled(tail, max, suffix);

  const labelBudget = Math.min(headWidth, Math.max(1, max - tailWidth - 1));
  const tailBudget = Math.min(tailWidth, Math.max(0, max - labelBudget - 1));
  if (tailBudget === 0) return truncateStyled(head, max, suffix);
  const fittedTail =
    tailWidth <= tailBudget ? tail : truncateStyled(tail, tailBudget, suffix);
  return `${truncateStyled(head, labelBudget, suffix)} ${fittedTail}`;
}

function removeTrailingExpandHint(text: string): string {
  const plain = stripAnsi(text).trimEnd();
  const hint = plain.match(/\s+\([^)]*to expand\)$/i);
  if (hint?.index === undefined) return text.trimEnd();
  return sliceByColumn(
    text,
    0,
    visibleWidth(plain.slice(0, hint.index)),
  ).trimEnd();
}

function trimRenderedLine(text: string): string {
  const plain = sanitizeInline(stripAnsi(text));
  const leading = plain.match(/^\s*/)?.[0] ?? "";
  const trimmed = plain.trim();
  if (!trimmed) return "";
  return sliceByColumn(
    plain,
    visibleWidth(leading),
    visibleWidth(trimmed),
  ).trimEnd();
}

function renderedCallSummary(
  row: ToolExecutionRow,
  width: number,
  theme: ThemeLike,
): string {
  const fallback = () => {
    const args = compactArgs(row.args);
    return args
      ? fgCollapsed(theme, "toolOutput", args)
      : fgCollapsed(theme, "muted", "(no arguments)");
  };
  let component = row.callRendererComponent;
  if (!component && Array.isArray(row.contentBox?.children)) {
    component = row.contentBox.children[0] as ComponentLike | undefined;
  }
  if (!component || typeof component.render !== "function") return fallback();

  const visibleLines = component
    .render(Math.max(1, width))
    .filter(hasVisibleContent);
  const rendered = visibleLines.slice(0, 3);
  const line = rendered[0];
  if (!line) return fallback();

  const first = trimRenderedLine(line);
  const plain = stripAnsi(first);
  const match = /^(\s*)(\S+)(\s*)/.exec(plain);
  if (!match) return fallback();

  const expectedToken = row.toolName === "bash" ? "$" : row.toolName;
  const hasKnownHeading =
    match[2] === expectedToken ||
    (row.toolName === "read" &&
      (match[2] === "read" || match[2] === "[skill]"));
  const summaryStart = hasKnownHeading
    ? visibleWidth((match[1] ?? "") + (match[2] ?? "") + (match[3] ?? ""))
    : 0;
  const firstSummary = removeTrailingExpandHint(
    sliceByColumn(
      first,
      summaryStart,
      Math.max(0, visibleWidth(first) - summaryStart),
    ),
  );
  const continuations = rendered
    .slice(1)
    .map(trimRenderedLine)
    .filter(hasVisibleContent);
  if (visibleLines.length > rendered.length)
    continuations.push(fgCollapsed(theme, "muted", "…"));
  const compact = [firstSummary, ...continuations]
    .filter(hasVisibleContent)
    .join(fgCollapsed(theme, "muted", " · "));
  return hasVisibleContent(compact) ? compact : fallback();
}

// Codemode carries its tunables in the script's first line —
// `// @options: {"max_output_tokens": 2500, "timeout_ms": 120000}` — so a
// collapsed row shows those params instead of a script preview. The
// prefix and first-line handling mirror pi-codemode's parseCodemodeSource;
// anything absent or unparsable returns undefined so the row keeps the
// ordinary summary paths.
const CODEMODE_OPTIONS_PREFIX = "// @options:";

function codemodeOptionsLabel(row: ToolExecutionRow): string | undefined {
  if (row.toolName !== "codemode") return undefined;
  const code = (row.args as { code?: unknown } | undefined)?.code;
  if (typeof code !== "string") return undefined;
  const newline = code.indexOf("\n");
  const head = newline === -1 ? code : code.slice(0, newline);
  const firstLine = head.replace(/\r$/, "").trimStart();
  if (!firstLine.startsWith(CODEMODE_OPTIONS_PREFIX)) return undefined;
  const directive = firstLine.slice(CODEMODE_OPTIONS_PREFIX.length).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(directive);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return undefined;
  const params = Object.entries(parsed as Record<string, unknown>).map(
    ([key, value]) => `${JSON.stringify(key)}: ${JSON.stringify(value)}`,
  );
  return params.length > 0 ? params.join(", ") : undefined;
}

// Pi stores a JSON argument preview, capped at 200 characters. Long bash
// commands can therefore end inside a JSON string. Decode only complete
// escape sequences from a leading command field; never evaluate script text.
function codemodeBashCommand(args: unknown): string | undefined {
  if (typeof args !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(args);
    return isRecord(parsed) && typeof parsed.command === "string"
      ? parsed.command
      : undefined;
  } catch {
    if (!args.endsWith("...")) return undefined;
    const prefix = args.slice(0, -3);
    const match =
      /^\{\s*"command"\s*:\s*"((?:[^"\\]|\\(?:["\\/bfnrt]|u[\da-fA-F]{4}))*)/.exec(
        prefix,
      );
    if (!match) return undefined;
    try {
      const command: unknown = JSON.parse('"' + match[1] + '"');
      const suffix = prefix[match[0].length] === '"' ? "" : "…";
      return typeof command === "string" ? command + suffix : undefined;
    } catch {
      return undefined;
    }
  }
}

// Show each tool's total count, including ×1, on its first preview.
// Distinct previews remain visible; repeated previews take no extra space.
function codemodeCallsSummary(row: ToolExecutionRow): string | undefined {
  const calls = row.result?.details?.calls;
  if (!Array.isArray(calls) || calls.length === 0) return undefined;
  const counts = new Map<string, number>();
  const labels = new Map<string, { name: string; preview: string }>();
  for (const call of calls) {
    if (!isRecord(call)) continue;
    const name = call.name;
    if (typeof name !== "string" || name.length === 0) continue;
    const command =
      name === "bash" ? codemodeBashCommand(call.args) : undefined;
    const preview = command === undefined ? "" : sanitizeInline(command).trim();
    const label = preview ? name + " " + preview : name;
    counts.set(name, (counts.get(name) ?? 0) + 1);
    labels.set(label, { name, preview });
  }
  if (counts.size === 0) return undefined;
  const shown = new Set<string>();
  return [...labels.values()]
    .map(({ name, preview }) => {
      const count = counts.get(name) ?? 1;
      const heading = !shown.has(name) ? name + " ×" + count : name;
      shown.add(name);
      return preview ? heading + " " + preview : heading;
    })
    .join(", ");
}

// Codemode's collapsed label pairs what the script did with how it ran:
// `read ×2, fffind ×1 · "max_output_tokens": 2500`. Without either part the row
// falls through to the ordinary summary paths.
function codemodeCallLabel(row: ToolExecutionRow): string | undefined {
  if (row.toolName !== "codemode") return undefined;
  const parts = [codemodeCallsSummary(row), codemodeOptionsLabel(row)].filter(
    (part) => part !== undefined,
  );
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

function collapsedAnchor(
  theme: ThemeLike,
  color: string,
  glyph: string | undefined,
): string {
  const rail = withFaintCollapsedRail((marker) =>
    fgCollapsed(theme, "muted", marker),
  );
  return glyph === undefined
    ? `${rail}${SUBAGENT_LABEL_GAP}`
    : `${rail}${fgCollapsed(theme, color, glyph, true)} `;
}

function resourcePath(path: string, cwd: string): string {
  const localPath = path.startsWith("@") ? path.slice(1) : path;
  return resolve(
    cwd,
    localPath.startsWith("~/")
      ? `${homedir()}/${localPath.slice(2)}`
      : localPath,
  );
}

function readGlyph(
  row: ToolExecutionRow,
  state: PresentationPatchState,
): string {
  const path = isRecord(row.args) ? row.args.path : undefined;
  if (typeof path !== "string") return "●";
  const localPath = path.startsWith("@") ? path.slice(1) : path;
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(localPath)) return "●";
  if (/(?:^|[/\\])SKILL\.md$/.test(localPath)) return "§";
  return state.promptPaths.has(resourcePath(path, state.cwd)) ? "≡" : "●";
}

// The collapsed-row seam lives here and nowhere else: which anchor a row
// takes, and the call text that follows it. Callers append the outcome tail.
function collapsedSeam(
  row: ToolExecutionRow,
  width: number,
  theme: ThemeLike,
  color: string,
  state: PresentationPatchState,
): { anchor: string; content: string } {
  const isBash = row.toolName === "bash";
  const isSubagent = row.toolName === "subagent";
  const glyph = isSubagent
    ? undefined
    : isBash
      ? "$"
      : row.toolName === "read"
        ? readGlyph(row, state)
        : (TOOL_CALL_GLYPHS.get(row.toolName ?? "") ?? "*");
  const anchor = collapsedAnchor(theme, color, glyph);
  const budget = Math.max(1, width - visibleWidth(anchor));
  // Self-rendered rows build their own `tool {args}` label — Pi's call title
  // is gone once settled — while ordinary rows scrape the rendered call
  // line, which already drops its heading token.
  const selfRendered = row.getRenderShell?.() === "self";
  // Codemode rows pair the script's nested calls with its `@options` params;
  // with neither, they fall through to the ordinary summary paths.
  const source =
    codemodeCallLabel(row) ??
    (selfRendered
      ? selfRenderedCallLabel(row)
      : renderedCallSummary(row, budget, theme));
  const plain = sanitizeInline(stripAnsi(source)).trim();
  // The anchor stands in for the label's leading token. Only self-rendered
  // labels still carry it; a subagent fallback keeps `subagent` as its own
  // heading, which the scrape dropped.
  const text = isSubagent
    ? subagentFallbackLabel(row.args, plain)
    : selfRendered
      ? dropCallToken(plain, row.toolName ?? "tool")
      : plain;
  return {
    anchor,
    content: fgCollapsed(theme, color, text || "(no arguments)"),
  };
}

// Drops the leading token an anchor now stands for, with whichever separator
// the label joined it with.
function dropCallToken(plain: string, token: string): string {
  if (!plain.startsWith(token)) return plain;
  const rest = plain.slice(token.length);
  if (!/^:?\s|^:$/.test(rest)) return plain;
  return rest.replace(/^:?\s*/, "");
}

function collapsedOutcome(
  row: ToolExecutionRow,
  width: number,
  theme: ThemeLike,
): string | undefined {
  if (rowHasFailed(row)) {
    return capFailureTail(
      renderedErrorOutcome(row, theme),
      Math.max(3, Math.floor(width / 2)),
      theme,
    );
  }
  if (isPendingRow(row)) {
    const elapsed = liveElapsedText(row);
    return theme.fg("warning", elapsed ? `… · ${elapsed}` : "…");
  }
  if (row.getRenderShell?.() === "self") {
    const editStat = renderedEditDiffStat(row);
    if (editStat) return fgCollapsed(theme, "toolOutput", `→ ${editStat}`);
    return renderedGenericOutcome(theme);
  }
  return renderedOutcome(row, theme);
}

// One collapsed row — head and outcome tail — at the given width. Singleton
// and grouped rows differ only in what surrounds the line.
function collapsedRowLine(
  row: ToolExecutionRow,
  width: number,
  theme: ThemeLike,
  state: PresentationPatchState,
): string {
  // Failed rows render entirely in error so the row reads as the one that
  // failed, not just its outcome tail. Only the row's anchor stays bold.
  const color = rowHasFailed(row) ? "error" : "muted";
  const seam = collapsedSeam(row, width, theme, color, state);
  const budget = Math.max(1, width - visibleWidth(seam.anchor));
  const outcome = collapsedOutcome(row, budget, theme);
  // The truncation suffix inherits the row tone; pi-tui's truncation resets
  // around a plain suffix, which would render it in the terminal default
  // foreground instead of the row color.
  const suffix = fgCollapsed(theme, color, "…");
  return (
    seam.anchor +
    (outcome
      ? fitSummaryTail(seam.content, outcome, budget, suffix)
      : fitSummary(seam.content, budget, suffix))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function subagentDisplayProfile(
  args: Record<string, unknown>,
  action: unknown,
): string | undefined {
  const { profile, model } = args;
  if (typeof profile !== "string") return undefined;
  // Blank model strings do not override launch profiles. Keep the existing
  // rendering of controls, unknown actions, and malformed model values.
  const launch =
    action === undefined || action === "run" || action === "interactive";
  if (
    model !== undefined &&
    (!launch || typeof model !== "string" || model.trim() !== "")
  )
    return undefined;
  return profile.trim() || undefined;
}

function defaultSubagentEmoji(
  action: unknown,
  profile: string | undefined,
): string {
  if (profile === "coder") return "🧑‍💻";
  return typeof action === "string" &&
    [
      "interactive",
      "list",
      "status",
      "send",
      "wait",
      "stop",
      "resume",
    ].includes(action)
    ? "🤖"
    : "👾";
}

// Match a whole icon token, including joined emoji, flags, and keycaps.
// ASCII digits, #, and * count only in keycap sequences.
const SUBAGENT_EMOJI_TOKEN =
  /^(?:[#*0-9]\uFE0F?\u20E3|(?![#*0-9])\p{Emoji}[\uFE0E\uFE0F\u{E0020}-\u{E007F}]*\u200D?)+$/u;

function subagentFallbackLabel(args: unknown, summary: string): string {
  const input = isRecord(args) ? args : undefined;
  const match = /^(\S+)\s+(?=\S)/u.exec(summary);
  const icon = match?.[1] ?? "";
  const heading = match ? summary.slice(match[0].length) : "";
  const agent =
    typeof input?.agent === "string" ? sanitizeInline(input.agent).trim() : "";
  const startsWithAgent = (text: string) =>
    agent !== "" && (text === agent || text.startsWith(`${agent} `));
  // Subagents also accept configured Unicode symbols as icons. A token
  // directly before the known name can still be one of those assignments.
  const assigned = startsWithAgent(heading)
    ? /[^\x00-\x7f]/u.test(icon)
    : !startsWithAgent(summary) && SUBAGENT_EMOJI_TOKEN.test(icon);
  const action = input?.action;
  const prefix = assigned
    ? ""
    : `${defaultSubagentEmoji(action, input && subagentDisplayProfile(input, action))} `;
  return `subagent ${prefix}${summary}`.trimEnd();
}

type SubagentStep = {
  agent: string;
  profile: string | undefined;
  task: string;
};

type SubagentPlan = {
  kind: "single" | "parallel" | "chain";
  scope: string;
  steps: readonly [SubagentStep, ...SubagentStep[]];
};

function parseSubagentArgs(
  args: Record<string, unknown>,
): SubagentPlan | undefined {
  const scope =
    args.agentScope === "project" || args.agentScope === "both"
      ? args.agentScope
      : "user";
  const hasParallel = Array.isArray(args.tasks) && args.tasks.length > 0;
  const hasChain = Array.isArray(args.chain) && args.chain.length > 0;
  const hasSingle =
    typeof args.task === "string" && args.task.trim().length > 0;
  if (Number(hasParallel) + Number(hasChain) + Number(hasSingle) !== 1) {
    return undefined;
  }

  const parseStep = (item: unknown): SubagentStep | undefined => {
    if (!isRecord(item) || typeof item.task !== "string") return undefined;
    return {
      agent:
        typeof item.agent === "string" && item.agent.trim()
          ? item.agent.trim()
          : "...",
      profile: subagentDisplayProfile(item, args.action),
      task: item.task,
    };
  };

  const multiStepMode = hasParallel
    ? { kind: "parallel" as const, input: args.tasks as unknown[] }
    : hasChain
      ? { kind: "chain" as const, input: args.chain as unknown[] }
      : undefined;

  if (multiStepMode) {
    const parsedSteps = multiStepMode.input.map(parseStep);
    const steps: SubagentStep[] = [];
    for (const step of parsedSteps) {
      if (step === undefined) return undefined;
      steps.push(step);
    }
    const firstStep = steps[0];
    if (firstStep === undefined) return undefined;
    const nonEmptySteps: readonly [SubagentStep, ...SubagentStep[]] = [
      firstStep,
      ...steps.slice(1),
    ];
    return { kind: multiStepMode.kind, scope, steps: nonEmptySteps };
  }

  const single = parseStep(args);
  if (!single) return undefined;
  return { kind: "single", scope, steps: [single] };
}

// Extract the existing emoji-capable prefix and its bare lookup name.
function parseStepContent(
  content: string,
): { emoji: string; bareName: string } | undefined {
  const [first, bareName] = content.trim().split(/\s+/).filter(Boolean);
  if (!first || !bareName) return undefined;
  const hasEmoji = [...first].some((char) => (char.codePointAt(0) ?? 0) > 0x7f);
  return hasEmoji ? { emoji: first, bareName } : undefined;
}

// Assigned emojis come from the subagent extension's call component when
// available; args only carry the bare agent name.
function scrapeSubagentEmojis(
  row: ToolExecutionRow,
  kind: SubagentPlan["kind"],
): Map<string, string> {
  const names = new Map<string, string>();
  let component = row.callRendererComponent;
  if (!component && Array.isArray(row.contentBox?.children)) {
    component = row.contentBox.children[0] as ComponentLike | undefined;
  }
  if (!component || typeof component.render !== "function") return names;
  try {
    for (const raw of component.render(120)) {
      const text = sanitizeInline(stripAnsi(raw));
      // Native single-call headings can wrap. The first indented line starts
      // the task preview; neither it nor its continuations carry identity.
      if (kind === "single" && text.startsWith("  ")) break;
      const line = text.trim();
      if (!line) continue;
      // Single calls carry the agent name on their "subagent <name>" heading
      // line; stripping the heading word (and step numbers) lets both shapes
      // flow through the same parse. Heading remainders without an emoji
      // (e.g. "chain (2 steps)") are skipped.
      const content = line
        .replace(/^subagent\b\s*/, "")
        .replace(/^\d+\.\s*/, "");
      const identity = parseStepContent(content);
      if (identity) names.set(identity.bareName, identity.emoji);
    }
  } catch {
    // Display-name scraping is cosmetic; args still carry the bare name.
  }
  return names;
}

function subagentStepPreview(task: string): string {
  const clean = sanitizeInline(task)
    .replace(/\{previous\}/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return clean.length > 40 ? `${clean.slice(0, 40)}...` : clean;
}

// Partial and final subagent results both carry per-task usage in details
// (the subagent extension streams makeDetails snapshots through onUpdate), so
// this works live and settled. Surface the smallest useful progress — total
// turns, and the model when every task resolved to the same one.
function subagentProgressText(row: ToolExecutionRow): string | undefined {
  const results = row.result?.details?.results;
  if (!Array.isArray(results) || results.length === 0) return undefined;
  let turns = 0;
  const models = new Set<string>();
  for (const result of results) {
    if (!isRecord(result)) continue;
    const usage = result.usage;
    const turnCount = isRecord(usage) ? usage.turns : undefined;
    if (typeof turnCount === "number" && Number.isFinite(turnCount)) {
      turns += turnCount;
    }
    const model = result.model ?? result.requestedModel;
    if (typeof model === "string" && model.trim().length > 0) {
      models.add(model.trim());
    }
  }
  const parts: string[] = [];
  if (turns > 0) parts.push(`${turns} turn${turns === 1 ? "" : "s"}`);
  if (models.size === 1) parts.push(sanitizeInline([...models][0]!));
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

function subagentPlanOutcome(
  row: ToolExecutionRow,
  failed: boolean,
  progress: string | undefined,
  budget: number,
  theme: ThemeLike,
): string | undefined {
  if (failed) return collapsedOutcome(row, budget, theme);
  if (isPendingRow(row))
    return theme.fg("warning", progress ? `→ ${progress}` : "…");
  if (row.result)
    return fgCollapsed(
      theme,
      "toolOutput",
      progress ? `→ ${progress}` : "→ done",
    );
  return theme.fg("warning", "…");
}

// Subagents use the collapsed rail with no separate glyph. A single call
// starts with its agent identity; a multi-step plan starts with a heading.
// Agent identities use accent, and failures use error colors.
function renderSubagentPlan(
  row: ToolExecutionRow,
  width: number,
  theme: ThemeLike,
): string[] | undefined {
  if (!isRecord(row.args)) return undefined;
  const { action } = row.args;
  const plan = parseSubagentArgs(row.args);
  if (!plan || width < 12) return undefined;

  const failed = rowHasFailed(row);
  const color = failed ? "error" : "muted";
  const nameColor = failed ? "error" : "accent";
  const suffix = fgCollapsed(theme, color, "…");
  const displayEmojis = scrapeSubagentEmojis(row, plan.kind);
  // Agent/profile/task values are model-supplied; sanitize them like every
  // other collapsed-row text so control bytes cannot reach the terminal.
  // Identity order: emoji, then the profile and agent-name badges.
  const identityOf = (step: SubagentStep) => {
    const emoji = displayEmojis.get(step.agent);
    const accentPart = (text: string) => fgCollapsed(theme, nameColor, text);
    const fallbackEmoji = defaultSubagentEmoji(action, step.profile);
    const emojiPart = `${accentPart(emoji || fallbackEmoji)} `;
    const profilePart = step.profile
      ? accentPart(`[${sanitizeInline(step.profile)}]`)
      : "";
    return `${emojiPart}${profilePart}${accentPart(`[${sanitizeInline(step.agent)}]`)}`;
  };
  const detailColor = failed ? "error" : "toolOutput";
  const previewOf = (step: SubagentStep) =>
    fgCollapsed(theme, detailColor, ` ${subagentStepPreview(step.task)}`);

  const marker = collapsedAnchor(theme, color, undefined);
  const budget = Math.max(1, width - visibleWidth(marker));
  const progress = subagentProgressText(row);
  const outcome = subagentPlanOutcome(row, failed, progress, budget, theme);
  const headline = (label: string) =>
    marker +
    (outcome
      ? fitSummaryTail(label, outcome, budget, suffix)
      : fitSummary(label, budget, suffix));

  if (plan.kind === "single") {
    const step = plan.steps[0];
    return [headline(identityOf(step) + previewOf(step))];
  }

  const kindLabel =
    plan.kind === "chain"
      ? `chain (${plan.steps.length} ${plan.steps.length === 1 ? "step" : "steps"})`
      : `parallel (${plan.steps.length} tasks)`;
  const lines = [
    headline(
      fgCollapsed(theme, failed ? "error" : "toolTitle", "subagent", true) +
        " " +
        fgCollapsed(theme, failed ? "error" : "toolOutput", kindLabel) +
        fgCollapsed(theme, failed ? "error" : "toolOutput", ` [${plan.scope}]`),
    ),
  ];
  const stepIndent = " ".repeat(
    visibleWidth(COLLAPSED_RAIL + SUBAGENT_LABEL_GAP),
  );
  const shown = plan.steps.slice(0, 3);
  for (let index = 0; index < shown.length; index++) {
    const step = shown[index]!;
    const number =
      plan.kind === "chain"
        ? `${fgCollapsed(theme, color, `${index + 1}.`)} `
        : "";
    lines.push(`${stepIndent}${number}${identityOf(step)}${previewOf(step)}`);
  }
  if (plan.steps.length > shown.length) {
    lines.push(
      `${stepIndent}${fgCollapsed(theme, color, `... +${plan.steps.length - shown.length} more`)}`,
    );
  }
  return lines;
}

function imageResultLines(
  row: ToolExecutionRow,
  width: number,
  theme: ThemeLike,
): string[] {
  if (!hasImageResult(row)) return [];
  const lines: string[] = [];
  const output = row.getTextOutput?.() || resultText(row);
  if (output) {
    const sanitized = output
      .split("\n")
      .map((line) => sanitizeInline(line))
      .join("\n");
    lines.push(
      "",
      ...wrapTextWithAnsi(
        fgCollapsed(theme, "toolOutput", sanitized),
        Math.max(1, width),
      ),
    );
  }

  for (let index = 0; index < (row.imageComponents?.length ?? 0); index++) {
    const spacer = row.imageSpacers?.[index];
    if (spacer) lines.push(...renderComponent(spacer, width));
    const image = row.imageComponents?.[index];
    if (image) lines.push(...renderComponent(image, width));
  }
  return lines.map((line) => truncateToWidth(line, width, "", false));
}

function renderCollapsedToolRow(
  row: ToolExecutionRow,
  width: number,
  theme: ThemeLike,
  state: PresentationPatchState,
): string[] {
  // An asked question is a user-input moment, not an execution row: it takes
  // the submitted-prompt shell, which carries its own inset.
  const questionBlock = renderQuestionBlock(row, width, theme);
  if (questionBlock) return ["", ...questionBlock];
  const layout = insetLayout(width);
  const plan =
    row.toolName === "subagent"
      ? renderSubagentPlan(row, layout.contentWidth, theme)
      : undefined;
  const body = plan ?? [
    collapsedRowLine(row, layout.contentWidth, theme, state),
  ];
  body.push(...imageResultLines(row, layout.contentWidth, theme));
  return ["", ...insetLines(body, width)];
}

function renderGroupedCallLines(
  rows: ToolExecutionRow[],
  width: number,
  theme: ThemeLike,
  state: PresentationPatchState,
): Array<{ row: ToolExecutionRow; lines: string[] }> {
  const segments: Array<{ row: ToolExecutionRow; lines: string[] }> = [];
  for (const row of rows) {
    segments.push({ row, lines: [collapsedRowLine(row, width, theme, state)] });
  }
  return segments;
}

function sameMemberSnapshots(
  snapshots: readonly GroupMemberSnapshot[],
  rows: ToolExecutionRow[],
  state: PresentationPatchState,
): boolean {
  return (
    snapshots.length === rows.length &&
    snapshots.every(
      (snapshot, index) =>
        snapshot.row === rows[index] &&
        snapshot.version === (state.rowVersions.get(snapshot.row) ?? 0),
    )
  );
}

type GroupBlock = {
  lines: string[];
  // Click-routing accounting aligned with `lines`: one entry per drawn row
  // segment, so mouse events land on the member that owns the line.
  heights: Array<{ component: ToolExecutionRow; height: number }>;
};

function renderGroupedToolRows(
  row: ToolExecutionRow,
  rows: ToolExecutionRow[],
  width: number,
  state: PresentationPatchState,
): GroupBlock {
  const theme = state.theme;
  if (!theme) {
    const lines = state.originalRender.call(row, width);
    return { lines, heights: [{ component: row, height: lines.length }] };
  }
  const themeSample = paletteSample(theme);
  const cached = state.groupCache.get(row);
  const hasLiveMembers = rows.some(isLiveRow);
  if (
    !hasLiveMembers &&
    cached &&
    cached.width === width &&
    cached.themeSample === themeSample &&
    sameMemberSnapshots(cached.memberSnapshots, rows, state)
  ) {
    return { lines: cached.lines, heights: cached.heights };
  }

  const layout = insetLayout(width);
  const segments = renderGroupedCallLines(
    rows,
    layout.contentWidth,
    theme,
    state,
  );
  const lines = [
    "",
    ...insetLines(
      segments.flatMap((s) => s.lines),
      width,
    ),
  ];
  // The first member owns the leading blank; every member owns its call line.
  const heights = segments.map((segment, index) => ({
    component: segment.row,
    height: index === 0 ? segment.lines.length + 1 : segment.lines.length,
  }));
  if (hasLiveMembers) {
    state.groupCache.delete(row);
  } else {
    state.groupCache.set(row, {
      lines,
      heights,
      memberSnapshots: rows.map((member) => ({
        row: member,
        version: state.rowVersions.get(member) ?? 0,
      })),
      themeSample,
      width,
    });
  }
  return { lines, heights };
}

type ContainerRender = {
  lines: string[];
  // Click-routing accounting aligned with `lines`.
  heights: Array<{ component: unknown; height: number }>;
};

function renderContainerWithToolGroups(
  children: unknown[],
  width: number,
  presentation: PresentationPatchState,
): ContainerRender {
  const lines: string[] = [];
  const heights: Array<{ component: unknown; height: number }> = [];
  const rendered = new Map<number, string[]>();
  const renderAt = (index: number): string[] => {
    const cached = rendered.get(index);
    if (cached) return cached;
    const next = renderComponent(children[index], width);
    rendered.set(index, next);
    return next;
  };

  for (let index = 0; index < children.length; index++) {
    const child = children[index];
    if (
      !isToolExecutionRow(child) ||
      !isGroupableToolRow(child, children, index, renderAt, presentation)
    ) {
      const drawn = renderAt(index);
      lines.push(...drawn);
      heights.push({ component: child, height: drawn.length });
      continue;
    }

    const group: ToolExecutionRow[] = [child];
    let lastMemberIndex = index;
    for (
      let candidateIndex = index + 1;
      candidateIndex < children.length;
      candidateIndex++
    ) {
      const candidate = children[candidateIndex];
      if (isAssistantMessageRow(candidate)) {
        if (renderAt(candidateIndex).some(hasVisibleContent)) break;
        continue;
      }
      if (isToolExecutionRow(candidate)) {
        if (
          !isGroupableToolRow(
            candidate,
            children,
            candidateIndex,
            renderAt,
            presentation,
          )
        )
          break;
        group.push(candidate);
        lastMemberIndex = candidateIndex;
        continue;
      }
      if (renderAt(candidateIndex).some(hasVisibleContent)) break;
    }

    if (group.length === 1) {
      const drawn = renderAt(index);
      lines.push(...drawn);
      heights.push({ component: child, height: drawn.length });
      continue;
    }

    // Use a live member while any call is pending, then the first member once
    // settled. Either way, the grouped row keeps the same number of lines.
    const shellRow = group.find(isLiveRow) ?? child;
    const block = renderGroupedToolRows(shellRow, group, width, presentation);
    lines.push(...block.lines);
    heights.push(...block.heights);
    index = lastMemberIndex;
  }

  return { lines, heights };
}

// TODO: Replace prototype patching with a public Pi tool/transcript rendering API when available.
function installGroupingPatch(
  presentation: PresentationPatchState,
): GroupingPatchState | undefined {
  try {
    const proto = Container?.prototype as unknown as ComponentContainer & {
      [GROUPING_PATCHED]?: GroupingPatchState;
      render?: (width: number) => string[];
    };
    if (!proto || typeof proto.render !== "function") return undefined;

    const existing = proto[GROUPING_PATCHED];
    if (existing?.disabled && proto.render === existing.patchedRender) {
      // A later wrapper may have restored ours after we shut down. Replace
      // it now so reload uses the new module's renderer, not the old closure.
      proto.render = existing.originalRender;
      delete proto[GROUPING_PATCHED];
    } else if (existing) {
      existing.owners++;
      existing.presentation = presentation;
      existing.disabled = false;
      return existing;
    }

    const state: GroupingPatchState = {
      owners: 1,
      presentation,
      originalRender: proto.render,
    };
    const patchedRender = function renderWithCollapsedToolGroups(
      this: ComponentContainer,
      width: number,
    ): string[] {
      const children = this.children;
      if (
        state.disabled ||
        !Array.isArray(children) ||
        !children.some(isToolExecutionRow)
      ) {
        return state.originalRender.call(this, width);
      }
      let restoreHooks: () => void = () => {};
      try {
        // Other container-level concerns (pi-content-layout's system-text
        // inset) decorate children through the shared hooks before grouping
        // rewrites the rows; delegation alone cannot reach them from here.
        restoreHooks = runChatContainerHooks(this, children, width);
        const drawn = renderContainerWithToolGroups(
          children,
          width,
          state.presentation,
        );
        // The grouping path bypasses the native render that refreshes the
        // container's click-routing cache, so a click would be routed by the
        // layout from before the first tool row. Publish the drawn accounting
        // so click-to-expand keeps landing on the row that actually owns the
        // line, including grouped members and the messages below them. Pi
        // 1.6 reads `childLines`, each child with the lines it drew; older
        // hosts read `mouseLayout`, each child with its height. Both are
        // pi-tui Container internals, so a rename there breaks clicks quietly.
        const host = this as { mouseLayout?: unknown; childLines?: unknown };
        host.mouseLayout = { width, children: drawn.heights };
        const parts: string[][] = [];
        let drawnLine = 0;
        for (const { height } of drawn.heights) {
          parts.push(drawn.lines.slice(drawnLine, drawnLine + height));
          drawnLine += height;
        }
        host.childLines = {
          width,
          children: drawn.heights.map(({ component }) => component),
          parts,
          lines: drawn.lines,
        };
        return drawn.lines;
      } catch {
        return state.originalRender.call(this, width);
      } finally {
        restoreHooks();
      }
    };

    state.patchedRender = patchedRender;
    proto.render = patchedRender;
    Object.defineProperty(proto, GROUPING_PATCHED, {
      configurable: true,
      value: state,
    });
    return state;
  } catch {
    // Grouping is cosmetic; preserve Pi's container renderer if its internals change.
    return undefined;
  }
}

function uninstallGroupingPatch(state: GroupingPatchState | undefined): void {
  if (!state || state.owners <= 0) return;
  state.owners--;
  if (state.owners > 0) return;
  // Even when another extension's wrapper sits on top of ours, grouping must
  // not outlive its final owner: the wrapper delegates once disabled, and a
  // later reinstall re-enables it.
  state.disabled = true;
  const proto = Container?.prototype as unknown as ComponentContainer & {
    [GROUPING_PATCHED]?: GroupingPatchState;
    render?: (width: number) => string[];
  };
  if (proto[GROUPING_PATCHED] !== state || proto.render !== state.patchedRender)
    return;
  proto.render = state.originalRender;
  delete proto[GROUPING_PATCHED];
}

function installPresentationPatch(): PresentationPatchState | undefined {
  try {
    const proto =
      ToolExecutionComponent?.prototype as unknown as ToolExecutionRow & {
        [PRESENTATION_PATCHED]?: PresentationPatchState;
        [LEGACY_PRESENTATION_PATCHED]?: PresentationPatchState;
        render?: (width: number) => string[];
        updateDisplay?: () => void;
      };
    if (!proto) return undefined;

    const existing = proto[PRESENTATION_PATCHED];
    const retired =
      existing?.disabled && existing.generation !== PRESENTATION_GENERATION
        ? existing
        : undefined;
    if (existing && !retired) {
      existing.owners++;
      existing.disabled = false;
      return existing;
    }
    const legacy = !existing && proto[LEGACY_PRESENTATION_PATCHED];
    if (legacy) {
      proto.render = legacy.originalRender;
      proto.updateDisplay = legacy.originalUpdateDisplay;
    }
    if (
      typeof proto.render !== "function" ||
      typeof proto.updateDisplay !== "function"
    )
      return undefined;

    const { render, updateDisplay } = proto;
    const buriedRender = retired && render !== retired.patchedRender;
    const buriedUpdate =
      retired && updateDisplay !== retired.patchedUpdateDisplay;
    const retiredMouse = retired?.originalHandleMouse;

    const state: PresentationPatchState = {
      generation: PRESENTATION_GENERATION,
      owners: 1,
      cwd: process.cwd(),
      promptPaths: new Set(),
      collapseParallel:
        retired?.collapseParallel ?? envEnabled(COLLAPSE_PARALLEL_ENV, true),
      expandedTools: retired?.expandedTools ?? envToolNames(EXPANDED_TOOLS_ENV),
      groupCache: new WeakMap(),
      collapsedCache: new WeakMap(),
      rowVersions: new WeakMap(),
      originalRender: retired?.originalRender ?? render,
      originalUpdateDisplay: retired?.originalUpdateDisplay ?? updateDisplay,
    };
    const patchedUpdateDisplay = function updateDisplayWithToolPresentation(
      this: ToolExecutionRow,
    ): void {
      if (state.disabled) {
        state.originalUpdateDisplay.call(this);
        return;
      }
      // Transcript rerenders reuse settled caches, but a real component
      // display update can change args, results, renderer output, or images
      // without changing the row's shape signature.
      state.rowVersions.set(this, (state.rowVersions.get(this) ?? 0) + 1);
      state.groupCache.delete(this);
      state.collapsedCache.delete(this);
      state.originalUpdateDisplay.call(this);
      // Rows for an always-expanded tool skip the collapsed presentation.
      // Forcing the flag here, before grouping decides whether the row is
      // eligible, keeps Pi's native expanded block authoritative; it also
      // re-expands the row after a global collapse.
      if (
        this.expanded === false &&
        state.expandedTools.has(this.toolName ?? "") &&
        typeof this.setExpanded === "function"
      ) {
        this.setExpanded(true);
      }
    };
    // Pi 0.85 wraps settled tool results in a click-to-expand MouseRegion.
    // The custom collapsed row replaces those lines with a single summary, so
    // the region never receives the click; toggle expansion here instead.
    let patchedHandleMouse:
      | ((this: ToolExecutionRow, event: unknown) => unknown)
      | undefined;
    const originalHandleMouse = retiredMouse ?? proto.handleMouse;
    if (typeof originalHandleMouse === "function") {
      state.originalHandleMouse = originalHandleMouse;
      patchedHandleMouse = function handleMouseWithCollapsedToggle(
        this: ToolExecutionRow,
        event: unknown,
      ): unknown {
        const mouseEvent = event as { type?: unknown; button?: unknown };
        if (state.disabled) {
          return state.originalHandleMouse?.call(this, event);
        }
        if (
          state.theme &&
          this.expanded === false &&
          !!this.result &&
          mouseEvent?.type === "click" &&
          mouseEvent.button === "left" &&
          typeof this.setExpanded === "function"
        ) {
          this.setExpanded(true);
          return { handled: true };
        }
        return state.originalHandleMouse?.call(this, event);
      };
      if (!retiredMouse) proto.handleMouse = patchedHandleMouse;
    }
    const patchedRender = function renderWithToolPresentation(
      this: ToolExecutionRow,
      width: number,
    ): string[] {
      const theme = state.theme;
      if (
        state.disabled ||
        typeof this.expanded !== "boolean" ||
        typeof this.isPartial !== "boolean" ||
        this.expanded ||
        !theme
      ) {
        return state.originalRender.call(this, width);
      }

      // ================================================================
      // Settled-row render cache — PLEASE DO NOT REMOVE THIS FAST PATH.
      // ================================================================
      // Pi's TUI re-renders the whole transcript on every keystroke, and
      // the collapsed-row decoration below rebuilds strings for every row
      // it touches. On a long session (~1,000 messages, hundreds of tool
      // rows) that measured at ~80 ms per keystroke — visible input lag.
      //
      // Settled rows (not partial, not expanded) have static output between
      // component display updates, so their collapsed lines are cached keyed
      // by width + rowSignatureOf + rowVersions + theme sample. Every real
      // updateDisplay call bumps rowVersions and clears both caches; partial
      // rows bypass the cache because their content streams.
      // ================================================================
      if (!this.isPartial) {
        const signature = rowSignatureOf(this);
        const version = state.rowVersions.get(this) ?? 0;
        const themeSample = paletteSample(theme);
        const cached = state.collapsedCache.get(this);
        if (
          cached &&
          cached.width === width &&
          cached.signature === signature &&
          cached.version === version &&
          cached.themeSample === themeSample
        ) {
          return cached.lines;
        }
        const lines = state.originalRender.call(this, width);
        if (drawsNoRowLines(this, lines)) {
          return lines;
        }
        try {
          const collapsed = renderCollapsedToolRow(this, width, theme, state);
          state.collapsedCache.set(this, {
            lines: collapsed,
            signature,
            version,
            themeSample,
            width,
          });
          return collapsed;
        } catch {
          return lines;
        }
      }

      // Partial (streaming) rows keep the collapsed presentation but are
      // never cached: their content changes with every streamed chunk.
      const lines = state.originalRender.call(this, width);
      if (drawsNoRowLines(this, lines)) {
        return lines;
      }
      try {
        return renderCollapsedToolRow(this, width, theme, state);
      } catch {
        return lines;
      }
    };

    try {
      state.patchedUpdateDisplay = patchedUpdateDisplay;
      state.patchedRender = patchedRender;
      if (!buriedUpdate) proto.updateDisplay = patchedUpdateDisplay;
      if (!buriedRender) proto.render = patchedRender;
      Object.defineProperty(proto, PRESENTATION_PATCHED, {
        configurable: true,
        value: state,
      });
      if (retired) {
        // Keep foreign wrappers on the outside, including on cached renders.
        // The retired closures stay disabled and only forward to these delegates.
        if (buriedRender) retired.originalRender = patchedRender;
        if (buriedUpdate) retired.originalUpdateDisplay = patchedUpdateDisplay;
        if (retiredMouse && patchedHandleMouse) {
          retired.originalHandleMouse = patchedHandleMouse;
        }
      }
    } catch {
      if (!buriedUpdate) proto.updateDisplay = updateDisplay;
      if (!buriedRender) proto.render = render;
      return undefined;
    }
    return state;
  } catch {
    // Pi internals can change across versions; fail silently rather than break the session.
    return undefined;
  }
}

function uninstallPresentationPatch(
  state: PresentationPatchState | undefined,
): void {
  if (!state || state.owners <= 0) return;
  state.owners--;
  if (state.owners > 0) return;
  state.disabled = true;
  const proto =
    ToolExecutionComponent?.prototype as unknown as ToolExecutionRow & {
      [PRESENTATION_PATCHED]?: PresentationPatchState;
      render?: (width: number) => string[];
      updateDisplay?: () => void;
      handleMouse?: (event: unknown) => unknown;
    };
  if (
    proto[PRESENTATION_PATCHED] !== state ||
    proto.render !== state.patchedRender ||
    proto.updateDisplay !== state.patchedUpdateDisplay
  ) {
    return;
  }
  proto.render = state.originalRender;
  proto.updateDisplay = state.originalUpdateDisplay;
  if (
    state.patchedHandleMouse &&
    proto.handleMouse === state.patchedHandleMouse
  ) {
    if (state.originalHandleMouse) {
      proto.handleMouse = state.originalHandleMouse;
    } else {
      delete proto.handleMouse;
    }
  }
  delete proto[PRESENTATION_PATCHED];
}

// TODO(compaction cards): native/failed compaction cards in the transcript
// are currently rendered by the pi-verbatim-compaction extension. Its
// src/chat-log.ts is deliberately self-contained (public Pi imports only), so
// porting here is: drop in that file, registerEntryRenderer(COMPACTION_LOG_TYPE),
// and wire pi.on("session_compact") / pi.on("session_compact_failed") filtered
// to fromExtension === false. Do this only if pi-verbatim-compaction is
// removed or native cards should exist without it; while both are installed,
// rendering here too would double-render every native compaction.
export default function (pi: ExtensionAPI) {
  const patch = installPresentationPatch();
  const grouping = patch ? installGroupingPatch(patch) : undefined;
  const bashPatch = installBashBlockPatch();
  installInfoVisibility(pi);
  let released = false;

  pi.on("session_start", (_event, ctx) => {
    if (patch) {
      patch.theme = ctx.ui.theme;
      patch.cwd = ctx.cwd ?? process.cwd();
      patch.promptPaths = new Set(
        (pi.getCommands?.() ?? [])
          .filter((command) => command.source === "prompt")
          .map((command) => command.sourceInfo?.path)
          .filter((path): path is string => typeof path === "string")
          .map((path) => resourcePath(path, patch.cwd)),
      );
      patch.groupCache = new WeakMap();
      patch.collapsedCache = new WeakMap();
    }
    if (bashPatch) bashPatch.theme = ctx.ui.theme;
    ctx.ui.setToolsExpanded(false);
  });

  pi.on("session_shutdown", () => {
    if (released) return;
    released = true;
    uninstallGroupingPatch(grouping);
    uninstallPresentationPatch(patch);
    uninstallBashBlockPatch(bashPatch);
    uninstallInfoVisibility();
  });
}
