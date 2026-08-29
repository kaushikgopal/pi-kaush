import { StringEnum } from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import { HASHLINE_SNAPSHOT_CAP_BYTES } from "../hashline/contract.ts";
import {
  parseHashlineScript,
  type HashlineOperation,
  type HashlineSection,
} from "../hashline/parser.ts";

export type FinalNewlineMode = "preserve" | "present" | "absent";
type LegacyInsertionAnchor = { kind: "before" | "after"; line: number };
const legacyOperationAnchors = new WeakMap<object, LegacyInsertionAnchor>();
const legacyAnchorPrefix = `\u0000pi-better-read-edit:${randomUUID()}:`;

export type StructuredLineEdit = {
  startLine: number;
  deleteCount: number;
  newLines: string[];
};

export type StructuredFileEdit = {
  path: string;
  tag: string;
  edits: StructuredLineEdit[];
  appendLines: string[];
  finalNewline: FinalNewlineMode;
};

export type EditParams = { files: StructuredFileEdit[] };

const lineEditSchema = Type.Object(
  {
    startLine: Type.Integer({
      minimum: 1,
      maximum: 100_001,
      description:
        "First original line to replace/delete, or the insertion point. Use original lineCount + 1 to append.",
    }),
    deleteCount: Type.Integer({
      minimum: 0,
      maximum: 100_000,
      description: "Number of original lines to delete; use 0 to insert.",
    }),
    newLines: Type.Array(Type.String(), {
      maxItems: 100_000,
      description: "Replacement or inserted lines; use [] to delete only.",
    }),
  },
  { additionalProperties: false },
);

const fileEditSchema = Type.Object(
  {
    path: Type.String({
      minLength: 1,
      pattern: "^[^\\u0000-\\u001F\\u007F]+$",
      description: "Local path without control characters.",
    }),
    tag: Type.String({
      pattern: "^[0-9A-Fa-f]{16}$",
      description: "The 16-character tag returned by read or edit.",
    }),
    edits: Type.Array(lineEditSchema, { maxItems: 1_000 }),
    appendLines: Type.Array(Type.String(), {
      maxItems: 100_000,
      description: "Lines appended at observed EOF; use [] when not appending.",
    }),
    finalNewline: StringEnum(["preserve", "present", "absent"] as const, {
      description:
        "Keep, add, or remove the terminal newline after applying the line edits.",
    }),
  },
  { additionalProperties: false },
);

export const editSchema = Type.Object(
  {
    files: Type.Array(fileEditSchema, {
      minItems: 1,
      maxItems: 16,
      description: "Tagged files to edit atomically through preflight.",
    }),
  },
  { additionalProperties: false },
);

export function normalizeEditArguments(input: unknown): EditParams {
  if (!input || typeof input !== "object") return input as EditParams;
  const raw = input as Record<string, unknown>;
  if (typeof raw.script === "string" && raw.files === undefined) {
    if (Object.keys(raw).some((key) => key !== "script")) {
      throw new Error("Legacy edit calls accept only the script field.");
    }
    return legacyScriptToParams(raw.script);
  }
  if (!Array.isArray(raw.files)) return input as EditParams;

  return {
    ...raw,
    files: raw.files.map((candidate) => {
      if (!candidate || typeof candidate !== "object") {
        return candidate as StructuredFileEdit;
      }
      const file = candidate as Record<string, unknown>;
      const mode =
        file.finalNewline === undefined ||
        file.finalNewline === null ||
        (typeof file.finalNewline === "string" &&
          file.finalNewline.trim() === "")
          ? "preserve"
          : file.finalNewline;
      return {
        ...file,
        ...(typeof file.tag === "string"
          ? { tag: file.tag.toUpperCase() }
          : {}),
        finalNewline: mode,
        ...(file.appendLines === null || file.appendLines === undefined
          ? { appendLines: [] }
          : {}),
        ...(Array.isArray(file.edits)
          ? {
              edits: file.edits.map((edit) => normalizeLineEdit(edit)),
            }
          : {}),
      };
    }),
  } as unknown as EditParams;
}

function normalizeLineEdit(input: unknown): unknown {
  if (!input || typeof input !== "object") return input;
  const edit = input as Record<string, unknown>;
  const normalized: Record<string, unknown> = { ...edit };
  for (const key of ["startLine", "deleteCount"] as const) {
    const value = edit[key];
    if (typeof value === "string" && /^\d+$/.test(value.trim())) {
      normalized[key] = Number(value.trim());
    }
  }
  if (edit.newLines === null) normalized.newLines = [];
  return normalized;
}

function legacyScriptToParams(script: string): EditParams {
  if (Buffer.byteLength(script, "utf8") > HASHLINE_SNAPSHOT_CAP_BYTES) {
    throw new Error("Hashline edit script exceeds the 4 MiB input cap.");
  }
  let lineCount = script.length === 0 ? 0 : 1;
  for (let index = 0; index < script.length; index++) {
    if (script.charCodeAt(index) === 10) lineCount++;
  }
  if (lineCount > 20_000) {
    throw new Error("Hashline edit script exceeds the 20000-line input cap.");
  }
  return {
    files: parseHashlineScript(script).map(legacySectionToFile),
  };
}

function legacySectionToFile(section: HashlineSection): StructuredFileEdit {
  const appends = section.operations.filter(
    (operation) => operation.kind === "append",
  );
  if (appends.length > 1) {
    throw new Error(
      `Hashline section ${section.displayPath} appends at EOF more than once; merge those rows.`,
    );
  }
  return {
    path: section.displayPath,
    tag: section.tag,
    edits: section.operations
      .filter((operation) => operation.kind !== "append")
      .map((operation) => legacyOperationToLineEdit(operation)),
    appendLines: appends[0]?.rows ?? [],
    finalNewline: "preserve",
  };
}

function legacyOperationToLineEdit(
  operation: Exclude<HashlineOperation, { kind: "append" }>,
): StructuredLineEdit {
  switch (operation.kind) {
    case "replace":
      return {
        startLine: operation.start,
        deleteCount: operation.end - operation.start + 1,
        newLines: operation.rows,
      };
    case "cut":
      return {
        startLine: operation.start,
        deleteCount: operation.end - operation.start + 1,
        newLines: [],
      };
    case "insert-before":
      return {
        startLine: operation.line,
        deleteCount: 0,
        newLines: [
          encodeLegacyAnchor({ kind: "before", line: operation.line }),
          ...operation.rows,
        ],
      };
    case "insert-after":
      return {
        startLine: operation.line + 1,
        deleteCount: 0,
        newLines: [
          encodeLegacyAnchor({ kind: "after", line: operation.line }),
          ...operation.rows,
        ],
      };
  }
}

function encodeLegacyAnchor(anchor: LegacyInsertionAnchor): string {
  return `${legacyAnchorPrefix}${anchor.kind}:${anchor.line}`;
}

function decodeLegacyAnchor(lines: readonly string[]): {
  anchor?: LegacyInsertionAnchor;
  lines: string[];
} {
  const first = lines[0];
  if (!first?.startsWith(legacyAnchorPrefix)) return { lines: [...lines] };
  const match = /^(before|after):(\d+)$/u.exec(
    first.slice(legacyAnchorPrefix.length),
  );
  if (!match) return { lines: [...lines] };
  return {
    anchor: { kind: match[1] as "before" | "after", line: Number(match[2]) },
    lines: lines.slice(1),
  };
}

export function toHashlineSection(
  file: StructuredFileEdit,
  lineCount: number,
): HashlineSection {
  validateExactLines(file.appendLines, file.path, "appendLines");
  const operations = file.edits.map((edit, index) => {
    const decoded = decodeLegacyAnchor(edit.newLines);
    validateExactLines(decoded.lines, file.path, `edit ${index + 1} newLines`);
    const normalizedEdit = { ...edit, newLines: decoded.lines };
    const operation = toHashlineOperation(
      normalizedEdit,
      lineCount,
      file.path,
      index,
    );
    if (decoded.anchor) {
      const anchor = decoded.anchor;
      const validLegacyInsertion =
        normalizedEdit.deleteCount === 0 &&
        normalizedEdit.newLines.length > 0 &&
        ((anchor.kind === "before" &&
          normalizedEdit.startLine === anchor.line) ||
          (anchor.kind === "after" &&
            normalizedEdit.startLine === anchor.line + 1));
      if (!validLegacyInsertion) {
        throw new Error(
          `${file.path} edit ${index + 1} has invalid legacy insertion metadata.`,
        );
      }
      legacyOperationAnchors.set(operation, anchor);
    }
    return operation;
  });
  if (file.appendLines.length > 0) {
    operations.push({ kind: "append", rows: file.appendLines });
  }
  return {
    displayPath: file.path,
    tag: file.tag.toUpperCase(),
    operations,
  };
}

function validateExactLines(
  lines: readonly string[],
  path: string,
  label: string,
): void {
  for (const [index, line] of lines.entries()) {
    if (/[\r\n]/u.test(line)) {
      throw new Error(
        `${path} ${label}[${index}] contains a newline; provide one array item per logical line.`,
      );
    }
    if (Buffer.from(line, "utf8").toString("utf8") !== line) {
      throw new Error(
        `${path} ${label}[${index}] cannot round-trip through UTF-8 exactly.`,
      );
    }
  }
}
export function getLegacyInsertionAnchor(
  operation: HashlineOperation,
): LegacyInsertionAnchor | undefined {
  return legacyOperationAnchors.get(operation);
}

function toHashlineOperation(
  edit: StructuredLineEdit,
  lineCount: number,
  path: string,
  index: number,
): HashlineOperation {
  const startLine = edit.startLine;
  if (startLine > lineCount + 1) {
    throw new Error(
      `${path} edit ${index + 1} starts at line ${startLine}, beyond the ${lineCount + 1} insertion boundary.`,
    );
  }
  if (edit.deleteCount === 0) {
    if (edit.newLines.length === 0) {
      throw new Error(
        `${path} edit ${index + 1} neither deletes nor inserts any lines.`,
      );
    }
    return startLine === lineCount + 1
      ? { kind: "append", rows: edit.newLines }
      : { kind: "insert-before", line: startLine, rows: edit.newLines };
  }

  const end = startLine + edit.deleteCount - 1;
  if (!Number.isSafeInteger(end) || end > lineCount) {
    throw new Error(
      `${path} edit ${index + 1} deletes through line ${end}, beyond the ${lineCount}-line snapshot.`,
    );
  }
  return edit.newLines.length === 0
    ? { kind: "cut", start: startLine, end }
    : { kind: "replace", start: startLine, end, rows: edit.newLines };
}
