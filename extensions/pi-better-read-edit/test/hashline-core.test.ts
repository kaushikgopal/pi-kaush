import { describe, expect, test } from "vitest";
import { applyHashlineOperations } from "../src/hashline/apply.ts";
import {
  computeFullDigest,
  createHashlineRecord,
  decodeEligibleText,
  mergeRanges,
  rangesCover,
} from "../src/hashline/contract.ts";
import { parseHashlineScript } from "../src/hashline/parser.ts";
import { HashlineRegistry } from "../src/hashline/registry.ts";
import {
  changedWindows,
  renderHashlineRanges,
} from "../src/hashline/render.ts";
import { recoverNonOverlappingEdit } from "../src/hashline/recovery.ts";
import { HashlineSnapshotStore } from "../src/hashline/snapshot-store.ts";

function record(
  text: string,
  seenRanges = [{ start: 1, end: 1 }],
  canonicalPath = "/tmp/example.ts",
) {
  const document = decodeEligibleText(Buffer.from(text));
  return createHashlineRecord({
    canonicalPath,
    displayPath: "example.ts",
    document,
    seenRanges,
    eofSeen:
      document.lines.length === 0 ||
      seenRanges.some((range) => range.end === document.lines.length),
    producer: "read",
  });
}

function toolEntry(details: unknown, isError = false) {
  return {
    type: "message",
    message: { role: "toolResult", toolName: "read", isError, details },
  } as never;
}

describe("hashline contract", () => {
  test("hashes logical text while recording exact line-ending metadata", () => {
    const lf = record("a\nb\n");
    const crlf = record("a\r\nb\r\n");
    expect(lf.fullDigest).toBe(crlf.fullDigest);
    expect(lf.tag).toMatch(/^[0-9A-F]{16}$/);
    expect(crlf.lineEnding).toBe("crlf");
    expect(crlf.lineCount).toBe(2);
  });

  test("distinguishes empty files from newline-only blank lines", () => {
    expect(decodeEligibleText(Buffer.from("")).lines).toEqual([]);
    expect(decodeEligibleText(Buffer.from("\n")).lines).toEqual([""]);
    expect(decodeEligibleText(Buffer.from("\r\n")).lines).toEqual([""]);
  });

  test("rejects text that cannot round-trip exactly", () => {
    expect(() => decodeEligibleText(Buffer.from("\uFEFFa"))).toThrow(/BOM/);
    expect(() => decodeEligibleText(Buffer.from("a\rb"))).toThrow(/lone CR/);
    expect(() => decodeEligibleText(Buffer.from("a\r\nb\n"))).toThrow(/mixed/);
    expect(() => decodeEligibleText(Buffer.from([0xff]))).toThrow(/UTF-8/);
  });

  test("rejects newline-dense snapshots before allocating line arrays", () => {
    expect(() => decodeEligibleText(Buffer.from("\n".repeat(100_001)))).toThrow(
      /100000 logical lines/,
    );
  });

  test("merges ranges and checks complete coverage", () => {
    const merged = mergeRanges([
      { start: 5, end: 7 },
      { start: 1, end: 2 },
      { start: 3, end: 4 },
    ]);
    expect(merged).toEqual([{ start: 1, end: 7 }]);
    expect(rangesCover(merged, 2, 6)).toBe(true);
    expect(rangesCover(merged, 2, 8)).toBe(false);
  });
});

test("bounds runtime snapshots by least-recently-used path", () => {
  const snapshots = new HashlineSnapshotStore({ maxPaths: 1 });
  const firstDocument = decodeEligibleText(Buffer.from("first\n"));
  const secondDocument = decodeEligibleText(Buffer.from("second\n"));
  const first = record("first\n", undefined, "/tmp/first");
  const second = record("second\n", undefined, "/tmp/second");
  snapshots.record(first, firstDocument);
  snapshots.record(second, secondDocument);
  expect(snapshots.lookup(first)).toBeUndefined();
  expect(snapshots.lookup(second)?.document.logicalText).toBe("second\n");
});

test("recovers only through unique unchanged operation context", () => {
  const base = decodeEligibleText(Buffer.from("one\ntwo\nthree\nfour\nfive\n"));
  const current = decodeEligibleText(
    Buffer.from("external\none\ntwo\nthree\nfour\nfive\n"),
  );
  expect(
    recoverNonOverlappingEdit(
      base,
      current,
      [{ kind: "replace", start: 5, end: 5, rows: ["FIVE"] }],
      "[example#AAAAAAAAAAAAAAAA]",
    )?.logicalText,
  ).toBe("external\none\ntwo\nthree\nfour\nFIVE\n");

  const changed = decodeEligibleText(Buffer.from("ONE ELSEWHERE\ntwo\n"));
  expect(
    recoverNonOverlappingEdit(
      decodeEligibleText(Buffer.from("one\ntwo\n")),
      changed,
      [{ kind: "replace", start: 1, end: 1, rows: ["ONE"] }],
      "[example#AAAAAAAAAAAAAAAA]",
    ),
  ).toBeUndefined();
});

test("rejects stale recovery when duplicate context could relocate a change", () => {
  const lines = Array.from({ length: 100 }, () => "A");
  const current = [...lines];
  current[49] = "B";
  expect(
    recoverNonOverlappingEdit(
      decodeEligibleText(Buffer.from(`${lines.join("\n")}\n`)),
      decodeEligibleText(Buffer.from(`${current.join("\n")}\n`)),
      [{ kind: "replace", start: 50, end: 50, rows: ["CHANGED"] }],
      "[example#AAAAAAAAAAAAAAAA]",
    ),
  ).toBeUndefined();
});

describe("hashline parser and planner", () => {
  test("parses strict PUT/CUT sections and blank inserted rows", () => {
    const [section] = parseHashlineScript(
      "[src/a#AAAAAAAAAAAAAAAA]\nPUT <2:\n+hello\n+\nCUT 5.=6\n",
    );
    expect(section).toEqual({
      displayPath: "src/a",
      tag: "AAAAAAAAAAAAAAAA",
      operations: [
        { kind: "insert-before", line: 2, rows: ["hello", ""] },
        { kind: "cut", start: 5, end: 6 },
      ],
    });
  });

  test("rejects zero coordinates, empty PUT bodies, and legacy syntax", () => {
    expect(() =>
      parseHashlineScript("[x#AAAAAAAAAAAAAAAA]\nPUT <0:\n+x"),
    ).toThrow();
    expect(() =>
      parseHashlineScript("[x#AAAAAAAAAAAAAAAA]\nPUT 1.=1:"),
    ).toThrow(/requires at least one/);
    expect(() =>
      parseHashlineScript("*** Begin Patch\n[x#AAAAAAAAAAAAAAAA]"),
    ).toThrow();
  });

  test("applies disjoint changes in original snapshot coordinates", () => {
    const operations = parseHashlineScript(
      "[x#AAAAAAAAAAAAAAAA]\nPUT 1.=1:\n+ONE\nCUT 3.=3\nPUT >4:\n+tail",
    )[0]!.operations;
    const applied = applyHashlineOperations({
      lines: ["one", "two", "three", "four"],
      finalNewline: true,
      operations,
    });
    expect(applied.logicalText).toBe("ONE\ntwo\nfour\ntail\n");
  });

  test("handles large line and changed-span arrays without argument overflow", () => {
    const lines = Array.from(
      { length: 130_000 },
      (_, index) => `line-${index}`,
    );
    const operations = lines.map((_, index) => ({
      kind: "insert-before" as const,
      line: index + 1,
      rows: ["inserted"],
    }));
    const applied = applyHashlineOperations({
      lines,
      finalNewline: true,
      operations,
    });
    expect(applied.lines).toHaveLength(260_000);
    expect(applied.firstChangedLine).toBe(1);
  });

  test("rejects overlapping spans and ambiguous insertion boundaries", () => {
    expect(() =>
      applyHashlineOperations({
        lines: ["a", "b", "c"],
        finalNewline: false,
        operations: parseHashlineScript(
          "[x#AAAAAAAAAAAAAAAA]\nPUT 1.=2:\n+x\nCUT 2.=3",
        )[0]!.operations,
      }),
    ).toThrow(/overlap/);
    expect(() =>
      applyHashlineOperations({
        lines: ["a", "b"],
        finalNewline: false,
        operations: parseHashlineScript(
          "[x#AAAAAAAAAAAAAAAA]\nPUT 1.=1:\n+x\nPUT <1:\n+y",
        )[0]!.operations,
      }),
    ).toThrow(/within or beside/);
  });
});

describe("hashline registry and rendering", () => {
  test("restores all successful anchors and merges capabilities by digest", () => {
    const first = record("one\ntwo\n", [{ start: 1, end: 1 }]);
    const second = {
      ...first,
      seenRanges: [{ start: 2, end: 2 }],
      eofSeen: true,
    };
    const registry = HashlineRegistry.fromBranch([
      toolEntry({ hashlineAnchor: first }),
      toolEntry({ hashlineAnchors: [second] }),
      toolEntry({ hashlineAnchor: record("ignored") }, true),
    ]);
    expect(registry.lookup(first.canonicalPath, first.tag)).toMatchObject({
      seenRanges: [{ start: 1, end: 2 }],
      eofSeen: true,
    });
  });

  test("ignores malformed, failed, and unrelated tool results", () => {
    const anchor = record("one\n");
    const registry = HashlineRegistry.fromBranch([
      { type: "message", message: null } as never,
      {
        type: "message",
        message: {
          role: "toolResult",
          toolName: "other",
          details: { hashlineAnchor: anchor },
        },
      } as never,
      {
        type: "message",
        message: {
          role: "toolResult",
          toolName: "read",
          details: { hashlineAnchor: anchor },
        },
      } as never,
      toolEntry({ hashlineAnchor: anchor }, true),
    ]);
    expect(registry.lookup(anchor.canonicalPath, anchor.tag)).toBeUndefined();
  });

  test("keeps visible-tag collisions and resolves them with the live digest", () => {
    const first = record("one\n");
    const collision = {
      ...first,
      fullDigest: `${first.tag}${"B".repeat(48)}`,
    };
    expect(computeFullDigest("one\n")).toBe(first.fullDigest);
    const registry = HashlineRegistry.fromBranch([
      toolEntry({ hashlineAnchor: first }),
      toolEntry({ hashlineAnchor: collision }),
    ]);
    expect(registry.lookup(first.canonicalPath, first.tag)).toEqual({
      ambiguous: 2,
    });
    expect(
      registry.lookup(first.canonicalPath, first.tag, {
        fullDigest: first.fullDigest,
        lineEnding: first.lineEnding,
        finalNewline: first.finalNewline,
        lineCount: first.lineCount,
      }),
    ).toMatchObject({ record: { fullDigest: first.fullDigest } });
  });

  test("renders numbered ranges and compact deletion windows", () => {
    const anchor = record("one\ntwo\nthree\n", [{ start: 1, end: 3 }]);
    expect(
      renderHashlineRanges(
        anchor,
        ["one", "two", "three"],
        [
          { start: 1, end: 1 },
          { start: 3, end: 3 },
        ],
      ),
    ).toContain("…\n3:three");
    expect(changedWindows(2, [{ start: 2, end: 1 }])).toEqual([
      { start: 1, end: 2 },
    ]);
  });
});
