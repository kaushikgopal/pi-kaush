import { StringEnum } from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import { HASHLINE_SNAPSHOT_CAP_BYTES } from "../hashline/contract.ts";
import {
  parseHashlineScript,
  type HashlineOperation,
  type HashlineSection,
  type TextSplice,
} from "../hashline/parser.ts";

export type FinalNewlineMode = "preserve" | "present" | "absent";
type LegacyInsertionAnchor = { kind: "before" | "after"; line: number };
const legacyOperationAnchors = new WeakMap<object, LegacyInsertionAnchor>();
const dualTextSplices = new WeakMap<object, TextSplice>();
const legacyAnchorPrefix = `\u0000pi-better-read-edit:${randomUUID()}:`;

export type StructuredLineEdit = {
  startLine?: number;
  deleteCount?: number;
  newLines?: string[];
  oldText?: string[];
  newText?: string[];
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
    startLine: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 100_001,
        description:
          "First original line to replace/delete, or the insertion point. Use original lineCount + 1 to append. Every replaced/deleted line must have been displayed by the tagged read. Omit when anchoring by oldText instead.",
      }),
    ),
    deleteCount: Type.Optional(
      Type.Integer({
        minimum: 0,
        maximum: 100_000,
        description:
          "Number of original lines to delete; use 0 to insert. The tagged read must have displayed the full deleted range, not only its boundaries. Defaults to 0.",
      }),
    ),
    newLines: Type.Optional(
      Type.Array(Type.String(), {
        maxItems: 100_000,
        description:
          "Replacement or inserted lines for a startLine splice. Omit or use [] to delete only.",
      }),
    ),
    oldText: Type.Optional(
      Type.Array(Type.String(), {
        minItems: 1,
        maxItems: 100_000,
        description:
          "Exact current lines to locate this splice when line numbers are uncertain. Must appear exactly once in the file; the splice then replaces those lines. Also used as a fallback when the startLine splice fails.",
      }),
    ),
    newText: Type.Optional(
      Type.Array(Type.String(), {
        maxItems: 100_000,
        description:
          "Replacement lines for an oldText splice. Omit or use [] to delete only.",
      }),
    ),
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
    edits: Type.Optional(
      Type.Array(lineEditSchema, {
        maxItems: 1_000,
        description:
          "Original-coordinate line splices; omit when only appending.",
      }),
    ),
    appendLines: Type.Optional(
      Type.Array(Type.String(), {
        maxItems: 100_000,
        description: "Lines appended at observed EOF; omit when not appending.",
      }),
    ),
    finalNewline: Type.Optional(
      StringEnum(["preserve", "present", "absent"] as const, {
        description:
          'Terminal newline mode; omit for the default "preserve" behavior.',
      }),
    ),
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

  const files = parseJsonArray(raw.files, "files");
  if (!Array.isArray(files)) return { ...raw, files } as unknown as EditParams;

  return {
    ...raw,
    files: files.map((candidate) => {
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
      const edits = parseJsonArray(file.edits, "files[].edits");
      return {
        ...file,
        ...(typeof file.tag === "string"
          ? { tag: file.tag.toUpperCase() }
          : {}),
        finalNewline: mode,
        ...(file.appendLines === null || file.appendLines === undefined
          ? { appendLines: [] }
          : {}),
        ...(edits === null || edits === undefined
          ? { edits: [] }
          : Array.isArray(edits)
            ? { edits: edits.map((edit) => normalizeLineEdit(edit)) }
            : { edits }),
      };
    }),
  } as unknown as EditParams;
}

function parseJsonArray(value: unknown, label: string): unknown {
  if (typeof value !== "string") return value;
  if (Buffer.byteLength(value, "utf8") > HASHLINE_SNAPSHOT_CAP_BYTES) {
    throw new Error(`${label} JSON string exceeds the 4 MiB input cap.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${label} must be an array, not malformed JSON text.`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${label} JSON text must decode to an array.`);
  }
  return parsed;
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
  for (const key of ["newLines", "oldText", "newText"] as const) {
    if (typeof edit[key] === "string") {
      normalized[key] = parseJsonArray(edit[key], `edit ${key}`);
    }
  }
  if (edit.newLines === null || edit.newLines === undefined) {
    normalized.newLines = [];
  }
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
  const operations: HashlineOperation[] = [];
  const textSplices: TextSplice[] = [];
  file.edits.forEach((edit, index) => {
    const oldText = edit.oldText;
    if (oldText !== undefined && oldText !== null) {
      if (!Array.isArray(oldText) || oldText.length === 0) {
        throw new Error(
          `${file.path} edit ${index + 1} oldText must be a non-empty array of exact current lines.`,
        );
      }
      validateExactLines(oldText, file.path, `edit ${index + 1} oldText`);
    }
    if (edit.newText !== undefined && edit.newText !== null) {
      if (!Array.isArray(edit.newText)) {
        throw new Error(
          `${file.path} edit ${index + 1} newText must be an array of lines.`,
        );
      }
      validateExactLines(edit.newText, file.path, `edit ${index + 1} newText`);
    }
    const anchorLines: readonly string[] | undefined = oldText;
    const rows = edit.newText ?? edit.newLines ?? [];
    if (!anchorLines && edit.startLine === undefined) {
      throw new Error(
        `${file.path} edit ${index + 1} needs startLine (original coordinates) or oldText (exact current lines to replace).`,
      );
    }
    if (!anchorLines) {
      const decoded = decodeLegacyAnchor(edit.newLines ?? []);
      validateExactLines(
        decoded.lines,
        file.path,
        `edit ${index + 1} newLines`,
      );
      const normalizedEdit = {
        ...edit,
        startLine: edit.startLine!,
        deleteCount: edit.deleteCount ?? 0,
        newLines: decoded.lines,
      };
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
      operations.push(operation);
      return;
    }
    const splice: TextSplice = {
      editIndex: index,
      oldLines: [...anchorLines],
      newLines: rows,
    };
    if (edit.startLine === undefined) {
      textSplices.push(splice);
      return;
    }
    // Dual splice: the coordinate path is tried first; the text match is the
    // fallback. Replacement rows come from newText (or newLines) on both paths.
    if ((edit.deleteCount ?? 0) === 0) {
      throw new Error(
        `${file.path} edit ${index + 1} pairs startLine with oldText, so the fallback replaces the oldText lines; set deleteCount to at least 1, or drop startLine and put the full replacement in newText.`,
      );
    }
    const operation = toHashlineOperation(
      {
        ...edit,
        startLine: edit.startLine,
        deleteCount: edit.deleteCount ?? 0,
        newLines: rows,
      },
      lineCount,
      file.path,
      index,
      true,
    );
    dualTextSplices.set(operation, splice);
    operations.push(operation);
  });
  if (file.appendLines.length > 0) {
    operations.push({ kind: "append", rows: file.appendLines });
  }
  return {
    displayPath: file.path,
    tag: file.tag.toUpperCase(),
    operations,
    textSplices,
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

export function getDualTextSplice(
  operation: HashlineOperation,
): TextSplice | undefined {
  return dualTextSplices.get(operation);
}

function toHashlineOperation(
  edit: StructuredLineEdit & {
    startLine: number;
    deleteCount: number;
    newLines: string[];
  },
  lineCount: number,
  path: string,
  index: number,
  skipBounds = false,
): HashlineOperation {
  const startLine = edit.startLine;
  if (!skipBounds && startLine > lineCount + 1) {
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
  if (!skipBounds && (!Number.isSafeInteger(end) || end > lineCount)) {
    throw new Error(
      `${path} edit ${index + 1} deletes through line ${end}, beyond the ${lineCount}-line snapshot.`,
    );
  }
  return edit.newLines.length === 0
    ? { kind: "cut", start: startLine, end }
    : { kind: "replace", start: startLine, end, rows: edit.newLines };
}
