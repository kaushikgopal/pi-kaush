import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  AssistantMessageComponent,
  ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import {
  Box,
  Container,
  sliceByColumn,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";

const BADGE = " ⚙️";
const BADGE_WIDTH = visibleWidth(BADGE);
const PRESENTATION_PATCHED = Symbol.for("kg.pi.toolPresentation.v3");
const LEGACY_PRESENTATION_PATCHED = Symbol.for("kg.pi.toolPresentation.v2");
const GROUPING_PATCHED = Symbol.for("kg.pi.toolGrouping.v1");
const ANSI_RE = /\u001b\[[0-9;]*m/g;
const BOLD_ON_RE = /\u001b\[1m/g;
const COLLAPSE_PARALLEL_ENV = "PI_TOOL_CALL_MARKERS_COLLAPSE_PARALLEL";

type ThemeLike = {
  bold(text: string): string;
  fg(color: string, text: string): string;
  bg(color: string, text: string): string;
};

type ComponentLike = {
  render(width: number): string[];
  invalidate(): void;
};

type ComponentContainer = ComponentLike & {
  children?: unknown[];
  removeChild?(component: unknown): void;
};

type TextComponent = {
  text?: string;
  setText?(text: string): void;
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
  contentText?: TextComponent;
  selfRenderContainer?: ComponentContainer;
  callRendererComponent?: ComponentLike;
  imageComponents?: unknown[];
  imageSpacers?: unknown[];
  hasRendererDefinition?(): boolean;
  getRenderShell?(): "default" | "self";
  getTextOutput?(): string;
  removeChild?(component: unknown): void;
};

type PresentationPatchState = {
  theme?: ThemeLike;
  collapseParallel: boolean;
  groupCache: WeakMap<ToolExecutionRow, GroupRenderCache>;
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
};

type GroupRenderCache = {
  lines: string[];
  members: ToolExecutionRow[];
  memberVersions: number[];
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

function hasVisibleContent(line: string): boolean {
  return stripAnsi(line).trim().length > 0;
}

function prefixBadge(line: string): string {
  let index = 0;
  while (line[index] === "\x1b" && line[index + 1] === "[") {
    const end = line.indexOf("m", index + 2);
    if (end === -1) break;
    index = end + 1;
  }
  return line.slice(0, index) + BADGE + line.slice(index);
}

function hasGearBadge(line: string): boolean {
  return stripAnsi(line).trimStart().startsWith("⚙️");
}

function boldLeadingToolToken(
  line: string,
  token: string,
  theme: ThemeLike,
): string {
  const visible = stripAnsi(line);
  const prefix = visible.match(/^\s*(?:⚙️\s*)?/)?.[0] ?? "";
  if (!visible.startsWith(token, prefix.length)) return line;

  const start = visibleWidth(prefix);
  const tokenWidth = visibleWidth(token);
  const before = sliceByColumn(line, 0, start);
  const styledToken = sliceByColumn(line, start, tokenWidth);
  const after = sliceByColumn(
    line,
    start + tokenWidth,
    visibleWidth(line),
  ).replace(BOLD_ON_RE, "");
  return before + theme.bold(styledToken) + "\x1b[22m" + after;
}

function decorateHeader(
  row: ToolExecutionRow,
  lines: string[],
  width: number,
  theme?: ThemeLike,
): string[] {
  const lineIndex = lines.findIndex(hasVisibleContent);
  if (lineIndex === -1) return lines;

  const next = [...lines];
  let header = next[lineIndex];
  if (header === undefined) return lines;
  if (!hasGearBadge(header) && width > BADGE_WIDTH) {
    header = truncateToWidth(prefixBadge(header), width, "", false);
  }

  const token = row.toolName === "bash" ? "$" : row.toolName;
  if (theme && token) header = boldLeadingToolToken(header, token, theme);
  next[lineIndex] = header;
  return next;
}

function removeResultComponent(container?: ComponentContainer): boolean {
  if (
    !container ||
    !Array.isArray(container.children) ||
    typeof container.removeChild !== "function"
  )
    return false;
  for (const child of container.children.slice(1)) container.removeChild(child);
  return true;
}

function collapseGenericResult(row: ToolExecutionRow): boolean {
  const text = row.contentText?.text;
  if (
    typeof text !== "string" ||
    typeof row.contentText?.setText !== "function"
  )
    return false;

  const output = row.getTextOutput?.();
  if (!output) return true;
  const suffix = `\n${output}`;
  if (!text.endsWith(suffix)) return false;
  row.contentText.setText(text.slice(0, -suffix.length));
  return true;
}

function hideResultImages(row: ToolExecutionRow): void {
  if (typeof row.removeChild !== "function") return;
  for (const image of row.imageComponents ?? []) row.removeChild(image);
  for (const spacer of row.imageSpacers ?? []) row.removeChild(spacer);
  row.imageComponents = [];
  row.imageSpacers = [];
}

function collapseSuccessfulResult(
  row: ToolExecutionRow,
  theme?: ThemeLike,
): void {
  if (
    row.expanded !== false ||
    row.isPartial !== false ||
    !row.result ||
    hasImageResult(row)
  )
    return;

  if (row.getRenderShell?.() === "self") {
    collapseSelfRenderedRow(row, theme);
    return;
  }

  // Default-shell failures keep Pi's native error render, which already
  // applies the error background. rowHasFailed also catches MCP tools that
  // use the default shell (e.g. mcpScript) and report via details.error.
  if (rowHasFailed(row)) return;

  const collapsed = row.hasRendererDefinition?.()
    ? removeResultComponent(row.contentBox)
    : collapseGenericResult(row);
  if (collapsed) {
    hideResultImages(row);
    decorateSuccessfulCall(row, theme);
  }
}

// Self-rendered tools (e.g. MCP adapter rows) own their framing, so there is
// no result component to trim. Swap the whole container for a single summary
// line in the same style as collapsed default-shell rows. Pi rebuilds the
// container on every updateDisplay, so this never corrupts expanded renders.
// Failures collapse too, with the error background and the first error line,
// since MCP error output tends to be a huge markdown blob.
function collapseSelfRenderedRow(
  row: ToolExecutionRow,
  theme?: ThemeLike,
): void {
  const container = row.selfRenderContainer;
  if (!theme || !container || !Array.isArray(container.children)) return;

  const failed = rowHasFailed(row);
  const tail = failed
    ? renderedErrorOutcome(row, theme)
    : (renderedOutcome(row, theme) ?? renderedGenericOutcome(theme));
  const box = new Box(1, 1, (text) =>
    theme.bg(failed ? "toolErrorBg" : "toolSuccessBg", text),
  );
  box.addChild(
    selfRenderedSummaryComponent(row, theme, tail, failed ? 0.5 : 1),
  );
  container.children = [box];
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
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "error";
  return `${theme.fg("muted", "→")} ${theme.fg("error", firstLine)}`;
}

function selfRenderedSummaryComponent(
  row: ToolExecutionRow,
  theme: ThemeLike,
  tail: string,
  maxTailShare = 1,
): ComponentLike {
  return {
    render(width: number): string[] {
      // The Box already shrinks our width by its horizontal padding before
      // calling render, so only the badge deducts from this headline;
      // counting the padding again starves the label at narrow widths.
      const budget = Math.max(1, width - BADGE_WIDTH);
      const summary = selfRenderedSummary(row, budget);
      // Long error lines would otherwise evict the call summary entirely;
      // cap the tail's share so the label always survives.
      const cappedTail =
        maxTailShare >= 1
          ? tail
          : capFailureTail(tail, Math.floor(budget * maxTailShare), theme);
      return [fitSummaryTail(summary, cappedTail, budget)];
    },
    invalidate() {},
  };
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
  const ellipsis = theme.fg("muted", "…");
  const ellipsisWidth = visibleWidth(ellipsis);
  if (cap <= 0) return "";
  if (ellipsisWidth >= cap) return sliceByColumn(tail, 0, cap, true);
  return `${sliceByColumn(tail, 0, cap - ellipsisWidth, true)}${ellipsis}`;
}

function renderedGenericOutcome(theme: ThemeLike): string {
  return `${theme.fg("muted", "→")} ${theme.fg("success", "done")}`;
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

function liveTailText(
  row: ToolExecutionRow,
  droppedVisible: boolean,
  theme?: ThemeLike,
): string | undefined {
  if (!theme) return undefined;
  const elapsed = liveElapsedText(row);
  if (!droppedVisible && !elapsed) return undefined;
  const parts: string[] = [];
  if (droppedVisible) parts.push("…");
  if (elapsed) parts.push("·", elapsed);
  return theme.fg("muted", parts.join(" "));
}

function fitLiveHeader(
  header: string,
  tail: string,
  width: number,
  droppedVisible: boolean,
): string {
  const max = Math.max(1, width);
  const head = header.trimEnd();
  if (visibleWidth(head) + visibleWidth(tail) + 1 <= max)
    return `${head} ${tail}`;
  const headWidth = Math.max(1, max - visibleWidth(tail) - 1);
  const headSuffix = droppedVisible ? "" : "…";
  return `${truncateToWidth(head, headWidth, headSuffix, false)} ${tail}`;
}

// While a call streams or runs, pin it to a single header line with the
// elapsed time inline, so the block never grows and never collapses on
// completion; the header text simply settles into the outcome summary. The
// cap is composed before the Box applies background and padding, so the live
// line keeps the tool background edge to edge and the block's bottom padding.
function capLiveRowDisplay(row: ToolExecutionRow, theme?: ThemeLike): void {
  // Pin live self-rendered rows (e.g. MCP calls) to the same one-line summary
  // they settle into, so the block never grows and hops on completion.
  if (row.getRenderShell?.() === "self") {
    const container = row.selfRenderContainer;
    if (!theme || !container || !Array.isArray(container.children)) return;
    const box = new Box(1, 1, (text) => theme.bg("toolPendingBg", text));
    box.addChild(
      selfRenderedSummaryComponent(row, theme, theme.fg("muted", "…")),
    );
    container.children = [box];
    return;
  }
  if (row.hasRendererDefinition?.()) {
    const container = row.contentBox;
    if (!container || !Array.isArray(container.children)) return;
    const hadExtraChildren = container.children.length > 1;
    removeResultComponent(container);
    const original = container.children[0] as ComponentLike | undefined;
    if (!original || typeof original.render !== "function") return;
    container.children[0] = {
      render(width: number): string[] {
        const lines = original.render(width);
        const headerIndex = lines.findIndex(hasVisibleContent);
        if (headerIndex === -1) return lines;
        const header = lines[headerIndex] ?? "";
        const droppedVisible =
          hadExtraChildren ||
          lines.slice(headerIndex + 1).some(hasVisibleContent);
        const tail = liveTailText(row, droppedVisible, theme);
        return [
          tail ? fitLiveHeader(header, tail, width, droppedVisible) : header,
        ];
      },
      invalidate() {
        original.invalidate();
      },
    };
    return;
  }

  const text = row.contentText;
  if (typeof text?.text !== "string" || typeof text.setText !== "function")
    return;
  const lines = text.text.split("\n");
  const title = lines[0] ?? "";
  const droppedVisible = lines.slice(1).some((line) => line.trim().length > 0);
  const tail = liveTailText(row, droppedVisible, theme);
  text.setText(tail ? `${title} ${tail}` : title);
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
  return `${theme.fg("muted", "→")} ${theme.fg("success", summary)}`;
}

function renderedGroupedOutcome(
  row: ToolExecutionRow,
  theme: ThemeLike,
): string | undefined {
  const outcome = renderedOutcome(row, theme);
  if (outcome) return outcome;
  if (isLiveRow(row)) {
    const elapsed = liveElapsedText(row);
    return theme.fg("muted", elapsed ? `· ${elapsed}` : "…");
  }
  // Self-rendered tools have no per-tool outcome summary; keep the group's
  // settled tail consistent with collapsed singletons.
  if (row.getRenderShell?.() === "self") return renderedGenericOutcome(theme);
  return undefined;
}

// A budget too small for the suffix keeps literal text instead, so a
// one-column label never collapses into a bare ellipsis.
function truncatePlain(text: string, width: number, suffix = "…"): string {
  const max = Math.max(0, width);
  const plain = stripAnsi(text);
  if (visibleWidth(plain) <= max) return plain;

  const suffixWidth = visibleWidth(suffix);
  if (suffixWidth >= max) return sliceByColumn(plain, 0, max, true);
  return `${sliceByColumn(plain, 0, max - suffixWidth, true)}${suffix}`;
}

function fitSummary(summary: string, width: number): string {
  const max = Math.max(1, width);
  return visibleWidth(summary) <= max ? summary : truncatePlain(summary, max);
}

// Fits "head tail" into width while always reserving at least one literal
// head column plus the joining space; the tail takes what is left and
// disappears entirely when no columns remain.
function fitSummaryTail(head: string, tail: string, width: number): string {
  const max = Math.max(1, width);
  const headWidth = visibleWidth(head);
  const tailWidth = visibleWidth(tail);
  if (headWidth + 1 + tailWidth <= max) return `${head.trimEnd()} ${tail}`;
  if (tailWidth === 0) return truncatePlain(head, max);
  if (headWidth === 0) return truncatePlain(tail, max);

  const labelBudget = Math.min(headWidth, Math.max(1, max - tailWidth - 1));
  const tailBudget = Math.min(tailWidth, Math.max(0, max - labelBudget - 1));
  if (tailBudget === 0) return truncatePlain(head, max);
  const fittedTail =
    tailWidth <= tailBudget ? tail : truncatePlain(tail, tailBudget);
  return `${truncatePlain(head, labelBudget)} ${fittedTail}`;
}

function decorateSuccessfulCall(
  row: ToolExecutionRow,
  theme?: ThemeLike,
): void {
  if (!theme || !Array.isArray(row.contentBox?.children)) return;
  const original = row.contentBox.children[0] as ComponentLike | undefined;
  const outcome = renderedOutcome(row, theme);
  if (!original || typeof original.render !== "function" || !outcome) return;

  row.contentBox.children[0] = {
    render(width: number): string[] {
      const lines = original.render(width);
      const visibleLines = lines.filter(hasVisibleContent);
      const line = visibleLines[0];
      if (line === undefined) return lines;

      const rendered = visibleLines.slice(0, 3).map(trimRenderedLine);
      if (visibleLines.length > rendered.length)
        rendered.push(theme.fg("muted", "…"));
      const summary = rendered.join(theme.fg("muted", " · "));
      return [
        fitSummaryTail(summary, outcome, Math.max(1, width - BADGE_WIDTH)),
      ];
    },
    invalidate() {
      original.invalidate();
    },
  };
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
  const plain = stripAnsi(text);
  const leading = plain.match(/^\s*/)?.[0] ?? "";
  const trimmed = plain.trim();
  if (!trimmed) return "";
  return sliceByColumn(
    text,
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
    ? theme.fg("accent", fallback)
    : theme.fg("muted", "(no arguments)");
}

function compactBulletLine(
  summary: string,
  outcome: string | undefined,
  width: number,
  theme: ThemeLike,
): string {
  const prefix = `  ${theme.fg("muted", "•")} `;
  const indent = visibleWidth(prefix);
  if (width <= indent) return truncateToWidth(prefix, width, "", false);
  const available = width - indent;
  return (
    prefix +
    (outcome
      ? fitSummaryTail(summary, outcome, available)
      : fitSummary(summary, available))
  );
}

function groupedCallComponent(
  rows: ToolExecutionRow[],
  theme: ThemeLike,
): ComponentLike {
  return {
    render(width: number): string[] {
      const lines: string[] = [];
      let previousToolName: string | undefined;
      for (const row of rows) {
        if (lines.length === 0 || row.toolName !== previousToolName) {
          if (lines.length > 0) lines.push("");
          const token =
            row.toolName === "bash" ? "$" : (row.toolName ?? "tool");
          const heading = theme.fg(
            "toolTitle",
            `${BADGE} ${theme.bold(token)}`,
          );
          lines.push(truncateToWidth(heading, width, "", false));
          previousToolName = row.toolName;
        }
        const call = renderedCallSummary(row, Math.max(1, width - 4), theme);
        const outcome = renderedGroupedOutcome(row, theme);
        lines.push(compactBulletLine(call, outcome, width, theme));
      }
      return lines;
    },
    invalidate() {},
  };
}

function renderWithTemporaryChild(
  container: ComponentContainer,
  child: ComponentLike,
  render: () => string[],
): string[] {
  const children = container.children;
  if (!Array.isArray(children)) return render();
  container.children = [child];
  try {
    return render();
  } finally {
    container.children = children;
  }
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
  if (!theme)
    return decorateHeader(
      row,
      state.originalRender.call(row, width),
      width,
      theme,
    );
  const themeSample =
    theme.fg("toolTitle", "x") +
    theme.fg("muted", "x") +
    theme.bg("toolPendingBg", "x") +
    theme.bg("toolSuccessBg", "x");
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

  const summary = groupedCallComponent(rows, theme);
  let lines: string[];
  if (!row.hasRendererDefinition?.()) {
    const text = row.contentText;
    const previous = text?.text;
    if (typeof previous !== "string" || typeof text?.setText !== "function") {
      return decorateHeader(
        row,
        state.originalRender.call(row, width),
        width,
        theme,
      );
    }
    text.setText(summary.render(Math.max(1, width - 2)).join("\n"));
    try {
      lines = state.originalRender.call(row, width);
    } finally {
      text.setText(previous);
    }
  } else if (row.getRenderShell?.() === "self") {
    const container = row.selfRenderContainer;
    if (!container)
      return decorateHeader(
        row,
        state.originalRender.call(row, width),
        width,
        theme,
      );
    const box = new Box(1, 1, (text) =>
      theme.bg(hasLiveMembers ? "toolPendingBg" : "toolSuccessBg", text),
    );
    box.addChild(summary);
    lines = renderWithTemporaryChild(container, box, () =>
      state.originalRender.call(row, width),
    );
  } else {
    const container = row.contentBox;
    if (!container)
      return decorateHeader(
        row,
        state.originalRender.call(row, width),
        width,
        theme,
      );
    lines = renderWithTemporaryChild(container, summary, () =>
      state.originalRender.call(row, width),
    );
  }

  const decorated = decorateHeader(row, lines, width, theme);
  if (hasLiveMembers) {
    state.groupCache.delete(row);
  } else {
    state.groupCache.set(row, {
      lines: decorated,
      members: [...rows],
      memberVersions: rows.map((member) => state.rowVersions.get(member) ?? 0),
      themeSample,
      width,
    });
  }
  return decorated;
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
    // An active member supplies the pending background. Once every call
    // settles, the first member supplies the success background. Either way,
    // the grouped row keeps the same number of lines.
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
      if (!Array.isArray(children) || !children.some(isToolExecutionRow)) {
        return state.originalRender.call(this, width);
      }
      try {
        return renderContainerWithToolGroups(
          children,
          width,
          state.presentation,
        );
      } catch {
        return state.originalRender.call(this, width);
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
      const signature = `${this.isPartial}|${this.expanded}|${this.result ? 1 : 0}|${this.result?.isError ? 1 : 0}`;
      if (
        state.rowGroups.has(this) ||
        state.rowSignatures.get(this) !== signature
      ) {
        state.rowSignatures.set(this, signature);
        state.rowVersions.set(this, (state.rowVersions.get(this) ?? 0) + 1);
        state.groupCache.delete(this);
      }
      state.originalUpdateDisplay.call(this);
      try {
        if (isLiveRow(this)) capLiveRowDisplay(this, state.theme);
        else collapseSuccessfulResult(this, state.theme);
      } catch {
        // Presentation is cosmetic; preserve Pi's renderer if its internals change.
      }
    };
    const patchedRender = function renderWithToolPresentation(
      this: ToolExecutionRow,
      width: number,
    ): string[] {
      const lines = state.originalRender.call(this, width);
      try {
        return decorateHeader(this, lines, width, state.theme);
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
