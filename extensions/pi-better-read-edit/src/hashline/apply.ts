import { joinLogicalLines } from "./contract.ts";
import type { HashlineOperation } from "./parser.ts";

export type ChangedSpan = {
  start: number;
  end: number;
};

export type AppliedHashline = {
  lines: string[];
  finalNewline: boolean;
  logicalText: string;
  changedSpans: ChangedSpan[];
  firstChangedLine?: number;
};

type PlannedSpan = {
  start: number;
  end: number;
  rows: string[];
  operationIndex: number;
};

type PlannedGap = {
  position: number;
  rows: string[];
  operationIndex: number;
};

export function applyHashlineOperations(input: {
  lines: readonly string[];
  finalNewline: boolean;
  operations: readonly HashlineOperation[];
  label?: string;
}): AppliedHashline {
  const label = input.label ?? "file";
  const lineCount = input.lines.length;
  const spans: PlannedSpan[] = [];
  const gaps: PlannedGap[] = [];

  for (const [operationIndex, operation] of input.operations.entries()) {
    if (operation.kind === "replace" || operation.kind === "cut") {
      if (operation.end > lineCount) {
        throw new Error(
          `${label} operation ${operationIndex + 1} targets lines ${operation.start}-${operation.end}, but the snapshot has ${lineCount} line(s).`,
        );
      }
      spans.push({
        start: operation.start,
        end: operation.end,
        rows: operation.kind === "replace" ? operation.rows : [],
        operationIndex,
      });
      continue;
    }

    if (operation.kind === "append") {
      gaps.push({
        position: lineCount,
        rows: operation.rows,
        operationIndex,
      });
      continue;
    }

    if (operation.line > lineCount) {
      throw new Error(
        `${label} operation ${operationIndex + 1} anchors line ${operation.line}, but the snapshot has ${lineCount} line(s).`,
      );
    }
    gaps.push({
      position:
        operation.kind === "insert-before"
          ? operation.line - 1
          : operation.line,
      rows: operation.rows,
      operationIndex,
    });
  }

  for (let left = 0; left < spans.length; left++) {
    for (let right = left + 1; right < spans.length; right++) {
      const a = spans[left]!;
      const b = spans[right]!;
      if (a.start <= b.end && b.start <= a.end) {
        throw new Error(
          `${label} operations ${a.operationIndex + 1} and ${b.operationIndex + 1} overlap in original coordinates.`,
        );
      }
    }
  }

  const gapOwners = new Map<number, number>();
  for (const gap of gaps) {
    const previous = gapOwners.get(gap.position);
    if (previous !== undefined) {
      throw new Error(
        `${label} operations ${previous + 1} and ${gap.operationIndex + 1} insert at the same boundary; merge them.`,
      );
    }
    gapOwners.set(gap.position, gap.operationIndex);
    for (const span of spans) {
      if (gap.position >= span.start - 1 && gap.position <= span.end) {
        throw new Error(
          `${label} operation ${gap.operationIndex + 1} inserts within or beside the changed range ${span.start}-${span.end}.`,
        );
      }
    }
  }

  type PlannedChange =
    | ({ type: "span" } & PlannedSpan)
    | ({ type: "gap" } & PlannedGap);
  const changes: PlannedChange[] = [
    ...spans.map((span) => ({ type: "span" as const, ...span })),
    ...gaps.map((gap) => ({ type: "gap" as const, ...gap })),
  ].sort((a, b) => {
    const aPosition = a.type === "span" ? a.start - 1 : a.position;
    const bPosition = b.type === "span" ? b.start - 1 : b.position;
    return aPosition - bPosition;
  });

  const result: string[] = [];
  const changedSpans: ChangedSpan[] = [];
  let sourceCursor = 0;

  const appendRows = (rows: readonly string[]) => {
    for (const row of rows) result.push(row);
  };
  const copyUntil = (position: number) => {
    if (position <= sourceCursor) return;
    for (let index = sourceCursor; index < position; index++) {
      result.push(input.lines[index]!);
    }
    sourceCursor = position;
  };

  for (const change of changes) {
    const position =
      change.type === "span" ? change.start - 1 : change.position;
    copyUntil(position);
    const start = result.length + 1;
    appendRows(change.rows);
    changedSpans.push({ start, end: start + change.rows.length - 1 });
    if (change.type === "span") sourceCursor = change.end;
  }
  copyUntil(lineCount);

  const finalNewline =
    result.length > 0 && (input.finalNewline || result.at(-1) === "");
  const logicalText = joinLogicalLines(result, finalNewline);
  const firstChangedLine = changedSpans.reduce(
    (first, span) => Math.min(first, span.start),
    Number.POSITIVE_INFINITY,
  );
  return {
    lines: result,
    finalNewline,
    logicalText,
    changedSpans,
    ...(Number.isFinite(firstChangedLine) ? { firstChangedLine } : {}),
  };
}
