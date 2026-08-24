import {
  DELETION_MARKER_PATTERN,
  type AppliedCompaction,
  type InclusiveRange,
  type ParsedPlannerRanges,
  type PlannerFailureCategory,
  type Transcript,
  type TranscriptLine,
} from "./types.ts";
import { digestText, estimateLineTokens } from "./transcript.ts";

const RANGE_RECORD = /^([1-9][0-9]*),([1-9][0-9]*)$/;
const MAX_PLANNER_RANGES = 4_096;
const RECOVERABLE_RANGE_RECORD = /^\s*([1-9][0-9]*)\s*,\s*([1-9][0-9]*)\s*$/;
const RECOVERABLE_HEADING =
  /^(?:here are the )?(?:ranked )?(?:deletion )?ranges:$/i;
const RECOVERABLE_FENCE_OPEN = /^```(?:text)?$/i;
const RECOVERABLE_FENCE_CLOSE = "```";
const MAX_SELECTED_RANGES = 4_096;

export interface ParsePlannerRangesOptions {
  /** Use only complete newline-terminated records when provider output was truncated. */
  recoverTruncated?: boolean;
}

export interface RangeSelectionOptions {
  targetRetainedTokens: number;
  minimumRetainedTokens: number;
}

export interface PlannerRangeRecovery {
  parsed?: ParsedPlannerRanges;
  rangeLikeLines: number;
  ignoredNonblankLines: number;
  failureCategory?: PlannerFailureCategory;
}

export function parsePlannerRanges(
  output: string,
  options: ParsePlannerRangesOptions = {},
): ParsedPlannerRanges | undefined {
  const recordsText = plannerRecordsText(output, options.recoverTruncated);

  const ranges: InclusiveRange[] = [];
  const seen = new Set<string>();
  const lines = recordsText.split("\n");
  for (let line of lines) {
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (line.trim().length === 0) continue;

    const match = RANGE_RECORD.exec(line);
    if (match === null) return undefined;
    const start = Number(match[1]);
    const end = Number(match[2]);
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start > end
    ) {
      return undefined;
    }
    const key = `${start},${end}`;
    if (seen.has(key) || ranges.length >= MAX_PLANNER_RANGES) return undefined;
    seen.add(key);
    ranges.push({ start, end });
  }

  return { ranges, proposedCount: ranges.length };
}

/** Recover complete records inside one optional heading and one paired fence. */
export function recoverPlannerRanges(
  output: string,
  options: ParsePlannerRangesOptions = {},
): PlannerRangeRecovery {
  const recordsText = plannerRecordsText(output, options.recoverTruncated);
  const lines = recordsText
    .split("\n")
    .map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line))
    .filter((line) => line.trim().length > 0);
  const ranges: InclusiveRange[] = [];
  const seen = new Set<string>();
  let rangeLikeLines = 0;
  let ignoredNonblankLines = 0;
  let startIndex = 0;
  let endIndex = lines.length;

  if (RECOVERABLE_HEADING.test(lines[startIndex]?.trim() ?? "")) {
    startIndex += 1;
    ignoredNonblankLines += 1;
  }
  if (RECOVERABLE_FENCE_OPEN.test(lines[startIndex]?.trim() ?? "")) {
    if (
      endIndex - startIndex < 3 ||
      lines[endIndex - 1]?.trim() !== RECOVERABLE_FENCE_CLOSE
    ) {
      return recoveryFailure(
        rangeLikeLines,
        ignoredNonblankLines,
        "invalid-wrapper",
      );
    }
    startIndex += 1;
    endIndex -= 1;
    ignoredNonblankLines += 2;
  }

  for (const line of lines.slice(startIndex, endIndex)) {
    const match = RECOVERABLE_RANGE_RECORD.exec(line);
    if (match === null) {
      return recoveryFailure(
        rangeLikeLines,
        ignoredNonblankLines,
        "invalid-wrapper",
      );
    }
    rangeLikeLines += 1;
    const start = Number(match[1]);
    const end = Number(match[2]);
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start > end
    ) {
      return recoveryFailure(
        rangeLikeLines,
        ignoredNonblankLines,
        "invalid-range-record",
      );
    }
    const key = `${start},${end}`;
    if (seen.has(key)) {
      return recoveryFailure(
        rangeLikeLines,
        ignoredNonblankLines,
        "duplicate-range",
      );
    }
    if (ranges.length >= MAX_PLANNER_RANGES) {
      return recoveryFailure(
        rangeLikeLines,
        ignoredNonblankLines,
        "too-many-ranges",
      );
    }
    seen.add(key);
    ranges.push({ start, end });
  }

  if (ranges.length === 0) {
    return recoveryFailure(
      rangeLikeLines,
      ignoredNonblankLines,
      "no-range-records",
    );
  }
  return {
    parsed: { ranges, proposedCount: ranges.length },
    rangeLikeLines,
    ignoredNonblankLines,
  };
}

function recoveryFailure(
  rangeLikeLines: number,
  ignoredNonblankLines: number,
  failureCategory: PlannerFailureCategory,
): PlannerRangeRecovery {
  return { rangeLikeLines, ignoredNonblankLines, failureCategory };
}

function plannerRecordsText(output: string, recoverTruncated = false): string {
  if (!recoverTruncated) return output;
  const lastNewline = output.lastIndexOf("\n");
  return lastNewline < 0 ? "" : output.slice(0, lastNewline + 1);
}

export function normalizeRanges(
  ranges: readonly InclusiveRange[],
  lineCount: number,
): InclusiveRange[] {
  if (!Number.isSafeInteger(lineCount) || lineCount < 1) return [];

  const canonical: InclusiveRange[] = [];
  for (const range of ranges) {
    if (!isSafeEndpoint(range.start) || !isSafeEndpoint(range.end)) continue;
    const low = Math.min(range.start, range.end);
    const high = Math.max(range.start, range.end);
    canonical.push({
      start: clamp(low, 1, lineCount),
      end: clamp(high, 1, lineCount),
    });
  }

  canonical.sort(
    (left, right) => left.start - right.start || left.end - right.end,
  );
  const merged: InclusiveRange[] = [];
  for (const range of canonical) {
    const previous = merged.at(-1);
    if (previous !== undefined && range.start <= previous.end + 1) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

export function splitRangesAroundProtected(
  ranges: readonly InclusiveRange[],
  protectedLines: readonly number[],
  lineCount: number,
): InclusiveRange[] {
  const protectedSet = new Set(
    protectedLines.filter(
      (line) => Number.isSafeInteger(line) && line >= 1 && line <= lineCount,
    ),
  );
  const split: InclusiveRange[] = [];

  for (const range of normalizeRanges(ranges, lineCount)) {
    let runStart: number | undefined;
    for (let line = range.start; line <= range.end; line += 1) {
      if (protectedSet.has(line)) {
        if (runStart !== undefined) {
          split.push({ start: runStart, end: line - 1 });
          runStart = undefined;
        }
      } else if (runStart === undefined) {
        runStart = line;
      }
    }
    if (runStart !== undefined) split.push({ start: runStart, end: range.end });
  }

  return split;
}

/** Preserve planner ranking while mechanically enforcing protection and token floors. */
export function selectRangesForRetention(
  transcript: Transcript,
  rankedRanges: readonly InclusiveRange[],
  options: RangeSelectionOptions,
): InclusiveRange[] {
  const minimum = tokenBoundary(options.minimumRetainedTokens);
  const target = Math.max(minimum, tokenBoundary(options.targetRetainedTokens));
  if (transcript.estimatedTokens <= target) return [];

  let selected: InclusiveRange[] = [];
  let retainedTokens = transcript.estimatedTokens;
  const scorer = createRetentionScorer(transcript);
  const protectedLines = protectedLineIds(transcript).sort(
    (left, right) => left - right,
  );
  for (const rankedRange of rankedRanges.slice(0, MAX_PLANNER_RANGES)) {
    const canonical = normalizeRanges(
      [rankedRange],
      transcript.lines.length,
    )[0];
    if (canonical === undefined) continue;
    const fragments = splitRangeAroundProtected(canonical, protectedLines);
    for (const fragment of fragments) {
      for (const available of subtractRanges(fragment, selected)) {
        const candidate = bestSubrange(
          selected,
          available,
          target,
          minimum,
          retainedTokens,
          scorer,
        );
        if (candidate === undefined) continue;

        const trial = insertRange(selected, candidate);
        if (trial.length > MAX_SELECTED_RANGES) return selected;
        const trialRetainedTokens = scorer.ranges(trial);
        if (trialRetainedTokens < retainedTokens) {
          selected = trial;
          retainedTokens = trialRetainedTokens;
          if (retainedTokens <= target) return selected;
        }
      }
    }
  }

  return selected;
}

export function applyCompaction(
  transcript: Transcript,
  ranges: readonly InclusiveRange[],
): AppliedCompaction {
  const safeRanges = splitRangesAroundProtected(
    ranges,
    protectedLineIds(transcript),
    transcript.lines.length,
  );
  const output: string[] = [];
  const protectedLines: number[] = [];
  const markerLines: number[] = [];
  const structureLines: number[] = [];
  let deletedLines = 0;
  let deletedTokens = 0;
  let retainedTokens = 0;
  let cursor = 1;

  for (const range of safeRanges) {
    while (cursor < range.start) {
      retainedTokens += keepLine(
        output,
        transcript.lines[cursor - 1],
        protectedLines,
        markerLines,
        structureLines,
      );
      cursor += 1;
    }

    let representedLines = 0n;
    while (cursor <= range.end) {
      const line = transcript.lines[cursor - 1];
      deletedLines += 1;
      deletedTokens += line.estimatedTokens;
      representedLines += representedLineCount(line);
      cursor += 1;
    }

    const marker = `[verbatim-compaction: ${representedLines} lines removed]`;
    output.push(marker);
    markerLines.push(output.length);
    retainedTokens += estimateLineTokens(marker);
  }

  while (cursor <= transcript.lines.length) {
    retainedTokens += keepLine(
      output,
      transcript.lines[cursor - 1],
      protectedLines,
      markerLines,
      structureLines,
    );
    cursor += 1;
  }

  const text = output.join("\n");
  return {
    text,
    ranges: safeRanges,
    deletedLines,
    deletedTokens,
    retainedTokens,
    provenance: {
      digest: digestText(text),
      protectedLines,
      markerLines,
      structureLines,
    },
  };
}

function representedLineCount(line: TranscriptLine): bigint {
  if (line.kind !== "marker") return 1n;
  const match = DELETION_MARKER_PATTERN.exec(line.text);
  if (match === null || match[1]?.startsWith("0")) return 1n;
  const count = BigInt(match[1]);
  return count > 0n ? count : 1n;
}

function keepLine(
  output: string[],
  line: TranscriptLine,
  protectedLines: number[],
  markerLines: number[],
  structureLines: number[],
): number {
  output.push(line.text);
  if (line.protected) protectedLines.push(output.length);
  if (line.kind === "marker") markerLines.push(output.length);
  if (line.kind === "structure") structureLines.push(output.length);
  return line.estimatedTokens;
}

function tokenBoundary(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

function protectedLineIds(transcript: Transcript): number[] {
  const protectedLines = new Set(transcript.protectedLines);
  transcript.lines.forEach((line, index) => {
    if (line.protected) protectedLines.add(index + 1);
  });
  return [...protectedLines];
}

function subtractRanges(
  source: InclusiveRange,
  excluded: readonly InclusiveRange[],
): InclusiveRange[] {
  const result: InclusiveRange[] = [];
  let cursor = source.start;
  for (const range of excluded) {
    if (range.end < cursor) continue;
    if (range.start > source.end) break;
    if (range.start > cursor) {
      result.push({
        start: cursor,
        end: Math.min(source.end, range.start - 1),
      });
    }
    cursor = Math.max(cursor, range.end + 1);
    if (cursor > source.end) break;
  }
  if (cursor <= source.end) result.push({ start: cursor, end: source.end });
  return result;
}

function* splitRangeAroundProtected(
  range: InclusiveRange,
  protectedLines: readonly number[],
): Generator<InclusiveRange> {
  let cursor = range.start;
  let index = lowerBound(protectedLines, range.start);
  while (index < protectedLines.length) {
    const protectedLine = protectedLines[index];
    if (protectedLine === undefined || protectedLine > range.end) break;
    if (protectedLine > cursor) {
      yield { start: cursor, end: protectedLine - 1 };
    }
    cursor = protectedLine + 1;
    index += 1;
  }
  if (cursor <= range.end) yield { start: cursor, end: range.end };
}

function lowerBound(values: readonly number[], target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((values[middle] ?? Number.POSITIVE_INFINITY) < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

function insertRange(
  selected: readonly InclusiveRange[],
  candidate: InclusiveRange,
): InclusiveRange[] {
  const result: InclusiveRange[] = [];
  let merged = { ...candidate };
  let inserted = false;
  for (const range of selected) {
    if (range.end + 1 < merged.start) {
      result.push(range);
    } else if (merged.end + 1 < range.start) {
      if (!inserted) {
        result.push(merged);
        inserted = true;
      }
      result.push(range);
    } else {
      merged = {
        start: Math.min(merged.start, range.start),
        end: Math.max(merged.end, range.end),
      };
    }
  }
  if (!inserted) result.push(merged);
  return result;
}

interface RetentionScorer {
  ranges(ranges: readonly InclusiveRange[]): number;
  candidate(
    selected: readonly InclusiveRange[],
    candidate: InclusiveRange,
    currentRetainedTokens: number,
  ): number;
}

function bestSubrange(
  selected: readonly InclusiveRange[],
  available: InclusiveRange,
  targetRetainedTokens: number,
  minimumRetainedTokens: number,
  currentRetainedTokens: number,
  scorer: RetentionScorer,
): InclusiveRange | undefined {
  let targetBest: { range: InclusiveRange; retainedTokens: number } | undefined;
  let aboveBest: { range: InclusiveRange; retainedTokens: number } | undefined;
  let right = available.start - 1;

  const consider = (range: InclusiveRange): number => {
    const retainedTokens = scorer.candidate(
      selected,
      range,
      currentRetainedTokens,
    );
    if (
      retainedTokens < minimumRetainedTokens ||
      retainedTokens >= currentRetainedTokens
    ) {
      return retainedTokens;
    }
    if (retainedTokens <= targetRetainedTokens) {
      if (
        targetBest === undefined ||
        retainedTokens > targetBest.retainedTokens
      ) {
        targetBest = { range, retainedTokens };
      }
    } else if (
      aboveBest === undefined ||
      retainedTokens < aboveBest.retainedTokens
    ) {
      aboveBest = { range, retainedTokens };
    }
    return retainedTokens;
  };

  for (let left = available.start; left <= available.end; left += 1) {
    if (right < left - 1) right = left - 1;
    if (right >= left) {
      const retainedTokens = consider({ start: left, end: right });
      if (retainedTokens <= targetRetainedTokens) continue;
    }
    while (right < available.end) {
      const candidate = { start: left, end: right + 1 };
      const retainedTokens = consider(candidate);
      if (retainedTokens < minimumRetainedTokens) break;
      right += 1;
      if (retainedTokens <= targetRetainedTokens) break;
    }
  }

  return targetBest?.range ?? aboveBest?.range;
}

function createRetentionScorer(transcript: Transcript): RetentionScorer {
  const tokenPrefix = [0];
  const representedPrefix = [0n];
  for (const line of transcript.lines) {
    tokenPrefix.push((tokenPrefix.at(-1) ?? 0) + line.estimatedTokens);
    representedPrefix.push(
      (representedPrefix.at(-1) ?? 0n) + representedLineCount(line),
    );
  }

  const contribution = (range: InclusiveRange): number => {
    const deletedTokens =
      (tokenPrefix[range.end] ?? 0) - (tokenPrefix[range.start - 1] ?? 0);
    const represented =
      (representedPrefix[range.end] ?? 0n) -
      (representedPrefix[range.start - 1] ?? 0n);
    return (
      estimateLineTokens(
        `[verbatim-compaction: ${represented} lines removed]`,
      ) - deletedTokens
    );
  };

  return {
    ranges(ranges) {
      return ranges.reduce(
        (tokens, range) => tokens + contribution(range),
        transcript.estimatedTokens,
      );
    },
    candidate(selected, candidate, currentRetainedTokens) {
      const index = rangeInsertionIndex(selected, candidate.start);
      const previous = selected[index - 1];
      const next = selected[index];
      let merged = { ...candidate };
      let retainedTokens = currentRetainedTokens;
      if (previous !== undefined && previous.end + 1 >= merged.start) {
        retainedTokens -= contribution(previous);
        merged = {
          start: previous.start,
          end: Math.max(previous.end, merged.end),
        };
      }
      if (next !== undefined && merged.end + 1 >= next.start) {
        retainedTokens -= contribution(next);
        merged = {
          start: Math.min(merged.start, next.start),
          end: Math.max(merged.end, next.end),
        };
      }
      return retainedTokens + contribution(merged);
    },
  };
}

function rangeInsertionIndex(
  ranges: readonly InclusiveRange[],
  start: number,
): number {
  let low = 0;
  let high = ranges.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((ranges[middle]?.start ?? Number.POSITIVE_INFINITY) < start) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

function isSafeEndpoint(value: number): boolean {
  return Number.isSafeInteger(value);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
