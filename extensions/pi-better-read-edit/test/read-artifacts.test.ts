import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  isArchivePath,
  isSqlitePath,
  readDirectory,
  readNotebook,
  resolveLocalPath,
  tryReadProjection,
} from "../src/read/artifacts.ts";
import {
  parseLineSelector,
  selectTextRanges,
  splitInlineSelector,
} from "../src/read/selectors.ts";
import { isUnsafeAddress, safeFetchText } from "../src/read/safe-url.ts";
import { readBoundedFile } from "../src/read/bounded.ts";

const roots: string[] = [];

function tarArchive(entries: Array<{ name: string; text: string }>): Buffer {
  const blocks: Buffer[] = [];
  const octal = (
    header: Buffer,
    offset: number,
    length: number,
    value: number,
  ) => {
    header.write(
      `${value.toString(8).padStart(length - 1, "0")}\0`,
      offset,
      length,
      "ascii",
    );
  };
  for (const entry of entries) {
    const body = Buffer.from(entry.text);
    const header = Buffer.alloc(512);
    header.write(entry.name, 0, 100, "utf8");
    octal(header, 100, 8, 0o644);
    octal(header, 108, 8, 0);
    octal(header, 116, 8, 0);
    octal(header, 124, 12, body.length);
    octal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    header.write("0", 156, 1, "ascii");
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(
      `${checksum.toString(8).padStart(6, "0")}\0 `,
      148,
      8,
      "ascii",
    );
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  return Buffer.concat([...blocks, Buffer.alloc(1024)]);
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("read selectors", () => {
  test("parses counts, windows, open ranges, sorting, and merging", () => {
    expect(parseLineSelector("8+2,1-3,4", 2)).toEqual([
      { start: 1, end: 5 },
      { start: 8, end: 9 },
    ]);
    expect(parseLineSelector("10-", 4)).toEqual([{ start: 10, end: 13 }]);
  });

  test("renders one-based selected lines and rejects beyond EOF", () => {
    expect(selectTextRanges("a\nb\nc\nd", "2-2,4-4", { numbered: true })).toBe(
      "2|b\n…\n4|d",
    );
    expect(() => selectTextRanges("a\n", "2-3")).toThrow(/beyond EOF/);
  });

  test("splits inline selectors without splitting URLs", () => {
    expect(splitInlineSelector("notes.md:2-4")).toEqual({
      path: "notes.md",
      selector: "2-4",
    });
    expect(splitInlineSelector("https://example.com/a:2-4")).toEqual({
      path: "https://example.com/a:2-4",
    });
  });
});

describe("local projections", () => {
  test("renders directories first with stable markers", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-better-read-"));
    roots.push(root);
    await writeFile(join(root, "a.txt"), "a");
    await mkdir(join(root, "z-dir"));
    const projection = await readDirectory(root);
    expect(projection.content[0]!.text).toMatch(/^d z-dir\/\n- a\.txt/);
    expect(projection.details).toMatchObject({
      sourceKind: "directory",
      projection: true,
      mutableLocalText: false,
    });
  });

  test("bounds directory enumeration work", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-better-read-"));
    roots.push(root);
    await Promise.all(
      Array.from({ length: 505 }, (_, index) =>
        writeFile(join(root, `entry-${String(index).padStart(3, "0")}`), ""),
      ),
    );
    const projection = await readDirectory(root);
    expect(projection.details.listingLimitReached).toBe(true);
    expect(projection.content[0]!.text).toContain("500-entry enumeration cap");
  });

  test("reports bounded projection truncation without a misleading cursor", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-better-read-"));
    roots.push(root);
    const path = join(root, "large.ipynb");
    await writeFile(
      path,
      JSON.stringify({
        cells: [
          {
            cell_type: "code",
            source: Array.from(
              { length: 2_100 },
              (_, index) => `line-${index}\n`,
            ),
          },
        ],
      }),
    );
    const projection = await readNotebook(path, undefined);
    expect(projection.details.truncated).toBe(true);
    expect(projection.details.totalLines).toBeGreaterThan(
      projection.details.displayedLines,
    );

    const selected = await readNotebook(path, "1-2100");
    expect(selected.details.truncated).toBe(true);
  });

  test("renders notebook cells as an untagged projection", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-better-read-"));
    roots.push(root);
    const path = join(root, "example.ipynb");
    await writeFile(
      path,
      JSON.stringify({
        cells: [{ cell_type: "code", source: ["print(1)\n"] }],
      }),
    );
    const projection = await readNotebook(path, undefined);
    expect(projection.content[0]!.text).toContain(
      "# %% [code] cell:1\nprint(1)",
    );
    expect(projection.details.mutableLocalText).toBe(false);
  });

  test("routes only complete archive and SQLite extensions", () => {
    expect(isArchivePath("archive.tar.gz:src/a.ts")).toBe(true);
    expect(isArchivePath("archive.zip.backup")).toBe(false);
    expect(isSqlitePath("report.sqlite3:users")).toBe(true);
    expect(isSqlitePath("report.sqlite3.backup")).toBe(false);
    expect(isSqlitePath("dir.db/file.txt")).toBe(false);
  });

  test("rejects FIFOs without waiting for a writer", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-better-read-"));
    roots.push(root);
    const fifo = join(root, "blocked.db");
    execFileSync("mkfifo", [fifo]);
    await expect(readBoundedFile(fifo)).rejects.toThrow(/regular files/);
  });

  test("keeps SQLite resource selectors separate from output ranges", async () => {
    let sqlite: string;
    try {
      sqlite = execFileSync("which", ["sqlite3"], { encoding: "utf8" }).trim();
    } catch {
      return;
    }
    const root = await mkdtemp(join(tmpdir(), "pi-better-read-"));
    roots.push(root);
    execFileSync(sqlite, [
      join(root, "data.db"),
      "CREATE TABLE users(name TEXT); INSERT INTO users VALUES ('Ada'); CREATE VIEW bomb AS SELECT printf('%.*c',900000000,'x') AS value;",
    ]);
    const pi = {
      async exec() {
        return { code: 0, stdout: `${sqlite}\n`, stderr: "", killed: false };
      },
    } as never;
    const selected = await tryReadProjection(
      pi,
      root,
      { path: "data.db", selector: "users", ranges: "3-3" },
      undefined,
    );
    expect(selected?.result?.details).toMatchObject({
      selector: "users",
      ranges: "3-3",
    });
    expect(selected?.result?.content[0]?.text).toContain("3|");
    await expect(
      tryReadProjection(
        pi,
        root,
        { path: "data.db", selector: "bomb" },
        undefined,
      ),
    ).rejects.toThrow(/ordinary rowid tables/);
  });

  test("rejects unsafe archive members and free-form SQLite queries", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-better-read-"));
    roots.push(root);
    await writeFile(join(root, "archive.tar"), "not needed");
    await writeFile(join(root, "data.db"), "not needed");
    const pi = {
      async exec() {
        throw new Error("command lookup must not run");
      },
    } as never;
    await expect(
      tryReadProjection(
        pi,
        root,
        { path: "archive.tar:-checkpoint=1" },
        undefined,
      ),
    ).rejects.toThrow(/literal relative paths/);
    await expect(
      tryReadProjection(
        pi,
        root,
        { path: "data.db:q=SELECT%20writefile('x','y')" },
        undefined,
      ),
    ).rejects.toThrow(/Free-form SQLite queries are disabled/);
  });

  test("rejects directory-like TAR selections before extraction", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-better-read-"));
    roots.push(root);
    await mkdir(join(root, "dir"));
    await writeFile(join(root, "dir", "inside.txt"), "inside");
    const archive = join(root, "archive.tar");
    execFileSync("tar", ["-cf", archive, "-C", root, "dir"]);
    const pi = {
      async exec() {
        return {
          code: 0,
          stdout: `${execFileSync("which", ["tar"], { encoding: "utf8" }).trim()}\n`,
          stderr: "",
          killed: false,
        };
      },
    } as never;
    await expect(
      tryReadProjection(pi, root, { path: "archive.tar:dir" }, undefined),
    ).rejects.toThrow(/directory/);
  });

  test("rejects canonical TAR member aliases before extraction", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-better-read-"));
    roots.push(root);
    await writeFile(
      join(root, "aliases.tar"),
      tarArchive([
        { name: "a/b", text: "one" },
        { name: "a//b", text: "two" },
        { name: "a/./b", text: "three" },
      ]),
    );
    const tar = execFileSync("which", ["tar"], { encoding: "utf8" }).trim();
    const pi = {
      async exec() {
        return { code: 0, stdout: `${tar}\n`, stderr: "", killed: false };
      },
    } as never;
    await expect(
      tryReadProjection(pi, root, { path: "aliases.tar:a/b" }, undefined),
    ).rejects.toThrow(/duplicate or noncanonical aliases/);
  });

  test("resolves home, file URLs, and cwd-relative paths", () => {
    expect(resolveLocalPath("/work", "src/a.ts")).toBe("/work/src/a.ts");
    expect(resolveLocalPath("/work", "file:///tmp/a.ts")).toBe("/tmp/a.ts");
    expect(resolveLocalPath("/work", "~/a.ts")).toContain("/a.ts");
  });
});

describe("URL safety", () => {
  test("rejects private, metadata, mapped, and transition addresses", () => {
    for (const address of [
      "127.0.0.1",
      "10.0.0.1",
      "169.254.169.254",
      "168.63.129.16",
      "192.168.1.1",
      "::1",
      "fc00::1",
      "fe80::1",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "::ffff:a9fe:a9fe",
      "0:0:0:0:0:0:0:1",
      "0:0:0:0:0:ffff:7f00:1",
      "::ffff:0:169.254.169.254",
      "0:0:0:0:ffff:0:a9fe:a9fe",
      "2002:7f00:1::",
      "2001:2::",
      "2001:20::",
      "3fff::1",
    ]) {
      expect(isUnsafeAddress(address), address).toBe(true);
    }
    expect(isUnsafeAddress("93.184.216.34")).toBe(false);
    expect(isUnsafeAddress("2606:2800:220:1:248:1893:25c8:1946")).toBe(false);
    expect(isUnsafeAddress("2001:4860:4860::8888")).toBe(false);
  });

  test("rejects malformed SQLite selectors before command execution", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-better-read-"));
    roots.push(root);
    await writeFile(join(root, "data.db"), "not a database");
    let calls = 0;
    const pi = {
      async exec() {
        calls++;
        throw new Error("must not execute");
      },
    } as never;
    for (const selector of [
      "users?limit=1&limit=2",
      "users?offset=10001",
      "users:1?limit=1",
      "users:1:2",
      "users?limit=1?offset=2",
    ]) {
      await expect(
        tryReadProjection(pi, root, { path: `data.db:${selector}` }, undefined),
      ).rejects.toThrow();
    }
    expect(calls).toBe(0);
  });

  test("bounds oversized raw local files", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-better-read-"));
    roots.push(root);
    await writeFile(join(root, "large.txt"), Buffer.alloc(4 * 1024 * 1024 + 1));
    const pi = {
      async exec() {
        throw new Error("must not execute");
      },
    } as never;
    await expect(
      tryReadProjection(
        pi,
        root,
        { path: "large.txt", selector: "raw" },
        undefined,
      ),
    ).rejects.toThrow(/safety cap/);
  });

  test("rejects projection pagination before invoking an adapter", async () => {
    let calls = 0;
    const pi = {
      async exec() {
        calls++;
        throw new Error("must not execute");
      },
    } as never;
    await expect(
      tryReadProjection(
        pi,
        "/tmp",
        { path: "https://github.com/example/repo/pull/1", offset: 1 },
        undefined,
      ),
    ).rejects.toThrow(/offset\/limit/);
    expect(calls).toBe(0);
  });

  test("rejects a hostname when any DNS answer is private", async () => {
    await expect(
      safeFetchText("https://example.test", {
        resolver: async () => [
          { address: "93.184.216.34", family: 4 },
          { address: "127.0.0.1", family: 4 },
        ],
      }),
    ).rejects.toThrow(/non-public address/);
  });
});
