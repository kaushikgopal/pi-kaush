import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export const OUTER_INSET = 2;
export const PROMPT_RAIL = "▎";
const SUBMITTED_SIDE_PADDING = 1;

// Submitted message bodies paint with the theme's userMessageBg token.
// The active editor uses Pi's native terminal background. The legacy hex
// remains only as a fallback for theme lookalikes that cannot resolve it.
const PROMPT_SURFACE_BG_FALLBACK = "\x1b[48;2;7;19;18m"; // #071312

export function promptSurfaceBg(theme: Theme): string {
  try {
    return theme.getBgAnsi("userMessageBg");
  } catch {
    return PROMPT_SURFACE_BG_FALLBACK;
  }
}

const SGR_PATTERN = /\x1b\[([0-9;]*)m/g;
const BACKGROUND_PATTERN =
  /\x1b\[(?:4[0-8]|10[0-7]|48;5;\d{1,3}|48;2;\d{1,3};\d{1,3};\d{1,3})m/g;

export function contentInset(width: number): number {
  return width > OUTER_INSET * 2 ? OUTER_INSET : 0;
}

function semanticControlEnd(text: string, offset: number): number | undefined {
  if (text[offset] !== "\x1b") return undefined;
  const kind = text[offset + 1];
  if (kind !== "]" && kind !== "_" && kind !== "P" && kind !== "^") {
    return undefined;
  }

  for (let index = offset + 2; index < text.length; index++) {
    if (text[index] === "\x07") return index + 1;
    if (text[index] === "\x1b" && text[index + 1] === "\\") {
      return index + 2;
    }
  }
  return undefined;
}

export function splitLeadingSemanticControls(line: string): {
  controls: string;
  content: string;
} {
  let offset = 0;
  while (offset < line.length) {
    const end = semanticControlEnd(line, offset);
    if (end === undefined) break;
    offset = end;
  }
  return { controls: line.slice(0, offset), content: line.slice(offset) };
}

export function fitLine(line: string, width: number): string {
  if (width <= 0) return "";
  const clipped = truncateToWidth(line, width, "");
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

export function insetLines(
  lines: string[],
  width: number,
  inset = contentInset(width),
): string[] {
  if (inset === 0) return lines.map((line) => fitLine(line, width));
  const contentWidth = Math.max(1, width - inset * 2);
  const margin = " ".repeat(inset);
  return lines.map((line) => {
    const { controls, content } = splitLeadingSemanticControls(line);
    return `${controls}${margin}${fitLine(content, contentWidth)}${margin}`;
  });
}

function reapplyBackgroundAfterReset(
  text: string,
  backgroundAnsi: string,
): string {
  return text.replace(SGR_PATTERN, (sequence, rawParameters: string) => {
    const parameters =
      rawParameters === "" ? [0] : rawParameters.split(";").map(Number);
    return parameters.includes(0) || parameters.includes(49)
      ? `${sequence}${backgroundAnsi}`
      : sequence;
  });
}

export function paintBackground(
  line: string,
  width: number,
  backgroundAnsi: string,
): string {
  const fitted = fitLine(line, width);
  // Mirrors Theme.bg: background, content, then a background-only reset.
  return `${backgroundAnsi}${reapplyBackgroundAfterReset(fitted, backgroundAnsi)}\x1b[49m`;
}

function replaceBackground(text: string, backgroundAnsi: string): string {
  return text.replace(BACKGROUND_PATTERN, backgroundAnsi);
}

export function renderSubmittedUserLines(
  lines: string[],
  width: number,
  theme: Theme,
  inset = contentInset(width),
  railColor: ThemeColor = "borderAccent",
): string[] {
  const blockWidth = width - inset * 2;
  if (inset === 0 || blockWidth <= visibleWidth(PROMPT_RAIL)) {
    return lines.map((line) => fitLine(line, width));
  }

  const bodyWidth = blockWidth - visibleWidth(PROMPT_RAIL);
  const margin = " ".repeat(inset);
  const surfaceBg = promptSurfaceBg(theme);
  return lines.map((line) => {
    const { controls, content } = splitLeadingSemanticControls(line);
    const recolored = replaceBackground(content, surfaceBg);
    const rail = theme.fg(railColor, PROMPT_RAIL);
    // The rail glyph (▎) fills only the left quarter of its cell, so one
    // column of left padding already reads as a two-column visual gap.
    // Give the right edge two columns so both sides of the text read equal.
    const leftPadding = " ".repeat(SUBMITTED_SIDE_PADDING);
    const rightPadding = " ".repeat(SUBMITTED_SIDE_PADDING + 1);
    const innerWidth = Math.max(1, bodyWidth - SUBMITTED_SIDE_PADDING * 2 - 1);
    const body = paintBackground(
      `${leftPadding}${fitLine(recolored, innerWidth)}${rightPadding}`,
      bodyWidth,
      surfaceBg,
    );
    return `${controls}${margin}${rail}${body}${margin}`;
  });
}
