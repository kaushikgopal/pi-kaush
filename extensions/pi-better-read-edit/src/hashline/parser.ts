import { parseHashlineHeader, type LineRange } from "./contract.ts";

export type HashlineOperation =
  | { kind: "replace"; start: number; end: number; rows: string[] }
  | { kind: "cut"; start: number; end: number }
  | { kind: "insert-before"; line: number; rows: string[] }
  | { kind: "insert-after"; line: number; rows: string[] }
  | { kind: "append"; rows: string[] };

export type HashlineSection = {
  displayPath: string;
  tag: string;
  operations: HashlineOperation[];
};

const POSITIVE_INTEGER = "([1-9][0-9]*)";
const REPLACE_RE = new RegExp(
  `^PUT ${POSITIVE_INTEGER}\\.=${POSITIVE_INTEGER}:$`,
);
const BEFORE_RE = new RegExp(`^PUT <${POSITIVE_INTEGER}:$`);
const AFTER_RE = new RegExp(`^PUT >${POSITIVE_INTEGER}:$`);
const CUT_RE = new RegExp(`^CUT ${POSITIVE_INTEGER}\\.=${POSITIVE_INTEGER}$`);

function coordinate(raw: string, lineNumber: number): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(
      `Hashline script line ${lineNumber}: coordinate must be a positive safe integer.`,
    );
  }
  return value;
}

function range(
  match: RegExpExecArray,
  lineNumber: number,
): { start: number; end: number } {
  const start = coordinate(match[1]!, lineNumber);
  const end = coordinate(match[2]!, lineNumber);
  if (end < start) {
    throw new Error(
      `Hashline script line ${lineNumber}: range end must be at least its start.`,
    );
  }
  return { start, end };
}

export function parseHashlineScript(script: string): HashlineSection[] {
  if (script.startsWith("\uFEFF") || /\r(?!\n)/.test(script)) {
    throw new Error(
      "Hashline script must be UTF-8 text with LF or CRLF lines.",
    );
  }
  const withoutCrLf = script.replace(/\r\n/g, "");
  if (script.includes("\r\n") && withoutCrLf.includes("\n")) {
    throw new Error("Hashline script must not mix LF and CRLF lines.");
  }

  const lines = script.replace(/\r\n/g, "\n").split("\n");
  const sections: HashlineSection[] = [];
  let current: HashlineSection | undefined;

  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index]!;
    if (raw === "") continue;

    const header = parseHashlineHeader(raw);
    if (header) {
      if (current && current.operations.length === 0) {
        throw new Error(
          `Hashline section ${current.displayPath} has no operations.`,
        );
      }
      current = { ...header, operations: [] };
      sections.push(current);
      continue;
    }

    if (!current) {
      throw new Error(
        `Hashline script line ${index + 1}: expected a [path#TAG] header.`,
      );
    }
    if (raw.startsWith("+")) {
      throw new Error(
        `Hashline script line ${index + 1}: + rows must follow a PUT operation.`,
      );
    }

    const replace = REPLACE_RE.exec(raw);
    const before = BEFORE_RE.exec(raw);
    const after = AFTER_RE.exec(raw);
    const cut = CUT_RE.exec(raw);

    if (cut) {
      current.operations.push({ kind: "cut", ...range(cut, index + 1) });
      continue;
    }

    let pending: Extract<HashlineOperation, { rows: string[] }> | undefined;
    if (replace) {
      pending = {
        kind: "replace",
        ...range(replace, index + 1),
        rows: [],
      };
    } else if (before) {
      pending = {
        kind: "insert-before",
        line: coordinate(before[1]!, index + 1),
        rows: [],
      };
    } else if (after) {
      pending = {
        kind: "insert-after",
        line: coordinate(after[1]!, index + 1),
        rows: [],
      };
    } else if (raw === "PUT >$:") {
      pending = { kind: "append", rows: [] };
    } else {
      throw new Error(
        `Hashline script line ${index + 1}: expected PUT N.=M:, PUT <N:, PUT >N:, PUT >$:, or CUT N.=M.`,
      );
    }

    while (index + 1 < lines.length && lines[index + 1]!.startsWith("+")) {
      pending.rows.push(lines[++index]!.slice(1));
    }
    if (pending.rows.length === 0) {
      throw new Error(
        `Hashline script line ${index + 1}: PUT requires at least one + row; use CUT to delete.`,
      );
    }
    current.operations.push(pending);
  }

  if (sections.length === 0) {
    throw new Error("Hashline script contains no [path#TAG] sections.");
  }
  if (current && current.operations.length === 0) {
    throw new Error(
      `Hashline section ${current.displayPath} has no operations.`,
    );
  }
  return sections;
}

export function operationRange(
  operation: HashlineOperation,
): LineRange | undefined {
  if (operation.kind === "replace" || operation.kind === "cut") {
    return { start: operation.start, end: operation.end };
  }
  if (operation.kind === "insert-before" || operation.kind === "insert-after") {
    return { start: operation.line, end: operation.line };
  }
  return undefined;
}
