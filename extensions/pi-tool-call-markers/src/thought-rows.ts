import { truncateToWidth } from "@earendil-works/pi-tui";
import { fgCollapsedRail, fgCollapsedThinking } from "./muted.ts";
import { sanitizeInline } from "./sanitize.ts";

// A hidden thought is a collapsed placeholder, like a collapsed tool call, so
// an assistant row that shows nothing but hidden-thinking labels joins the
// tool-call rail instead of breaking it. Recognition is structural: the row's
// content must be blank spacers plus text nodes carrying the row's own
// hidden-thinking label. Any visible trace, prose, or error text keeps the
// row a native boundary, so Ctrl+T and click-to-reveal fall back naturally.

export const THOUGHT_GLYPH = "✦";
const RAIL_MARKER = "│";
// Pi's braille spinner frames; a label led by one is still streaming.
const SPINNER_RE = /^([\u2800-\u28ff])\s+(.*)$/u;
const SETTLED_RE = /^\+\s+(.*)$/u;

type ThoughtTheme = {
  fg(color: string, text: string): string;
  bold?(text: string): string;
  getFgAnsi?(color: string): string;
};

type MouseTarget = { handleMouse?(event: unknown): unknown };

type AssistantRowShape = {
  hiddenThinkingLabel?: unknown;
  contentContainer?: { children?: unknown[] };
};

export type HiddenThought = {
  // Plain label text, e.g. `+ Thought · 2.5s` or `⠋ Thinking…`.
  label: string;
  // The label nodes (Pi wraps each in a click-to-reveal MouseRegion), in order.
  regions: unknown[];
};

function rendersBlank(component: unknown): boolean {
  const render = (component as { render?: unknown } | undefined)?.render;
  if (typeof render !== "function") return false;
  const lines = (render as (width: number) => unknown).call(component, 80);
  return (
    Array.isArray(lines) &&
    lines.every(
      (line) => typeof line === "string" && sanitizeInline(line).trim() === "",
    )
  );
}

function plainLabel(text: string): string {
  return sanitizeInline(text).trim();
}

export function hiddenThoughtOf(component: unknown): HiddenThought | undefined {
  const row = component as AssistantRowShape | undefined;
  if (typeof row?.hiddenThinkingLabel !== "string") return undefined;
  const label = plainLabel(row.hiddenThinkingLabel);
  const children = row.contentContainer?.children;
  if (!label || !Array.isArray(children)) return undefined;
  const regions: unknown[] = [];
  for (const child of children) {
    const inner = (child as { child?: unknown } | undefined)?.child ?? child;
    const text = (inner as { text?: unknown } | undefined)?.text;
    if (typeof text === "string") {
      if (plainLabel(text) !== label) return undefined;
      regions.push(child);
      continue;
    }
    if (!rendersBlank(child)) return undefined;
  }
  return regions.length > 0 ? { label, regions } : undefined;
}

// One rail row per label. The live spinner takes the glyph slot and settles
// into `✦` in place, so the row count never changes as thinking finishes.
export function thoughtRowLine(
  label: string,
  width: number,
  theme: ThoughtTheme,
): string {
  const live = SPINNER_RE.exec(label);
  const settled = live ? undefined : SETTLED_RE.exec(label);
  const glyph = live
    ? theme.fg("warning", live[1]!)
    : fgCollapsedThinking(theme, THOUGHT_GLYPH, true);
  const text = live?.[2] ?? settled?.[1] ?? label;
  const line = `${fgCollapsedRail(theme, RAIL_MARKER)} ${glyph} ${fgCollapsedThinking(theme, text)}`;
  return truncateToWidth(
    line,
    Math.max(1, width),
    fgCollapsedThinking(theme, "…"),
    false,
  );
}

// Click routing for a grouped thought line: forward to the label's own
// MouseRegion so a click still reveals the trace, which then renders as
// visible content and leaves the group.
export function thoughtMouseTarget(region: unknown): MouseTarget {
  return {
    handleMouse(event: unknown) {
      const target = region as MouseTarget | undefined;
      if (typeof target?.handleMouse !== "function") return undefined;
      return target.handleMouse({
        ...(event as Record<string, unknown>),
        y: 0,
        height: 1,
      });
    },
  };
}
