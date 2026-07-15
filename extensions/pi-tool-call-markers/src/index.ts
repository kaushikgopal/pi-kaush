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
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

const BADGE = " ⚙️";
const BADGE_WIDTH = visibleWidth(BADGE);
const PRESENTATION_PATCHED = Symbol.for("kg.pi.toolPresentation.v3");
const LEGACY_PRESENTATION_PATCHED = Symbol.for("kg.pi.toolPresentation.v2");
const GROUPING_PATCHED = Symbol.for("kg.pi.toolGrouping.v1");
const THINKING_GROUPING_PATCHED = Symbol.for("kg.pi.thinkingGrouping.v1");
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
  result?: { isError?: boolean };
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

type AssistantMessageLike = {
  content?: unknown[];
};

type AssistantMessageRow = {
  updateContent(message: AssistantMessageLike): void;
};

type ThinkingGroupingPatchState = {
  originalUpdateContent: (message: AssistantMessageLike) => void;
  patchedUpdateContent?: (message: AssistantMessageLike) => void;
};

type ThinkingContentLike = {
  type: "thinking";
  thinking: string;
  [key: string]: unknown;
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

function collapseSuccessfulResult(row: ToolExecutionRow): void {
  if (row.expanded !== false || !row.result || row.result.isError) return;

  const collapsed = row.hasRendererDefinition?.()
    ? removeResultComponent(
        row.getRenderShell?.() === "self"
          ? row.selfRenderContainer
          : row.contentBox,
      )
    : collapseGenericResult(row);
  if (collapsed) hideResultImages(row);
}

function isToolExecutionRow(
  component: unknown,
): component is ToolExecutionRow & ComponentLike {
  return component instanceof ToolExecutionComponent;
}

function isCollapsibleSuccess(row: ToolExecutionRow): boolean {
  return (
    row.expanded === false &&
    row.isPartial === false &&
    !!row.result &&
    !row.result.isError
  );
}

function renderComponent(component: unknown, width: number): string[] {
  if (!component || typeof (component as ComponentLike).render !== "function")
    return [];
  return (component as ComponentLike).render(width);
}

function isThinkingContent(content: unknown): content is ThinkingContentLike {
  return (
    !!content &&
    typeof content === "object" &&
    (content as { type?: unknown }).type === "thinking" &&
    typeof (content as { thinking?: unknown }).thinking === "string"
  );
}

function combineAdjacentThinking(
  message: AssistantMessageLike,
): AssistantMessageLike {
  if (!Array.isArray(message.content)) return message;

  // Merge a display-only copy; the original provider blocks and their signatures stay untouched.
  let changed = false;
  const content: unknown[] = [];
  for (const block of message.content) {
    const previous = content.at(-1);
    if (isThinkingContent(previous) && isThinkingContent(block)) {
      content[content.length - 1] = {
        ...previous,
        thinking: `${previous.thinking.trim()}\n\n${block.thinking.trim()}`,
      };
      changed = true;
      continue;
    }
    content.push(block);
  }

  return changed ? { ...message, content } : message;
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

function wrappedBulletLines(
  summary: string,
  width: number,
  theme: ThemeLike,
): string[] {
  const prefix = `  ${theme.fg("muted", "•")} `;
  const indent = visibleWidth(prefix);
  if (width <= indent) return [truncateToWidth(prefix, width, "", false)];

  const wrapped = wrapTextWithAnsi(summary, width - indent);
  return wrapped.map((line, index) => {
    const linePrefix = index === 0 ? prefix : " ".repeat(indent);
    return truncateToWidth(linePrefix + line, width, "", false);
  });
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
        const summary = renderedCallSummary(row, Math.max(1, width - 4), theme);
        lines.push(...wrappedBulletLines(summary, width, theme));
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

    const group: ToolExecutionRow[] = [child];
    let lastMemberIndex = index;
    for (
      let candidateIndex = index + 1;
      candidateIndex < children.length;
      candidateIndex++
    ) {
      const candidate = children[candidateIndex];
      if (isToolExecutionRow(candidate)) {
        if (!isCollapsibleSuccess(candidate)) break;
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

    lines.push(...renderGroupedToolRows(child, group, width, presentation));
    index = lastMemberIndex;
  }

  return lines;
}

// TODO: Replace prototype patching with a public Pi tool/transcript rendering API when available.
function installThinkingGroupingPatch():
  | ThinkingGroupingPatchState
  | undefined {
  try {
    const proto =
      AssistantMessageComponent?.prototype as unknown as AssistantMessageRow & {
        [THINKING_GROUPING_PATCHED]?: ThinkingGroupingPatchState;
        updateContent?: (message: AssistantMessageLike) => void;
      };
    if (!proto || typeof proto.updateContent !== "function") return undefined;

    const existing = proto[THINKING_GROUPING_PATCHED];
    if (existing) return existing;

    const state: ThinkingGroupingPatchState = {
      originalUpdateContent: proto.updateContent,
    };
    const patchedUpdateContent = function updateContentWithCombinedThinking(
      this: AssistantMessageRow,
      message: AssistantMessageLike,
    ): void {
      // Combine adjacent thinking blocks for display, but fall back to the original
      // message if combining throws. Either way, invoke Pi's renderer exactly once.
      let combined = message;
      try {
        combined = combineAdjacentThinking(message);
      } catch {
        // Thinking grouping is cosmetic; preserve the original message intact.
      }
      state.originalUpdateContent.call(this, combined);
    };

    state.patchedUpdateContent = patchedUpdateContent;
    proto.updateContent = patchedUpdateContent;
    Object.defineProperty(proto, THINKING_GROUPING_PATCHED, {
      configurable: true,
      value: state,
    });
    return state;
  } catch {
    // Thinking grouping is cosmetic; preserve Pi's renderer if its internals change.
    return undefined;
  }
}

function uninstallThinkingGroupingPatch(
  state: ThinkingGroupingPatchState | undefined,
): void {
  if (!state) return;
  const proto =
    AssistantMessageComponent?.prototype as unknown as AssistantMessageRow & {
      [THINKING_GROUPING_PATCHED]?: ThinkingGroupingPatchState;
      updateContent?: (message: AssistantMessageLike) => void;
    };
  if (
    proto[THINKING_GROUPING_PATCHED] !== state ||
    proto.updateContent !== state.patchedUpdateContent
  )
    return;
  proto.updateContent = state.originalUpdateContent;
  delete proto[THINKING_GROUPING_PATCHED];
}

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
      originalRender: proto.render,
      originalUpdateDisplay: proto.updateDisplay,
    };
    const patchedUpdateDisplay = function updateDisplayWithCollapsedResult(
      this: ToolExecutionRow,
    ): void {
      state.rowVersions.set(this, (state.rowVersions.get(this) ?? 0) + 1);
      state.groupCache.delete(this);
      state.originalUpdateDisplay.call(this);
      try {
        if (this.result?.isError && this.expanded === false) {
          this.expanded = true;
          state.originalUpdateDisplay.call(this);
        }
        collapseSuccessfulResult(this);
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
  const thinkingGrouping = installThinkingGroupingPatch();

  pi.on("session_start", (_event, ctx) => {
    if (patch) patch.theme = ctx.ui.theme;
    ctx.ui.setToolsExpanded(false);
  });

  pi.on("session_shutdown", () => {
    uninstallThinkingGroupingPatch(thinkingGrouping);
    uninstallGroupingPatch(grouping);
    uninstallPresentationPatch(patch);
  });
}
