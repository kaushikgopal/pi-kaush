import {
  createReadTool,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
} from "@earendil-works/pi-coding-agent";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { HashlineSnapshotStore } from "../src/hashline/snapshot-store.ts";
import registerReadTool from "../src/read/tool.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function readFixture(name: string, contents: string | Uint8Array) {
  const root = await mkdtemp(join(tmpdir(), "pi-better-read-fallback-"));
  roots.push(root);
  await writeFile(join(root, name), contents);
  let tool: any;
  registerReadTool(
    {
      registerTool(registered: any) {
        tool = registered;
      },
    } as never,
    new HashlineSnapshotStore(),
  );
  const context = { cwd: root };
  const result = await tool.execute(
    "read-fallback",
    { path: name },
    undefined,
    undefined,
    context,
  );
  const builtin = await createReadTool(root).execute(
    "builtin-read",
    { path: name },
    undefined,
    undefined,
  );
  return { result, builtin };
}

test("explains why an exact-text read fell back without changing details", async () => {
  const { result, builtin } = await readFixture(
    "invalid-utf8.txt",
    Uint8Array.of(0xff),
  );

  expect(result.details).toEqual(builtin.details);
  expect(result.content[0].text).toContain(
    "Untagged fallback: Hashline editing requires valid UTF-8 text.",
  );
  expect(result.content[0].text).toContain(
    "A usable edit requires a [path#TAG] header.",
  );
});

test("keeps the fallback explanation within Pi's output caps", async () => {
  const source = `${"x".repeat(32)}\n`.repeat(3_000);
  const { result } = await readFixture("large-rendering.txt", source);
  const text = result.content[0].text;

  expect(text).toContain("Untagged fallback:");
  expect(text).toContain("tagged rendering exceeds Pi's read output cap");
  expect(text).toMatch(/\[[^\n]*Use offset=\d+ to continue\.\]/u);
  const marker =
    /\[Showing lines 1-(\d+) of \d+[^\]]*Use offset=(\d+) to continue\.\]/u.exec(
      text,
    );
  expect(marker).not.toBeNull();
  const displayedEnd = Number(marker![1]);
  expect(Number(marker![2])).toBe(displayedEnd + 1);
  expect(
    text.slice(0, text.indexOf("\n\n[Showing lines")).split("\n"),
  ).toHaveLength(displayedEnd);
  expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(
    DEFAULT_MAX_BYTES,
  );
  expect(text.split("\n").length).toBeLessThanOrEqual(DEFAULT_MAX_LINES);
});

test("accounts for terminal newlines when reserving notice lines", async () => {
  const source = `\ufeff${"x\n".repeat(1_998)}`;
  const { result } = await readFixture("bom.txt", source);
  const text = result.content[0].text;

  expect(text).toContain("Untagged fallback:");
  expect(text.split("\n").length).toBeLessThanOrEqual(DEFAULT_MAX_LINES);
  expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(
    DEFAULT_MAX_BYTES,
  );
});

test("keeps an oversized first line instead of replacing it with a notice", async () => {
  const source = `\ufeff${"x".repeat(DEFAULT_MAX_BYTES - 100)}`;
  const { result, builtin } = await readFixture("long-bom.txt", source);

  const builtinText = builtin.content.find(
    (part) => part.type === "text",
  )?.text;
  expect(result.content[0].text).toBe(builtinText);
  expect(result.content[0].text).not.toContain("Untagged fallback:");
});
