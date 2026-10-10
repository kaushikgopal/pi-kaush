import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AssistantMessageComponent } from "@earendil-works/pi-coding-agent";
import { infoVisibilityHidden } from "./info-visibility-state.ts";
import { collapsedThinkingAnsi } from "./muted.ts";

const THINKING_GROUPING_PATCHED = Symbol.for("kg.pi.thinkingGrouping.v2");
const PI_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;

// Visual treatment for the collapsed thinking label. The live "Thinking…"
// spinner tints with the session's active thinking-level color
// (thinkingOff…thinkingMax), so progress reads as activity; the settled
// "│ * Thought" row drops to the muted token collapsed tool calls use, so
// finished reasoning stops advertising the level. "inherit" keeps Pi's
// native styling (italic + thinkingText) for both states, and "mdheading"
// rides the theme's mdHeading token for both. The env var overrides the
// default so variants can be compared without republishing. Only the
// collapsed label is restyled — the expanded thinking block keeps Pi's
// thinkingText.
const THOUGHT_LABEL_COLOR_ENV = "PI_TOOL_CALL_MARKERS_THOUGHT_COLOR";
type ThoughtLabelColor = "inherit" | "level" | "mdheading";
const DEFAULT_THOUGHT_LABEL_COLOR: ThoughtLabelColor = "level";

function thoughtLabelColorChoice(): ThoughtLabelColor {
  const raw = process.env[THOUGHT_LABEL_COLOR_ENV];
  return raw === "inherit" || raw === "level" || raw === "mdheading"
    ? raw
    : DEFAULT_THOUGHT_LABEL_COLOR;
}

// thinkingLevel values map onto theme tokens: "xhigh" → thinkingXhigh etc.
const LEVEL_TOKEN: Record<string, string> = {
  off: "thinkingOff",
  minimal: "thinkingMinimal",
  low: "thinkingLow",
  medium: "thinkingMedium",
  high: "thinkingHigh",
  xhigh: "thinkingXhigh",
  max: "thinkingMax",
};

type ThemeDetail = {
  fg(color: string, text: string): string;
  getFgAnsi?(color: string): string;
  getColorMode?(): "truecolor" | "256color" | string;
};

// Live reference into the UI context: reading .theme per check keeps label
// styles current across mid-session theme switches, which fire no event.
let themeProvider: (() => ThemeDetail | undefined) | undefined;
let activeLevel: (() => string) | undefined;
// Pi builds both thinking labels italic. The default treatment replaces that
// with a plain row: italic-off always leads — the TUI diff renderer can skip
// bytes shared with the previous italic frame, which would leave the terminal
// italic — plus the resolved color when the theme supplies one. The `inherit`
// variant is the only choice that keeps Pi's native italic styling.
const ITALIC_OFF = "\x1b[23m";

type LabelStyle = { prefix: string; suffix: string };

// The package styles labels only inside a session it can read the theme from.
// `inherit` is the other native case: it keeps Pi's italic labels.
function stylesThinkingLabels(): boolean {
  return themeProvider !== undefined && thoughtLabelColorChoice() !== "inherit";
}

function styledWith(
  token: string,
  theme: ThemeDetail | undefined,
): LabelStyle | undefined {
  // Pi's Theme throws on a token it does not know, so probe the way muted.ts
  // does: an unresolvable color costs the label its tint, never the row.
  let ansi: string | undefined;
  try {
    const resolved = theme?.getFgAnsi?.(token);
    if (typeof resolved === "string") ansi = resolved;
  } catch {
    ansi = undefined;
  }
  if (!ansi) return undefined;
  return { prefix: `${ITALIC_OFF}${ansi}`, suffix: "\x1b[39m" };
}

// The theme's collapsedThinkingCall override when defined, else its comment
// color, else the muted token.
function settledMutedStyle(theme: ThemeDetail): LabelStyle | undefined {
  const ansi = collapsedThinkingAnsi(theme);
  if (ansi) return { prefix: `${ITALIC_OFF}${ansi}`, suffix: "\x1b[39m" };
  return styledWith("muted", theme);
}

// Resolved per label, never cached: Pi swaps the colors behind a stable theme
// Proxy, so a cached style would survive a theme switch and repaint the
// transcript in the old palette.
function labelStyle(
  settled: boolean,
  theme: ThemeDetail,
): LabelStyle | undefined {
  const choice = thoughtLabelColorChoice();
  if (settled && choice !== "mdheading") return settledMutedStyle(theme);
  const token =
    choice === "mdheading"
      ? "mdHeading"
      : (LEVEL_TOKEN[activeLevel?.() ?? "off"] ?? "thinkingOff");
  return styledWith(token, theme);
}

// Both labels wear the collapsed tool-row anchor — faint rail, bold glyph —
// so reasoning reads like the tool calls around it. The live spinner holds
// the glyph slot and settles into `*` in place: the rail and the label text
// keep their columns, and only the glyph, the words, and the tint change.
const THOUGHT_RAIL = "│";
const THOUGHT_GLYPH = "*";
const SETTLED_THOUGHT = `${THOUGHT_RAIL} ${THOUGHT_GLYPH} Thought`;
const ANCHORED_LABEL_RE = /^│ (\S) (.*)$/su;

function isSettledThoughtLabel(label: string): boolean {
  return label.startsWith(SETTLED_THOUGHT);
}

// The rail keeps the settled collapsed tone in both states, like a pending
// tool row's rail, so settling never repaints it.
function styledAnchoredLabel(
  raw: string,
  style: LabelStyle,
  theme: ThemeDetail,
): string {
  const match = ANCHORED_LABEL_RE.exec(raw);
  if (!match) return `${style.prefix}${raw}${style.suffix}`;
  const rail = settledMutedStyle(theme) ?? style;
  const railText = `\x1b[2m${THOUGHT_RAIL}\x1b[22m`;
  const body = ` \x1b[1m${match[1]}\x1b[22m ${match[2]}${style.suffix}`;
  return rail.prefix === style.prefix
    ? `${style.prefix}${railText}${body}`
    : `${rail.prefix}${railText}${rail.suffix}${style.prefix}${body}`;
}

export function visibleThoughtLabel(label: string): string {
  if (!stylesThinkingLabels()) return label;
  const raw = label.replace(/\x1b\[[0-9;]*m/g, "");
  const theme = themeProvider?.();
  const settled = isSettledThoughtLabel(raw);
  const style = theme ? labelStyle(settled, theme) : undefined;
  // A theme that cannot resolve a color still drops Pi's italics.
  if (!style || !theme) return `${ITALIC_OFF}${raw}`;
  return styledAnchoredLabel(raw, style, theme);
}

type AssistantMessageLike = {
  content?: unknown[];
};

type AssistantMessageRow = {
  hiddenThinkingLabel?: unknown;
  hideThinkingBlock?: unknown;
  contentContainer?: { children?: unknown[] };
  updateContent(message: AssistantMessageLike, ...args: unknown[]): void;
};

type TextLikeChild = {
  text?: unknown;
  setText?(text: string): void;
  render?(width: number): string[];
};

type MarkdownLikeChild = {
  defaultTextStyle?: { italic?: boolean };
  invalidate?(): void;
};

// Pi renders a visible thinking trace as italic markdown. Italic is the live
// cue — a settled trace drops it and reads as ordinary transcript text — and
// the italic default style is what identifies the trace: Pi passes it for
// thinking content and for nothing else. Callers gate on the row actually
// carrying thinking, so no other italic block is touched.
// Pi 1.0 wraps each thinking child in a MouseRegion (click toggles
// visibility); older versions hang the Markdown/Text directly. Walk both
// shapes so the restyle reaches the node either way.
function contentNodes(row: AssistantMessageRow): unknown[] {
  const children = row.contentContainer?.children;
  if (!Array.isArray(children)) return [];
  const nodes: unknown[] = [];
  for (const child of children) {
    nodes.push(child);
    const inner = (child as { child?: unknown } | undefined)?.child;
    if (inner !== undefined && inner !== null) nodes.push(inner);
  }
  return nodes;
}

function unitalicizeSettledThinking(row: AssistantMessageRow): void {
  for (const child of contentNodes(row)) {
    const markdown = child as MarkdownLikeChild | undefined;
    const style = markdown?.defaultTextStyle;
    if (style?.italic !== true) continue;
    style.italic = false;
    markdown?.invalidate?.();
  }
}

// Pi renders the hidden-thinking label as an italic Text node built from the
// plain label field. Embedding style codes in the field itself is not
// enough: the TUI diff renderer reuses the byte prefix shared with the
// previous (italic) frame, so an in-line italic reset may never reach the
// terminal. Swap the node's text for a self-contained styled version after
// each native render pass instead.
//
// Only label nodes qualify. Answer prose and a click-revealed trace are
// Markdown nodes that also carry `text` and `setText`, so Markdown never
// matches, and a candidate's plain text must equal the label exactly. Pi 1.0
// wraps each thinking run in a MouseRegion; each child is judged on its own,
// unwrapped when it has a wrapped inner.
function hiddenLabelNodes(row: AssistantMessageRow): unknown[] {
  const children = row.contentContainer?.children;
  if (!Array.isArray(children)) return [];
  return children
    .map((child) => (child as { child?: unknown } | undefined)?.child ?? child)
    .filter((node) => !isMarkdownLike(node));
}

// Duck-typed, not `instanceof`: a locally loaded extension can resolve its
// own pi-tui copy, so class identity is not shared with Pi's. pi-tui's
// Markdown declares `theme` and `defaultTextStyle` fields; Text has neither.
function isMarkdownLike(node: unknown): boolean {
  return (
    !!node &&
    typeof node === "object" &&
    ("defaultTextStyle" in node || "theme" in node)
  );
}

function plainText(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

// A live label re-reads the clock whenever the TUI draws it, so the spinner
// steps with the redraws Pi's working indicator already drives instead of
// freezing between bursty thinking deltas. Pi rebuilds the label node on
// every content update, so the override dies with the node; no timer is
// added, and with no redraws the spinner still advances on each delta.
function animateLiveLabel(node: TextLikeChild, startedAt: number): void {
  const render = node.render;
  if (typeof render !== "function") return;
  node.render = function renderLiveThinkingLabel(
    this: TextLikeChild,
    width: number,
  ): string[] {
    try {
      const styled = visibleThoughtLabel(
        liveThinkingLabel(startedAt, Date.now()),
      );
      if (this.text !== styled) this.setText?.(styled);
    } catch {
      // Keep the last frame if styling fails mid-render.
    }
    return Reflect.apply(render, this, [width]) as string[];
  };
}

function restyleHiddenThinkingLabel(
  row: AssistantMessageRow,
  liveSince?: number,
): void {
  if (
    row.hideThinkingBlock !== true ||
    typeof row.hiddenThinkingLabel !== "string"
  ) {
    return;
  }
  const label = row.hiddenThinkingLabel;
  if (!stylesThinkingLabels()) return;
  const styled = visibleThoughtLabel(label);
  const plainLabel = plainText(label);
  for (const child of hiddenLabelNodes(row)) {
    const textChild = child as TextLikeChild | undefined;
    if (
      typeof textChild?.text !== "string" ||
      typeof textChild.setText !== "function" ||
      plainText(textChild.text) !== plainLabel
    ) {
      continue;
    }
    textChild.setText(styled);
    if (liveSince !== undefined) animateLiveLabel(textChild, liveSince);
  }
}

type ThinkingTiming = {
  finishedAt?: number;
  startedAt: number;
};

type ThinkingGroupingPatchState = {
  owners: number;
  // Set at the final owner's shutdown. A wrapper another extension has buried
  // cannot be uninstalled, so it delegates instead of outliving its owner; a
  // later install re-enables it.
  disabled?: boolean;
  originalUpdateContent: (
    message: AssistantMessageLike,
    ...args: unknown[]
  ) => void;
  patchedUpdateContent?: (
    message: AssistantMessageLike,
    ...args: unknown[]
  ) => void;
  timings: WeakMap<AssistantMessageRow, ThinkingTiming>;
  // Last update per tracked row, so /toggle-info can replay rows without
  // waiting for new content. Only rows that carry thinking change under the
  // toggle, and the map is capped so a long session or an abandoned branch
  // cannot pin every message the transcript ever showed.
  rows: Map<
    AssistantMessageRow,
    { message: AssistantMessageLike; args: unknown[] }
  >;
};

const MAX_REPLAY_ROWS = 400;

// Bookkeeping only, so it fails open: a message whose content shape throws
// must not take the row's update pass down with it.
function trackReplayRow(
  state: ThinkingGroupingPatchState,
  row: AssistantMessageRow,
  message: AssistantMessageLike,
  args: unknown[],
): void {
  try {
    // A tracked row keeps tracking even when its final content drops
    // thinking, so a replay never resurrects an earlier streaming snapshot.
    if (!hasThinkingContent(message) && !state.rows.has(row)) return;
    state.rows.set(row, { message, args });
    while (state.rows.size > MAX_REPLAY_ROWS) {
      const oldest = state.rows.keys().next().value;
      if (oldest === undefined) return;
      state.rows.delete(oldest);
    }
  } catch {
    // The row keeps its native rendering; only /toggle-info replay misses it.
  }
}

type ThinkingContentLike = {
  type: "thinking";
  thinking: string;
  [key: string]: unknown;
};

function isThinkingContent(content: unknown): content is ThinkingContentLike {
  return (
    !!content &&
    typeof content === "object" &&
    (content as { type?: unknown }).type === "thinking" &&
    typeof (content as { thinking?: unknown }).thinking === "string"
  );
}

function hasThinkingContent(message: AssistantMessageLike): boolean {
  return (
    Array.isArray(message.content) &&
    message.content.some(
      (content) =>
        isThinkingContent(content) && content.thinking.trim().length > 0,
    )
  );
}

function combineAdjacentThinking(
  message: AssistantMessageLike,
): AssistantMessageLike {
  if (!Array.isArray(message.content)) return message;

  // Merge a display-only copy; provider blocks and signatures stay untouched.
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

function formatThoughtDuration(startedAt: number, finishedAt: number): string {
  return `${(Math.max(0, finishedAt - startedAt) / 1000).toFixed(1)}s`;
}

function liveThinkingLabel(startedAt: number, now: number): string {
  return `${THOUGHT_RAIL} ${thinkingSpinner(startedAt, now)} Thinking…`;
}

function thinkingSpinner(startedAt: number, now: number): string {
  const frame = Math.floor(Math.max(0, now - startedAt) / SPINNER_INTERVAL_MS);
  return PI_SPINNER_FRAMES[frame % PI_SPINNER_FRAMES.length]!;
}

// A row is live while it streams, and stays live through un-flagged rebuilds
// (resize, theme switch, /reload) until an explicit final update arrives.
// Rows that never carry the flag — restored history, older runtimes — count
// as settled.
function thinkingStillLive(
  streaming: boolean | undefined,
  timing: ThinkingTiming | undefined,
): boolean {
  if (streaming === true) return true;
  return (
    streaming === undefined &&
    timing !== undefined &&
    timing.finishedAt === undefined
  );
}

// Thinking ends when the answer starts: visible text or a tool call after
// the last thinking block. Settling there keeps the duration honest and
// keeps a live label as the transcript's last line, so its spinner never
// changes a line scrolled above the viewport (which forces a full replay).
function answerStarted(message: AssistantMessageLike): boolean {
  const content = Array.isArray(message.content) ? message.content : [];
  let lastThinking = -1;
  content.forEach((block, index) => {
    if (isThinkingContent(block)) lastThinking = index;
  });
  return content.slice(lastThinking + 1).some((block) => {
    const b = block as { type?: unknown; text?: unknown } | undefined;
    return (
      b?.type === "toolCall" ||
      (b?.type === "text" && typeof b.text === "string" && b.text.trim() !== "")
    );
  });
}

function timingLive(
  streaming: boolean | undefined,
  timing: ThinkingTiming | undefined,
): boolean {
  return (
    streaming !== false &&
    timing !== undefined &&
    timing.finishedAt === undefined
  );
}

function lifecycleLabel(
  row: AssistantMessageRow,
  message: AssistantMessageLike,
  streaming: boolean | undefined,
  timings: WeakMap<AssistantMessageRow, ThinkingTiming>,
): string {
  const now = Date.now();
  const previous = timings.get(row);
  const answering = answerStarted(message);
  if (!answering && thinkingStillLive(streaming, previous)) {
    const current =
      previous && previous.finishedAt === undefined
        ? previous
        : { startedAt: now };
    timings.set(row, current);
    return liveThinkingLabel(current.startedAt, now);
  }

  if (
    (streaming === false || answering) &&
    previous &&
    previous.finishedAt === undefined
  ) {
    previous.finishedAt = now;
  }

  const settled = timings.get(row);
  if (settled?.finishedAt !== undefined) {
    return `${SETTLED_THOUGHT} · ${formatThoughtDuration(settled.startedAt, settled.finishedAt)}`;
  }
  return SETTLED_THOUGHT;
}

function stripThinkingBlocks(
  message: AssistantMessageLike,
): AssistantMessageLike {
  const content = message.content;
  if (!Array.isArray(content) || !content.some(isThinkingContent)) {
    return message;
  }
  return { ...message, content: content.filter((c) => !isThinkingContent(c)) };
}

// Replays the last update on every tracked assistant row so a /toggle-info
// flip applies immediately instead of waiting for the next content pass.
export function refreshThinkingVisibility(): void {
  try {
    const proto = AssistantMessageComponent?.prototype as unknown as {
      [THINKING_GROUPING_PATCHED]?: ThinkingGroupingPatchState;
    };
    const state = proto?.[THINKING_GROUPING_PATCHED];
    if (!state?.patchedUpdateContent) return;
    for (const [row, tracked] of state.rows) {
      try {
        Reflect.apply(state.patchedUpdateContent, row, [
          tracked.message,
          ...tracked.args,
        ]);
      } catch {
        // A row that changed shape mid-flight keeps its last render.
      }
    }
  } catch {
    // Cosmetic replay; never break the toggle.
  }
}

function applyHiddenThinkingLabel(
  row: AssistantMessageRow,
  message: AssistantMessageLike,
  streaming: boolean | undefined,
  timings: WeakMap<AssistantMessageRow, ThinkingTiming>,
): void {
  // Record the component's first streaming update even when the provider has
  // not emitted a non-empty thinking block yet.
  const label = lifecycleLabel(row, message, streaming, timings);
  if (!hasThinkingContent(message)) return;
  if (
    row.hideThinkingBlock !== true ||
    typeof row.hiddenThinkingLabel !== "string"
  ) {
    return;
  }
  // Assign the row-local field directly. The public UI setter relabels every
  // historical assistant row and would make earlier durations change.
  row.hiddenThinkingLabel = label;
}

// TODO: Replace prototype patching with a public assistant-message rendering API.
function installThinkingGroupingPatch():
  | ThinkingGroupingPatchState
  | undefined {
  try {
    const proto =
      AssistantMessageComponent?.prototype as unknown as AssistantMessageRow & {
        [THINKING_GROUPING_PATCHED]?: ThinkingGroupingPatchState;
        updateContent?: (
          message: AssistantMessageLike,
          ...args: unknown[]
        ) => void;
      };
    if (!proto || typeof proto.updateContent !== "function") return undefined;

    const existing = proto[THINKING_GROUPING_PATCHED];
    if (existing) {
      existing.owners++;
      existing.rows ??= new Map();
      existing.disabled = false;
      return existing;
    }

    const state: ThinkingGroupingPatchState = {
      owners: 1,
      originalUpdateContent: proto.updateContent,
      timings: new WeakMap(),
      rows: new Map(),
    };
    const patchedUpdateContent = function updateContentWithCombinedThinking(
      this: AssistantMessageRow,
      message: AssistantMessageLike,
      ...args: unknown[]
    ): void {
      // Grouping and styling are cosmetic. Each fails open independently, and
      // the original renderer is still called exactly once with every arg.
      if (state.disabled) {
        Reflect.apply(state.originalUpdateContent, this, [message, ...args]);
        return;
      }
      trackReplayRow(state, this, message, args);
      const streaming = typeof args[0] === "boolean" ? args[0] : undefined;
      let combined = message;
      try {
        // Pi builds the hidden label and the visible block only when thinking
        // blocks exist, so stripping them hides both at once.
        combined = infoVisibilityHidden()
          ? stripThinkingBlocks(message)
          : combineAdjacentThinking(message);
      } catch {
        // Preserve the original message intact.
      }
      try {
        applyHiddenThinkingLabel(this, combined, streaming, state.timings);
      } catch {
        // Preserve Pi's native label if its private row shape changes.
      }
      Reflect.apply(state.originalUpdateContent, this, [combined, ...args]);
      try {
        if (hasThinkingContent(combined)) {
          const timing = state.timings.get(this);
          const liveSince =
            timing && timingLive(streaming, timing)
              ? timing.startedAt
              : undefined;
          restyleHiddenThinkingLabel(this, liveSince);
        }
      } catch {
        // Keep Pi's native label styling if the row shape changes.
      }
      try {
        if (
          hasThinkingContent(combined) &&
          !timingLive(streaming, state.timings.get(this))
        ) {
          unitalicizeSettledThinking(this);
        }
      } catch {
        // Keep Pi's native italic trace if the row shape changes.
      }
    };

    state.patchedUpdateContent = patchedUpdateContent;
    proto.updateContent = patchedUpdateContent;
    Object.defineProperty(proto, THINKING_GROUPING_PATCHED, {
      configurable: true,
      value: state,
    });
    return state;
  } catch {
    return undefined;
  }
}

function uninstallThinkingGroupingPatch(
  state: ThinkingGroupingPatchState | undefined,
): boolean {
  if (!state || state.owners <= 0) return false;
  state.owners--;
  if (state.owners > 0) return false;
  state.disabled = true;
  const proto =
    AssistantMessageComponent?.prototype as unknown as AssistantMessageRow & {
      [THINKING_GROUPING_PATCHED]?: ThinkingGroupingPatchState;
      updateContent?: (
        message: AssistantMessageLike,
        ...args: unknown[]
      ) => void;
    };
  if (
    proto[THINKING_GROUPING_PATCHED] !== state ||
    proto.updateContent !== state.patchedUpdateContent
  ) {
    return true;
  }
  proto.updateContent = state.originalUpdateContent;
  delete proto[THINKING_GROUPING_PATCHED];
  return true;
}

export default function (pi: ExtensionAPI) {
  const patch = installThinkingGroupingPatch();
  let released = false;
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    try {
      const proto = AssistantMessageComponent?.prototype as unknown as {
        [THINKING_GROUPING_PATCHED]?: ThinkingGroupingPatchState;
      };
      proto?.[THINKING_GROUPING_PATCHED]?.rows.clear();
    } catch {
      // Best effort; stale rows would only linger until the process exits.
    }
    const uiCtx = ctx;
    themeProvider = () => uiCtx.ui?.theme as unknown as ThemeDetail;
    activeLevel = () => {
      try {
        return pi.getThinkingLevel();
      } catch {
        return "off";
      }
    };
  });
  pi.on("session_shutdown", () => {
    if (released) return;
    released = true;
    if (patch && !uninstallThinkingGroupingPatch(patch)) return;
    themeProvider = undefined;
    activeLevel = undefined;
  });
}
