import type { Theme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import {
  contentInset,
  insetLines,
  PROMPT_SURFACE_BG,
  renderActiveEditor,
  renderSubmittedUserLines,
  splitLeadingSemanticControls,
} from "../src/render.ts";

const CSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const CONTROL_RE =
  /\x1b(?:\][^\x07]*(?:\x07|\x1b\\)|_[^\x07]*(?:\x07|\x1b\\))/g;
const stripControls = (text: string) =>
  text.replace(CONTROL_RE, "").replace(CSI_RE, "");

const theme = {
  fg(color: string, text: string) {
    const code = color === "accent" ? 35 : 90;
    return `\x1b[${code}m${text}\x1b[39m`;
  },
} as Theme;

class FakeEditor {
  borderColor = (text: string) => `\x1b[36m${text}\x1b[39m`;
  focused = true;
  suggestion = true;

  render(width: number): string[] {
    const border = this.borderColor("─").repeat(width);
    const content = `${CURSOR_MARKER}prompt\x1b[0m`;
    const line =
      content + " ".repeat(Math.max(0, width - visibleWidth(content)));
    return this.suggestion
      ? [border, line, border, "→ option"]
      : [border, line, border];
  }

  invalidate(): void {}
  getText(): string {
    return "prompt";
  }
  setText(): void {}
  handleInput(): void {}
}

describe("content inset", () => {
  test("keeps shell controls before the visual margin", () => {
    const zone = "\x1b]133;A\x07";
    const [line] = insetLines([`${zone}hello`], 14);
    expect(line).toBeDefined();
    expect(line?.startsWith(`${zone}  hello`)).toBe(true);
    expect(visibleWidth(line ?? "")).toBe(14);
  });

  test("recognizes consecutive OSC and APC prefixes without moving SGR color", () => {
    const controls = "\x1b]133;A\x07\x1b_pi:c\x07";
    const split = splitLeadingSemanticControls(`${controls}\x1b[31mtext`);
    expect(split.controls).toBe(controls);
    expect(split.content).toBe("\x1b[31mtext");
  });

  test("drops the preferred inset at tiny widths", () => {
    expect(contentInset(5)).toBe(2);
    expect(contentInset(4)).toBe(0);
    expect(stripControls(insetLines(["abcdef"], 4)[0] ?? "")).toBe("abcd");
  });
});

describe("active editor", () => {
  test("paints a full-width dark surface with one padded row above and below", () => {
    const editor = new FakeEditor();
    const originalBorder = editor.borderColor;
    const lines = renderActiveEditor(editor, 30, theme);

    expect(lines).toHaveLength(4);
    expect(lines.every((line) => visibleWidth(line) === 30)).toBe(true);
    expect(stripControls(lines[0] ?? "")).toMatch(/^\s+$/);
    expect(stripControls(lines[1] ?? "")).toMatch(/^ prompt/);
    expect(stripControls(lines[2] ?? "")).toMatch(/^\s+$/);
    expect(stripControls(lines[3] ?? "")).toMatch(/^→ option/);
    expect(
      lines.slice(0, 3).every((line) => line.includes(PROMPT_SURFACE_BG)),
    ).toBe(true);
    expect(lines[3]).not.toContain(PROMPT_SURFACE_BG);
    expect(stripControls(lines.slice(0, 3).join("\n"))).not.toContain("▎");
    expect(stripControls(lines.join("\n"))).not.toContain("─");
    expect(editor.borderColor).toBe(originalBorder);
  });

  test("keeps scroll hints inside the padded dark surface", () => {
    const editor = new FakeEditor();
    editor.suggestion = false;
    editor.render = function render(width: number): string[] {
      const indicator = "─── ↑ 2 more ";
      const top = this.borderColor(
        indicator + "─".repeat(Math.max(0, width - visibleWidth(indicator))),
      );
      const content = "prompt".padEnd(width);
      const bottom = this.borderColor("─").repeat(width);
      return [top, content, bottom];
    };

    const lines = renderActiveEditor(editor, 30, theme);
    expect(lines).toHaveLength(3);
    expect(stripControls(lines[0] ?? "")).toMatch(/^  ↑ 2 more/);
    expect(stripControls(lines[1] ?? "")).toMatch(/^ prompt/);
    expect(stripControls(lines[2] ?? "")).toMatch(/^\s+$/);
    expect(lines.every((line) => line.includes(PROMPT_SURFACE_BG))).toBe(true);
  });

  test("fails open to native rendering when the editor has no border hook", () => {
    const editor = {
      render: (width: number) => ["prompt".padEnd(width)],
      invalidate() {},
      getText: () => "prompt",
      setText() {},
      handleInput() {},
    };
    const lines = renderActiveEditor(editor, 20, theme);
    expect(stripControls(lines[0] ?? "")).toContain("prompt");
    expect(lines.some((line) => line.includes(PROMPT_SURFACE_BG))).toBe(false);
  });
});

describe("submitted user block", () => {
  test("keeps shell markers outside the inset and replaces the native background", () => {
    const zoneStart = "\x1b]133;A\x07";
    const zoneEnd = "\x1b]133;B\x07\x1b]133;C\x07";
    const native = [
      `${zoneStart}\x1b[45m${" ".repeat(25)}\x1b[49m`,
      `\x1b[45m hello${" ".repeat(19)}\x1b[49m`,
      `${zoneEnd}\x1b[45m${" ".repeat(25)}\x1b[49m`,
    ];
    const lines = renderSubmittedUserLines(native, 30, theme);

    expect(lines.every((line) => visibleWidth(line) === 30)).toBe(true);
    expect(lines[0]?.startsWith(`${zoneStart}  `)).toBe(true);
    expect(lines[2]?.startsWith(`${zoneEnd}  `)).toBe(true);
    expect(lines.every((line) => !line.includes("\x1b[45m"))).toBe(true);
    expect(lines.every((line) => line.includes(PROMPT_SURFACE_BG))).toBe(true);
    expect(stripControls(lines[1] ?? "")).toContain("  ▎  hello");
    expect(lines[1]).toContain(`\x1b[35m▎\x1b[39m${PROMPT_SURFACE_BG}`);
  });
});
