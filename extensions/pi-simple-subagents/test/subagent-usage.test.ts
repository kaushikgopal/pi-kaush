import { describe, expect, test } from "vitest";
import {
  emptyUsage,
  formatUsageCompact,
  formatUsageDetailed,
  formatUsageProse,
} from "../src/_usage.ts";

const usage = {
  ...emptyUsage(),
  input: 1500,
  output: 300,
  cacheRead: 20,
  cacheWrite: 0,
  cost: 0.01,
  turns: 1,
  contextTokens: 4100,
};

describe("usage formatting", () => {
  test("each format keeps its established shape", () => {
    expect(formatUsageCompact(usage, "anthropic/claude")).toBe(
      "1 turn ↑1.5k ↓300 R20 $0.0100 ctx:4.1k anthropic/claude",
    );
    expect(formatUsageProse({ ...usage, turns: 2 })).toBe(
      "2 turns, 1500 input tokens, 300 output tokens, $0.0100",
    );
    expect(formatUsageCompact(emptyUsage())).toBe("");
    expect(formatUsageProse(emptyUsage())).toBe("");
  });

  test("the detailed form uses a singular turn label", () => {
    expect(formatUsageDetailed(usage)).toBe(
      "in 1500 · out 300 · cache 20+0 · context 4100 · 1 turn · $0.0100",
    );
    expect(formatUsageDetailed(emptyUsage())).toContain("· 0 turns ·");
  });
});
