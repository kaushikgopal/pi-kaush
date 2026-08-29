import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import registerExtension from "../src/index.ts";
import { normalizeReadInput, readSchema } from "../src/read/tool.ts";

const roots: string[] = [];
let root: string;
let branch: any[];
let tools: Map<string, any>;
let context: any;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pi-better-read-"));
  roots.push(root);
  branch = [];
  tools = new Map();
  const pi = {
    registerTool(tool: any) {
      tools.set(tool.name, tool);
    },
    async exec() {
      return { code: 1, stdout: "", stderr: "not installed", killed: false };
    },
  };
  registerExtension(pi as never);
  context = {
    cwd: root,
    sessionManager: { getBranch: () => branch },
  };
});

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

/**
 * Simulate the framework pipeline: prepareArguments (if declared) runs before
 * schema validation, then execute receives the prepared arguments.
 */
async function read(path: string, extra: Record<string, unknown> = {}) {
  const tool = tools.get("read");
  const args: Record<string, unknown> = { path, ...extra };
  const prepared = tool.prepareArguments ? tool.prepareArguments(args) : args;
  return tool.execute("read-1", prepared, undefined, undefined, context);
}

describe("read input hardening", () => {
  describe("normalizeReadInput", () => {
    test("treats null and blank optional string fields as absent", () => {
      expect(
        normalizeReadInput({
          path: "notes.txt",
          selector: "",
          ranges: "  ",
          offset: null,
          limit: "",
        }),
      ).toEqual({ path: "notes.txt" });
    });

    test("coerces numeric-string offset/limit to numbers", () => {
      expect(
        normalizeReadInput({
          path: "notes.txt",
          selector: null,
          offset: "3",
          limit: " 2 ",
        }),
      ).toEqual({ path: "notes.txt", offset: 3, limit: 2 });
    });

    test("leaves non-blank values untouched", () => {
      expect(
        normalizeReadInput({
          path: "notes.txt",
          selector: "raw",
          ranges: "2-4",
        }),
      ).toEqual({ path: "notes.txt", selector: "raw", ranges: "2-4" });
      // Non-numeric strings are left for schema validation to reject.
      expect(normalizeReadInput({ path: "notes.txt", offset: "abc" })).toEqual({
        path: "notes.txt",
        offset: "abc",
      });
    });

    test("passes through non-object input", () => {
      expect(normalizeReadInput(undefined)).toBeUndefined();
      expect(normalizeReadInput(null)).toBeNull();
    });
  });

  describe("readSchema", () => {
    test("constrains offset/limit to positive integers", () => {
      expect(readSchema.properties.offset).toMatchObject({
        type: "integer",
        minimum: 1,
      });
      expect(readSchema.properties.limit).toMatchObject({
        type: "integer",
        minimum: 1,
      });
    });
  });

  describe("blank and null inputs end to end", () => {
    test("blank selector/ranges behave like an unselected read", async () => {
      await writeFile(join(root, "notes.txt"), "one\ntwo\nthree\n");
      const result = await read("notes.txt", { selector: "", ranges: " " });
      expect(result.content[0].text).toContain("1:one");
      expect(result.content[0].text).toContain("3:three");
    });

    test("blank and null offset/limit behave like unset", async () => {
      await writeFile(join(root, "notes.txt"), "one\ntwo\nthree\n");
      const result = await read("notes.txt", {
        offset: null,
        limit: " ",
      });
      expect(result.content[0].text).toContain("2:two");
    });

    test("numeric-string offset/limit select the expected window", async () => {
      await writeFile(join(root, "notes.txt"), "one\ntwo\nthree\nfour\n");
      const result = await read("notes.txt", { offset: "2", limit: "2" });
      const text = result.content[0].text;
      expect(text).toContain("2:two");
      expect(text).toContain("3:three");
      expect(text).not.toContain("1:one");
      expect(text).not.toContain("4:four");
    });
  });

  describe("unambiguous selection modes", () => {
    test("rejects ranges combined with selector on non-SQLite paths", async () => {
      await writeFile(join(root, "notes.txt"), "one\ntwo\nthree\n");
      await expect(
        read("notes.txt", { ranges: "2-2", selector: "3-3" }),
      ).rejects.toThrow(/ranges or selector, not both/);
    });

    test("rejects selector/ranges combined with offset/limit", async () => {
      await writeFile(join(root, "notes.txt"), "one\ntwo\nthree\n");
      await expect(
        read("notes.txt", { ranges: "2-2", offset: 1 }),
      ).rejects.toThrow(/offset\/limit or selector\/ranges, not both/);
      await expect(
        read("notes.txt", { selector: "2-2", limit: 1 }),
      ).rejects.toThrow(/offset\/limit or selector\/ranges, not both/);
      await expect(
        read("notes.txt", { selector: "raw", offset: 1 }),
      ).rejects.toThrow(/offset\/limit or selector\/ranges, not both/);
    });

    test("rejects offset/limit on SQLite selectors too", async () => {
      await writeFile(join(root, "data.db"), "not a database");
      await expect(
        read("data.db", { selector: "users", offset: 1 }),
      ).rejects.toThrow(/offset\/limit or selector\/ranges, not both/);
    });

    test("keeps a single selection mode working", async () => {
      await writeFile(join(root, "notes.txt"), "one\ntwo\nthree\n");
      const byRanges = await read("notes.txt", { ranges: "2-2" });
      expect(byRanges.content[0].text).toContain("2:two");
      const bySelector = await read("notes.txt", { selector: "3-3" });
      expect(bySelector.content[0].text).toContain("3:three");
      const byOffsetLimit = await read("notes.txt", { offset: 1, limit: 2 });
      const text = byOffsetLimit.content[0].text;
      expect(text).toContain("2:two");
      expect(text).not.toContain("3:three");
    });
  });

  describe("offset/limit value hardening", () => {
    test("rejects non-positive and fractional offset/limit", async () => {
      await writeFile(join(root, "notes.txt"), "one\ntwo\n");
      for (const extra of [
        { offset: 0 },
        { offset: -1 },
        { offset: 1.5 },
        { limit: 0 },
        { limit: -2 },
        { limit: 2.5 },
      ]) {
        await expect(read("notes.txt", extra)).rejects.toThrow(
          /positive integer/,
        );
      }
    });

    test("still rejects invalid ranges", async () => {
      await writeFile(join(root, "notes.txt"), "one\ntwo\n");
      await expect(read("notes.txt", { ranges: "1-2-3" })).rejects.toThrow(
        /ranges must use/,
      );
    });
  });

  describe("projection pagination preserved", () => {
    test("rejects offset on URL projections through the tool", async () => {
      await expect(
        read("https://github.com/example/repo/pull/1", { offset: 1 }),
      ).rejects.toThrow(/offset\/limit/);
    });
  });

  describe("SQLite dual mode preserved", () => {
    test("keeps SQLite resource selectors paired with output ranges", async () => {
      let sqlite: string;
      try {
        sqlite = execFileSync("which", ["sqlite3"], {
          encoding: "utf8",
        }).trim();
      } catch {
        return;
      }
      execFileSync(sqlite, [
        join(root, "data.db"),
        "CREATE TABLE users(name TEXT); INSERT INTO users VALUES ('Ada'); INSERT INTO users VALUES ('Grace');",
      ]);
      const sqliteTools = new Map<string, any>();
      registerExtension({
        registerTool(tool: any) {
          sqliteTools.set(tool.name, tool);
        },
        async exec() {
          return { code: 0, stdout: `${sqlite}\n`, stderr: "", killed: false };
        },
      } as never);
      const result = await sqliteTools
        .get("read")
        .execute(
          "read-1",
          { path: "data.db", selector: "users", ranges: "3-3" },
          undefined,
          undefined,
          context,
        );
      expect(result.content[0].text).toContain("3|");
    });
  });
});
