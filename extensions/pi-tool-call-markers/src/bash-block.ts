import { BashExecutionComponent } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { paletteSample } from "./muted.ts";
import {
  PROMPT_RAIL,
  fitLine,
  promptBlockInset,
  renderRailedBlockLines,
  stripDisplayAnsi,
  type PromptShellTheme,
} from "./prompt-shell.ts";

type ThemeLike = PromptShellTheme & {
  fg(color: string, text: string): string;
};

const BASH_BLOCK_PATCHED = Symbol.for("kg.pi.bashBlock.v1");

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
  inset = promptBlockInset(width),
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
  // Set at the final owner's shutdown. A wrapper another extension has buried
  // cannot be uninstalled, so it delegates instead of outliving its owner; a
  // later install re-enables it.
  disabled?: boolean;
  theme?: ThemeLike;
  cache: WeakMap<
    object,
    { width: number; src: string[]; lines: string[]; palette: string }
  >;
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
      existing.disabled = false;
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
      if (state.disabled || !theme) {
        return state.originalRender.call(this, width);
      }
      const inset = promptBlockInset(width);
      const bodyWidth = width - inset * 2 - visibleWidth(PROMPT_RAIL);
      if (inset === 0 || bodyWidth < 8) {
        return state.originalRender.call(this, width);
      }
      const lines = state.originalRender.call(this, Math.max(1, bodyWidth));
      // Decorated lines carry resolved colors, so the cache keys on the
      // palette too: Pi swaps the colors behind a stable theme Proxy, which a
      // theme-identity check would never notice.
      const palette = paletteSample(theme);
      const entry = state.cache.get(this);
      if (
        entry &&
        entry.width === width &&
        entry.palette === palette &&
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
      state.cache.set(this, { width, src: lines, lines: decorated, palette });
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
  state.disabled = true;
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
