import { BashExecutionComponent } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

type ThemeLike = {
  bold(text: string): string;
  fg(color: string, text: string): string;
  getBgAnsi?(color: string): string;
};

const BASH_BLOCK_PATCHED = Symbol.for("kg.pi.bashBlock.v1");

// The prompt surface paints with the theme's customMessageBg token, matching
// pi-content-layout's surfaces (cobalt2 maps it to `actionBlock`, #071312).
// customMessageBg is a required pi theme token; the legacy hex remains only
// as a fallback for theme lookalikes without getBgAnsi.
const PROMPT_SURFACE_BG_FALLBACK = "\x1b[48;2;7;19;18m"; // #071312

function promptSurfaceBg(theme: ThemeLike): string {
  try {
    return theme.getBgAnsi?.("customMessageBg") ?? PROMPT_SURFACE_BG_FALLBACK;
  } catch {
    return PROMPT_SURFACE_BG_FALLBACK;
  }
}
const PROMPT_RAIL = "▎";

// User-run bash blocks align with the message inset pi-content-layout
// applies to transcript lines. Keep this in sync with that package's
// contentInset (2 columns outside the rail for any width above 4); the
// conversation surface has one shared visual contract even though the two
// packages otherwise own disjoint components.
function bashBlockInset(width: number): number {
  return width > BASH_BLOCK_INSET * 2 ? BASH_BLOCK_INSET : 0;
}
const BASH_BLOCK_INSET = 2;

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

function fitLine(line: string, width: number): string {
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

function stripDisplayAnsi(text: string): string {
  return text.replace(DISPLAY_ANSI_PATTERN, "");
}

function replaceBackground(text: string, backgroundAnsi: string): string {
  return text.replace(BACKGROUND_PATTERN, backgroundAnsi);
}

// Renders lines inside a railed, dark-surfaced block (the submitted-prompt
// shell): optional leading semantic controls stay outside the inset, the rail
// is recolored, and content backgrounds are normalized to the prompt surface.
function renderRailedBlockLines(
  lines: string[],
  width: number,
  theme: ThemeLike,
  inset: number,
  railColor: string,
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
    // One extra leading space inside the body, so submitted text sits two
    // columns right of the rail instead of one.
    const body = paintBackground(
      ` ${fitLine(recolored, Math.max(1, bodyWidth - 1))}`,
      bodyWidth,
      surfaceBg,
    );
    return `${controls}${margin}${rail}${body}${margin}`;
  });
}

const RULE_LINE_RE = /^─+$/;

function isRuleLine(line: string | undefined): line is string {
  return line !== undefined && RULE_LINE_RE.test(stripDisplayAnsi(line).trim());
}

// `!!` commands draw their rules dim instead of bashMode green, but the
// component does not store that flag, so sniff the top rule's color to keep
// the rail consistent with the framing it replaces.
function sniffsDimRule(rule: string, theme: ThemeLike): boolean {
  const prefixOf = (colored: string) => colored.slice(0, colored.indexOf("─"));
  const dimPrefix = prefixOf(theme.fg("dim", "─"));
  return (
    dimPrefix.length > 0 &&
    dimPrefix !== prefixOf(theme.fg("bashMode", "─")) &&
    rule.startsWith(dimPrefix)
  );
}

// Rail tone for a user bash block: failures read red and cancellations
// yellow, matching the block's status text; anything else keeps the green
// the rules used (dim for `!!` commands).
function bashBlockRailColor(
  status: string | undefined,
  topRule: string | undefined,
  theme: ThemeLike,
): string {
  if (status === "error") return "error";
  if (status === "cancelled") return "warning";
  if (topRule !== undefined && sniffsDimRule(topRule, theme)) return "dim";
  return "bashMode";
}

// Reshapes BashExecutionComponent output into the submitted-prompt shell: the
// leading spacer stays outside the block, the top/bottom rules are dropped,
// and the remaining lines get one blank padded row at each end plus the rail
// and dark surface.
function renderBashBlockLines(
  lines: string[],
  width: number,
  theme: ThemeLike,
  status: string | undefined,
  inset = bashBlockInset(width),
): string[] {
  const [spacer, ...rest] = lines;
  const topRule = isRuleLine(rest[0]) ? rest[0] : undefined;
  const inner = topRule !== undefined ? rest.slice(1) : rest.slice();
  if (isRuleLine(inner[inner.length - 1])) inner.pop();
  const railColor = bashBlockRailColor(status, topRule, theme);
  const block = renderRailedBlockLines(
    ["", ...inner, ""],
    width,
    theme,
    inset,
    railColor,
  );
  return [fitLine(spacer ?? "", width), ...block];
}

type BashRow = { status?: unknown };

type BashBlockPatchState = {
  owners: number;
  theme?: ThemeLike;
  cache: WeakMap<object, { width: number; src: string[]; lines: string[] }>;
  originalRender: (width: number) => string[];
  patchedRender?: (width: number) => string[];
};

// User-typed `!` commands are execution rows, so their presentation belongs
// here with every other collapsed execution display; pi-content-layout stops
// at the message surface. Pi's BashExecutionComponent already draws the
// command, rules, and status; this patch reshapes that output into the
// railed prompt shell and recolors the rail from the exit outcome.
// TODO: Replace prototype patching with a public Pi rendering API when available.
function installBashBlockPatch(): BashBlockPatchState | undefined {
  try {
    const proto = BashExecutionComponent?.prototype as unknown as BashRow & {
      [BASH_BLOCK_PATCHED]?: BashBlockPatchState;
      render?: (width: number) => string[];
    };
    if (!proto || typeof proto.render !== "function") return undefined;

    const existing = proto[BASH_BLOCK_PATCHED];
    if (existing) {
      existing.owners++;
      return existing;
    }

    const state: BashBlockPatchState = {
      owners: 1,
      cache: new WeakMap(),
      originalRender: proto.render,
    };
    const patchedRender = function renderWithBashBlockShell(
      this: BashRow,
      width: number,
    ): string[] {
      const theme = state.theme;
      if (!theme) return state.originalRender.call(this, width);
      const inset = bashBlockInset(width);
      const bodyWidth = width - inset * 2 - visibleWidth(PROMPT_RAIL);
      if (inset === 0 || bodyWidth < 8) {
        return state.originalRender.call(this, width);
      }
      const lines = state.originalRender.call(this, Math.max(1, bodyWidth));
      const entry = state.cache.get(this);
      if (
        entry &&
        entry.width === width &&
        entry.src.length === lines.length &&
        entry.src.every((line, index) => line === lines[index])
      ) {
        return entry.lines;
      }
      const status = this.status;
      const decorated = renderBashBlockLines(
        lines,
        width,
        theme,
        typeof status === "string" ? status : undefined,
        inset,
      );
      state.cache.set(this, { width, src: lines, lines: decorated });
      return decorated;
    };

    try {
      state.patchedRender = patchedRender;
      proto.render = patchedRender;
      Object.defineProperty(proto, BASH_BLOCK_PATCHED, {
        configurable: true,
        value: state,
      });
    } catch {
      proto.render = state.originalRender;
      return undefined;
    }
    return state;
  } catch {
    // Pi internals can change across versions; fail silently.
    return undefined;
  }
}

function uninstallBashBlockPatch(state: BashBlockPatchState | undefined): void {
  if (!state || state.owners <= 0) return;
  state.owners--;
  if (state.owners > 0) return;
  const proto = BashExecutionComponent?.prototype as unknown as BashRow & {
    [BASH_BLOCK_PATCHED]?: BashBlockPatchState;
    render?: (width: number) => string[];
  };
  if (
    proto[BASH_BLOCK_PATCHED] !== state ||
    proto.render !== state.patchedRender
  ) {
    return;
  }
  proto.render = state.originalRender;
  delete proto[BASH_BLOCK_PATCHED];
}

export { PROMPT_RAIL, installBashBlockPatch, uninstallBashBlockPatch };
export type { BashBlockPatchState };
