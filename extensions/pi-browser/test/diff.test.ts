import { describe, expect, test } from "vitest";
import { diffOutlines } from "../src/core/diff.ts";

describe("diffOutlines", () => {
  test("ignores re-minted ref ids on unchanged lines", () => {
    const before = '[e1] link "More information"\nheading "Example"';
    const after = '[e9] link "More information"\nheading "Example"';
    expect(diffOutlines(before, after)).toBe("Page unchanged.");
  });

  test("reports added and removed lines", () => {
    const before = 'heading "Settings"\n[e1] button "Save"';
    const after = 'heading "Settings"\n[e2] button "Save"\n[e3] dialog "Saved"';
    const diff = diffOutlines(before, after);
    expect(diff).toContain("Page changes:");
    expect(diff).toContain('+ dialog "Saved"');
    expect(diff).not.toMatch(/^- /m);
  });

  test("handles duplicate lines as a multiset", () => {
    const before = '"item"\n"item"\n"item"';
    const after = '"item"';
    const diff = diffOutlines(before, after);
    expect(diff).toContain('- "item"');
    expect(diff).not.toContain("+");
  });

  test("caps long diffs", () => {
    const before = "";
    const after = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
    const diff = diffOutlines(before, after, 10);
    expect(diff).toContain("(95 more)");
  });
});
