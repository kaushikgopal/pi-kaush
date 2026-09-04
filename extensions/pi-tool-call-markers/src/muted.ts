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

// Resolved per theme object (Pi's Theme throws on unknown tokens; themes
// without getFgAnsi have no overrides), alongside index.ts's other
// theme-identity-keyed caches.
const ansiCache = new WeakMap<object, Map<string, string | null>>();

function tokenAnsi(theme: CollapsedTheme, token: string): string | null {
  let cache = ansiCache.get(theme);
  if (!cache) {
    cache = new Map();
    ansiCache.set(theme, cache);
  }
  if (cache.has(token)) return cache.get(token)!;
  let ansi: string | null = null;
  try {
    const resolved = theme.getFgAnsi?.(token);
    if (typeof resolved === "string") ansi = resolved;
  } catch {
    ansi = null;
  }
  cache.set(token, ansi);
  return ansi;
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
