import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// The submitted-prompt shell, shared by every execution row that should read
// as user input: user-run `!` bash blocks and asked-question blocks. Pi's own
// submitted user messages are drawn with the same rail, surface, inset, and
// body padding by pi-content-layout, which owns the message surface and never
// tool rows. The geometry here mirrors that package's `renderSubmittedUserLines`
// and `contentInset`; change the two together.

export const PROMPT_RAIL = "▎";

export type PromptShellTheme = {
  fg(color: string, text: string): string;
  getBgAnsi?(color: string): string;
};

// The prompt surface paints with the theme's userMessageBg token, matching
// pi-content-layout's surfaces. userMessageBg is a required pi theme token;
// the legacy hex remains only as a fallback for theme lookalikes without
// getBgAnsi.
const PROMPT_SURFACE_BG_FALLBACK = "\x1b[48;2;7;19;18m"; // #071312

const PROMPT_BLOCK_INSET = 2;

function promptSurfaceBg(theme: PromptShellTheme): string {
  try {
    return theme.getBgAnsi?.("userMessageBg") ?? PROMPT_SURFACE_BG_FALLBACK;
  } catch {
    return PROMPT_SURFACE_BG_FALLBACK;
  }
}

// Prompt-shell blocks align with the message inset pi-content-layout applies
// to transcript lines: 2 columns outside the rail for any width above 4.
export function promptBlockInset(width: number): number {
  return width > PROMPT_BLOCK_INSET * 2 ? PROMPT_BLOCK_INSET : 0;
}

// Inside the rail, a block's body is padded on both sides. Pi's submitted user
// messages carry one column left and two right, which the shorter right column
// of the rail glyph's cell makes read as equal. A user `!` block keeps Pi's own
// body and pads left only.
export type PromptBlockPadding = { left: number; right: number };

export const SUBMITTED_PROMPT_PADDING: PromptBlockPadding = {
  left: 1,
  right: 2,
};

const BASH_BLOCK_PADDING: PromptBlockPadding = { left: 1, right: 0 };

// Columns available to pre-wrapped content lines: the inset on both sides, the
// rail, and the body padding `renderRailedBlockLines` applies.
export function promptBlockContentWidth(
  width: number,
  inset = promptBlockInset(width),
  padding: PromptBlockPadding = BASH_BLOCK_PADDING,
): number {
  if (inset === 0) return Math.max(1, width);
  return Math.max(
    1,
    width -
      inset * 2 -
      visibleWidth(PROMPT_RAIL) -
      padding.left -
      padding.right,
  );
}

const SGR_PATTERN = /\x1b\[([0-9;]*)m/g;
const BACKGROUND_PATTERN =
  /\x1b\[(?:4[0-8]|10[0-7]|48;5;\d{1,3}|48;2;\d{1,3};\d{1,3};\d{1,3})m/g;
const DISPLAY_ANSI_PATTERN = /\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

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

function splitLeadingSemanticControls(line: string): {
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

function paintBackground(
  line: string,
  width: number,
  backgroundAnsi: string,
): string {
  const fitted = fitLine(line, width);
  // Mirrors Theme.bg: background, content, then a background-only reset.
  return `${backgroundAnsi}${reapplyBackgroundAfterReset(fitted, backgroundAnsi)}\x1b[49m`;
}

export function stripDisplayAnsi(text: string): string {
  return text.replace(DISPLAY_ANSI_PATTERN, "");
}

function replaceBackground(text: string, backgroundAnsi: string): string {
  return text.replace(BACKGROUND_PATTERN, backgroundAnsi);
}

// Renders lines inside a railed, dark-surfaced block (the submitted-prompt
// shell): optional leading semantic controls stay outside the inset, the rail
// is recolored, and content backgrounds are normalized to the prompt surface.
// A blank input line becomes a fully painted body row, which is how the shell
// gets its background padding rows above and below.
export function renderRailedBlockLines(
  lines: string[],
  width: number,
  theme: PromptShellTheme,
  inset: number,
  railColor: string,
  padding: PromptBlockPadding = BASH_BLOCK_PADDING,
): string[] {
  const blockWidth = width - inset * 2;
  if (inset === 0 || blockWidth <= visibleWidth(PROMPT_RAIL)) {
    return lines.map((line) => fitLine(line, width));
  }
  const bodyWidth = blockWidth - visibleWidth(PROMPT_RAIL);
  const margin = " ".repeat(inset);
  const leftPad = " ".repeat(padding.left);
  const rightPad = " ".repeat(padding.right);
  const contentWidth = Math.max(1, bodyWidth - padding.left - padding.right);
  const surfaceBg = promptSurfaceBg(theme);
  return lines.map((line) => {
    const { controls, content } = splitLeadingSemanticControls(line);
    const recolored = replaceBackground(content, surfaceBg);
    const rail = theme.fg(railColor, PROMPT_RAIL);
    const body = paintBackground(
      `${leftPad}${fitLine(recolored, contentWidth)}${rightPad}`,
      bodyWidth,
      surfaceBg,
    );
    return `${controls}${margin}${rail}${body}${margin}`;
  });
}
