import { describe, expect, test } from "vitest";
import {
  DEFAULT_OUTPUT_BUDGET,
  applyCeiling,
  isCappedTool,
  recoveryHint,
  stderrNote,
} from "../src/context/output-ceiling.ts";

describe("output ceiling", () => {
  test("leaves output within budget untouched", () => {
    const text = "a".repeat(500);
    expect(applyCeiling(text, 8000, "hint")).toEqual({
      text,
      truncated: false,
    });
  });

  test("keeps the head and the tail and reports what it dropped", () => {
    const text = `${"H".repeat(6000)}${"M".repeat(50_000)}${"T".repeat(4000)}`;
    const { text: capped, truncated } = applyCeiling(text, 8000, "RECOVERY");
    expect(truncated).toBe(true);
    expect(capped.startsWith("H")).toBe(true);
    expect(capped.endsWith("T")).toBe(true);
    expect(capped).toContain("RECOVERY");
    expect(capped).toContain("60,000 chars total");
    expect(capped).not.toContain("MMMMM");
    // The marker must stay inside the budget, not add to it.
    expect(capped.length).toBeLessThan(8000 + 300);
  });

  test("caps only tools that have a bounded re-query path", () => {
    expect(isCappedTool("bash")).toBe(true);
    expect(isCappedTool("web_search")).toBe(true);
    expect(isCappedTool("fetch_content")).toBe(true);
    expect(isCappedTool("mcp__glean__search")).toBe(true);
    // read/edit authorize edits by the lines they displayed.
    expect(isCappedTool("read")).toBe(false);
    expect(isCappedTool("edit")).toBe(false);
    expect(isCappedTool("ffgrep")).toBe(false);
  });

  test("names a recovery path per tool", () => {
    expect(recoveryHint("bash", "/tmp/x.txt")).toContain("codemode");
    expect(recoveryHint("bash", "/tmp/x.txt")).toContain("/tmp/x.txt");
    expect(recoveryHint("web_search")).toContain("get_search_content");
    expect(recoveryHint("mcp__glean__search")).toContain("codemode");
  });

  test("flags suppressed stderr only when the result looks failed or empty", () => {
    expect(
      stderrNote(
        "obsidian tasks todo format=tsv > /tmp/a 2>/dev/null",
        false,
        4000,
      ),
    ).toBe("");
    expect(
      stderrNote("obsidian tasks todo format=tsv 2>/dev/null", false, 0),
    ).toContain("2>/dev/null");
    expect(stderrNote("foo 2>/dev/null", true, 9000)).toContain("2>/dev/null");
    expect(stderrNote("ls", false, 10)).toBe("");
  });

  test("defaults to a budget below pi's own 50KB truncation cap", () => {
    expect(DEFAULT_OUTPUT_BUDGET).toBeLessThan(50 * 1024);
    expect(DEFAULT_OUTPUT_BUDGET).toBeGreaterThan(4000);
  });
});
