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
  rendererState?: { startedAt?: unknown; endedAt?: unknown };
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
  groupCache: WeakMap<ToolExecutionRow, GroupRenderCache>;
  rowVersions: WeakMap<ToolExecutionRow, number>;
  // A row's settled shape is decided the first time it renders settled and
  // never changes afterwards, so live output only ever grows downwards.
  rowModes: WeakMap<ToolExecutionRow, "individual" | ToolExecutionRow[]>;
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
    row.result.isError ||
    hasImageResult(row) ||
    row.getRenderShell?.() === "self"
  )
    return;

  const collapsed = row.hasRendererDefinition?.()
    ? removeResultComponent(row.contentBox)
    : collapseGenericResult(row);
  if (collapsed) {
    hideResultImages(row);
    decorateSuccessfulCall(row, theme);
  }
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
    row.getRenderShell?.() !== "self" &&
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
    !row.result.isError &&
    !hasImageResult(row)
  );
}

function isSettledToolRow(row: ToolExecutionRow): boolean {
  return row.isPartial === false && !!row.result;
}

function hasUnsettledToolInBatch(
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
      if (isToolExecutionRow(candidate)) {
        if (!isSettledToolRow(candidate)) return true;
        continue;
      }
      if (renderAt(candidateIndex).some(hasVisibleContent)) break;
    }
  }
  return false;
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

function truncatePlain(text: string, width: number, suffix = "…"): string {
  const max = Math.max(0, width);
  const plain = stripAnsi(text);
  if (visibleWidth(plain) <= max) return plain;

  const suffixWidth = visibleWidth(suffix);
  if (suffixWidth >= max) return sliceByColumn(suffix, 0, max, true);
  return `${sliceByColumn(plain, 0, max - suffixWidth, true)}${suffix}`;
}

function fitSummary(summary: string, width: number): string {
  const max = Math.max(1, width);
  return visibleWidth(summary) <= max ? summary : truncatePlain(summary, max);
}

function fitSummaryTail(head: string, tail: string, width: number): string {
  const max = Math.max(1, width);
  const summary = `${head.trimEnd()} ${tail}`;
  if (visibleWidth(summary) <= max) return summary;

  const tailWidth = visibleWidth(tail);
  if (tailWidth >= max) return truncatePlain(tail, max);
  return `${truncatePlain(head, max - tailWidth - 1)} ${tail}`;
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
      const lineIndex = lines.findIndex(hasVisibleContent);
      if (lineIndex === -1) return lines;
      const line = lines[lineIndex];
      if (line === undefined) return lines;
      const next = [...lines];
      next[lineIndex] = fitSummaryTail(
        trimRenderedLine(line),
        outcome,
        Math.max(1, width - BADGE_WIDTH),
      );
      return next;
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
  let component = row.callRendererComponent;
  if (!component && Array.isArray(row.contentBox?.children)) {
    component = row.contentBox.children[0] as ComponentLike | undefined;
  }

  const selfRendered = row.getRenderShell?.() === "self";
  if (component && typeof component.render === "function") {
    const visibleLines = component
      .render(Math.max(1, width))
      .filter(hasVisibleContent);
    const rendered = visibleLines.slice(0, selfRendered ? 1 : 3);
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

  if (selfRendered) return theme.fg("muted", "(details omitted)");

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
        const outcome = renderedOutcome(row, theme);
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
    theme.bg("toolSuccessBg", "x");
  const cached = state.groupCache.get(row);
  if (
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
    const box = new Box(1, 1, (text) => theme.bg("toolSuccessBg", text));
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
  state.groupCache.set(row, {
    lines: decorated,
    members: [...rows],
    memberVersions: rows.map((member) => state.rowVersions.get(member) ?? 0),
    themeSample,
    width,
  });
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
    if (!isToolExecutionRow(child) || !isCollapsibleSuccess(child)) {
      lines.push(...renderAt(index));
      continue;
    }
    const decided = presentation.rowModes.get(child);
    if (decided === "individual") {
      lines.push(...renderAt(index));
      continue;
    }
    if (Array.isArray(decided)) {
      // A decided group is sticky, but transient states like Ctrl+O expansion
      // still render members in full until they become collapsible again.
      if (!decided.every(isCollapsibleSuccess)) {
        lines.push(...renderAt(index));
        continue;
      }
      const lastMember = decided[decided.length - 1];
      let lastMemberIndex = index;
      for (
        let candidateIndex = index + 1;
        candidateIndex < children.length;
        candidateIndex++
      ) {
        if (children[candidateIndex] === lastMember) {
          lastMemberIndex = candidateIndex;
          break;
        }
      }
      lines.push(...renderGroupedToolRows(child, decided, width, presentation));
      index = lastMemberIndex;
      continue;
    }

    // Undecided row: pick its settled shape once. A row that first settles
    // next to an active sibling stays individual forever, so live batches
    // never regroup after the fact; only batches that are fully settled on
    // first render (e.g. restored history) become groups.
    if (hasUnsettledToolInBatch(children, index, renderAt)) {
      presentation.rowModes.set(child, "individual");
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
        if (!isCollapsibleSuccess(candidate)) break;
        if (presentation.rowModes.has(candidate)) break;
        group.push(candidate);
        lastMemberIndex = candidateIndex;
        continue;
      }
      if (renderAt(candidateIndex).some(hasVisibleContent)) break;
    }

    if (group.length === 1) {
      presentation.rowModes.set(child, "individual");
      lines.push(...renderAt(index));
      continue;
    }

    for (const member of group) presentation.rowModes.set(member, group);
    lines.push(...renderGroupedToolRows(child, group, width, presentation));
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
      groupCache: new WeakMap(),
      rowVersions: new WeakMap(),
      rowModes: new WeakMap(),
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
        Array.isArray(state.rowModes.get(this)) ||
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
