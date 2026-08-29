// Deterministic fixture materialization + generator math tests.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  buildFixture,
  fixtureNames,
  generateLargeDelete,
  loadFixtures,
  materializeFiles,
} from "../fixtures.mjs";
import { snapshotTree } from "../workspace.mjs";
import { benchDir } from "../util.mjs";

const fixturesDir = join(benchDir(), "fixtures");

describe("fixture loading", () => {
  test("all default fixtures load and match their file names", async () => {
    const names = await fixtureNames(fixturesDir);
    expect(names).toEqual([
      "large-delete",
      "repeated-context",
      "two-files",
      "two-splices",
    ]);
    const fixtures = await loadFixtures(names, fixturesDir);
    expect(fixtures.map((fixture) => fixture.name)).toEqual(names);
    for (const fixture of fixtures) {
      expect(fixture.prompt.length).toBeGreaterThan(60);
      expect(Object.keys(fixture.startFiles).length).toBeGreaterThan(0);
      expect(Object.keys(fixture.expectedFiles).length).toBeGreaterThan(0);
    }
  });

  test("rejects descriptor/file name mismatch", () => {
    expect(() =>
      buildFixture(
        {
          name: "other",
          prompt: "x",
          files: { a: "b" },
          expectedFiles: { a: "b" },
        },
        "two-splices",
      ),
    ).toThrow(/does not match/);
  });

  test("rejects unknown generators and missing prompts", () => {
    expect(() =>
      buildFixture(
        { name: "x", prompt: "x", generator: { kind: "nope" } },
        "x",
      ),
    ).toThrow(/unknown generator/);
    expect(() =>
      buildFixture({ name: "x", prompt: "", files: { a: "b" } }, "x"),
    ).toThrow(/non-empty prompt/);
  });
});

describe("deterministic materialization", () => {
  test("two materializations of the same fixture produce identical bytes", async () => {
    const fixture = (await loadFixtures(["two-splices"], fixturesDir))[0];
    const roots = [];
    try {
      const first = await mkdtemp(join(tmpdir(), "bench-fix-"));
      const second = await mkdtemp(join(tmpdir(), "bench-fix-"));
      roots.push(first, second);
      await materializeFiles(first, fixture.startFiles);
      await materializeFiles(second, fixture.startFiles);
      const a = await snapshotTree(first);
      const b = await snapshotTree(second);
      expect(b).toEqual(a);
      expect(a.files["src/greeting.ts"].sha256).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      await Promise.all(
        roots.map((dir) => rm(dir, { recursive: true, force: true })),
      );
    }
  });

  test("fixture expected trees are internally consistent with the tasks", async () => {
    const [twoSplices, repeated, twoFiles] = await loadFixtures(
      ["two-splices", "repeated-context", "two-files"],
      fixturesDir,
    );
    expect(twoSplices.expectedFiles["src/greeting.ts"]).toContain(
      "composeGreeting",
    );
    expect(twoSplices.expectedFiles["src/greeting.ts"]).not.toContain(
      "formatGreeting",
    );
    // Only the second gamma row changes; its twin keeps the identical text.
    expect(
      repeated.expectedFiles["data.js"].match(/\["gamma", 3\]/g),
    ).toHaveLength(1);
    expect(repeated.expectedFiles["data.js"]).toContain('["GAMMA", 30]');
    expect(twoFiles.expectedFiles["src/a.ts"]).toBe(
      'export const VERSION_A = "0.2.0";\n',
    );
    expect(twoFiles.expectedFiles["src/b.ts"]).toBe(
      'export const VERSION_B = "0.2.0";\n',
    );
  });
});

describe("large-delete generator", () => {
  test("expected tree is the start tree minus the requested block", () => {
    const { startFiles, expectedFiles } = generateLargeDelete({
      lines: 20,
      deleteStartId: 5,
      deleteCount: 3,
    });
    const startLines = startFiles["records.js"].split("\n");
    const expectedLines = expectedFiles["records.js"].split("\n");
    expect(startLines).toHaveLength(24); // 2 header + 20 rows + footer + trailing empty
    expect(expectedLines).toHaveLength(21); // 24 - 3 deleted rows
    expect(startLines[7]).toContain("id: 5");
    expect(expectedLines).not.toContain(startLines[7]);
    expect(expectedLines[7]).toContain("id: 8");
  });

  test("2000-row default deletes exactly 500 element lines", () => {
    const { startFiles, expectedFiles } = generateLargeDelete();
    const start = startFiles["records.js"].split("\n");
    const expected = expectedFiles["records.js"].split("\n");
    expect(start.length - expected.length).toBe(500);
    expect(expected).toContain('  { id: 999, label: "record-0999" },');
    expect(expected).toContain('  { id: 1500, label: "record-1500" },');
    expect(expected).not.toContain('  { id: 1000, label: "record-1000" },');
  });
});
