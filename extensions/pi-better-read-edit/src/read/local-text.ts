import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
} from "@earendil-works/pi-coding-agent";
import { realpath } from "node:fs/promises";
import { extname } from "node:path";
import {
  createHashlineRecord,
  decodeEligibleText,
  formatHashlineHeader,
  HASHLINE_SNAPSHOT_CAP_BYTES,
  throwIfAborted,
  type LineRange,
} from "../hashline/contract.ts";
import { clampRanges, isLineSelector, parseLineSelector } from "./selectors.ts";
import type { HashlineSnapshotStore } from "../hashline/snapshot-store.ts";
import { readBoundedFile } from "./bounded.ts";
import { resolveLocalPath } from "./artifacts.ts";

const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".ico",
  ".svg",
  ".avif",
  ".heic",
  ".tiff",
]);
const PROJECTION_EXTENSIONS = new Set([".html", ".htm", ".pdf", ".ipynb"]);

export type HashlineReadResult = {
  content: Array<{ type: "text"; text: string }>;
  details: {
    hashlineAnchor: ReturnType<typeof createHashlineRecord>;
    sourceKind: "local-text";
    sourcePath: string;
    projection: false;
    mutableLocalText: true;
    selectedRanges: LineRange[];
    continuation?: { nextOffset: number };
    truncation?: never;
  };
};

const MAX_TAGGED_SOURCE_LINES = Math.max(1, DEFAULT_MAX_LINES - 2);

export async function tryHashlineRead(
  cwd: string,
  displayPath: string,
  selection: { offset?: number; limit?: number; selector?: string },
  snapshots: HashlineSnapshotStore,
  signal?: AbortSignal,
): Promise<HashlineReadResult | undefined> {
  if (!displayPath.trim() || /[\u0000-\u001F\u007F]/.test(displayPath)) {
    return undefined;
  }
  throwIfAborted(signal);
  const absolutePath = resolveLocalPath(cwd, displayPath);
  const extension = extname(absolutePath).toLowerCase();
  if (IMAGE_EXTENSIONS.has(extension) || PROJECTION_EXTENSIONS.has(extension)) {
    return undefined;
  }

  let canonicalPath: string;
  try {
    canonicalPath = await realpath(absolutePath);
  } catch {
    return undefined;
  }

  throwIfAborted(signal);
  let bounded: Awaited<ReturnType<typeof readBoundedFile>>;
  try {
    bounded = await readBoundedFile(
      canonicalPath,
      HASHLINE_SNAPSHOT_CAP_BYTES,
      signal,
    );
  } catch {
    return undefined;
  }
  throwIfAborted(signal);
  if (bounded.truncated || bounded.links > 1) return undefined;

  let document: ReturnType<typeof decodeEligibleText>;
  try {
    document = decodeEligibleText(bounded.bytes);
  } catch {
    return undefined;
  }

  const lineCount = document.lines.length;
  let ranges: LineRange[];
  if (selection.selector !== undefined) {
    if (!isLineSelector(selection.selector)) return undefined;
    ranges = clampRanges(parseLineSelector(selection.selector), lineCount);
  } else if (selection.offset !== undefined || selection.limit !== undefined) {
    const offset = selection.offset ?? 1;
    const limit = selection.limit ?? MAX_TAGGED_SOURCE_LINES;
    if (
      !Number.isSafeInteger(offset) ||
      offset < 1 ||
      !Number.isSafeInteger(limit) ||
      limit < 1
    ) {
      throw new Error("Read offset and limit must be positive integers.");
    }
    if (lineCount === 0) {
      if (selection.offset !== undefined) {
        throw new Error("Read offset is beyond EOF (empty file).");
      }
      ranges = [];
    } else {
      ranges = clampRanges(
        [{ start: offset, end: offset + limit - 1 }],
        lineCount,
      );
    }
  } else {
    ranges =
      lineCount === 0
        ? []
        : [{ start: 1, end: Math.min(lineCount, MAX_TAGGED_SOURCE_LINES) }];
  }

  const selectedLineCount = ranges.reduce(
    (total, range) => total + range.end - range.start + 1,
    0,
  );
  if (selectedLineCount > MAX_TAGGED_SOURCE_LINES) return undefined;
  const lastSelectedLine = ranges.at(-1)?.end ?? 0;
  const nextOffset =
    selection.selector === undefined && lastSelectedLine < lineCount
      ? lastSelectedLine + 1
      : undefined;

  const record = createHashlineRecord({
    canonicalPath,
    displayPath,
    document,
    seenRanges: ranges,
    eofSeen: lineCount === 0 || ranges.some((range) => range.end === lineCount),
    producer: "read",
  });
  const output = [formatHashlineHeader(displayPath, record.tag)];
  for (const [rangeIndex, range] of ranges.entries()) {
    for (let line = range.start; line <= range.end; line++) {
      const source = document.lines[line - 1] ?? "";
      if (Buffer.byteLength(source, "utf8") > DEFAULT_MAX_BYTES) {
        return undefined;
      }
      output.push(`${line}:${source}`);
    }
    if (rangeIndex < ranges.length - 1) output.push("…");
  }
  if (nextOffset !== undefined) {
    output.push(`[More lines available; continue with offset=${nextOffset}.]`);
  }
  const text = output.join("\n");
  if (
    output.length > DEFAULT_MAX_LINES ||
    Buffer.byteLength(text, "utf8") > DEFAULT_MAX_BYTES
  ) {
    return undefined;
  }
  snapshots.record(record, document);

  return {
    content: [{ type: "text", text }],
    details: {
      hashlineAnchor: record,
      sourceKind: "local-text",
      sourcePath: canonicalPath,
      projection: false,
      mutableLocalText: true,
      selectedRanges: ranges,
      ...(nextOffset !== undefined ? { continuation: { nextOffset } } : {}),
    },
  };
}
