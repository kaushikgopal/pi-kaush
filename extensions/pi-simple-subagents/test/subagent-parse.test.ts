import { describe, expect, test } from "vitest";
import { isStaleContextError } from "../src/_parse.ts";

describe("isStaleContextError", () => {
  test("recognizes only Pi's stale-context error as expected", () => {
    expect(
      isStaleContextError(
        new Error(
          "This extension ctx is stale after session replacement or reload.",
        ),
      ),
    ).toBe(true);
    expect(isStaleContextError(new Error("boom"))).toBe(false);
    expect(isStaleContextError("This extension ctx is stale")).toBe(false);
  });
});
