import { DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";

export type LineRange = {
  start: number;
  end: number;
};

const SELECTOR_RE = /^\d+(?:(?:-|\+)\d+|-)?(?:,\d+(?:(?:-|\+)\d+|-)?)*$/;
const MAX_SELECTOR_LENGTH = 8_192;
const MAX_SELECTOR_PARTS = 100;
const MAX_PROJECTION_LINES = 100_000;

export function isLineSelector(value: string | undefined): value is string {
  return (
    value !== undefined &&
    value.length <= MAX_SELECTOR_LENGTH &&
    SELECTOR_RE.test(value.trim())
  );
}

export function parseLineSelector(
  selector: string,
  defaultCount = DEFAULT_MAX_LINES,
): LineRange[] {
  if (selector.length > MAX_SELECTOR_LENGTH) {
    throw new Error("Line selector is too long.");
  }
  if (selector.split(",").length > MAX_SELECTOR_PARTS) {
    throw new Error(
      `Line selectors accept at most ${MAX_SELECTOR_PARTS} comma-separated ranges.`,
    );
  }
  const ranges = selector.split(",").map((raw) => {
    const part = raw.trim();
    const match = /^(\d+)(?:(-|\+)(\d+)?)?$/.exec(part);
    if (!match) {
      throw new Error(
        `Invalid line selector '${part}'. Use N, N-M, N+K, N-, or comma-separated ranges.`,
      );
    }
    const start = Number(match[1]);
    if (!Number.isSafeInteger(start) || start < 1) {
      throw new Error(`Invalid line selector '${part}': lines are 1-indexed.`);
    }
    const operator = match[2];
    const operand = match[3] === undefined ? undefined : Number(match[3]);
    if (operator === "+") {
      if (!operand || !Number.isSafeInteger(operand)) {
        throw new Error(
          `Invalid line selector '${part}': + count must be >= 1.`,
        );
      }
      return { start, end: start + operand - 1 };
    }
    if (operator === "-" && operand !== undefined) {
      if (!Number.isSafeInteger(operand) || operand < start) {
        throw new Error(
          `Invalid line selector '${part}': end must be >= start.`,
        );
      }
      return { start, end: operand };
    }
    return { start, end: start + defaultCount - 1 };
  });

  ranges.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: LineRange[] = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end + 1) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

export function splitInlineSelector(input: string): {
  path: string;
  selector?: string;
} {
  if (/^https?:\/\//i.test(input)) return { path: input };
  const colon = input.lastIndexOf(":");
  if (colon <= 0) return { path: input };
  const tail = input.slice(colon + 1);
  if (tail.toLowerCase() !== "raw" && !isLineSelector(tail)) {
    return { path: input };
  }
  return { path: input.slice(0, colon), selector: tail };
}

export function clampRanges(
  ranges: readonly LineRange[],
  lineCount: number,
): LineRange[] {
  const clamped: LineRange[] = [];
  for (const range of ranges) {
    if (range.start > lineCount) {
      throw new Error(
        `Line selector starts at ${range.start}, beyond EOF (${lineCount} line(s)).`,
      );
    }
    clamped.push({ start: range.start, end: Math.min(range.end, lineCount) });
  }
  return clamped;
}

export function selectTextRanges(
  text: string,
  selector: string,
  options: { numbered?: boolean } = {},
): string {
  const normalized = text.replace(/\r\n/g, "\n");
  const finalNewline = normalized.endsWith("\n");
  const body = finalNewline ? normalized.slice(0, -1) : normalized;
  let lineCount = body.length === 0 ? 0 : 1;
  for (let index = 0; index < body.length; index++) {
    if (body.charCodeAt(index) === 10) lineCount++;
  }
  if (lineCount > MAX_PROJECTION_LINES) {
    throw new Error(
      `Range selection supports at most ${MAX_PROJECTION_LINES} source lines.`,
    );
  }
  const lines = body.length === 0 ? [] : body.split("\n");
  const ranges = clampRanges(parseLineSelector(selector), lines.length);
  return ranges
    .map((range) =>
      lines
        .slice(range.start - 1, range.end)
        .map((line, index) =>
          options.numbered ? `${range.start + index}|${line}` : line,
        )
        .join("\n"),
    )
    .join("\n…\n");
}
