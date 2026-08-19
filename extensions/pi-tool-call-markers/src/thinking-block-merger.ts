import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AssistantMessageComponent } from "@earendil-works/pi-coding-agent";

const THINKING_GROUPING_PATCHED = Symbol.for("kg.pi.thinkingGrouping.v1");
const PI_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;

// Visual experiment for the settled "+ Thought" label. "inherit" keeps Pi's
// native styling (italic + thinkingText); "gray" sits halfway between the
// muted and text theme colors. The env var overrides the default so the
// variants can be compared without editing code or republishing.
const THOUGHT_LABEL_COLOR_ENV = "PI_TOOL_CALL_MARKERS_THOUGHT_COLOR";
type ThoughtLabelColor = "inherit" | "orange" | "gray";
const DEFAULT_THOUGHT_LABEL_COLOR: ThoughtLabelColor = "orange";
// cobalt2's orange token (#ffb86c).
const THOUGHT_LABEL_ORANGE = { r: 255, g: 184, b: 108 };

function thoughtLabelColorChoice(): ThoughtLabelColor {
  const raw = process.env[THOUGHT_LABEL_COLOR_ENV];
  return raw === "inherit" || raw === "orange" || raw === "gray"
    ? raw
    : DEFAULT_THOUGHT_LABEL_COLOR;
}

const CUBE_VALUES = [0, 95, 135, 175, 215, 255];
const BASIC_ANSI_RGB: Array<[number, string] | undefined> = [
  [0, "#000000"],
  [1, "#800000"],
  [2, "#008000"],
  [3, "#808000"],
  [4, "#000080"],
  [5, "#800080"],
  [6, "#008080"],
  [7, "#c0c0c0"],
  [8, "#808080"],
  [9, "#ff0000"],
  [10, "#00ff00"],
  [11, "#ffff00"],
  [12, "#0000ff"],
  [13, "#ff00ff"],
  [14, "#00ffff"],
  [15, "#ffffff"],
];

type Rgb = { r: number; g: number; b: number };

type ThemeDetail = {
  fg(color: string, text: string): string;
  getFgAnsi?(color: string): string;
  getColorMode?(): "truecolor" | "256color" | string;
};

let activeTheme: ThemeDetail | undefined;

function hexToRgb(hex: string): Rgb | undefined {
  const match = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return undefined;
  const value = parseInt(match[1]!, 16);
  return { r: value >> 16, g: (value >> 8) & 255, b: value & 255 };
}

// Mirrors Pi's own mapping so a named color can round-trip through a
// 256-color terminal (e.g. when COLORFGBG forces 256color mode).
function ansi256ToRgb(index: number): Rgb | undefined {
  if (index < 16) {
    const hex = BASIC_ANSI_RGB[index]?.[1];
    return hex ? hexToRgb(hex) : undefined;
  }
  if (index < 232) {
    const cube = index - 16;
    const channel = (n: number) => (n === 0 ? 0 : 55 + n * 40);
    return {
      r: channel(Math.floor(cube / 36)),
      g: channel(Math.floor((cube % 36) / 6)),
      b: channel(cube % 6),
    };
  }
  const gray = 8 + (index - 232) * 10;
  return { r: gray, g: gray, b: gray };
}

function rgbToAnsi256({ r, g, b }: Rgb): number {
  const nearest = (value: number) =>
    CUBE_VALUES.reduce(
      (best, candidate) =>
        Math.abs(candidate - value) < Math.abs(best - value) ? candidate : best,
      0,
    );
  const cubeR = nearest(r);
  const cubeG = nearest(g);
  const cubeB = nearest(b);
  const cubeDistance =
    (r - cubeR) ** 2 * 0.299 +
    (g - cubeG) ** 2 * 0.587 +
    (b - cubeB) ** 2 * 0.114;
  const luminance = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
  const grayStep = Math.max(0, Math.min(23, Math.round((luminance - 8) / 10)));
  const grayValue = 8 + grayStep * 10;
  const grayDistance = (luminance - grayValue) ** 2;
  const spread = Math.max(r, g, b) - Math.min(r, g, b);
  if (spread < 10 && grayDistance < cubeDistance) return 232 + grayStep;
  return (
    16 +
    36 * CUBE_VALUES.indexOf(cubeR) +
    6 * CUBE_VALUES.indexOf(cubeG) +
    CUBE_VALUES.indexOf(cubeB)
  );
}

function parseAnsiFgRgb(ansi: string): Rgb | undefined {
  if (/^\x1b\[39m$/.test(ansi)) return undefined;
  const truecolor = /^\x1b\[38;2;(\d+);(\d+);(\d+)m$/.exec(ansi);
  if (truecolor) {
    return {
      r: Number(truecolor[1]),
      g: Number(truecolor[2]),
      b: Number(truecolor[3]),
    };
  }
  const indexed = /^\x1b\[38;5;(\d+)m$/.exec(ansi);
  if (indexed) return ansi256ToRgb(Number(indexed[1]));
  const basic = /^\x1b\[(9[0-7]|3[0-7])m$/.exec(ansi);
  if (basic) {
    const code = Number(basic[1]);
    return ansi256ToRgb(code >= 90 ? code - 90 + 8 : code - 30);
  }
  return undefined;
}

function fgRgbAnsi({ r, g, b }: Rgb): string {
  if (activeTheme?.getColorMode?.() === "256color") {
    return `\x1b[38;5;${rgbToAnsi256({ r, g, b })}m`;
  }
  return `\x1b[38;2;${r};${g};${b}m`;
}

function midpointRgb(a: Rgb, b: Rgb): Rgb {
  return {
    r: Math.round((a.r + b.r) / 2),
    g: Math.round((a.g + b.g) / 2),
    b: Math.round((a.b + b.b) / 2),
  };
}

let thoughtLabelPrefix = "";
let thoughtLabelSuffix = "";

function updateThoughtLabelStyle(): void {
  thoughtLabelPrefix = "";
  thoughtLabelSuffix = "";
  const choice = thoughtLabelColorChoice();
  if (choice === "inherit" || !activeTheme) return;

  let rgb: Rgb | undefined;
  if (choice === "orange") {
    rgb = THOUGHT_LABEL_ORANGE;
  } else if (activeTheme.getFgAnsi) {
    const muted = parseAnsiFgRgb(activeTheme.getFgAnsi("muted"));
    const text = parseAnsiFgRgb(activeTheme.getFgAnsi("text"));
    if (muted && text) rgb = midpointRgb(muted, text);
  }
  if (!rgb) return;

  // The styled label replaces Pi's italicized Text node wholesale (see
  // restyleHiddenThinkingLabel). The leading italic-off still matters: the
  // TUI's diff renderer can skip bytes shared with the previously drawn
  // italic line, leaving the terminal in italic state otherwise.
  thoughtLabelPrefix = `\x1b[23m${fgRgbAnsi(rgb)}`;
  thoughtLabelSuffix = "\x1b[39m";
}

export function visibleThoughtLabel(label: string): string {
  if (!thoughtLabelPrefix) return label;
  const raw = label.replace(/\x1b\[[0-9;]*m/g, "");
  return `${thoughtLabelPrefix}${raw}${thoughtLabelSuffix}`;
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
};

// Pi renders the hidden-thinking label as an italic Text node built from the
// plain label field. Embedding style codes in the field itself is not
// enough: the TUI diff renderer reuses the byte prefix shared with the
// previous (italic) frame, so an in-line italic reset may never reach the
// terminal. Swap the node's text for a self-contained styled version after
// each native render pass instead.
function restyleHiddenThinkingLabel(row: AssistantMessageRow): void {
  if (!thoughtLabelPrefix) return;
  if (
    row.hideThinkingBlock !== true ||
    typeof row.hiddenThinkingLabel !== "string"
  ) {
    return;
  }
  const label = row.hiddenThinkingLabel;
  const children = row.contentContainer?.children;
  if (!Array.isArray(children)) return;
  const styled = visibleThoughtLabel(label);
  for (const child of children) {
    const textChild = child as TextLikeChild | undefined;
    if (
      typeof textChild?.text !== "string" ||
      typeof textChild.setText !== "function" ||
      !textChild.text.includes(label)
    ) {
      continue;
    }
    textChild.setText(styled);
  }
}

type ThinkingTiming = {
  finishedAt?: number;
  startedAt: number;
};

type ThinkingGroupingPatchState = {
  originalUpdateContent: (
    message: AssistantMessageLike,
    ...args: unknown[]
  ) => void;
  patchedUpdateContent?: (
    message: AssistantMessageLike,
    ...args: unknown[]
  ) => void;
  timings: WeakMap<AssistantMessageRow, ThinkingTiming>;
};

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

function thinkingSpinner(startedAt: number, now: number): string {
  const frame = Math.floor(Math.max(0, now - startedAt) / SPINNER_INTERVAL_MS);
  return PI_SPINNER_FRAMES[frame % PI_SPINNER_FRAMES.length]!;
}

function lifecycleLabel(
  row: AssistantMessageRow,
  streaming: boolean | undefined,
  timings: WeakMap<AssistantMessageRow, ThinkingTiming>,
): string {
  const now = Date.now();
  let current = timings.get(row);
  if (streaming === true) {
    if (!current || current.finishedAt !== undefined) {
      current = { startedAt: now };
      timings.set(row, current);
    }
    return `${thinkingSpinner(current.startedAt, now)} Thinking…`;
  }

  if (streaming === undefined && current?.finishedAt === undefined && current) {
    // Pi can rebuild a live row on resize/theme changes without forwarding
    // the optional streaming flag. Keep its active label until an explicit
    // final update arrives.
    return `${thinkingSpinner(current.startedAt, now)} Thinking…`;
  }

  if (streaming === false && current?.finishedAt === undefined) {
    if (current) current.finishedAt = now;
  }

  const settled = timings.get(row);
  if (settled?.finishedAt !== undefined) {
    return `+ Thought · ${formatThoughtDuration(settled.startedAt, settled.finishedAt)}`;
  }
  return "+ Thought";
}

function applyHiddenThinkingLabel(
  row: AssistantMessageRow,
  message: AssistantMessageLike,
  streaming: boolean | undefined,
  timings: WeakMap<AssistantMessageRow, ThinkingTiming>,
): void {
  // Record the component's first streaming update even when the provider has
  // not emitted a non-empty thinking block yet.
  const label = lifecycleLabel(row, streaming, timings);
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
    if (existing) return existing;

    const state: ThinkingGroupingPatchState = {
      originalUpdateContent: proto.updateContent,
      timings: new WeakMap(),
    };
    const patchedUpdateContent = function updateContentWithCombinedThinking(
      this: AssistantMessageRow,
      message: AssistantMessageLike,
      ...args: unknown[]
    ): void {
      // Grouping and labels are cosmetic. Each fails open independently, and
      // the original renderer is still called exactly once with every arg.
      let combined = message;
      try {
        combined = combineAdjacentThinking(message);
      } catch {
        // Preserve the original message intact.
      }
      try {
        const streaming = typeof args[0] === "boolean" ? args[0] : undefined;
        applyHiddenThinkingLabel(this, combined, streaming, state.timings);
      } catch {
        // Preserve Pi's native label if its private row shape changes.
      }
      Reflect.apply(state.originalUpdateContent, this, [combined, ...args]);
      try {
        restyleHiddenThinkingLabel(this);
      } catch {
        // Keep Pi's native label styling if the row shape changes.
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
): void {
  if (!state) return;
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
    return;
  }
  proto.updateContent = state.originalUpdateContent;
  delete proto[THINKING_GROUPING_PATCHED];
}

export default function (pi: ExtensionAPI) {
  const patch = installThinkingGroupingPatch();
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    activeTheme = ctx.ui.theme as unknown as ThemeDetail;
    updateThoughtLabelStyle();
  });
  pi.on("session_shutdown", () => {
    activeTheme = undefined;
    thoughtLabelPrefix = "";
    thoughtLabelSuffix = "";
    uninstallThinkingGroupingPatch(patch);
  });
}
