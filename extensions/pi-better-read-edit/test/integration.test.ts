import { link, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import registerExtension from "../src/index.ts";
import { compareCanonicalPaths } from "../src/edit/tool.ts";

const roots: string[] = [];
let root: string;
let branch: any[];
let tools: Map<string, any>;
let context: any;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pi-better-read-edit-"));
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

function addToolResult(
  details: unknown,
  toolName: "read" | "edit" = "read",
  isError = false,
): void {
  branch.push({
    type: "message",
    message: { role: "toolResult", toolName, isError, details },
  });
}

async function read(path: string, extra: Record<string, unknown> = {}) {
  return tools
    .get("read")
    .execute("read-1", { path, ...extra }, undefined, undefined, context);
}

async function edit(script: string) {
  return tools
    .get("edit")
    .execute("edit-1", { script }, undefined, undefined, context);
}

function header(result: any): string {
  const match = /^\[.+#[0-9A-F]{16}\]$/m.exec(result.content[0].text);
  if (!match) throw new Error("Result did not contain a hashline header");
  return match[0];
}

describe("paired read and edit tools", () => {
  test("uses a strict total order for multi-file locks", () => {
    const left = "/tmp/a";
    const right = "/tmp/a\u200B";
    expect(compareCanonicalPaths(left, right)).toBe(-1);
    expect(compareCanonicalPaths(right, left)).toBe(1);
  });

  test("reads, edits, returns a fresh tag, and supports continuation", async () => {
    await writeFile(join(root, "example.ts"), "one\ntwo\nthree\n");
    const firstRead = await read("example.ts");
    expect(header(firstRead)).toMatch(/^\[example\.ts#[0-9A-F]{16}\]$/);
    expect(firstRead.content[0].text).toContain("2:two");
    addToolResult(firstRead.details);

    const firstEdit = await edit(
      `${header(firstRead)}\nPUT 2.=2:\n+TWO\nPUT >3:\n+four`,
    );
    expect(await readFile(join(root, "example.ts"), "utf8")).toBe(
      "one\nTWO\nthree\nfour\n",
    );
    expect(firstEdit.details.diff).toContain("TWO");
    expect(firstEdit.details.patch).toContain("example.ts");
    expect(header(firstEdit)).not.toBe(header(firstRead));
    addToolResult(firstEdit.details, "edit");

    const secondEdit = await edit(`${header(firstEdit)}\nPUT 1.=1:\n+ONE`);
    expect(secondEdit.details.hashlineAnchor.producer).toBe("edit");
    expect(await readFile(join(root, "example.ts"), "utf8")).toContain("ONE");
  });

  test("preserves non-overlapping drift and rejects overlapping drift", async () => {
    const path = join(root, "stale.txt");
    await writeFile(path, "one\ntwo\n");
    const tagged = await read("stale.txt");
    addToolResult(tagged.details);
    await writeFile(path, "external\none\ntwo\n");

    const recovered = await edit(`${header(tagged)}\nPUT 1.=1:\n+ONE`);
    expect(recovered.details.recoveryWarnings).toEqual([
      "stale.txt: preserved non-overlapping changes made after the tagged read.",
    ]);
    expect(await readFile(path, "utf8")).toBe("external\nONE\ntwo\n");

    await writeFile(path, "changed target\nONE\ntwo\n");
    await expect(edit(`${header(tagged)}\nPUT 1.=1:\n+AGAIN`)).rejects.toThrow(
      /no longer matches/,
    );
    expect(await readFile(path, "utf8")).toBe("changed target\nONE\ntwo\n");
  });

  test("serializes sibling edits against one snapshot and preserves both", async () => {
    const path = join(root, "siblings.txt");
    await writeFile(
      path,
      Array.from({ length: 12 }, (_, index) => `line-${index + 1}`).join("\n") +
        "\n",
    );
    const tagged = await read("siblings.txt");
    addToolResult(tagged.details);

    const [first, second] = await Promise.all([
      edit(`${header(tagged)}\nPUT 1.=1:\n+FIRST`),
      edit(`${header(tagged)}\nPUT 12.=12:\n+LAST`),
    ]);
    expect(
      [first, second].some((result) => result.details.recoveryWarnings),
    ).toBe(true);
    expect(await readFile(path, "utf8")).toBe(
      [
        "FIRST",
        ...Array.from({ length: 10 }, (_, index) => `line-${index + 2}`),
        "LAST",
      ].join("\n") + "\n",
    );
  });

  test("rejects sibling appends at the same original EOF boundary", async () => {
    const path = join(root, "same-gap.txt");
    await writeFile(path, "base\n");
    const tagged = await read("same-gap.txt");
    addToolResult(tagged.details);

    const first = await edit(`${header(tagged)}\nPUT >$:\n+FIRST`);
    addToolResult(first.details, "edit");
    await expect(edit(`${header(tagged)}\nPUT >$:\n+SECOND`)).rejects.toThrow(
      /no longer matches/,
    );
    expect(await readFile(path, "utf8")).toBe("base\nFIRST\n");
  });

  test("authorizes only displayed lines and requires observed EOF to append", async () => {
    await writeFile(join(root, "partial.txt"), "one\ntwo\nthree\n");
    const tagged = await read("partial.txt", { ranges: "2-2" });
    addToolResult(tagged.details);

    await expect(edit(`${header(tagged)}\nPUT 1.=1:\n+ONE`)).rejects.toThrow(
      /not displayed/,
    );
    await expect(edit(`${header(tagged)}\nPUT >$:\n+four`)).rejects.toThrow(
      /displayed EOF/,
    );
    expect(await readFile(join(root, "partial.txt"), "utf8")).toBe(
      "one\ntwo\nthree\n",
    );
  });

  test("round-trips CRLF and terminal newline state", async () => {
    const path = join(root, "windows.txt");
    await writeFile(path, "one\r\ntwo\r\n");
    const tagged = await read("windows.txt");
    addToolResult(tagged.details);
    await edit(`${header(tagged)}\nPUT 2.=2:\n+TWO`);
    expect(await readFile(path, "utf8")).toBe("one\r\nTWO\r\n");
  });

  test("resolves a shared visible tag to the live line-ending identity", async () => {
    const path = join(root, "eol-collision.txt");
    await writeFile(path, "one\ntwo\n");
    const lf = await read("eol-collision.txt");
    addToolResult(lf.details);
    await writeFile(path, "one\r\ntwo\r\n");
    const crlf = await read("eol-collision.txt");
    addToolResult(crlf.details);
    expect(header(crlf)).toBe(header(lf));

    await edit(`${header(crlf)}\nPUT 2.=2:\n+TWO`);
    expect(await readFile(path, "utf8")).toBe("one\r\nTWO\r\n");
  });

  test("preserves empty, newline-only, and no-final-newline states", async () => {
    await writeFile(join(root, "empty.txt"), "");
    const empty = await read("empty.txt");
    addToolResult(empty.details);
    await edit(`${header(empty)}\nPUT >$:\n+one`);
    expect(await readFile(join(root, "empty.txt"), "utf8")).toBe("one");

    await writeFile(join(root, "blank.txt"), "\n");
    const blank = await read("blank.txt");
    expect(blank.content[0].text).toContain("1:");
    addToolResult(blank.details);
    await edit(`${header(blank)}\nCUT 1.=1`);
    expect(await readFile(join(root, "blank.txt"), "utf8")).toBe("");

    await writeFile(join(root, "trailing-blank.txt"), "a");
    const trailingBlank = await read("trailing-blank.txt");
    addToolResult(trailingBlank.details);
    await edit(`${header(trailingBlank)}\nPUT >$:\n+`);
    expect(await readFile(join(root, "trailing-blank.txt"), "utf8")).toBe(
      "a\n\n",
    );

    await writeFile(join(root, "blank-from-empty.txt"), "");
    const blankFromEmpty = await read("blank-from-empty.txt");
    addToolResult(blankFromEmpty.details);
    await edit(`${header(blankFromEmpty)}\nPUT >$:\n+`);
    expect(await readFile(join(root, "blank-from-empty.txt"), "utf8")).toBe(
      "\n",
    );

    await writeFile(join(root, "unterminated.txt"), "one");
    const unterminated = await read("unterminated.txt");
    addToolResult(unterminated.details);
    await edit(`${header(unterminated)}\nPUT 1.=1:\n+ONE`);
    expect(await readFile(join(root, "unterminated.txt"), "utf8")).toBe("ONE");
  });

  test("preflights every file before a multi-file write", async () => {
    const firstPath = join(root, "first.txt");
    const secondPath = join(root, "second.txt");
    await writeFile(firstPath, "first\n");
    await writeFile(secondPath, "second\n");
    const first = await read("first.txt");
    const second = await read("second.txt");
    addToolResult(first.details);
    addToolResult(second.details);
    await writeFile(secondPath, "changed elsewhere\n");

    await expect(
      edit(
        `${header(first)}\nPUT 1.=1:\n+FIRST\n${header(second)}\nPUT 1.=1:\n+SECOND`,
      ),
    ).rejects.toThrow(/no longer matches/);
    expect(await readFile(firstPath, "utf8")).toBe("first\n");
    expect(await readFile(secondPath, "utf8")).toBe("changed elsewhere\n");
  });

  test("leaves hard links untagged and rejects oversized edit output", async () => {
    const original = join(root, "original.txt");
    const alias = join(root, "alias.txt");
    await writeFile(original, "same\n");
    await link(original, alias);
    const originalRead = await read("original.txt");
    const aliasRead = await read("alias.txt");
    expect(originalRead.details?.hashlineAnchor).toBeUndefined();
    expect(aliasRead.details?.hashlineAnchor).toBeUndefined();

    const bounded = join(root, "bounded.txt");
    await writeFile(bounded, "same\n");
    const boundedRead = await read("bounded.txt");
    addToolResult(boundedRead.details);
    await expect(
      edit(`${header(boundedRead)}\nPUT 1.=1:\n+${"x".repeat(60_000)}`),
    ).rejects.toThrow(/output cap/);
    expect(await readFile(bounded, "utf8")).toBe("same\n");
  });

  test("rejects unknown and no-op edits", async () => {
    await writeFile(join(root, "safe.txt"), "same\n");
    await expect(
      edit("[safe.txt#AAAAAAAAAAAAAAAA]\nPUT 1.=1:\n+different"),
    ).rejects.toThrow(/Unknown tag/);

    const tagged = await read("safe.txt");
    addToolResult(tagged.details);
    await expect(edit(`${header(tagged)}\nPUT 1.=1:\n+same`)).rejects.toThrow(
      /no-op/,
    );
    expect(await readFile(join(root, "safe.txt"), "utf8")).toBe("same\n");
  });

  test("does not recover stale text from a previous extension runtime", async () => {
    const path = join(root, "runtime.txt");
    await writeFile(path, "one\ntwo\n");
    const tagged = await read("runtime.txt");
    addToolResult(tagged.details);
    await writeFile(path, "external\none\ntwo\n");

    const restartedTools = new Map<string, any>();
    registerExtension({
      registerTool(tool: any) {
        restartedTools.set(tool.name, tool);
      },
      async exec() {
        return { code: 1, stdout: "", stderr: "", killed: false };
      },
    } as never);
    await expect(
      restartedTools
        .get("edit")
        .execute(
          "edit-restarted",
          { script: `${header(tagged)}\nPUT 1.=1:\n+ONE` },
          undefined,
          undefined,
          context,
        ),
    ).rejects.toThrow(/no longer matches/);
    expect(await readFile(path, "utf8")).toBe("external\none\ntwo\n");
  });

  test("rejects newline-dense fallback reads before Pi allocates line arrays", async () => {
    await writeFile(join(root, "dense.txt"), "\n".repeat(100_001));
    await expect(read("dense.txt")).rejects.toThrow(
      /100000-line processing cap/,
    );
  });

  test("caps file sections before filesystem preflight", async () => {
    const script = Array.from(
      { length: 17 },
      (_, index) => `[file-${index}.txt#AAAAAAAAAAAAAAAA]\nPUT 1.=1:\n+changed`,
    ).join("\n");
    await expect(edit(script)).rejects.toThrow(/at most 16 file sections/);
  });
});
