import { describe, expect, test } from "vitest";

import {
  collapsedThinkingAnsi,
  collapsedToolAnsi,
  fgCollapsed,
} from "../src/muted.ts";

// Pi's Theme throws on unknown tokens; themes without getFgAnsi have no
// overrides or syntaxComment color. This fake mirrors both behaviors.
function themeWith(colors: Record<string, string> = {}) {
  return {
    calls: [] as Array<[string, string]>,
    bold(t: string) {
      return `\x1b[1m${t}\x1b[22m`;
    },
    fg(color: string, t: string) {
      this.calls.push([color, t]);
      return `\x1b[38;2;${color.length}m${t}\x1b[39m`;
    },
    getFgAnsi(color: string) {
      const ansi = colors[color];
      if (ansi === undefined) throw new Error(`Unknown theme color: ${color}`);
      return ansi;
    },
  };
}

const COMMENT = "\x1b[38;2;98;114;164m"; // cobalt2's comment blue-gray

describe("collapsed ansi resolution", () => {
  test("defaults to the theme's syntaxComment color", () => {
    const theme = themeWith({ syntaxComment: COMMENT });
    expect(collapsedToolAnsi(theme)).toBe(COMMENT);
    expect(collapsedThinkingAnsi(theme)).toBe(COMMENT);
  });

  test("override tokens win over syntaxComment", () => {
    const theme = themeWith({
      syntaxComment: COMMENT,
      collapsedToolCall: "\x1b[38;2;1;2;3m",
      collapsedThinkingCall: "\x1b[38;2;4;5;6m",
    });
    expect(collapsedToolAnsi(theme)).toBe("\x1b[38;2;1;2;3m");
    expect(collapsedThinkingAnsi(theme)).toBe("\x1b[38;2;4;5;6m");
  });

  test("returns null when the theme has neither override nor syntaxComment", () => {
    const theme = themeWith();
    expect(collapsedToolAnsi(theme)).toBeNull();
    expect(collapsedThinkingAnsi(theme)).toBeNull();
  });
});

describe("fgCollapsed", () => {
  test("syntaxComment mode: every non-error role shares one color, no token calls", () => {
    const theme = themeWith({ syntaxComment: COMMENT });
    expect(fgCollapsed(theme, "muted", "x")).toBe(`${COMMENT}x\x1b[39m`);
    expect(fgCollapsed(theme, "toolOutput", "x")).toBe(`${COMMENT}x\x1b[39m`);
    expect(fgCollapsed(theme, "toolTitle", "x", true)).toBe(
      `${COMMENT}\x1b[1mx\x1b[22m\x1b[39m`,
    );
    expect(theme.calls).toHaveLength(0);
  });

  test("collapsedToolCall override replaces the syntaxComment color", () => {
    const theme = themeWith({
      syntaxComment: COMMENT,
      collapsedToolCall: "\x1b[38;2;1;2;3m",
    });
    expect(fgCollapsed(theme, "muted", "x")).toBe("\x1b[38;2;1;2;3mx\x1b[39m");
  });

  test("error keeps its semantic token in all paths", () => {
    const theme = themeWith({
      syntaxComment: COMMENT,
      collapsedToolCall: "\x1b[38;2;1;2;3m",
    });
    expect(fgCollapsed(theme, "error", "x")).toBe(theme.fg("error", "x"));
    expect(fgCollapsed(theme, "error", "x", true)).toBe(
      theme.fg("error", theme.bold("x")),
    );
  });

  test("without syntaxComment or overrides, the historical token split applies", () => {
    const theme = themeWith();
    fgCollapsed(theme, "muted", "x");
    fgCollapsed(theme, "toolTitle", "x", true);
    fgCollapsed(theme, "toolOutput", "x");
    expect(theme.calls.map(([token]) => token)).toEqual([
      "muted",
      "toolTitle",
      "toolOutput",
    ]);
  });
});
