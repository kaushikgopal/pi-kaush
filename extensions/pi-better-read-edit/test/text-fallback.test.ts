import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import registerExtension from "../src/index.ts";

const roots: string[] = [];
let root: string;
let branch: any[];
let tools: Map<string, any>;
let context: any;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pi-text-fallback-"));
  roots.push(root);
  branch = [];
  tools = new Map();
  registerExtension({
    registerTool(tool: any) {
      tools.set(tool.name, tool);
    },
    async exec() {
      return { code: 1, stdout: "", stderr: "not installed", killed: false };
    },
  } as never);
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

async function taggedRead(path: string, extra: Record<string, unknown> = {}) {
  const result = await tools
    .get("read")
    .execute("read-1", { path, ...extra }, undefined, undefined, context);
  branch.push({
    type: "message",
    message: {
      role: "toolResult",
      toolName: "read",
      isError: false,
      details: result.details,
    },
  });
  return result.details.hashlineAnchor.tag as string;
}

async function edit(files: unknown[]) {
  const tool = tools.get("edit");
  const result = await tool.execute(
    "edit-1",
    { files },
    undefined,
    undefined,
    context,
  );
  branch.push({
    type: "message",
    message: {
      role: "toolResult",
      toolName: "edit",
      isError: false,
      details: result.details,
    },
  });
  return result;
}

async function writeFixture(lines: string[]): Promise<string> {
  await writeFile(join(root, "example.txt"), lines.join("\n") + "\n");
  return join(root, "example.txt");
}

describe("text-fallback edit splices", () => {
  test("oldText-only splice replaces uniquely matched lines", async () => {
    const path = await writeFixture(["alpha", "beta", "gamma"]);
    const tag = await taggedRead("example.txt");
    await edit([
      {
        path: "example.txt",
        tag,
        edits: [{ oldText: ["beta"], newText: ["beta2", "beta3"] }],
      },
    ]);
    expect(await readFile(path, "utf8")).toBe("alpha\nbeta2\nbeta3\ngamma\n");
  });

  test("oldText-only splice deletes when newText is omitted", async () => {
    const path = await writeFixture(["alpha", "beta", "gamma"]);
    const tag = await taggedRead("example.txt");
    await edit([{ path: "example.txt", tag, edits: [{ oldText: ["beta"] }] }]);
    expect(await readFile(path, "utf8")).toBe("alpha\ngamma\n");
  });

  test("unique text match authorizes lines the read never displayed", async () => {
    const path = await writeFixture(
      Array.from({ length: 10 }, (_, index) => `line ${index + 1}`),
    );
    const tag = await taggedRead("example.txt", { ranges: "1-2,9-10" });
    await edit([
      {
        path: "example.txt",
        tag,
        edits: [{ oldText: ["line 5"], newText: ["line five"] }],
      },
    ]);
    expect(await readFile(path, "utf8")).toContain("line five");
  });

  test("ambiguous oldText fails closed without writing", async () => {
    const path = await writeFixture(["dup", "middle", "dup"]);
    const tag = await taggedRead("example.txt");
    await expect(
      edit([
        {
          path: "example.txt",
          tag,
          edits: [{ oldText: ["dup"], newText: ["replaced"] }],
        },
      ]),
    ).rejects.toThrow(/appears more than once/);
    expect(await readFile(path, "utf8")).toBe("dup\nmiddle\ndup\n");
  });

  test("oldText absent from the file fails closed", async () => {
    const path = await writeFixture(["alpha", "beta"]);
    const tag = await taggedRead("example.txt");
    await expect(
      edit([
        {
          path: "example.txt",
          tag,
          edits: [{ oldText: ["delta"], newText: ["x"] }],
        },
      ]),
    ).rejects.toThrow(/does not appear in the current file/);
    expect(await readFile(path, "utf8")).toBe("alpha\nbeta\n");
  });

  test("dual splice prefers correct coordinates without warnings", async () => {
    const path = await writeFixture(["alpha", "beta", "gamma"]);
    const tag = await taggedRead("example.txt");
    const result = await edit([
      {
        path: "example.txt",
        tag,
        edits: [
          {
            startLine: 2,
            deleteCount: 1,
            oldText: ["beta"],
            newText: ["BETA"],
          },
        ],
      },
    ]);
    expect(result.details.recoveryWarnings).toBeUndefined();
    expect(await readFile(path, "utf8")).toBe("alpha\nBETA\ngamma\n");
  });

  test("dual splice falls back to text match when coordinates fail", async () => {
    const path = await writeFixture(["alpha", "beta", "gamma"]);
    const tag = await taggedRead("example.txt");
    const result = await edit([
      {
        path: "example.txt",
        tag,
        edits: [
          {
            startLine: 99,
            deleteCount: 1,
            oldText: ["beta"],
            newText: ["BETA"],
          },
        ],
      },
    ]);
    expect(result.details.recoveryWarnings?.[0]).toMatch(/unique text match/);
    expect(await readFile(path, "utf8")).toBe("alpha\nBETA\ngamma\n");
  });

  test("dual splice surfaces the coordinate error when text match also fails", async () => {
    const path = await writeFixture(["alpha", "beta", "gamma"]);
    const tag = await taggedRead("example.txt");
    await expect(
      edit([
        {
          path: "example.txt",
          tag,
          edits: [
            {
              startLine: 99,
              deleteCount: 1,
              oldText: ["delta"],
              newText: ["x"],
            },
          ],
        },
      ]),
    ).rejects.toThrow(/out of bounds/);
    expect(await readFile(path, "utf8")).toBe("alpha\nbeta\ngamma\n");
  });

  test("dual splice requires deleting at least one line", async () => {
    await writeFixture(["alpha", "beta", "gamma"]);
    const tag = await taggedRead("example.txt");
    await expect(
      edit([
        {
          path: "example.txt",
          tag,
          edits: [
            {
              startLine: 2,
              deleteCount: 0,
              oldText: ["beta"],
              newText: ["BETA"],
            },
          ],
        },
      ]),
    ).rejects.toThrow(/set deleteCount to at least 1/);
  });

  test("stale file with a matching oldText is rescued", async () => {
    const path = await writeFixture(["alpha", "beta", "gamma"]);
    const tag = await taggedRead("example.txt");
    await writeFile(path, "alpha\nbeta\ngamma\nextra\n");
    const result = await edit([
      {
        path: "example.txt",
        tag,
        edits: [{ oldText: ["beta"], newText: ["BETA"] }],
      },
    ]);
    expect(result.details.recoveryWarnings?.join(" ")).toMatch(
      /preserved non-overlapping changes/,
    );
    expect(await readFile(path, "utf8")).toBe("alpha\nBETA\ngamma\nextra\n");
  });

  test("newLines can carry the replacement rows for an oldText splice", async () => {
    const path = await writeFixture(["alpha", "beta", "gamma"]);
    const tag = await taggedRead("example.txt");
    await edit([
      {
        path: "example.txt",
        tag,
        edits: [{ oldText: ["beta"], newLines: ["BETA"] }],
      },
    ]);
    expect(await readFile(path, "utf8")).toBe("alpha\nBETA\ngamma\n");
  });

  test("identical oldText and newText is rejected as a no-op", async () => {
    const path = await writeFixture(["alpha", "beta"]);
    const tag = await taggedRead("example.txt");
    await expect(
      edit([
        {
          path: "example.txt",
          tag,
          edits: [{ oldText: ["beta"], newText: ["beta"] }],
        },
      ]),
    ).rejects.toThrow(/no-op/);
    expect(await readFile(path, "utf8")).toBe("alpha\nbeta\n");
  });

  test("a splice needs startLine or oldText", async () => {
    await writeFixture(["alpha", "beta"]);
    const tag = await taggedRead("example.txt");
    await expect(
      edit([
        {
          path: "example.txt",
          tag,
          edits: [{ newText: ["x"] }],
        },
      ]),
    ).rejects.toThrow(/needs startLine .* or oldText/);
  });

  test("coordinate and text splices combine in one call", async () => {
    const path = await writeFixture(["alpha", "beta", "gamma", "delta"]);
    const tag = await taggedRead("example.txt");
    await edit([
      {
        path: "example.txt",
        tag,
        edits: [
          { startLine: 1, deleteCount: 1, newLines: ["ALPHA"] },
          { oldText: ["gamma"], newText: ["GAMMA"] },
        ],
      },
    ]);
    expect(await readFile(path, "utf8")).toBe("ALPHA\nbeta\nGAMMA\ndelta\n");
  });

  describe("ambiguity guard", () => {
    test("coordinate splice on duplicated content is rejected", async () => {
      const path = await writeFixture(["dup", "mid", "dup", "tail"]);
      const tag = await taggedRead("example.txt");
      await expect(
        edit([
          {
            path: "example.txt",
            tag,
            edits: [{ startLine: 3, deleteCount: 1, newLines: ["replaced"] }],
          },
        ]),
      ).rejects.toThrow(/appears more than once/);
      expect(await readFile(path, "utf8")).toBe("dup\nmid\ndup\ntail\n");
    });

    test("dual splice with unique context falls back past the guard", async () => {
      const path = await writeFixture(["dup", "mid", "dup", "tail"]);
      const tag = await taggedRead("example.txt");
      const result = await edit([
        {
          path: "example.txt",
          tag,
          edits: [
            {
              startLine: 3,
              deleteCount: 1,
              oldText: ["mid", "dup", "tail"],
              newText: ["mid", "REPLACED", "tail"],
            },
          ],
        },
      ]);
      expect(result.details.recoveryWarnings?.[0]).toMatch(/unique text match/);
      expect(await readFile(path, "utf8")).toBe("dup\nmid\nREPLACED\ntail\n");
    });

    test("widened unique span needs no fallback", async () => {
      const path = await writeFixture(["dup", "mid", "dup", "tail"]);
      const tag = await taggedRead("example.txt");
      const result = await edit([
        {
          path: "example.txt",
          tag,
          edits: [
            { startLine: 3, deleteCount: 2, newLines: ["REPLACED", "tail"] },
          ],
        },
      ]);
      expect(result.details.recoveryWarnings).toBeUndefined();
      expect(await readFile(path, "utf8")).toBe("dup\nmid\nREPLACED\ntail\n");
    });

    test("inserts anchored on repeated content stay allowed", async () => {
      const path = await writeFixture(["dup", "mid", "dup", "tail"]);
      const tag = await taggedRead("example.txt");
      await edit([
        {
          path: "example.txt",
          tag,
          edits: [{ startLine: 4, deleteCount: 0, newLines: ["inserted"] }],
        },
      ]);
      expect(await readFile(path, "utf8")).toBe(
        "dup\nmid\ndup\ninserted\ntail\n",
      );
    });
  });
});
