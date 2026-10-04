// Collapsed-row color policy.
//
// Collapsed blocks (tool calls, settled "+ Thought" labels, subagent rows)
// default to the theme's `syntaxComment` token — it ships with every Pi
// theme and reads as a muted tone — instead of the louder
// muted/toolTitle/toolOutput split. A theme can override each collapsed
// kind independently with a `collapsedToolCall` or `collapsedThinkingCall`
// color token.
//
// Failures always fall back to the historical tokens.

const TOOL_OVERRIDE_TOKEN = "collapsedToolCall";
const THINKING_OVERRIDE_TOKEN = "collapsedThinkingCall";
const DEFAULT_TOKEN = "syntaxComment";

type CollapsedTheme = {
  fg(color: string, text: string): string;
  bold?(text: string): string;
  getFgAnsi?(color: string): string;
};

// Probed live, never cached: Pi swaps the colors behind a stable theme
// Proxy, so a value cached against the theme object outlives a theme switch.
// A probe is one map lookup, and the Theme throws on tokens it does not know
// (themes without getFgAnsi have no overrides at all).
function tokenAnsi(theme: CollapsedTheme, token: string): string | null {
  try {
    const resolved = theme.getFgAnsi?.(token);
    return typeof resolved === "string" ? resolved : null;
  } catch {
    return null;
  }
}

// The tokens this package resolves from a palette.
const PALETTE_TOKENS = [
  TOOL_OVERRIDE_TOKEN,
  THINKING_OVERRIDE_TOKEN,
  DEFAULT_TOKEN,
  "muted",
  "toolOutput",
  "accent",
  "warning",
  "error",
  // Asked-question blocks paint with the prompt-shell tokens: the rail, the
  // question text, and the surface behind both.
  "borderAccent",
  "text",
  "userMessageBg",
  "userMessageText",
] as const;

// Revision key for rendered output that bakes resolved colors in. Compares
// the colors themselves, so a mid-session theme switch is visible to every
// cache that keys on it.
export function paletteSample(theme: CollapsedTheme): string {
  return PALETTE_TOKENS.map((token) => tokenAnsi(theme, token) ?? "").join(",");
}

// Override token when defined, else the theme's syntaxComment color, else
// null (caller falls back to the historical tokens).
function collapsedAnsi(
  theme: CollapsedTheme,
  overrideToken: string,
): string | null {
  return tokenAnsi(theme, overrideToken) ?? tokenAnsi(theme, DEFAULT_TOKEN);
}

export function collapsedToolAnsi(theme: CollapsedTheme): string | null {
  return collapsedAnsi(theme, TOOL_OVERRIDE_TOKEN);
}

export function collapsedThinkingAnsi(theme: CollapsedTheme): string | null {
  return collapsedAnsi(theme, THINKING_OVERRIDE_TOKEN);
}

// One styling entry point for collapsed-row text. `color` is the historical
// token role ("muted", "toolOutput", "toolTitle", "accent", "error"); error
// keeps its semantic color in all paths.
export function fgCollapsed(
  theme: CollapsedTheme,
  color: string,
  text: string,
  bold = false,
): string {
  if (color !== "error") {
    const ansi = collapsedToolAnsi(theme);
    if (ansi) {
      return bold
        ? `${ansi}\x1b[1m${text}\x1b[22m\x1b[39m`
        : `${ansi}${text}\x1b[39m`;
    }
  }
  return theme.fg(color, bold && theme.bold ? theme.bold(text) : text);
}

// Decoration rails recede further than collapsed text. No palette token is
// guaranteed lighter than the collapsed color (e.g. catppuccin-latte's `dim`
// resolves to the same overlay0 as syntaxComment), so apply the terminal's
// faint attribute: it lightens toward the background on light themes and
// darkens on dark ones. The rail keeps this muted weight even on failed
// rows, where only the row's text turns error-colored.
export function fgCollapsedRail(theme: CollapsedTheme, text: string): string {
  return `\x1b[2m${fgCollapsed(theme, "muted", text)}\x1b[22m`;
}
