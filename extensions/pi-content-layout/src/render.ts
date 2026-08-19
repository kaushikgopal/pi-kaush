import type { Theme } from "@earendil-works/pi-coding-agent";
import type { EditorComponent } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export const OUTER_INSET = 2;
export const PROMPT_RAIL = "▎";
export const ACTIVE_SIDE_PADDING = 1;

// The prompt surface (active editor block and submitted message body) uses a
// fixed near-black green tint instead of the theme's selectedBg token so both
// user-input surfaces stay identical; the theme token remains for selections
// and dialogs.
export const PROMPT_SURFACE_BG = "\x1b[48;2;7;19;18m"; // #071312

const BORDER_SENTINEL = "\x1b]133;P;pi-content-layout\x07";
const SGR_PATTERN = /\x1b\[([0-9;]*)m/g;
const BACKGROUND_PATTERN =
  /\x1b\[(?:4[0-8]|10[0-7]|48;5;\d{1,3}|48;2;\d{1,3};\d{1,3};\d{1,3})m/g;
const DISPLAY_ANSI_PATTERN = /\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

type BorderEditor = EditorComponent & {
  borderColor?: (text: string) => string;
};

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

function stripDisplayAnsi(text: string): string {
  return text.replace(DISPLAY_ANSI_PATTERN, "");
}

function scrollHint(line: string): string | undefined {
  return stripDisplayAnsi(line).match(/[↑↓] \d+ more/)?.[0];
}

function activeBlockLine(
  line: string,
  isBoundary: boolean,
  width: number,
  theme: Theme,
): string {
  const hint = isBoundary ? scrollHint(line) : undefined;
  const body = hint ? theme.fg("muted", ` ${hint}`) : isBoundary ? "" : line;
  const innerWidth = Math.max(0, width - ACTIVE_SIDE_PADDING * 2);
  const padding = " ".repeat(ACTIVE_SIDE_PADDING);
  return paintBackground(
    `${padding}${fitLine(body, innerWidth)}${padding}`,
    width,
    PROMPT_SURFACE_BG,
  );
}

function markEditorBoundaries(editor: BorderEditor): () => void {
  const original = editor.borderColor;
  if (typeof original !== "function") return () => {};
  editor.borderColor = (text: string) =>
    `${BORDER_SENTINEL}${original(text)}${BORDER_SENTINEL}`;
  return () => {
    editor.borderColor = original;
  };
}

export function renderActiveEditor(
  editor: BorderEditor,
  width: number,
  theme: Theme,
): string[] {
  const editorWidth = width - ACTIVE_SIDE_PADDING * 2;
  if (editorWidth < 1 || typeof editor.borderColor !== "function") {
    return editor.render(width);
  }

  const restoreBorder = markEditorBoundaries(editor);
  let markedLines: string[];
  try {
    markedLines = editor.render(editorWidth);
  } finally {
    restoreBorder();
  }

  try {
    const boundaries = markedLines
      .map((line, index) => (line.includes(BORDER_SENTINEL) ? index : -1))
      .filter((index) => index >= 0);
    if (boundaries.length !== 2 || boundaries[0] !== 0) {
      return editor.render(width);
    }

    const bottomBoundary = boundaries[1];
    if (bottomBoundary === undefined || bottomBoundary <= 0) {
      return editor.render(width);
    }

    const cleanLines = markedLines.map((line) =>
      line.split(BORDER_SENTINEL).join(""),
    );
    const block = cleanLines
      .slice(0, bottomBoundary + 1)
      .map((line, index) =>
        activeBlockLine(
          line,
          index === 0 || index === bottomBoundary,
          width,
          theme,
        ),
      );
    const suggestions = cleanLines
      .slice(bottomBoundary + 1)
      .map((line) => fitLine(line, width));

    return [...block, ...suggestions];
  } catch {
    return editor.render(width);
  }
}

function replaceBackground(text: string, backgroundAnsi: string): string {
  return text.replace(BACKGROUND_PATTERN, backgroundAnsi);
}

export function renderSubmittedUserLines(
  lines: string[],
  width: number,
  theme: Theme,
  inset = contentInset(width),
): string[] {
  const blockWidth = width - inset * 2;
  if (inset === 0 || blockWidth <= visibleWidth(PROMPT_RAIL)) {
    return lines.map((line) => fitLine(line, width));
  }

  const bodyWidth = blockWidth - visibleWidth(PROMPT_RAIL);
  const margin = " ".repeat(inset);
  return lines.map((line) => {
    const { controls, content } = splitLeadingSemanticControls(line);
    const recolored = replaceBackground(content, PROMPT_SURFACE_BG);
    const rail = theme.fg("accent", PROMPT_RAIL);
    // One extra leading space inside the body, so submitted text sits two
    // columns right of the rail instead of one.
    const body = paintBackground(
      ` ${fitLine(recolored, Math.max(1, bodyWidth - 1))}`,
      bodyWidth,
      PROMPT_SURFACE_BG,
    );
    return `${controls}${margin}${rail}${body}${margin}`;
  });
}
