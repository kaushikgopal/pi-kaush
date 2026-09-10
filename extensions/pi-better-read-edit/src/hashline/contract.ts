import { createHash } from "node:crypto";
import type { HashlineOperation } from "./parser.ts";

export const HASHLINE_SCHEMA = "pi-better-read-edit/hashline/v1" as const;
export const HASHLINE_TAG_LENGTH = 16;
export const HASHLINE_SNAPSHOT_CAP_BYTES = 4 * 1024 * 1024;
export const HASHLINE_SNAPSHOT_CAP_LINES = 100_000;

export type LineEnding = "lf" | "crlf";
export type HashlineProducer = "read" | "edit";

export type LineRange = {
  start: number;
  end: number;
};

export type HashlineRecord = {
  schema: typeof HASHLINE_SCHEMA;
  canonicalPath: string;
  displayPath: string;
  tag: string;
  fullDigest: string;
  lineCount: number;
  finalNewline: boolean;
  lineEnding: LineEnding;
  seenRanges: LineRange[];
  eofSeen: boolean;
  producer: HashlineProducer;
};

export type LogicalDocument = {
  logicalText: string;
  lines: string[];
  finalNewline: boolean;
  lineEnding: LineEnding;
};

const TAG_RE = /^[0-9A-F]{16}$/;
const DIGEST_RE = /^[0-9A-F]{64}$/;

export function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error("Operation aborted");
}

export function decodeEligibleText(bytes: Uint8Array): LogicalDocument {
  if (
    bytes.byteLength >= 3 &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf
  ) {
    throw new Error("Hashline editing does not support UTF-8 BOM files.");
  }

  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Hashline editing requires valid UTF-8 text.");
  }

  const withoutCrLf = source.replace(/\r\n/g, "");
  if (withoutCrLf.includes("\r")) {
    throw new Error("Hashline editing does not support lone CR line endings.");
  }
  if (source.includes("\r\n") && withoutCrLf.includes("\n")) {
    throw new Error("Hashline editing does not support mixed line endings.");
  }

  const lineEnding: LineEnding = source.includes("\r\n") ? "crlf" : "lf";
  const logicalText = source.replace(/\r\n/g, "\n");
  const finalNewline = logicalText.endsWith("\n");
  let lineCount = logicalText.length === 0 ? 0 : finalNewline ? 0 : 1;
  for (let index = 0; index < logicalText.length; index++) {
    if (logicalText.charCodeAt(index) === 10) lineCount++;
  }
  if (lineCount > HASHLINE_SNAPSHOT_CAP_LINES) {
    throw new Error(
      `Hashline editing supports at most ${HASHLINE_SNAPSHOT_CAP_LINES} logical lines per file.`,
    );
  }
  const body = finalNewline ? logicalText.slice(0, -1) : logicalText;
  return {
    logicalText,
    lines: logicalText.length === 0 ? [] : body.split("\n"),
    finalNewline,
    lineEnding,
  };
}

export function encodePhysicalText(
  logicalText: string,
  lineEnding: LineEnding,
): string {
  return lineEnding === "crlf"
    ? logicalText.replace(/\n/g, "\r\n")
    : logicalText;
}

export function joinLogicalLines(
  lines: readonly string[],
  finalNewline: boolean,
): string {
  const body = lines.join("\n");
  return finalNewline ? `${body}\n` : body;
}
/**
 * Map seen ranges from base coordinates through one applied edit, dropping
 * the ranges the edit replaced and renumbering the survivors. Lines outside
 * the changed spans are byte-identical to what the tagged read displayed, so
 * their display authorization carries forward to the edit's anchor.
 */
export function mapSeenRangesThroughEdit(
  seenRanges: readonly LineRange[],
  operations: readonly HashlineOperation[],
  baseLineCount: number,
): { ranges: LineRange[]; eofSeen: boolean } {
  type Event = { at: number; delta: number }; // at: 0-based boundary
  const events: Event[] = [];
  const removals: Array<{ from: number; to: number }> = []; // 0-based [from, to)

  for (const operation of operations) {
    if (operation.kind === "replace" || operation.kind === "cut") {
      const from = operation.start - 1;
      const to = operation.end;
      removals.push({ from, to });
      events.push({
        at: from,
        delta:
          (operation.kind === "replace" ? operation.rows.length : 0) -
          (to - from),
      });
      continue;
    }
    if (operation.kind === "append") {
      events.push({ at: baseLineCount, delta: operation.rows.length });
      continue;
    }
    const at =
      operation.kind === "insert-before" ? operation.line - 1 : operation.line;
    events.push({ at, delta: operation.rows.length });
  }
  events.sort((a, b) => a.at - b.at || a.delta - b.delta);

  const shiftFor = (line0: number): number =>
    events.reduce(
      (total, event) => (event.at <= line0 ? total + event.delta : total),
      0,
    );

  const mapped: LineRange[] = [];
  for (const range of mergeRanges(seenRanges)) {
    // Walk the 1-based range in 0-based half-open pieces, skipping removals.
    let cursor = range.start - 1;
    const end0 = range.end;
    while (cursor < end0) {
      const overlapping = removals
        .filter((r) => r.from < end0 && r.to > cursor)
        .sort((a, b) => a.from - b.from)[0];
      const pieceEnd = overlapping ? Math.min(end0, overlapping.from) : end0;
      if (pieceEnd > cursor) {
        const newStart = cursor + shiftFor(cursor) + 1;
        const newEnd = pieceEnd + shiftFor(pieceEnd - 1);
        if (newEnd >= newStart && newStart >= 1)
          mapped.push({ start: newStart, end: newEnd });
      }
      if (!overlapping) break;
      cursor = Math.max(cursor, overlapping.to);
    }
  }

  const merged = mergeRanges(mapped);
  const newLineCount =
    baseLineCount + events.reduce((total, event) => total + event.delta, 0);
  return {
    ranges: merged,
    eofSeen: merged.some((range) => range.end >= newLineCount),
  };
}

export function computeFullDigest(logicalText: string): string {
  return createHash("sha256")
    .update(logicalText, "utf8")
    .digest("hex")
    .toUpperCase();
}

export function tagFromDigest(fullDigest: string): string {
  return fullDigest.slice(0, HASHLINE_TAG_LENGTH);
}

export function createHashlineRecord(input: {
  canonicalPath: string;
  displayPath: string;
  document: LogicalDocument;
  seenRanges: readonly LineRange[];
  eofSeen: boolean;
  producer: HashlineProducer;
}): HashlineRecord {
  const fullDigest = computeFullDigest(input.document.logicalText);
  return {
    schema: HASHLINE_SCHEMA,
    canonicalPath: input.canonicalPath,
    displayPath: input.displayPath,
    tag: tagFromDigest(fullDigest),
    fullDigest,
    lineCount: input.document.lines.length,
    finalNewline: input.document.finalNewline,
    lineEnding: input.document.lineEnding,
    seenRanges: mergeRanges(input.seenRanges),
    eofSeen: input.eofSeen,
    producer: input.producer,
  };
}

export function mergeRanges(ranges: readonly LineRange[]): LineRange[] {
  const valid = ranges.map((range) => {
    if (
      !Number.isSafeInteger(range.start) ||
      !Number.isSafeInteger(range.end) ||
      range.start < 1 ||
      range.end < range.start
    ) {
      throw new Error("Invalid line range.");
    }
    return { ...range };
  });
  valid.sort((a, b) => a.start - b.start || a.end - b.end);

  const merged: LineRange[] = [];
  for (const range of valid) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end + 1) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push(range);
    }
  }
  return merged;
}

export function rangesCover(
  ranges: readonly LineRange[],
  start: number,
  end: number,
): boolean {
  return mergeRanges(ranges).some(
    (range) => start >= range.start && end <= range.end,
  );
}

export function formatHashlineHeader(displayPath: string, tag: string): string {
  return `[${displayPath}#${tag}]`;
}

export function parseHashlineHeader(
  line: string,
): { displayPath: string; tag: string } | undefined {
  const match = /^\[(.+)#([0-9A-F]{16})\]$/.exec(line);
  return match ? { displayPath: match[1]!, tag: match[2]! } : undefined;
}

export function normalizeHashlineRecord(
  value: unknown,
): HashlineRecord | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (record.schema !== HASHLINE_SCHEMA) return undefined;
  if (
    typeof record.canonicalPath !== "string" ||
    record.canonicalPath.length === 0 ||
    typeof record.displayPath !== "string" ||
    record.displayPath.length === 0 ||
    typeof record.tag !== "string" ||
    !TAG_RE.test(record.tag) ||
    typeof record.fullDigest !== "string" ||
    !DIGEST_RE.test(record.fullDigest) ||
    record.tag !== tagFromDigest(record.fullDigest) ||
    typeof record.lineCount !== "number" ||
    !Number.isSafeInteger(record.lineCount) ||
    record.lineCount < 0 ||
    typeof record.finalNewline !== "boolean" ||
    (record.lineEnding !== "lf" && record.lineEnding !== "crlf") ||
    !Array.isArray(record.seenRanges) ||
    typeof record.eofSeen !== "boolean" ||
    (record.producer !== "read" && record.producer !== "edit")
  ) {
    return undefined;
  }

  let seenRanges: LineRange[];
  try {
    seenRanges = mergeRanges(record.seenRanges as LineRange[]);
  } catch {
    return undefined;
  }
  const lineCount = record.lineCount as number;
  if (seenRanges.some((range) => range.end > lineCount)) return undefined;
  if (lineCount === 0 && seenRanges.length > 0) return undefined;
  if (
    record.eofSeen &&
    lineCount > 0 &&
    !seenRanges.some((range) => range.end === lineCount)
  ) {
    return undefined;
  }

  return {
    schema: HASHLINE_SCHEMA,
    canonicalPath: record.canonicalPath,
    displayPath: record.displayPath,
    tag: record.tag,
    fullDigest: record.fullDigest,
    lineCount: record.lineCount,
    finalNewline: record.finalNewline,
    lineEnding: record.lineEnding,
    seenRanges,
    eofSeen: record.eofSeen,
    producer: record.producer,
  };
}
