import { applyHashlineOperations, type AppliedHashline } from "./apply.ts";
import type { LogicalDocument } from "./contract.ts";
import type { HashlineOperation } from "./parser.ts";

const MAX_CONTEXT_LINES = 8;

function wrappedLines(lines: readonly string[]): string {
  return `\n${lines.join("\n")}\n`;
}

function uniqueOccurrence(
  haystack: string,
  needle: string,
): number | undefined {
  const first = haystack.indexOf(needle);
  if (first < 0 || haystack.indexOf(needle, first + 1) >= 0) return undefined;
  return first;
}

function lineIndexAt(text: string, offset: number): number {
  let lines = 0;
  for (let index = 0; index < offset; index++) {
    if (text.charCodeAt(index) === 10) lines++;
  }
  return lines;
}

/** Locate one unchanged base span in current text using context unique in both. */
function locateUniqueSpan(
  baseLines: readonly string[],
  currentLines: readonly string[],
  start: number,
  end: number,
): { start: number; end: number } | undefined {
  const baseText = wrappedLines(baseLines);
  const currentText = wrappedLines(currentLines);
  for (let context = 0; context <= MAX_CONTEXT_LINES; context++) {
    for (let left = 0; left <= context; left++) {
      const right = context - left;
      const windowStart = Math.max(0, start - left);
      const windowEnd = Math.min(baseLines.length, end + right);
      if (windowStart > start || windowEnd < end) continue;
      const needle = wrappedLines(baseLines.slice(windowStart, windowEnd));
      const baseOffset = uniqueOccurrence(baseText, needle);
      if (
        baseOffset === undefined ||
        lineIndexAt(baseText, baseOffset) !== windowStart
      ) {
        continue;
      }
      const currentOffset = uniqueOccurrence(currentText, needle);
      if (currentOffset === undefined) continue;
      const currentWindowStart = lineIndexAt(currentText, currentOffset);
      const mappedStart = currentWindowStart + (start - windowStart);
      return { start: mappedStart, end: mappedStart + (end - start) };
    }
  }
  return undefined;
}

function translateOperation(
  base: LogicalDocument,
  current: LogicalDocument,
  operation: HashlineOperation,
): HashlineOperation | undefined {
  if (operation.kind === "replace" || operation.kind === "cut") {
    const mapped = locateUniqueSpan(
      base.lines,
      current.lines,
      operation.start - 1,
      operation.end,
    );
    if (!mapped) return undefined;
    return {
      ...operation,
      start: mapped.start + 1,
      end: mapped.end,
    };
  }

  if (operation.kind === "append") return undefined;
  const gap =
    operation.kind === "insert-before" ? operation.line - 1 : operation.line;
  // BOF/EOF drift is content-independent and cannot prove that another writer
  // did not already insert at the same boundary. Fail rather than reorder it.
  if (gap <= 0 || gap >= base.lines.length) return undefined;
  const adjacent = locateUniqueSpan(
    base.lines,
    current.lines,
    gap - 1,
    gap + 1,
  );
  if (!adjacent) return undefined;
  const mappedGap = adjacent.start + 1;
  return operation.kind === "insert-before"
    ? { ...operation, line: mappedGap + 1 }
    : { ...operation, line: mappedGap };
}

/**
 * Translate each requested base operation through uniquely matching unchanged
 * lines, then apply the translated operations to the live document. Duplicate
 * context, changed targets, and occupied insertion gaps fail closed.
 */
export function recoverNonOverlappingEdit(
  base: LogicalDocument,
  current: LogicalDocument,
  operations: readonly HashlineOperation[],
  label: string,
): AppliedHashline | undefined {
  const translated: HashlineOperation[] = [];
  for (const operation of operations) {
    const mapped = translateOperation(base, current, operation);
    if (!mapped) return undefined;
    translated.push(mapped);
  }
  try {
    return applyHashlineOperations({
      lines: current.lines,
      finalNewline: current.finalNewline,
      operations: translated,
      label,
    });
  } catch {
    return undefined;
  }
}
