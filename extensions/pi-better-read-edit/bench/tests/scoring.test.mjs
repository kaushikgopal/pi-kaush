// Tree scoring: byte-exact comparison rejects any missing/extra/changed
// file, with no partial credit.

import { describe, expect, test } from "vitest";
import { compareTrees, treeRecord } from "../workspace.mjs";
import { scoreTree, aggregateArmRuns } from "../scoring.mjs";
import { sha256Hex } from "../util.mjs";

const byteLength = (value) => Buffer.byteLength(value, "utf8");

function tree(files) {
  return {
    files: Object.fromEntries(
      Object.entries(files).map(([path, content]) => [
        path,
        { bytes: byteLength(content), sha256: sha256Hex(content) },
      ]),
    ),
    totalBytes: Object.values(files).reduce(
      (sum, content) => sum + byteLength(content),
      0,
    ),
  };
}

describe("compareTrees", () => {
  test("identical trees match with score 1", () => {
    const expected = tree({ "a.ts": "x\n", "src/b.ts": "y\n" });
    const diff = compareTrees(
      tree({ "a.ts": "x\n", "src/b.ts": "y\n" }),
      expected,
    );
    expect(diff.match).toBe(true);
    expect(diff.missing).toEqual([]);
    expect(diff.extra).toEqual([]);
    expect(diff.changed).toEqual([]);
    expect(scoreTree(diff)).toBe(1);
  });

  test("missing files are rejected", () => {
    const diff = compareTrees(
      tree({ "a.ts": "x\n" }),
      tree({ "a.ts": "x\n", "b.ts": "y\n" }),
    );
    expect(diff.match).toBe(false);
    expect(diff.missing).toEqual(["b.ts"]);
    expect(scoreTree(diff)).toBe(0);
  });

  test("extra files are rejected", () => {
    const diff = compareTrees(
      tree({ "a.ts": "x\n", "junk.txt": "j\n" }),
      tree({ "a.ts": "x\n" }),
    );
    expect(diff.match).toBe(false);
    expect(diff.extra).toEqual(["junk.txt"]);
  });

  test("changed bytes are rejected even with identical length", () => {
    const diff = compareTrees(
      tree({ "a.ts": "x\ny\n" }),
      tree({ "a.ts": "x\nz\n" }),
    );
    expect(diff.match).toBe(false);
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0].path).toBe("a.ts");
    expect(diff.changed[0].actualBytes).toBe(diff.changed[0].expectedBytes);
    expect(diff.changed[0].actualSha256).not.toBe(
      diff.changed[0].expectedSha256,
    );
  });

  test("treeRecord is a stable serializable projection", () => {
    const record = treeRecord(tree({ "b/a.ts": "1\n", "a.ts": "2\n" }));
    expect(Object.keys(record.files)).toEqual(["a.ts", "b/a.ts"]);
    expect(record.files["a.ts"].sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("aggregateArmRuns", () => {
  const arm = (overrides) => ({
    outcome: "completed",
    treeMatch: true,
    wallMs: 100,
    metrics: {
      tokens: { total: 10 },
      toolCalls: { total: 3, read: 1, edit: 1, errors: 0 },
      editArgsBytes: 50,
      firstEdit: { status: "success" },
    },
    errors: { provider: [], assistant: [] },
    ...overrides,
  });

  test("rolls up pass rates, medians and error counts", () => {
    const agg = aggregateArmRuns([
      arm({}),
      arm({
        treeMatch: false,
        metrics: {
          ...arm().metrics,
          toolCalls: { total: 5, edit: 2, read: 1, errors: 1 },
        },
        wallMs: 300,
      }),
    ]);
    expect(agg.trials).toBe(2);
    expect(agg.passed).toBe(1);
    expect(agg.treeMatchRate).toBe(0.5);
    expect(agg.medianWallMs).toBe(200);
    expect(agg.meanToolCalls).toBe(4);
    expect(agg.toolErrors).toBe(1);
    expect(agg.outcomes.completed).toBe(2);
    expect(agg.firstEdits).toEqual({ success: 2 });
  });

  test("empty input aggregates safely", () => {
    expect(aggregateArmRuns([])).toMatchObject({
      trials: 0,
      passed: 0,
      outcomes: {},
    });
  });
});
