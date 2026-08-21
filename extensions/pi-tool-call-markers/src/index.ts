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
import { runChatContainerHooks } from "./container-hooks.ts";

const OUTER_INSET = 2;
const GROUP_MARKER = "%";
const SUBAGENT_MARKER = "&";
const PRESENTATION_PATCHED = Symbol.for("kg.pi.toolPresentation.v3");
const LEGACY_PRESENTATION_PATCHED = Symbol.for("kg.pi.toolPresentation.v2");
const GROUPING_PATCHED = Symbol.for("kg.pi.toolGrouping.v1");
const ANSI_RE = /\u001b\[[0-9;]*m/g;
const COLLAPSE_PARALLEL_ENV = "PI_TOOL_CALL_MARKERS_COLLAPSE_PARALLEL";

type ThemeLike = {
  bold(text: string): string;
  fg(color: string, text: string): string;
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
};

type PresentationPatchState = {
  theme?: ThemeLike;
  collapseParallel: boolean;
  groupCache: WeakMap<ToolExecutionRow, GroupRenderCache>;
  collapsedCache: WeakMap<ToolExecutionRow, CollapsedRenderCache>;
  rowVersions: WeakMap<ToolExecutionRow, number>;
  rowGroups: WeakMap<ToolExecutionRow, ToolExecutionRow[]>;
  rowSignatures: WeakMap<ToolExecutionRow, string>;
  originalRender: (width: number) => string[];
  originalUpdateDisplay: () => void;
  patchedRender?: (width: number) => string[];
  patchedUpdateDisplay?: () => void;
};

type GroupingPatchState = {
  presentation: PresentationPatchState;
  originalRender: (width: number) => string[];
  patchedRender?: (width: number) => string[];
  disabled?: boolean;
};

type GroupRenderCache = {
  lines: string[];
  members: ToolExecutionRow[];
  memberVersions: number[];
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

function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

// Command output can carry cursor-moving control bytes (git progress writes
// \r) and raw terminal sequences. Collapsed rows are single-line, so result
// and scraped text is stripped of display sequences and control bytes before
// it can reach a row; a bare \r would otherwise return the cursor to column 0
// and overwrite the row's own marker.
const INLINE_CONTROL_RE = /[\x00-\x08\x0b-\x1f\x7f]/g;
// OSC first: the two-byte alternative would otherwise consume `\x1b]` and
// leave the hyperlink payload behind as visible text. OSC sequences (OSC 8
// hyperlinks, titles) end at their first BEL/ST terminator; a payload match
// must stop there too, because the visible text sits BETWEEN two OSC
// sequences — Pi wraps read paths as `ESC]8;;url ESC\ <path> ESC]8;; ESC\`,
// and a greedy `[^\x07]*` would swallow that path along with the sequences.
const DISPLAY_ANSI_RE =
  /\x1b(?:\][^\x07\x1b]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~]|[@-Z\\-_])/g;

function sanitizeInline(text: string): string {
  return text.replace(DISPLAY_ANSI_RE, "").replace(INLINE_CONTROL_RE, " ");
}

function hasVisibleContent(line: string): boolean {
  return stripAnsi(line).trim().length > 0;
}

// State-transition fingerprint used by both the updateDisplay version bump
// and the settled-row render cache. It deliberately covers only shape
// transitions (partial/expanded/result/error): while a row is partial its
// content streams and it is never cached, and once settled the rendered
// content is fully determined by this fingerprint + width + theme.
function rowSignatureOf(row: ToolExecutionRow): string {
  return `${row.isPartial}|${row.expanded}|${row.result ? 1 : 0}|${row.result?.isError ? 1 : 0}`;
}

// Theme samples are five theme.fg calls; computing them per row per frame
// would reintroduce the per-keystroke cost the render caches remove, so
// cache by theme object identity (a theme switch swaps the object).
const themeSamples = new WeakMap<ThemeLike, string>();
function themeSampleFor(theme: ThemeLike): string {
  let sample = themeSamples.get(theme);
  if (!sample) {
    sample =
      theme.fg("toolTitle", "x") +
      theme.fg("muted", "x") +
      theme.fg("dim", "x") +
      theme.fg("warning", "x") +
      theme.fg("error", "x");
    themeSamples.set(theme, sample);
  }
  return sample;
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
  return theme.fg("muted", "→ done");
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

// A concise one-line label for the adapter's "mcp" proxy from the call's
// shape alone. The adapter's dispatch order is an implementation detail, so
// only a single unambiguous selector gets a named operation; conflicting,
// empty, or unrecognized selectors return undefined so the caller shows the
// complete compact args instead of claiming which operation executed.
function mcpProxyCallLabel(
  record: Record<string, unknown>,
): string | undefined {
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
    const restJson = squashJsonish(rest);
    return restJson ? `${label} ${restJson}` : label;
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
    const restJson = squashJsonish(rest);
    return restJson ? `${label} ${restJson}` : label;
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
    const restJson = squashJsonish(rest);
    return restJson ? `${label} ${restJson}` : label;
  }
  // connect / describe / instructions: the adapter dispatches these modes
  // without params.server, so a server argument is shown raw rather than as
  // a scope suffix that implies an operation that never ran.
  const label = `mcp ${key} ${String(record[key])}`;
  const restJson = squashJsonish(
    server === undefined ? rest : { ...rest, server },
  );
  return restJson ? `${label} ${restJson}` : label;
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

function selfRenderedSummary(row: ToolExecutionRow, width: number): string {
  return fitSummary(selfRenderedCallLabel(row), width);
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

function isLiveRow(row: ToolExecutionRow): boolean {
  return (
    row.expanded === false &&
    (row.isPartial !== false || !row.result) &&
    !hasImageResult(row)
  );
}

function isCollapsibleSuccess(row: ToolExecutionRow): boolean {
  return (
    row.expanded === false &&
    row.isPartial === false &&
    !!row.result &&
    !rowHasFailed(row) &&
    !hasImageResult(row)
  );
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

function isGroupableToolRow(
  row: ToolExecutionRow,
  children: unknown[],
  index: number,
  renderAt: (index: number) => string[],
  state: PresentationPatchState,
): boolean {
  if (row.toolName === "subagent") return false;
  if (!isLiveRow(row) && !isCollapsibleSuccess(row)) return false;
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
// result.details.diff — lines like `+27 <content>`, `-27 <content>`,
// ` 28 <context>`, plus `...` for folded regions. Self-rendered rows
// normally keep only their one-line call label; edits additionally show
// the change as a bounded diff block under the summary and a +a/-b stat in
// the outcome tail, so the hunk stays visible without Ctrl+O while
// expanded rows keep Pi's native rendering.
const EDIT_DIFF_LINE_RE = /^([+\-\s])(\s*\d*)(.*)$/;
const MAX_EDIT_DIFF_LINES = 12;

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

function renderedEditDiffLines(
  row: ToolExecutionRow,
  theme: ThemeLike,
): string[] {
  const diff = editDiffText(row);
  if (diff === undefined) return [];
  const raw = diff.split("\n");
  if (raw[raw.length - 1] === "") raw.pop();
  const lines: string[] = [];
  for (const line of raw.slice(0, MAX_EDIT_DIFF_LINES)) {
    const clean = sanitizeInline(line).trimEnd();
    if (clean.trim() === "...") {
      lines.push(theme.fg("muted", "  ..."));
      continue;
    }
    const match = EDIT_DIFF_LINE_RE.exec(clean);
    if (!match) continue;
    const color =
      match[1] === "+"
        ? "toolDiffAdded"
        : match[1] === "-"
          ? "toolDiffRemoved"
          : "toolDiffContext";
    lines.push(theme.fg(color, `  ${match[1]}${match[2]}${match[3]}`));
  }
  if (raw.length > MAX_EDIT_DIFF_LINES) {
    lines.push(
      theme.fg("muted", `  ... +${raw.length - MAX_EDIT_DIFF_LINES} more`),
    );
  }
  return lines;
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
  return theme.fg("muted", `→ ${summary}`);
}

function renderedGroupedOutcome(
  row: ToolExecutionRow,
  theme: ThemeLike,
): string | undefined {
  const outcome = renderedOutcome(row, theme);
  if (outcome) return outcome;
  if (isLiveRow(row)) {
    const elapsed = liveElapsedText(row);
    return theme.fg("warning", elapsed ? `… · ${elapsed}` : "…");
  }
  // Self-rendered tools have no per-tool outcome summary; keep the group's
  // settled tail consistent with collapsed singletons.
  if (row.getRenderShell?.() === "self") return renderedGenericOutcome(theme);
  return undefined;
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
  // Self-rendered call components change shape across the live/settled
  // boundary (the adapter's call disappears once settled), so always build
  // the summary from the stable args label instead of scraping the preview.
  if (row.getRenderShell?.() === "self") return selfRenderedSummary(row, width);

  let component = row.callRendererComponent;
  if (!component && Array.isArray(row.contentBox?.children)) {
    component = row.contentBox.children[0] as ComponentLike | undefined;
  }
  if (component && typeof component.render === "function") {
    const visibleLines = component
      .render(Math.max(1, width))
      .filter(hasVisibleContent);
    const rendered = visibleLines.slice(0, 3);
    const line = rendered[0];
    if (line) {
      const first = trimRenderedLine(line);
      const plain = stripAnsi(first);
      const match = /^(\s*)(\S+)(\s*)/.exec(plain);
      if (match) {
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
          continuations.push(theme.fg("muted", "…"));
        const compact = [firstSummary, ...continuations]
          .filter(hasVisibleContent)
          .join(theme.fg("muted", " · "));
        if (hasVisibleContent(compact)) return compact;
      }
    }
  }

  const fallback = compactArgs(row.args);
  return fallback
    ? theme.fg("muted", fallback)
    : theme.fg("muted", "(no arguments)");
}

function styledCallLabel(
  label: string,
  theme: ThemeLike,
  color = "muted",
): string {
  const plain = sanitizeInline(stripAnsi(label)).trim();
  const match = /^(\S+)(.*)$/s.exec(plain);
  if (!match) return theme.fg(color, plain);
  const rest = match[2] ?? "";
  return (
    theme.fg(color, theme.bold(match[1] ?? "")) +
    (rest ? theme.fg(color, `:${rest}`) : "")
  );
}

function collapsedCallLabel(
  row: ToolExecutionRow,
  width: number,
  theme: ThemeLike,
  color = "muted",
): string {
  if (row.getRenderShell?.() === "self") {
    return styledCallLabel(selfRenderedCallLabel(row), theme, color);
  }

  const token = row.toolName === "bash" ? "$" : (row.toolName ?? "tool");
  const summary = renderedCallSummary(row, Math.max(1, width), theme);
  const plainSummary = stripAnsi(summary).trim();
  const label = plainSummary ? `${token} ${plainSummary}` : token;
  return styledCallLabel(label, theme, color);
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
  if (isLiveRow(row)) {
    const elapsed = liveElapsedText(row);
    return theme.fg("warning", elapsed ? `… · ${elapsed}` : "…");
  }
  if (row.getRenderShell?.() === "self") {
    const editStat = renderedEditDiffStat(row);
    if (editStat) return theme.fg("muted", `→ ${editStat}`);
    return renderedGenericOutcome(theme);
  }
  return renderedOutcome(row, theme);
}

function collapsedHeadline(
  row: ToolExecutionRow,
  width: number,
  theme: ThemeLike,
): string {
  // Failed rows render entirely in error so the row reads as the one that
  // failed, not just its outcome tail. Only the tool name is bold.
  const color = rowHasFailed(row) ? "error" : "muted";
  const marker = `${theme.fg(
    color,
    row.toolName === "subagent" ? SUBAGENT_MARKER : GROUP_MARKER,
  )} `;
  const budget = Math.max(1, width - visibleWidth(marker));
  const label = collapsedCallLabel(row, budget, theme, color);
  const outcome = collapsedOutcome(row, budget, theme);
  // The truncation suffix inherits the row tone; pi-tui's truncation resets
  // around a plain suffix, which would render it in the terminal default
  // foreground instead of the row color.
  const suffix = theme.fg(color, "…");
  return (
    marker +
    (outcome
      ? fitSummaryTail(label, outcome, budget, suffix)
      : fitSummary(label, budget, suffix))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

type SubagentStep = {
  agent: string;
  profile: string | undefined;
  task: string;
};

type SubagentPlan = {
  kind: "single" | "parallel" | "chain";
  scope: string;
  steps: SubagentStep[];
};

function parseSubagentArgs(args: unknown): SubagentPlan | undefined {
  if (!isRecord(args)) return undefined;
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
      // The subagent extension suppresses the profile badge when a model
      // override is present; mirror that here.
      profile:
        typeof item.profile === "string" &&
        item.profile.trim() &&
        item.model === undefined
          ? item.profile.trim()
          : undefined,
      task: item.task,
    };
  };

  if (hasParallel) {
    const steps = (args.tasks as unknown[]).map(parseStep);
    if (steps.some((step) => step === undefined)) return undefined;
    return { kind: "parallel", scope, steps: steps as SubagentStep[] };
  }
  if (hasChain) {
    const steps = (args.chain as unknown[]).map(parseStep);
    if (steps.some((step) => step === undefined)) return undefined;
    return { kind: "chain", scope, steps: steps as SubagentStep[] };
  }
  const single = parseStep(args);
  if (!single) return undefined;
  return { kind: "single", scope, steps: [single] };
}

// Splits a scraped plan line's content into the agent display name (which may
// carry a leading emoji) and the remaining badge/preview text.
function parseStepContent(content: string): {
  displayName: string;
  bareName: string;
  rest: string;
} {
  const tokens = content.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { displayName: "", bareName: "", rest: "" };
  const first = tokens[0]!;
  const hasEmoji = [...first].some((char) => (char.codePointAt(0) ?? 0) > 0x7f);
  const nameTokens = hasEmoji && tokens.length > 1 ? 2 : 1;
  const displayName = tokens.slice(0, nameTokens).join(" ");
  return {
    displayName,
    bareName: tokens[nameTokens - 1] ?? displayName,
    rest: tokens.slice(nameTokens).join(" "),
  };
}

// Agent display names (emoji + name) come from the subagent extension's own
// call component when available; args only carry the bare agent name.
function scrapeSubagentDisplayNames(
  row: ToolExecutionRow,
): Map<string, string> {
  const names = new Map<string, string>();
  let component = row.callRendererComponent;
  if (!component && Array.isArray(row.contentBox?.children)) {
    component = row.contentBox.children[0] as ComponentLike | undefined;
  }
  if (!component || typeof component.render !== "function") return names;
  try {
    for (const raw of component.render(120)) {
      const line = sanitizeInline(stripAnsi(raw)).trim();
      if (!line || /^subagent\b/.test(line)) continue;
      const { displayName, bareName } = parseStepContent(
        line.replace(/^\d+\.\s*/, ""),
      );
      if (displayName && bareName && displayName !== bareName) {
        names.set(bareName, displayName);
      }
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

// Subagents render as an ordinary unboxed tool block: a `%` heading with the
// plan kind/count/scope, then the numbered chain steps or parallel tasks with
// agent names in accent. Everything else stays muted (or error on failure),
// matching the shared tool-row aesthetic.
function renderSubagentPlan(
  row: ToolExecutionRow,
  width: number,
  theme: ThemeLike,
): string[] | undefined {
  const plan = parseSubagentArgs(row.args);
  if (!plan || width < 12) return undefined;

  const failed = rowHasFailed(row);
  const color = failed ? "error" : "muted";
  const nameColor = failed ? "error" : "accent";
  const suffix = theme.fg(color, "…");
  const displayNames = scrapeSubagentDisplayNames(row);
  // Agent/profile/task values are model-supplied; sanitize them like every
  // other collapsed-row text so control bytes cannot reach the terminal.
  const displayOf = (agent: string) =>
    theme.fg(nameColor, displayNames.get(agent) ?? sanitizeInline(agent));
  const detailOf = (step: SubagentStep) =>
    theme.fg(
      color,
      `${step.profile ? ` [${sanitizeInline(step.profile)}]` : ""} ${subagentStepPreview(step.task)}`,
    );

  const marker = `${theme.fg(color, theme.bold(SUBAGENT_MARKER))} `;
  const budget = Math.max(1, width - visibleWidth(marker));
  const outcome = failed
    ? collapsedOutcome(row, budget, theme)
    : isLiveRow(row)
      ? collapsedOutcome(row, budget, theme)
      : row.result
        ? renderedGenericOutcome(theme)
        : theme.fg("warning", "…");
  const headline = (label: string) =>
    marker +
    (outcome
      ? fitSummaryTail(label, outcome, budget, suffix)
      : fitSummary(label, budget, suffix));

  if (plan.kind === "single") {
    const step = plan.steps[0]!;
    return [
      headline(
        theme.fg(color, theme.bold("subagent")) +
          " " +
          displayOf(step.agent) +
          detailOf(step),
      ),
    ];
  }

  const kindLabel =
    plan.kind === "chain"
      ? `chain (${plan.steps.length} ${plan.steps.length === 1 ? "step" : "steps"})`
      : `parallel (${plan.steps.length} tasks)`;
  const lines = [
    headline(
      theme.fg(color, theme.bold("subagent")) +
        " " +
        theme.fg(color, kindLabel) +
        theme.fg(color, ` [${plan.scope}]`),
    ),
  ];
  const shown = plan.steps.slice(0, 3);
  for (let index = 0; index < shown.length; index++) {
    const step = shown[index]!;
    const number =
      plan.kind === "chain" ? `${theme.fg(color, `${index + 1}.`)} ` : "";
    lines.push(`  ${number}${displayOf(step.agent)}${detailOf(step)}`);
  }
  if (plan.steps.length > shown.length) {
    lines.push(
      `  ${theme.fg(color, `... +${plan.steps.length - shown.length} more`)}`,
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
      ...wrapTextWithAnsi(
        theme.fg("toolOutput", sanitized),
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
): string[] {
  const layout = insetLayout(width);
  const plan =
    row.toolName === "subagent"
      ? renderSubagentPlan(row, layout.contentWidth, theme)
      : undefined;
  const body = plan ?? [collapsedHeadline(row, layout.contentWidth, theme)];
  if (row.toolName === "edit") {
    body.push(...renderedEditDiffLines(row, theme));
  }
  body.push(...imageResultLines(row, layout.contentWidth, theme));
  return ["", ...insetLines(body, width)];
}

function groupedCallComponent(
  rows: ToolExecutionRow[],
  theme: ThemeLike,
): ComponentLike {
  return {
    render(width: number): string[] {
      // Every member renders like a singleton — `% tool: call → outcome` per
      // line with the tool name bolded — no bullets or internal blanks;
      // settled edits keep their change visible with a bounded diff block.
      return rows.flatMap((row) => [
        collapsedHeadline(row, width, theme),
        ...(row.toolName === "edit" ? renderedEditDiffLines(row, theme) : []),
      ]);
    },
    invalidate() {},
  };
}

function sameMembers(
  left: ToolExecutionRow[],
  right: ToolExecutionRow[],
): boolean {
  return (
    left.length === right.length &&
    left.every((member, index) => member === right[index])
  );
}

function sameMemberVersions(
  rows: ToolExecutionRow[],
  versions: number[],
  state: PresentationPatchState,
): boolean {
  return (
    rows.length === versions.length &&
    rows.every(
      (row, index) => (state.rowVersions.get(row) ?? 0) === versions[index],
    )
  );
}

function renderGroupedToolRows(
  row: ToolExecutionRow,
  rows: ToolExecutionRow[],
  width: number,
  state: PresentationPatchState,
): string[] {
  const theme = state.theme;
  if (!theme) return state.originalRender.call(row, width);
  const themeSample = themeSampleFor(theme);
  const cached = state.groupCache.get(row);
  const hasLiveMembers = rows.some(isLiveRow);
  if (
    !hasLiveMembers &&
    cached &&
    cached.width === width &&
    cached.themeSample === themeSample &&
    sameMembers(cached.members, rows) &&
    sameMemberVersions(rows, cached.memberVersions, state)
  ) {
    return cached.lines;
  }

  const layout = insetLayout(width);
  const summary = groupedCallComponent(rows, theme);
  const lines = ["", ...insetLines(summary.render(layout.contentWidth), width)];
  if (hasLiveMembers) {
    state.groupCache.delete(row);
  } else {
    state.groupCache.set(row, {
      lines,
      members: [...rows],
      memberVersions: rows.map((member) => state.rowVersions.get(member) ?? 0),
      themeSample,
      width,
    });
  }
  return lines;
}

function renderContainerWithToolGroups(
  children: unknown[],
  width: number,
  presentation: PresentationPatchState,
): string[] {
  const lines: string[] = [];
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
      lines.push(...renderAt(index));
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
      lines.push(...renderAt(index));
      continue;
    }

    for (const member of group) presentation.rowGroups.set(member, group);
    // Use a live member while any call is pending, then the first member once
    // settled. Either way, the grouped row keeps the same number of lines.
    const shellRow = group.find(isLiveRow) ?? child;
    lines.push(...renderGroupedToolRows(shellRow, group, width, presentation));
    index = lastMemberIndex;
  }

  return lines;
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
    if (existing) {
      existing.presentation = presentation;
      existing.disabled = false;
      return existing;
    }

    const state: GroupingPatchState = {
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
        return renderContainerWithToolGroups(
          children,
          width,
          state.presentation,
        );
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
  if (!state) return;
  // Even when another extension's wrapper sits on top of ours, grouping must
  // not outlive its owner: the wrapper delegates once disabled, and a later
  // reinstall re-enables it.
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
    if (existing) return existing;
    const legacy = proto[LEGACY_PRESENTATION_PATCHED];
    if (legacy) {
      proto.render = legacy.originalRender;
      proto.updateDisplay = legacy.originalUpdateDisplay;
    }
    if (
      typeof proto.render !== "function" ||
      typeof proto.updateDisplay !== "function"
    )
      return undefined;

    const state: PresentationPatchState = {
      collapseParallel: envEnabled(COLLAPSE_PARALLEL_ENV, true),
      groupCache: new WeakMap(),
      collapsedCache: new WeakMap(),
      rowVersions: new WeakMap(),
      rowGroups: new WeakMap(),
      rowSignatures: new WeakMap(),
      originalRender: proto.render,
      originalUpdateDisplay: proto.updateDisplay,
    };
    const patchedUpdateDisplay = function updateDisplayWithCollapsedResult(
      this: ToolExecutionRow,
    ): void {
      // Group members always bump so their leader's cache refreshes; other
      // rows only bump on state transitions, so bash's per-second invalidate
      // ticks and resize invalidations stop busting caches.
      const signature = rowSignatureOf(this);
      if (
        state.rowGroups.has(this) ||
        state.rowSignatures.get(this) !== signature
      ) {
        state.rowSignatures.set(this, signature);
        state.rowVersions.set(this, (state.rowVersions.get(this) ?? 0) + 1);
        state.groupCache.delete(this);
      }
      state.originalUpdateDisplay.call(this);
    };
    const patchedRender = function renderWithToolPresentation(
      this: ToolExecutionRow,
      width: number,
    ): string[] {
      const theme = state.theme;
      if (
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
      // Settled rows (not partial, not expanded) have fully static render
      // output, so their collapsed lines are cached keyed by width +
      // rowSignatureOf + rowVersions + theme sample. updateDisplay bumps
      // rowVersions on every real state transition, and partial rows
      // bypass the cache entirely because their content streams. This
      // mirrors the existing groupCache discipline; keep them in sync.
      // ================================================================
      if (!this.isPartial) {
        const signature = rowSignatureOf(this);
        const version = state.rowVersions.get(this) ?? 0;
        const themeSample = themeSampleFor(theme);
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
        if (lines.length === 0 && (this.imageComponents?.length ?? 0) === 0) {
          return lines;
        }
        try {
          const collapsed = renderCollapsedToolRow(this, width, theme);
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
      if (lines.length === 0 && (this.imageComponents?.length ?? 0) === 0) {
        return lines;
      }
      try {
        return renderCollapsedToolRow(this, width, theme);
      } catch {
        return lines;
      }
    };

    try {
      state.patchedUpdateDisplay = patchedUpdateDisplay;
      state.patchedRender = patchedRender;
      proto.updateDisplay = patchedUpdateDisplay;
      proto.render = patchedRender;
      Object.defineProperty(proto, PRESENTATION_PATCHED, {
        configurable: true,
        value: state,
      });
    } catch {
      proto.updateDisplay = state.originalUpdateDisplay;
      proto.render = state.originalRender;
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
  if (!state) return;
  const proto =
    ToolExecutionComponent?.prototype as unknown as ToolExecutionRow & {
      [PRESENTATION_PATCHED]?: PresentationPatchState;
      render?: (width: number) => string[];
      updateDisplay?: () => void;
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
  delete proto[PRESENTATION_PATCHED];
}

export default function (pi: ExtensionAPI) {
  const patch = installPresentationPatch();
  const grouping = patch ? installGroupingPatch(patch) : undefined;

  pi.on("session_start", (_event, ctx) => {
    if (patch) patch.theme = ctx.ui.theme;
    ctx.ui.setToolsExpanded(false);
  });

  pi.on("session_shutdown", () => {
    uninstallGroupingPatch(grouping);
    uninstallPresentationPatch(patch);
  });
}
