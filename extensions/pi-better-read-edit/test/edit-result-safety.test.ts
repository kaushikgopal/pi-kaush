import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import registerEditTool from "../src/edit/tool.ts";
import {
  createHashlineRecord,
  decodeEligibleText,
} from "../src/hashline/contract.ts";
import { HashlineSnapshotStore } from "../src/hashline/snapshot-store.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function editFixture(name: string, source: string) {
  const root = await mkdtemp(join(tmpdir(), "pi-better-edit-safety-"));
  roots.push(root);
  const path = join(root, name);
  await writeFile(path, source);
  const canonicalPath = await realpath(path);
  const document = decodeEligibleText(Buffer.from(source));
  const record = createHashlineRecord({
    canonicalPath,
    displayPath: name,
    document,
    seenRanges:
      document.lines.length > 0
        ? [{ start: 1, end: document.lines.length }]
        : [],
    eofSeen: true,
    producer: "read",
  });
  const branch = [
    {
      type: "message",
      message: {
        role: "toolResult",
        toolName: "read",
        isError: false,
        details: { hashlineAnchor: record },
      },
    },
  ];
  let tool: any;
  registerEditTool(
    {
      registerTool(registered: any) {
        tool = registered;
      },
    } as never,
    new HashlineSnapshotStore(),
  );
  const context = {
    cwd: root,
    sessionManager: { getBranch: () => branch },
  };
  return {
    path,
    record,
    execute: (script: string) =>
      tool.execute("edit-safety", { script }, undefined, undefined, context),
  };
}

test("caps the complete serialized edit details before writing", async () => {
  const source =
    Array.from(
      { length: 1_000 },
      (_, index) => `${index}:${"x".repeat(1_150)}`,
    ).join("\n") + "\n";
  const fixture = await editFixture("large-delete.txt", source);

  await expect(
    fixture.execute(`[large-delete.txt#${fixture.record.tag}]\nCUT 1.=1000`),
  ).rejects.toThrow(/Serialized hashline edit details would exceed the 4 MiB/);
  expect(await readFile(fixture.path, "utf8")).toBe(source);
});

test("does not present an unregistered live digest as a current edit tag", async () => {
  const fixture = await editFixture("stale.txt", "one\ntwo\n");
  await writeFile(fixture.path, "external\none\ntwo\n");

  const error = await fixture
    .execute(`[stale.txt#${fixture.record.tag}]\nPUT 1.=1:\n+ONE`)
    .then(
      () => undefined,
      (reason: unknown) => reason,
    );
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toMatch(
    /no longer matches the tagged read.*Reread the file/,
  );
  expect((error as Error).message).not.toContain("Current tag:");
});
