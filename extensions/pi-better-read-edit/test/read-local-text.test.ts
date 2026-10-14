import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
} from "@earendil-works/pi-coding-agent";
import { link, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as contract from "../src/hashline/contract.ts";
import { HashlineSnapshotStore } from "../src/hashline/snapshot-store.ts";
import { tryHashlineRead } from "../src/read/local-text.ts";
import registerReadTool from "../src/read/tool.ts";

let root: string;
let snapshots: HashlineSnapshotStore;
const maxLines = DEFAULT_MAX_LINES - 2;
type Selection = Parameters<typeof tryHashlineRead>[2];

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "pi-local-text-")));
  snapshots = new HashlineSnapshotStore();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

async function read(selection: Selection = {}, path = "source.txt") {
  const attempt = await tryHashlineRead(root, path, selection, snapshots);
  return attempt.status === "available"
    ? { result: attempt.result, reason: undefined }
    : { result: undefined, reason: attempt.reason };
}

describe("hashline unavailability", () => {
  test.each([
    [
      "blank path",
      " ",
      "the path cannot be represented safely in a hashline header",
    ],
    [
      "control in path",
      "bad\u0000.txt",
      "the path cannot be represented safely in a hashline header",
    ],
    ["image", "source.PNG", "this file type uses Pi's ordinary reader"],
    ["projection", "source.pdf", "this file type uses Pi's ordinary reader"],
    [
      "missing path",
      "missing.txt",
      "the path could not be resolved to one existing file",
    ],
    ["directory", ".", "the file could not be safely snapshotted"],
  ])("reports %s before later checks", async (_name, path, reason) => {
    expect(await read({}, path)).toEqual({ result: undefined, reason });
  });

  test.each([
    [
      "snapshot bytes",
      Buffer.alloc(contract.HASHLINE_SNAPSHOT_CAP_BYTES + 1),
      {},
      "the file exceeds the 4 MiB hashline snapshot cap",
    ],
    [
      "BOM",
      Buffer.from("﻿text"),
      {},
      "Hashline editing does not support UTF-8 BOM files.",
    ],
    [
      "UTF-8",
      Buffer.from([0xff]),
      {},
      "Hashline editing requires valid UTF-8 text.",
    ],
    [
      "lone CR",
      "a\rb",
      {},
      "Hashline editing does not support lone CR line endings.",
    ],
    [
      "mixed endings",
      "a\r\nb\n",
      {},
      "Hashline editing does not support mixed line endings.",
    ],
    [
      "logical lines",
      "\n".repeat(100_001),
      {},
      "Hashline editing supports at most 100000 logical lines per file.",
    ],
    [
      "unsupported selector",
      "a\n",
      { selector: "raw" },
      "the line selector is not supported for tagged text",
    ],
    [
      "selected lines",
      "x\n".repeat(maxLines + 1),
      { limit: maxLines + 1 },
      `the selection exceeds the ${maxLines}-line tagged-output cap`,
    ],
    [
      "single line bytes",
      "x".repeat(DEFAULT_MAX_BYTES + 1),
      {},
      "line 1 exceeds Pi's tagged-read byte cap",
    ],
    [
      "rendered bytes",
      ("x".repeat(DEFAULT_MAX_BYTES / 2) + "\n").repeat(2),
      {},
      "the tagged rendering exceeds Pi's read output cap",
    ],
    [
      "rendered lines",
      "x\n".repeat(2 * maxLines),
      {
        selector: Array.from(
          { length: 99 },
          (_, i) => `${21 * i + 1}-${21 * i + 20}`,
        ).join(","),
      },
      "the tagged rendering exceeds Pi's read output cap",
    ],
  ] as const)("reports %s", async (_name, source, selection, reason) => {
    await writeFile(join(root, "source.txt"), source);
    expect(await read(selection)).toEqual({ result: undefined, reason });
    if (
      typeof source === "string" &&
      !source.includes("\r") &&
      source.length < 100_000
    ) {
      const document = contract.decodeEligibleText(Buffer.from(source));
      const record = contract.createHashlineRecord({
        canonicalPath: join(root, "source.txt"),
        displayPath: "source.txt",
        document,
        seenRanges: [],
        eofSeen: false,
        producer: "read",
      });
      expect(snapshots.lookup(record)).toBeUndefined();
    }
  });

  test("reports hard links before decoding or selecting", async () => {
    await writeFile(join(root, "source.txt"), Buffer.from([0xff]));
    await link(join(root, "source.txt"), join(root, "alias.txt"));
    expect(await read({ selector: "raw" })).toEqual({
      result: undefined,
      reason: "the file has multiple hard links",
    });
  });

  test("uses the exact-text fallback for a non-Error decoder failure", async () => {
    await writeFile(join(root, "source.txt"), "text");
    vi.spyOn(contract, "decodeEligibleText").mockImplementationOnce(() => {
      throw "decoder failure";
    });
    expect(await read()).toEqual({
      result: undefined,
      reason: "the file is not eligible exact UTF-8 text",
    });
  });
});

describe("hashline selection and rendering", () => {
  test.each([
    [
      "default",
      "one\ntwo\nthree\nfour\n",
      {},
      ["1:one", "2:two", "3:three", "4:four"],
      [{ start: 1, end: 4 }],
      undefined,
      true,
    ],
    ["empty default", "", {}, [], [], undefined, true],
    ["empty limit", "", { limit: 1 }, [], [], undefined, true],
    [
      "offset default limit",
      "one\ntwo\nthree\nfour\n",
      { offset: 2 },
      ["2:two", "3:three", "4:four"],
      [{ start: 2, end: 4 }],
      undefined,
      true,
    ],
    [
      "limit default offset",
      "one\ntwo\nthree\nfour\n",
      { limit: 2 },
      ["1:one", "2:two", "[More lines available; continue with offset=3.]"],
      [{ start: 1, end: 2 }],
      3,
      false,
    ],
    [
      "clamped window",
      "one\ntwo\nthree\nfour\n",
      { offset: 3, limit: 10 },
      ["3:three", "4:four"],
      [{ start: 3, end: 4 }],
      undefined,
      true,
    ],
    [
      "selector suppresses continuation",
      "one\ntwo\nthree\nfour\n",
      { selector: "2-2" },
      ["2:two"],
      [{ start: 2, end: 2 }],
      undefined,
      false,
    ],
    [
      "disjoint clamped selector",
      "one\ntwo\nthree\nfour\n",
      { selector: "1-1,3-9" },
      ["1:one", "…", "3:three", "4:four"],
      [
        { start: 1, end: 1 },
        { start: 3, end: 4 },
      ],
      undefined,
      true,
    ],
    [
      "selector wins internally",
      "one\ntwo\nthree\nfour\n",
      { selector: "2-2", offset: 0, limit: 0 },
      ["2:two"],
      [{ start: 2, end: 2 }],
      undefined,
      false,
    ],
    [
      "CRLF",
      "one\r\ntwo\r\n",
      {},
      ["1:one", "2:two"],
      [{ start: 1, end: 2 }],
      undefined,
      true,
    ],
  ] as const)(
    "preserves %s",
    async (_name, source, selection, lines, ranges, nextOffset, eofSeen) => {
      await writeFile(join(root, "source.txt"), source);
      const { result, reason } = await read(selection);
      expect(reason).toBeUndefined();
      expect(result?.content[0]?.text.split("\n").slice(1)).toEqual(lines);
      expect(result?.content[0]?.text.split("\n")[0]).toMatch(
        /^\[source\.txt#[0-9A-F]{16}\]$/,
      );
      expect(result?.details.selectedRanges).toEqual(ranges);
      expect(result?.details.continuation).toEqual(
        nextOffset === undefined ? undefined : { nextOffset },
      );
      expect(result?.details.hashlineAnchor).toMatchObject({
        seenRanges: ranges,
        eofSeen,
      });
      expect(
        snapshots.lookup(result!.details.hashlineAnchor)?.document.logicalText,
      ).toBe(source.replaceAll("\r\n", "\n"));
    },
  );

  test("uses the default page cap and records only displayed authorization", async () => {
    await writeFile(join(root, "source.txt"), "x\n".repeat(maxLines + 1));
    const { result } = await read();
    expect(result?.content[0]?.text.split("\n")).toHaveLength(
      DEFAULT_MAX_LINES,
    );
    expect(result?.details.selectedRanges).toEqual([
      { start: 1, end: maxLines },
    ]);
    expect(result?.details.continuation).toEqual({ nextOffset: maxLines + 1 });
    expect(result?.details.hashlineAnchor.eofSeen).toBe(false);
  });

  test.each([
    [
      "invalid offset",
      "x",
      { offset: 0 },
      "Read offset and limit must be positive integers.",
    ],
    [
      "fractional offset",
      "x",
      { offset: 1.5 },
      "Read offset and limit must be positive integers.",
    ],
    [
      "invalid limit",
      "x",
      { limit: 0 },
      "Read offset and limit must be positive integers.",
    ],
    [
      "fractional limit",
      "x",
      { limit: 1.5 },
      "Read offset and limit must be positive integers.",
    ],
    [
      "empty offset",
      "",
      { offset: 1 },
      "Read offset is beyond EOF (empty file).",
    ],
    [
      "empty selector",
      "",
      { selector: "1-1" },
      "Line selector starts at 1, beyond EOF (0 line(s)).",
    ],
    [
      "offset EOF",
      "x\n",
      { offset: 2 },
      "Line selector starts at 2, beyond EOF (1 line(s)).",
    ],
    [
      "selector EOF",
      "x\n",
      { selector: "2-2" },
      "Line selector starts at 2, beyond EOF (1 line(s)).",
    ],
    [
      "invalid selector order",
      "x\n",
      { selector: "2-1" },
      "Invalid line selector '2-1': end must be >= start.",
    ],
  ] as const)(
    "throws for %s instead of falling back",
    async (_name, source, selection, message) => {
      await writeFile(join(root, "source.txt"), source);
      await expect(read(selection)).rejects.toThrow(message);
    },
  );
});

test("keeps fallback reasons in range reads and internal status out of tool results", async () => {
  await writeFile(join(root, "source.txt"), "﻿one\ntwo\n");
  let tool: any;
  registerReadTool(
    {
      registerTool(value: unknown) {
        tool = value;
      },
    } as never,
    snapshots,
  );
  const result = await tool.execute(
    "read",
    { path: "source.txt", selector: "2-2" },
    undefined,
    undefined,
    { cwd: root },
  );
  expect(result.content[0].text).toBe(
    "2|two\n\n[Untagged fallback: Hashline editing does not support UTF-8 BOM files. A usable edit requires a [path#TAG] header.]",
  );
  await writeFile(join(root, "source.txt"), "one\ntwo\n");
  const tagged = await tool.execute(
    "read",
    { path: "source.txt" },
    undefined,
    undefined,
    { cwd: root },
  );
  expect(tagged.structuredContent.source).toBe("tagged");
  expect(tagged.details.hashlineAnchor).toBeDefined();
  expect(Object.keys(tagged).sort()).toEqual([
    "content",
    "details",
    "structuredContent",
  ]);
});
