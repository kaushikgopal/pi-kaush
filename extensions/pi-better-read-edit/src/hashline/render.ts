import {
  formatHashlineHeader,
  mergeRanges,
  type HashlineRecord,
  type LineRange,
} from "./contract.ts";
import type { ChangedSpan } from "./apply.ts";

export function renderHashlineRanges(
  record: Pick<HashlineRecord, "displayPath" | "tag">,
  lines: readonly string[],
  ranges: readonly LineRange[],
): string {
  const output = [formatHashlineHeader(record.displayPath, record.tag)];
  const selected = mergeRanges(ranges);
  for (const [rangeIndex, range] of selected.entries()) {
    for (
      let line = range.start;
      line <= Math.min(range.end, lines.length);
      line++
    ) {
      output.push(`${line}:${lines[line - 1] ?? ""}`);
    }
    if (rangeIndex < selected.length - 1) output.push("…");
  }
  return output.join("\n");
}

export function changedWindows(
  lineCount: number,
  spans: readonly ChangedSpan[],
  contextLines = 1,
): LineRange[] {
  const windows: LineRange[] = [];
  for (const span of spans) {
    if (span.start <= span.end) {
      const window = {
        start: Math.max(1, span.start - contextLines),
        end: Math.min(lineCount, span.end + contextLines),
      };
      if (window.start <= window.end) windows.push(window);
      continue;
    }

    const boundary = Math.min(span.start, lineCount + 1);
    const start = Math.max(1, boundary - contextLines);
    const end = Math.min(lineCount, boundary - 1 + contextLines);
    if (start <= end) windows.push({ start, end });
  }
  return mergeRanges(windows);
}

export function renderChangedHashline(
  record: HashlineRecord,
  lines: readonly string[],
  spans: readonly ChangedSpan[],
  contextLines = 1,
): { text: string; seenRanges: LineRange[]; eofSeen: boolean } {
  const seenRanges = changedWindows(lines.length, spans, contextLines);
  return {
    text: renderHashlineRanges(record, lines, seenRanges),
    seenRanges,
    eofSeen:
      lines.length === 0 ||
      seenRanges.some((range) => range.end === lines.length),
  };
}
