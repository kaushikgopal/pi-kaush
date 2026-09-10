import { describe, expect, test } from "vitest";
import { mapSeenRangesThroughEdit } from "../src/hashline/contract.ts";
import type { HashlineOperation } from "../src/hashline/parser.ts";

describe("mapSeenRangesThroughEdit", () => {
  test("unchanged regions keep their display authorization, renumbered", () => {
    // Seen 1-10; replace lines 5-6 (2 lines) with 3 rows → +1 shift after.
    const operations: HashlineOperation[] = [
      { kind: "replace", start: 5, end: 6, rows: ["a", "b", "c"] },
    ];
    const result = mapSeenRangesThroughEdit(
      [{ start: 1, end: 10 }],
      operations,
      10,
    );
    // old 1-4 → 1-4; old 7-10 → 8-11 (3 rows replaced 2)
    expect(result.ranges).toEqual([
      { start: 1, end: 4 },
      { start: 8, end: 11 },
    ]);
    // The tail region now ends at the new last line (11).
    expect(result.eofSeen).toBe(true);
  });

  test("replaced lines lose their authorization", () => {
    const operations: HashlineOperation[] = [
      { kind: "replace", start: 5, end: 6, rows: ["a"] },
    ];
    const result = mapSeenRangesThroughEdit(
      [{ start: 4, end: 7 }],
      operations,
      10,
    );
    // old 4 → new 4; old 7 → new 6; old 5-6 were replaced
    expect(result.ranges).toEqual([
      { start: 4, end: 4 },
      { start: 6, end: 6 },
    ]);
  });

  test("a cut removes the range; an insertion extends it", () => {
    const cut = mapSeenRangesThroughEdit(
      [{ start: 3, end: 5 }],
      [{ kind: "cut", start: 3, end: 5 }],
      10,
    );
    expect(cut.ranges).toEqual([]);
    const insert = mapSeenRangesThroughEdit(
      [{ start: 3, end: 5 }],
      [{ kind: "insert-after", line: 3, rows: ["x", "y"] }],
      10,
    );
    expect(insert.ranges).toEqual([{ start: 3, end: 7 }]);
  });

  test("a stale-recovered edit inherits nothing (conservative)", () => {
    // Not this function's job — the tool passes empty ranges on recovery —
    // but the mapping of an empty set stays empty.
    const result = mapSeenRangesThroughEdit(
      [],
      [{ kind: "append", rows: ["x"] }],
      3,
    );
    expect(result.ranges).toEqual([]);
    expect(result.eofSeen).toBe(false);
  });
});
