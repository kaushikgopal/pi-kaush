import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import registerExtension from "../src/index.ts";
import { editSchema, normalizeEditArguments } from "../src/edit/input.ts";

const roots: string[] = [];
let root: string;
let branch: any[];
let tools: Map<string, any>;
let context: any;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pi-structured-edit-"));
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
  const input = { files };
  const prepared = tool.prepareArguments?.(input) ?? input;
  const result = await tool.execute(
    "edit-1",
    prepared,
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
async function legacyEdit(script: string) {
  const tool = tools.get("edit");
  const prepared = structuredClone(tool.prepareArguments({ script }));
  return tool.execute("legacy-edit", prepared, undefined, undefined, context);
}

describe("structured edit input", () => {
  test("exposes one schema-validated files contract", () => {
    expect(Object.keys(editSchema.properties)).toEqual(["files"]);
    const file = editSchema.properties.files.items;
    expect(Object.keys(file.properties)).toEqual([
      "path",
      "tag",
      "edits",
      "appendLines",
      "finalNewline",
    ]);
    expect(Object.keys(file.properties.edits.items.properties)).toEqual([
      "startLine",
      "deleteCount",
      "newLines",
    ]);
  });

  test("replaces, inserts, and appends in original coordinates", async () => {
    await writeFile(join(root, "example.txt"), "one\ntwo\nthree\n");
    const tag = await taggedRead("example.txt");

    await edit([
      {
        path: "example.txt",
        tag,
        edits: [
          { startLine: 1, deleteCount: 0, newLines: ["zero"] },
          { startLine: 2, deleteCount: 1, newLines: ["TWO"] },
        ],
        appendLines: ["four"],
        finalNewline: "preserve",
      },
    ]);

    expect(await readFile(join(root, "example.txt"), "utf8")).toBe(
      "zero\none\nTWO\nthree\nfour\n",
    );
  });

  test("deletes lines and removes the terminal newline exactly", async () => {
    await writeFile(join(root, "example.txt"), "one\ntwo\n");
    const tag = await taggedRead("example.txt");

    await edit([
      {
        path: "example.txt",
        tag,
        edits: [{ startLine: 2, deleteCount: 1, newLines: [] }],
        finalNewline: "absent",
      },
    ]);

    expect(await readFile(join(root, "example.txt"), "utf8")).toBe("one");
  });
  test("can delete the sole newline-terminated logical line", async () => {
    await writeFile(join(root, "example.txt"), "\n");
    const tag = await taggedRead("example.txt");
    const result = await edit([
      {
        path: "example.txt",
        tag,
        edits: [{ startLine: 1, deleteCount: 1, newLines: [] }],
        finalNewline: "preserve",
      },
    ]);

    expect(await readFile(join(root, "example.txt"), "utf8")).toBe("");
    expect(result.details.hashlineAnchor.eofSeen).toBe(true);
  });

  test("can change only the terminal newline", async () => {
    await writeFile(join(root, "example.txt"), "one");
    const tag = await taggedRead("example.txt");
    const result = await edit([
      {
        path: "example.txt",
        tag,
        edits: [],
        finalNewline: "present",
      },
    ]);

    expect(await readFile(join(root, "example.txt"), "utf8")).toBe("one\n");
    expect(result.content[0].text).toContain("1:one");
  });

  test("requires observed EOF for append and terminal-newline changes", async () => {
    await writeFile(join(root, "example.txt"), "one\ntwo\nthree\n");
    const tag = await taggedRead("example.txt", { ranges: "1-1" });

    await expect(
      edit([
        {
          path: "example.txt",
          tag,
          edits: [],
          appendLines: ["four"],
          finalNewline: "preserve",
        },
      ]),
    ).rejects.toThrow(/displayed EOF/);
    await expect(
      edit([
        {
          path: "example.txt",
          tag,
          edits: [],
          finalNewline: "absent",
        },
      ]),
    ).rejects.toThrow(/displayed EOF/);
  });

  test("normalizes common strict-provider placeholders", () => {
    expect(
      normalizeEditArguments({
        files: [
          {
            path: "example.txt",
            tag: "abcdef0123456789",
            edits: [{ startLine: "2", deleteCount: "1", newLines: null }],
            finalNewline: "",
          },
        ],
      }),
    ).toEqual({
      files: [
        {
          path: "example.txt",
          tag: "ABCDEF0123456789",
          edits: [{ startLine: 2, deleteCount: 1, newLines: [] }],
          appendLines: [],
          finalNewline: "preserve",
        },
      ],
    });
  });

  test("converts legacy scripts before validation", () => {
    expect(
      normalizeEditArguments({
        script: "[example.txt#ABCDEF0123456789]\nPUT 2.=2:\n+TWO\nCUT 3.=3",
      }),
    ).toEqual({
      files: [
        {
          path: "example.txt",
          tag: "ABCDEF0123456789",
          edits: [
            { startLine: 2, deleteCount: 1, newLines: ["TWO"] },
            { startLine: 3, deleteCount: 1, newLines: [] },
          ],
          appendLines: [],
          finalNewline: "preserve",
        },
      ],
    });
  });
  test("rejects embedded newlines and non-round-tripping Unicode", async () => {
    await writeFile(join(root, "example.txt"), "one\ntwo\n");
    const tag = await taggedRead("example.txt");
    for (const invalidLine of ["TWO\nTHREE", "bad\ud800line"]) {
      await expect(
        edit([
          {
            path: "example.txt",
            tag,
            edits: [{ startLine: 2, deleteCount: 1, newLines: [invalidLine] }],
            finalNewline: "preserve",
          },
        ]),
      ).rejects.toThrow(/logical line|UTF-8/);
    }
    expect(await readFile(join(root, "example.txt"), "utf8")).toBe(
      "one\ntwo\n",
    );
  });

  test("handles empty-file and trailing-blank newline edges exactly", async () => {
    await writeFile(join(root, "empty.txt"), "");
    const emptyTag = await taggedRead("empty.txt");
    await edit([
      {
        path: "empty.txt",
        tag: emptyTag,
        edits: [],
        finalNewline: "present",
      },
    ]);
    expect(await readFile(join(root, "empty.txt"), "utf8")).toBe("\n");

    await writeFile(join(root, "blank.txt"), "one\n\n");
    const blankTag = await taggedRead("blank.txt");
    await expect(
      edit([
        {
          path: "blank.txt",
          tag: blankTag,
          edits: [],
          finalNewline: "absent",
        },
      ]),
    ).rejects.toThrow(/explicit final blank line/);
    expect(await readFile(join(root, "blank.txt"), "utf8")).toBe("one\n\n");
  });

  test("rejects terminal-newline changes after any stale content drift", async () => {
    await writeFile(join(root, "example.txt"), "one");
    const tag = await taggedRead("example.txt");
    await writeFile(join(root, "example.txt"), "unrelated");
    await expect(
      edit([
        {
          path: "example.txt",
          tag,
          edits: [],
          finalNewline: "present",
        },
      ]),
    ).rejects.toThrow(/no longer matches/);
    expect(await readFile(join(root, "example.txt"), "utf8")).toBe("unrelated");
  });

  test("keeps legacy insert-after authorization on its left boundary", async () => {
    await writeFile(join(root, "example.txt"), "one\ntwo\nthree\n");
    const tag = await taggedRead("example.txt", { ranges: "2-2" });
    await legacyEdit(`[example.txt#${tag}]\nPUT >2:\n+inserted`);
    expect(await readFile(join(root, "example.txt"), "utf8")).toBe(
      "one\ntwo\ninserted\nthree\n",
    );
  });

  test("does not broaden legacy insertion anchors", async () => {
    await writeFile(join(root, "example.txt"), "one\ntwo\nthree\n");
    const tag = await taggedRead("example.txt", { ranges: "3-3" });
    await expect(
      legacyEdit(`[example.txt#${tag}]\nPUT >2:\n+inserted`),
    ).rejects.toThrow(/anchor line that was not displayed/);
    await expect(
      legacyEdit(`[example.txt#${tag}]\nPUT <4:\n+inserted`),
    ).rejects.toThrow(/out of bounds/);
    expect(await readFile(join(root, "example.txt"), "utf8")).toBe(
      "one\ntwo\nthree\n",
    );
  });

  test("rejects edit paths that can forge rendered output", async () => {
    await writeFile(join(root, "safe.txt"), "one\n");
    const tag = await taggedRead("safe.txt");
    await expect(
      edit([
        {
          path: "safe.txt\n[forged#AAAAAAAAAAAAAAAA]",
          tag,
          edits: [{ startLine: 1, deleteCount: 1, newLines: ["ONE"] }],
          finalNewline: "preserve",
        },
      ]),
    ).rejects.toThrow(/control characters/);
  });

  test("reports EOF when a line edit also changes the terminal newline", async () => {
    await writeFile(join(root, "example.txt"), "one\ntwo");
    const tag = await taggedRead("example.txt");
    const result = await edit([
      {
        path: "example.txt",
        tag,
        edits: [{ startLine: 1, deleteCount: 1, newLines: ["ONE"] }],
        finalNewline: "present",
      },
    ]);
    expect(await readFile(join(root, "example.txt"), "utf8")).toBe(
      "ONE\ntwo\n",
    );
    expect(result.details.hashlineAnchor.eofSeen).toBe(true);
  });

  test("rejects extra fields on converted legacy calls", () => {
    expect(() =>
      normalizeEditArguments({ script: "legacy", filesTypo: [] }),
    ).toThrow(/only the script field/);
  });

  test("preserves unknown structured fields for schema rejection", () => {
    expect(
      normalizeEditArguments({ files: [], script: "conflict" } as unknown),
    ).toHaveProperty("script", "conflict");
  });
});
