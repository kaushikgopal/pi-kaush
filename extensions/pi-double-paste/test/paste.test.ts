import { describe, expect, test } from "vitest";
import {
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START,
  extractBracketedPaste,
  fingerprint,
  isLongPaste,
  normalizePaste,
} from "../src/paste.ts";

describe("bracketed paste parsing", () => {
  test("extracts a complete paste envelope", () => {
    expect(
      extractBracketedPaste(
        `${BRACKETED_PASTE_START}hello\nworld${BRACKETED_PASTE_END}`,
      ),
    ).toBe("hello\nworld");
  });

  test.each([
    "plain text",
    `${BRACKETED_PASTE_START}missing end`,
    `missing start${BRACKETED_PASTE_END}`,
    `prefix${BRACKETED_PASTE_START}content${BRACKETED_PASTE_END}`,
    `${BRACKETED_PASTE_START}content${BRACKETED_PASTE_END}suffix`,
  ])("passes malformed or mixed input through: %j", (input) => {
    expect(extractBracketedPaste(input)).toBeUndefined();
  });
});

describe("paste normalization", () => {
  test("normalizes line endings, tabs, and control characters", () => {
    expect(normalizePaste("one\r\ntwo\rthree\tfour\u0000")).toBe(
      "one\ntwo\nthree    four",
    );
  });

  test("decodes tmux CSI-u Ctrl-letter sequences", () => {
    expect(normalizePaste("one\x1b[106;5utwo")).toBe("one\ntwo");
  });

  test("preserves Unicode", () => {
    expect(normalizePaste("hello 👋🏽 世界")).toBe("hello 👋🏽 世界");
  });
});

describe("large paste detection", () => {
  test("requires more than ten lines", () => {
    expect(isLongPaste(Array.from({ length: 10 }, () => "x").join("\n"))).toBe(
      false,
    );
    expect(isLongPaste(Array.from({ length: 11 }, () => "x").join("\n"))).toBe(
      true,
    );
  });

  test("requires more than one thousand characters", () => {
    expect(isLongPaste("x".repeat(1_000))).toBe(false);
    expect(isLongPaste("x".repeat(1_001))).toBe(true);
  });

  test("fingerprints equivalent normalized content identically", () => {
    expect(fingerprint(normalizePaste("one\r\ntwo"))).toBe(
      fingerprint(normalizePaste("one\ntwo")),
    );
    expect(fingerprint("one")).not.toBe(fingerprint("two"));
  });
});
