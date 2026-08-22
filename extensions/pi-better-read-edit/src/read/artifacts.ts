import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { chmod, mkdtemp, opendir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { findCommand, requireCommand, runCommand } from "./commands.ts";
import {
  isLineSelector,
  parseLineSelector,
  selectTextRanges,
  splitInlineSelector,
} from "./selectors.ts";
import {
  HASHLINE_SNAPSHOT_CAP_BYTES,
  HASHLINE_SNAPSHOT_CAP_LINES,
} from "../hashline/contract.ts";
import { readBoundedFile, readBoundedText } from "./bounded.ts";
import { safeFetchText } from "./safe-url.ts";

export type ReadProjectionDetails = {
  sourceKind: string;
  sourcePath?: string;
  sourceUrl?: string;
  projection: boolean;
  mutableLocalText: boolean;
  truncation?: ReturnType<typeof truncateHead>;
  selector?: string;
  ranges?: string;
  totalLines: number;
  displayedLines: number;
  totalBytes: number;
  displayedBytes: number;
  contentType?: string;
  truncated: boolean;
  listingLimitReached?: boolean;
  omittedFiles?: number;
  omittedComments?: number;
};

export type ReadResult = {
  content: Array<{ type: "text"; text: string }>;
  details: ReadProjectionDetails;
};

type ReadParams = {
  path: string;
  offset?: number;
  limit?: number;
  selector?: string;
  ranges?: string;
};

const ARCHIVE_EXTENSIONS = [".tar.gz", ".tgz", ".tar", ".zip"] as const;
const SQLITE_EXTENSIONS = [".sqlite", ".sqlite3", ".db3", ".db"] as const;
const SQLITE_INPUT_CAP_BYTES = 64 * 1024 * 1024;

export function resolveLocalPath(cwd: string, input: string): string {
  let expanded = input;
  if (input.startsWith("file://")) expanded = new URL(input).pathname;
  else if (input === "~") expanded = homedir();
  else if (input.startsWith("~/")) expanded = join(homedir(), input.slice(2));
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}

async function withPrivateSnapshot<T>(
  bytes: Uint8Array,
  suffix: string,
  callback: (path: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "pi-better-read-edit-"));
  await chmod(directory, 0o700);
  const path = join(directory, `source${suffix}`);
  try {
    await writeFile(path, bytes, { mode: 0o600 });
    return await callback(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export function isUrl(input: string): boolean {
  return /^https?:\/\//i.test(input);
}

function result(
  text: string,
  details: Omit<
    ReadProjectionDetails,
    | "truncated"
    | "totalLines"
    | "displayedLines"
    | "totalBytes"
    | "displayedBytes"
  >,
  _options: { continuable?: boolean } = {},
): ReadResult {
  let sourceLines = text.length === 0 ? 0 : text.endsWith("\n") ? 0 : 1;
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) === 10) sourceLines++;
  }
  if (sourceLines > HASHLINE_SNAPSHOT_CAP_LINES) {
    throw new Error(
      `Projection output exceeds the ${HASHLINE_SNAPSHOT_CAP_LINES}-line processing cap. Refine the selector or source.`,
    );
  }
  const truncation = truncateHead(text, {
    maxBytes: DEFAULT_MAX_BYTES - 512,
    maxLines: DEFAULT_MAX_LINES - 2,
  });
  let output = truncation.content;
  if (truncation.truncated)
    output += `\n\n[Output truncated: showing ${truncation.outputLines ?? "some"} of ${truncation.totalLines ?? "many"} lines (${formatSize(truncation.outputBytes ?? Buffer.byteLength(output))} of ${formatSize(truncation.totalBytes ?? Buffer.byteLength(text))}).]`;
  const totalLines = truncation.totalLines ?? 0;
  const displayedLines = output === "" ? 0 : output.split("\n").length;
  return {
    content: [{ type: "text", text: output }],
    details: {
      ...details,
      totalLines,
      displayedLines,
      totalBytes: truncation.totalBytes ?? Buffer.byteLength(text),
      displayedBytes: Buffer.byteLength(output),
      truncated: truncation.truncated,
      ...(truncation.truncated ? { truncation } : {}),
    },
  };
}

function splitByKnownExtension(
  input: string,
  extensions: readonly string[],
): { file: string; rest: string } | undefined {
  const lower = input.toLowerCase();
  let best: { end: number; extensionLength: number } | undefined;
  for (const extension of extensions) {
    const marker = `${extension}:`;
    const markerIndex = lower.indexOf(marker);
    const end =
      markerIndex >= 0
        ? markerIndex + extension.length
        : lower.endsWith(extension)
          ? input.length
          : undefined;
    if (
      end !== undefined &&
      (!best ||
        end < best.end ||
        (end === best.end && extension.length > best.extensionLength))
    ) {
      best = { end, extensionLength: extension.length };
    }
  }
  return best
    ? { file: input.slice(0, best.end), rest: input.slice(best.end) }
    : undefined;
}

export function isArchivePath(input: string): boolean {
  return splitByKnownExtension(input, ARCHIVE_EXTENSIONS) !== undefined;
}

export function isSqlitePath(input: string): boolean {
  return splitByKnownExtension(input, SQLITE_EXTENSIONS) !== undefined;
}

export async function readDirectory(path: string): Promise<ReadResult> {
  const entries: import("node:fs").Dirent[] = [];
  let listingLimitReached = false;
  const directory = await opendir(path);
  for await (const entry of directory) {
    if (entries.length === 500) {
      listingLimitReached = true;
      break;
    }
    entries.push(entry);
  }
  entries.sort(
    (a, b) =>
      Number(b.isDirectory()) - Number(a.isDirectory()) ||
      a.name.localeCompare(b.name),
  );
  const body = entries
    .map(
      (entry) =>
        `${entry.isDirectory() ? "d" : entry.isSymbolicLink() ? "l" : "-"} ${entry.name}${entry.isDirectory() ? "/" : ""}`,
    )
    .join("\n");
  const suffix = listingLimitReached
    ? "\n[More entries omitted after the 500-entry enumeration cap]"
    : "";
  return result(body + suffix, {
    sourceKind: "directory",
    sourcePath: path,
    projection: true,
    mutableLocalText: false,
    ...(listingLimitReached ? { listingLimitReached: true } : {}),
  });
}

export async function readNotebook(
  path: string,
  selector: string | undefined,
): Promise<ReadResult> {
  const info = await stat(path);
  if (!info.isFile()) throw new Error("Notebook must be a regular file.");
  if (info.size > HASHLINE_SNAPSHOT_CAP_BYTES) {
    throw new Error("Notebook exceeds the 4 MiB projection input cap.");
  }
  const boundedNotebook = await readBoundedText(
    path,
    HASHLINE_SNAPSHOT_CAP_BYTES,
  );
  if (boundedNotebook.truncated)
    throw new Error("Notebook exceeds the 4 MiB projection input cap.");
  const notebook = JSON.parse(boundedNotebook.text) as {
    cells?: Array<{ cell_type?: string; source?: string | string[] }>;
  };
  const text = (notebook.cells ?? [])
    .map((cell, index) => {
      const source = Array.isArray(cell.source)
        ? cell.source.join("")
        : String(cell.source ?? "");
      return `# %% [${cell.cell_type ?? "cell"}] cell:${index + 1}\n${source.trimEnd()}`;
    })
    .join("\n\n");
  return result(
    selector && isLineSelector(selector)
      ? selectTextRanges(text, selector, { numbered: true })
      : text,
    {
      sourceKind: "notebook",
      sourcePath: path,
      projection: true,
      mutableLocalText: false,
      ...(selector ? { selector } : {}),
    },
    { continuable: !selector || selector.toLowerCase() === "raw" },
  );
}

async function readPdf(
  pi: ExtensionAPI,
  path: string,
  selector: string | undefined,
  signal: AbortSignal | undefined,
): Promise<ReadResult> {
  const bounded = await readBoundedFile(
    path,
    HASHLINE_SNAPSHOT_CAP_BYTES,
    signal,
  );
  if (bounded.truncated) throw new Error("PDF exceeds the 4 MiB input cap.");
  const command = await requireCommand(
    pi,
    ["pdftotext"],
    "Install poppler (for example, `brew install poppler`).",
    signal,
  );
  const text = await withPrivateSnapshot(bounded.bytes, ".pdf", (snapshot) =>
    runCommand(pi, command, [snapshot, "-"], {
      ...(signal ? { signal } : {}),
      timeout: 60_000,
    }),
  );
  return result(
    selector && isLineSelector(selector)
      ? selectTextRanges(text, selector, { numbered: true })
      : text,
    {
      sourceKind: "pdf",
      sourcePath: path,
      projection: true,
      mutableLocalText: false,
      ...(selector ? { selector } : {}),
    },
    { continuable: !selector || selector.toLowerCase() === "raw" },
  );
}

function validateArchiveMember(member: string): void {
  const normalized = member.replaceAll("\\", "/");
  if (
    member.includes("\0") ||
    /[\u0000-\u001F\u007F]/.test(member) ||
    normalized.startsWith("/") ||
    normalized.startsWith("-") ||
    /[*?[\]]/.test(normalized) ||
    normalized
      .split("/")
      .some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(
      "Archive members must be literal relative paths without traversal, controls, wildcards, or leading hyphens.",
    );
  }
}

function archiveEntryIdentity(entry: string): {
  original: string;
  stripped: string;
  canonical: string;
} {
  const original = entry.replaceAll("\\", "/");
  const stripped = original.replace(/^(?:\.\/)+/, "");
  const canonical = stripped
    .split("/")
    .filter((part) => part !== "" && part !== ".")
    .join("/");
  return { original, stripped, canonical };
}

async function readArchive(
  pi: ExtensionAPI,
  cwd: string,
  rawPath: string,
  explicitSelector: string | undefined,
  signal: AbortSignal | undefined,
): Promise<ReadResult> {
  const split = splitByKnownExtension(rawPath, ARCHIVE_EXTENSIONS);
  if (!split) throw new Error(`Not an archive path: ${rawPath}`);
  const archivePath = resolveLocalPath(cwd, split.file);
  const bounded = await readBoundedFile(
    archivePath,
    HASHLINE_SNAPSHOT_CAP_BYTES,
    signal,
  );
  if (bounded.truncated)
    throw new Error("Archive exceeds the 4 MiB input cap.");

  let member = split.rest.startsWith(":") ? split.rest.slice(1) : "";
  let selector = explicitSelector;
  if (!selector && member) {
    const inline = splitInlineSelector(member);
    member = inline.path;
    selector = inline.selector;
  }
  if (member) validateArchiveMember(member);
  const zip = split.file.toLowerCase().endsWith(".zip");
  const command = await requireCommand(
    pi,
    [zip ? "unzip" : "tar"],
    `Install ${zip ? "unzip" : "tar"} to read this archive.`,
    signal,
  );
  const suffix = zip
    ? ".zip"
    : split.file.toLowerCase().endsWith(".tar.gz")
      ? ".tar.gz"
      : ".tar";
  const text = await withPrivateSnapshot(
    bounded.bytes,
    suffix,
    async (snapshotPath) => {
      let extractionMember = member;
      if (member) {
        const listing = await runCommand(
          pi,
          command,
          zip ? ["-Z1", snapshotPath] : ["-tf", snapshotPath],
          { ...(signal ? { signal } : {}), timeout: 60_000 },
        );
        const normalizedMember = archiveEntryIdentity(member).canonical;
        const entries = listing
          .split("\n")
          .filter(Boolean)
          .map(archiveEntryIdentity);
        const matches = entries.filter(
          (entry) => entry.canonical === normalizedMember,
        );
        const directoryLike =
          entries.some(
            (entry) =>
              entry.canonical === normalizedMember &&
              entry.stripped.endsWith("/"),
          ) ||
          entries.some((entry) =>
            entry.canonical.startsWith(`${normalizedMember}/`),
          );
        if (directoryLike) {
          throw new Error(
            `Archive member '${member}' is a directory; select one literal file member.`,
          );
        }
        if (matches.length !== 1 || matches[0]!.stripped !== normalizedMember) {
          throw new Error(
            matches.length === 0
              ? `Archive member '${member}' does not exist.`
              : `Archive member '${member}' has duplicate or noncanonical aliases; refusing an ambiguous read.`,
          );
        }
        extractionMember = matches[0]!.original;
      }
      const args = zip
        ? member
          ? ["-p", snapshotPath, extractionMember]
          : ["-l", snapshotPath]
        : member
          ? ["-xOf", snapshotPath, "--", extractionMember]
          : ["-tf", snapshotPath];
      return runCommand(pi, command, args, {
        ...(signal ? { signal } : {}),
        timeout: 60_000,
      });
    },
  );
  return result(
    selector && isLineSelector(selector)
      ? selectTextRanges(text, selector, { numbered: true })
      : text,
    {
      sourceKind: member ? "archive-member" : "archive",
      sourcePath: archivePath,
      projection: true,
      mutableLocalText: false,
      ...(selector ? { selector } : {}),
    },
  );
}

function quoteSqlIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function quoteSqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function sqliteQuery(
  pi: ExtensionAPI,
  dbPath: string,
  sql: string,
  signal: AbortSignal | undefined,
): Promise<string> {
  const command = await requireCommand(
    pi,
    ["sqlite3"],
    "Install sqlite3 or add it to PATH.",
    signal,
  );
  const output = await runCommand(
    pi,
    command,
    [
      "-safe",
      "-readonly",
      "-header",
      "-column",
      "-cmd",
      ".limit length 2097152",
      "-cmd",
      ".limit vdbe_op 1000000",
      dbPath,
      sql,
    ],
    { ...(signal ? { signal } : {}), timeout: 30_000 },
  );
  const lines = output.split("\n");
  for (const category of ["length", "vdbe_op"]) {
    const index = lines
      .slice(0, 4)
      .findIndex((line) =>
        new RegExp(`^\\s*${category}\\s+\\d+\\s*$`).test(line),
      );
    if (index >= 0) lines.splice(index, 1);
  }
  return lines.join("\n");
}

async function readSqlite(
  pi: ExtensionAPI,
  cwd: string,
  rawPath: string,
  explicitSelector: string | undefined,
  outputRanges: string | undefined,
  signal: AbortSignal | undefined,
): Promise<ReadResult> {
  const split = splitByKnownExtension(rawPath, SQLITE_EXTENSIONS);
  if (!split) throw new Error(`Not a SQLite path: ${rawPath}`);
  const dbPath = resolveLocalPath(cwd, split.file);
  const bounded = await readBoundedFile(dbPath, SQLITE_INPUT_CAP_BYTES, signal);
  if (bounded.truncated) {
    throw new Error("SQLite database exceeds the 64 MiB input cap.");
  }
  const wal = await stat(`${dbPath}-wal`).catch(() => undefined);
  if (wal?.isFile() && wal.size > 0) {
    throw new Error(
      "SQLite WAL is active; checkpoint the database before reading a pinned snapshot.",
    );
  }
  return withPrivateSnapshot(bounded.bytes, ".db", async (snapshotPath) => {
    const selector =
      explicitSelector ??
      (split.rest.startsWith(":") ? split.rest.slice(1) : "");
    let text: string;
    if (!selector) {
      text = await sqliteQuery(
        pi,
        snapshotPath,
        "SELECT name FROM pragma_table_list WHERE schema='main' AND type='table' AND wr=0 AND name NOT LIKE 'sqlite_%' ORDER BY name LIMIT 50",
        signal,
      );
    } else if (selector.startsWith("q=")) {
      throw new Error(
        "Free-form SQLite queries are disabled. Use a table, table:rowid, or table?limit=N&offset=N selector.",
      );
    } else {
      const question = selector.indexOf("?");
      if (question !== -1 && selector.indexOf("?", question + 1) !== -1) {
        throw new Error(
          "SQLite selector may contain only one query separator.",
        );
      }
      const tableAndKey =
        question === -1 ? selector : selector.slice(0, question);
      const queryString = question === -1 ? "" : selector.slice(question + 1);
      const keySeparator = tableAndKey.indexOf(":");
      if (
        keySeparator !== -1 &&
        tableAndKey.indexOf(":", keySeparator + 1) !== -1
      ) {
        throw new Error(
          "SQLite selector may contain only one rowid separator.",
        );
      }
      const table =
        keySeparator === -1 ? tableAndKey : tableAndKey.slice(0, keySeparator);
      const key =
        keySeparator === -1 ? undefined : tableAndKey.slice(keySeparator + 1);
      if (
        !table ||
        table.length > 256 ||
        /[\u0000-\u001F\u007F]/.test(table) ||
        table.toLowerCase().startsWith("sqlite_")
      ) {
        throw new Error("SQLite selector must name a user table.");
      }
      if (key !== undefined && queryString)
        throw new Error(
          "SQLite rowid selectors do not allow query parameters.",
        );
      const params = new URLSearchParams(queryString);
      const names = [...params.keys()];
      if (new Set(names).size !== names.length)
        throw new Error("SQLite selector parameters may not be duplicated.");
      for (const name of names) {
        if (name !== "limit" && name !== "offset")
          throw new Error(
            "SQLite table selectors only allow limit and offset.",
          );
      }
      const limit = Number(params.get("limit") ?? 20);
      const offset = Number(params.get("offset") ?? 0);
      if (
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 200 ||
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        offset > 10_000
      ) {
        throw new Error(
          "SQLite limit must be 1-200 and offset must be between 0 and 10000.",
        );
      }
      const tableName = quoteSqlIdentifier(table);
      const tableLiteral = quoteSqlLiteral(table);
      const supported = await sqliteQuery(
        pi,
        snapshotPath,
        `SELECT CASE WHEN EXISTS (SELECT 1 FROM pragma_table_list WHERE schema='main' AND type='table' AND wr=0 AND name=${tableLiteral} AND name NOT LIKE 'sqlite_%') AND NOT EXISTS (SELECT 1 FROM pragma_table_xinfo(${tableLiteral}) WHERE lower(name) IN ('rowid','_rowid_','oid')) THEN 'ok' ELSE 'unsupported' END AS status`,
        signal,
      );
      if (!/\bok\b/.test(supported)) {
        throw new Error(
          "SQLite selectors support only ordinary rowid tables without shadowed rowid columns.",
        );
      }
      if (key !== undefined) {
        if (!/^-?\d+$/.test(key)) {
          throw new Error(
            "SQLite row selectors require a signed numeric rowid.",
          );
        }
        const rowid = BigInt(key);
        if (
          rowid < -9_223_372_036_854_775_808n ||
          rowid > 9_223_372_036_854_775_807n
        ) {
          throw new Error("SQLite rowid exceeds the signed 64-bit range.");
        }
        text = await sqliteQuery(
          pi,
          snapshotPath,
          `SELECT * FROM ${tableName} WHERE rowid = ${rowid.toString()} LIMIT 1`,
          signal,
        );
      } else {
        text = await sqliteQuery(
          pi,
          snapshotPath,
          `SELECT * FROM ${tableName} ORDER BY rowid LIMIT ${limit} OFFSET ${offset}`,
          signal,
        );
      }
    }

    const rendered = outputRanges
      ? selectTextRanges(text, outputRanges, { numbered: true })
      : text;
    return result(rendered, {
      sourceKind: "sqlite",
      sourcePath: dbPath,
      projection: true,
      mutableLocalText: false,
      ...(selector ? { selector } : {}),
      ...(outputRanges ? { ranges: outputRanges } : {}),
    });
  });
}

function parseGitHubPrUrl(
  input: string,
): { owner: string; repo: string; number: string } | undefined {
  const match = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i.exec(
    input,
  );
  return match
    ? { owner: match[1]!, repo: match[2]!, number: match[3]! }
    : undefined;
}

async function readGitHubPr(
  pi: ExtensionAPI,
  input: string,
  signal: AbortSignal | undefined,
): Promise<ReadResult> {
  const parsed = parseGitHubPrUrl(input);
  if (!parsed) throw new Error(`Not a GitHub PR URL: ${input}`);
  const command = await requireCommand(
    pi,
    ["gh"],
    "Install and authenticate GitHub CLI.",
    signal,
  );
  const raw = await runCommand(
    pi,
    command,
    [
      "pr",
      "view",
      parsed.number,
      "--repo",
      `${parsed.owner}/${parsed.repo}`,
      "--json",
      "number,title,state,author,url,body,headRefName,baseRefName,files,comments",
    ],
    { ...(signal ? { signal } : {}), timeout: 30_000 },
  );
  const pr = JSON.parse(raw) as Record<string, any>;
  const files = Array.isArray(pr.files) ? pr.files : [];
  const comments = Array.isArray(pr.comments) ? pr.comments : [];
  const text = [
    `# PR #${pr.number}: ${pr.title}`,
    `State: ${pr.state}`,
    `URL: ${pr.url}`,
    `Branch: ${pr.headRefName} -> ${pr.baseRefName}`,
    `Author: ${pr.author?.login ?? "unknown"}`,
    "",
    "## Body",
    String(pr.body ?? "").trim() || "(empty)",
    "",
    `## Files (${files.length})`,
    ...files
      .slice(0, 80)
      .map(
        (file: any) =>
          `- ${file.path}${file.additions !== undefined ? ` (+${file.additions}/-${file.deletions})` : ""}`,
      ),
    ...(files.length > 80
      ? [`- … ${files.length - 80} additional file(s) omitted`]
      : []),
    "",
    `## Comments (${comments.length})`,
    ...comments
      .slice(-20)
      .map(
        (comment: any) =>
          `### ${comment.author?.login ?? "unknown"}\n${String(comment.body ?? "").trim()}`,
      ),
    ...(comments.length > 20
      ? [`\n… ${comments.length - 20} earlier comment(s) omitted`]
      : []),
  ].join("\n");
  return result(text, {
    sourceKind: "github-pr",
    sourceUrl: input,
    projection: true,
    mutableLocalText: false,
    omittedFiles: Math.max(0, files.length - 80),
    omittedComments: Math.max(0, comments.length - 20),
  });
}

async function defuddleLocalHtml(
  pi: ExtensionAPI,
  path: string,
  signal: AbortSignal | undefined,
): Promise<string | undefined> {
  const command = await findCommand(pi, ["defuddle"], signal);
  if (!command) return undefined;
  try {
    const output = await runCommand(
      pi,
      command,
      ["parse", path, "--markdown"],
      { ...(signal ? { signal } : {}), timeout: 60_000 },
    );
    return output.trim() ? output : undefined;
  } catch (error) {
    if (signal?.aborted) throw error;
    return undefined;
  }
}

async function defuddleFetchedHtml(
  pi: ExtensionAPI,
  html: string,
  signal: AbortSignal | undefined,
): Promise<string | undefined> {
  const directory = await mkdtemp(join(tmpdir(), "pi-better-read-edit-"));
  await chmod(directory, 0o700);
  const path = join(directory, "article.html");
  try {
    await writeFile(path, html, { encoding: "utf8", mode: 0o600 });
    return await defuddleLocalHtml(pi, path, signal);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function readUrl(
  pi: ExtensionAPI,
  input: string,
  selector: string | undefined,
  signal: AbortSignal | undefined,
): Promise<ReadResult> {
  if (parseGitHubPrUrl(input)) return readGitHubPr(pi, input, signal);
  const fetched = await safeFetchText(input, {
    ...(signal ? { signal } : {}),
  });
  const raw = selector?.toLowerCase() === "raw";
  const extracted = raw
    ? undefined
    : await defuddleFetchedHtml(pi, fetched.text, signal);
  const text = extracted ?? fetched.text;
  return result(
    selector && isLineSelector(selector)
      ? selectTextRanges(text, selector, { numbered: true })
      : text,
    {
      sourceKind: extracted ? "url-article" : "url",
      sourceUrl: fetched.finalUrl,
      ...(fetched.contentType ? { contentType: fetched.contentType } : {}),
      projection: true,
      mutableLocalText: false,
      ...(selector ? { selector } : {}),
    },
    { continuable: !selector || selector.toLowerCase() === "raw" },
  );
}

function validateProjectionParams(
  path: string,
  selector: string | undefined,
  offset?: number,
  limit?: number,
): void {
  if (offset !== undefined || limit !== undefined)
    throw new Error(
      "offset/limit apply to ordinary local text only; use selector/ranges for projections.",
    );
  if (!selector) return;
  if (/github\.com\/[^/]+\/[^/]+\/pull\/\d+/i.test(path)) {
    throw new Error("GitHub PRs do not support selectors.");
  } else if (
    isUrl(path) ||
    isArchivePath(path) ||
    /\.(?:pdf|ipynb|html?)$/i.test(path)
  ) {
    if (selector.toLowerCase() === "raw") return;
    if (!isLineSelector(selector)) {
      throw new Error(
        `Unsupported selector '${selector}'; use raw or a line range.`,
      );
    }
    parseLineSelector(selector);
  }
}

export async function tryReadProjection(
  pi: ExtensionAPI,
  cwd: string,
  params: ReadParams,
  signal: AbortSignal | undefined,
): Promise<
  { result?: ReadResult; path: string; selector?: string } | undefined
> {
  let readPath = params.path;
  let selector = params.ranges ?? params.selector;
  if (isUrl(readPath)) {
    validateProjectionParams(readPath, selector, params.offset, params.limit);
    return {
      result: await readUrl(pi, readPath, selector, signal),
      path: readPath,
      ...(selector ? { selector } : {}),
    };
  }
  if (isArchivePath(readPath)) {
    validateProjectionParams(readPath, selector, params.offset, params.limit);
    return {
      result: await readArchive(pi, cwd, readPath, selector, signal),
      path: readPath,
      ...(selector ? { selector } : {}),
    };
  }
  if (isSqlitePath(readPath)) {
    validateProjectionParams(
      readPath,
      params.ranges,
      params.offset,
      params.limit,
    );
    if (params.ranges) parseLineSelector(params.ranges);
    if (params.selector && params.selector.length > 8_192) {
      throw new Error("SQLite selector is too long.");
    }
    return {
      result: await readSqlite(
        pi,
        cwd,
        readPath,
        params.selector,
        params.ranges,
        signal,
      ),
      path: readPath,
      ...(params.selector ? { selector: params.selector } : {}),
    };
  }
  if (!selector) {
    const split = splitInlineSelector(readPath);
    readPath = split.path;
    selector = split.selector;
  }
  validateProjectionParams(readPath, selector);

  const absolutePath = resolveLocalPath(cwd, readPath);
  const info = await stat(absolutePath).catch(() => undefined);
  if (!info) return undefined;
  if (info.isDirectory()) {
    validateProjectionParams(readPath, selector, params.offset, params.limit);
    if (selector) throw new Error("Directories do not support selectors.");
    return { result: await readDirectory(absolutePath), path: readPath };
  }
  if (!info.isFile())
    throw new Error(`Only regular files can be read: ${absolutePath}`);

  const extension = extname(absolutePath).toLowerCase();
  if (extension === ".pdf") {
    validateProjectionParams(readPath, selector, params.offset, params.limit);
    return {
      result: await readPdf(pi, absolutePath, selector, signal),
      path: readPath,
      ...(selector ? { selector } : {}),
    };
  }
  if (extension === ".ipynb") {
    validateProjectionParams(readPath, selector, params.offset, params.limit);
    return {
      result: await readNotebook(absolutePath, selector),
      path: readPath,
      ...(selector ? { selector } : {}),
    };
  }
  if (selector?.toLowerCase() === "raw") {
    validateProjectionParams(readPath, selector, params.offset, params.limit);
    const bounded = await readBoundedText(
      absolutePath,
      HASHLINE_SNAPSHOT_CAP_BYTES,
    );
    if (bounded.truncated)
      throw new Error("Local file exceeds the 4 MiB safety cap.");
    const text = bounded.text;
    return {
      result: result(
        text,
        {
          sourceKind: "raw-local-text",
          sourcePath: absolutePath,
          projection: false,
          mutableLocalText: true,
          selector,
        },
        { continuable: true },
      ),
      path: readPath,
      selector,
    };
  }
  if (extension === ".html" || extension === ".htm") {
    validateProjectionParams(readPath, selector, params.offset, params.limit);
    const bounded = await readBoundedText(
      absolutePath,
      HASHLINE_SNAPSHOT_CAP_BYTES,
      signal,
    );
    if (bounded.truncated)
      throw new Error("HTML file exceeds the 4 MiB safety cap.");
    const extracted = await defuddleFetchedHtml(pi, bounded.text, signal);
    const source = extracted ?? bounded.text;
    const text =
      selector && isLineSelector(selector)
        ? selectTextRanges(source, selector, { numbered: true })
        : source;
    return {
      result: result(
        text,
        {
          sourceKind: extracted ? "html-article" : "html-source",
          sourcePath: absolutePath,
          projection: true,
          mutableLocalText: false,
          ...(selector ? { selector } : {}),
        },
        { continuable: !selector || selector.toLowerCase() === "raw" },
      ),
      path: readPath,
      ...(selector ? { selector } : {}),
    };
  }
  return {
    path: readPath,
    ...(selector ? { selector } : {}),
  };
}

export function untaggedRangeResult(
  absolutePath: string,
  text: string,
  selector: string,
): ReadResult {
  return result(selectTextRanges(text, selector, { numbered: true }), {
    sourceKind: "local-text-range",
    sourcePath: absolutePath,
    projection: false,
    mutableLocalText: true,
    selector,
  });
}
