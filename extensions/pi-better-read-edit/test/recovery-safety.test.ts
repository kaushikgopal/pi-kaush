import { describe, expect, test } from "vitest";
import { decodeEligibleText } from "../src/hashline/contract.ts";
import type { HashlineOperation } from "../src/hashline/parser.ts";
import { recoverNonOverlappingEdit } from "../src/hashline/recovery.ts";

const LABEL = "[example#AAAAAAAAAAAAAAAA]";

function recover(
  baseText: string,
  currentText: string,
  operations: HashlineOperation[],
) {
  const base = decodeEligibleText(Buffer.from(baseText));
  const current = decodeEligibleText(Buffer.from(currentText));
  return recoverNonOverlappingEdit(base, current, operations, LABEL);
}

describe("stale recovery requires neighbor context to prove target identity", () => {
  test("fails closed when zero-context relocation would relocate onto identical content elsewhere", () => {
    // The original target line 2 ("def") was changed to "xyz" by another
    // writer, while an identical "def" now appears at the top of the file.
    // A bare target match cannot tell the unchanged-shifted target apart from
    // this moved duplicate, so the edit must fail closed.
    expect(
      recover("abc\ndef\nghi\n", "def\nabc\nxyz\nghi\n", [
        { kind: "replace", start: 2, end: 2, rows: ["DDD"] },
      ]),
    ).toBeUndefined();
  });

  test("fails closed for the mirrored case where the duplicate sits at EOF", () => {
    expect(
      recover("abc\ndef\nghi\n", "abc\nxyz\ndef\n", [
        { kind: "replace", start: 2, end: 2, rows: ["DDD"] },
      ]),
    ).toBeUndefined();
  });

  test("still recovers a pure line shift via surviving neighbor context", () => {
    expect(
      recover("abc\ndef\nghi\n", "external\nabc\ndef\nghi\n", [
        { kind: "replace", start: 2, end: 2, rows: ["DDD"] },
      ])?.logicalText,
    ).toBe("external\nabc\nDDD\nghi\n");
  });

  test("recovers at BOF where only the right neighbor can prove identity", () => {
    expect(
      recover("abc\ndef\n", "ext\nabc\ndef\n", [
        { kind: "replace", start: 1, end: 1, rows: ["AAA"] },
      ])?.logicalText,
    ).toBe("ext\nAAA\ndef\n");
  });

  test("recovers at EOF where only the left neighbor can prove identity", () => {
    expect(
      recover("abc\ndef\n", "abc\ndef\nbar\n", [
        { kind: "replace", start: 2, end: 2, rows: ["DDD"] },
      ])?.logicalText,
    ).toBe("abc\nDDD\nbar\n");
  });

  test("recovers a shifted multi-line span once a neighbor line exists", () => {
    expect(
      recover("p\nq\nr\n", "z\np\nq\nr\n", [
        { kind: "replace", start: 1, end: 2, rows: ["PP", "QQ"] },
      ])?.logicalText,
    ).toBe("z\nPP\nQQ\nr\n");
  });
});

describe("stale recovery fails closed where identity is unprovable", () => {
  test("rejects a target spanning the whole document, which has no neighbors", () => {
    expect(
      recover("a\nb\nc\n", "a\nb\nc\nd\n", [
        { kind: "replace", start: 1, end: 3, rows: ["z"] },
      ]),
    ).toBeUndefined();
  });

  test("rejects edits to single-line documents, whose only line has no context", () => {
    expect(
      recover("only\n", "only\nsecond\n", [
        { kind: "replace", start: 1, end: 1, rows: ["X"] },
      ]),
    ).toBeUndefined();
  });

  test("rejects a single-line cut for the same reason", () => {
    expect(
      recover("only\n", "only\nsecond\n", [{ kind: "cut", start: 1, end: 1 }]),
    ).toBeUndefined();
  });
});

describe("stale recovery keeps cut and gap translation intact", () => {
  test("translates cuts through the same neighbor-constrained windows", () => {
    expect(
      recover("a\nb\nc\n", "x\na\nb\nc\n", [{ kind: "cut", start: 2, end: 2 }])
        ?.logicalText,
    ).toBe("x\na\nc\n");
  });

  test("still anchors a shifted insertion gap on its two unique surrounding lines", () => {
    expect(
      recover("a\nb\nc\n", "x\na\nb\nc\n", [
        { kind: "insert-before", line: 2, rows: ["INS"] },
      ])?.logicalText,
    ).toBe("x\na\nINS\nb\nc\n");
  });

  test("still fails closed for insertion gaps at BOF and EOF boundaries", () => {
    const base = "a\nb\n";
    expect(
      recover(base, "a\nb\nc\n", [
        { kind: "insert-before", line: 1, rows: ["X"] },
      ]),
    ).toBeUndefined();
    expect(
      recover(base, "a\nb\nc\n", [
        { kind: "insert-after", line: 2, rows: ["X"] },
      ]),
    ).toBeUndefined();
  });
});
