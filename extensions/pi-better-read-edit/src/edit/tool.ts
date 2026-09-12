import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  generateDiffString,
  generateUnifiedPatch,
  withFileMutationQueue,
  type EditToolDetails,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { constants } from "node:fs";
import { access, realpath, stat, writeFile } from "node:fs/promises";
import {
  editSchema,
  getDualTextSplice,
  getLegacyInsertionAnchor,
  normalizeEditArguments,
  toHashlineSection,
  type EditParams,
  type FinalNewlineMode,
} from "./input.ts";
import {
  applyHashlineOperations,
  type ChangedSpan,
} from "../hashline/apply.ts";
import {
  computeFullDigest,
  createHashlineRecord,
  decodeEligibleText,
  encodePhysicalText,
  formatHashlineHeader,
  HASHLINE_SNAPSHOT_CAP_BYTES,
  mergeRanges,
  mapSeenRangesThroughEdit,
  rangesCover,
  throwIfAborted,
  type HashlineRecord,
  type LineRange,
  type LogicalDocument,
} from "../hashline/contract.ts";
import {
  operationRange,
  type HashlineOperation,
  type HashlineSection,
  type TextSplice,
} from "../hashline/parser.ts";
import { HashlineRegistry } from "../hashline/registry.ts";
import { renderChangedHashline } from "../hashline/render.ts";
import { matchUniqueLines, translateOperations } from "../hashline/recovery.ts";
import { readBoundedFile } from "../read/bounded.ts";
import { resolveLocalPath } from "../read/artifacts.ts";
import type { HashlineSnapshotStore } from "../hashline/snapshot-store.ts";
const MAX_EDIT_TARGETS = 16;
const MAX_EDIT_OPERATIONS = 1_000;
const MAX_AGGREGATE_PLAN_BYTES = 16 * 1024 * 1024;

type PlannedFile = {
  displayPath: string;
  canonicalPath: string;
  record: HashlineRecord;
  seenRanges: LineRange[];
  section: HashlineSection;
  operations: HashlineOperation[];
  baseDocument: LogicalDocument;
  oldDocument: LogicalDocument;
  newLogicalText: string;
  changedSpans: ChangedSpan[];
  recoveryWarnings: string[];
  recovered: boolean;
  firstChangedLine?: number;
  finalNewlineOverride?: boolean;
  device: number;
  inode: number;
};

export type BetterEditDetails = EditToolDetails & {
  files: string[];
  hashlineAnchor: HashlineRecord;
  hashlineAnchors: HashlineRecord[];
  recoveryWarnings?: string[];
  fileEdits: Array<{
    path: string;
    diff: string;
    patch: string;
    firstChangedLine?: number;
  }>;
};

async function readEligibleFile(path: string): Promise<LogicalDocument> {
  const bounded = await readBoundedFile(path, HASHLINE_SNAPSHOT_CAP_BYTES);
  if (bounded.truncated) {
    throw new Error(
      `Cannot hashline-edit ${path}: it exceeds the ${HASHLINE_SNAPSHOT_CAP_BYTES}-byte snapshot cap.`,
    );
  }
  if (bounded.links > 1) {
    throw new Error(
      `Cannot hashline-edit ${path}: files with multiple hard links are not supported.`,
    );
  }
  return decodeEligibleText(bounded.bytes);
}

function staleError(displayPath: string): Error {
  return new Error(
    `${displayPath} no longer matches the tagged read. Reread the file and retry with the fresh tag.`,
  );
}

function snapshotMatches(
  document: LogicalDocument,
  record: HashlineRecord,
): boolean {
  return (
    computeFullDigest(document.logicalText) === record.fullDigest &&
    document.lineEnding === record.lineEnding &&
    document.finalNewline === record.finalNewline &&
    document.lines.length === record.lineCount
  );
}

function verifyUnchanged(
  displayPath: string,
  document: LogicalDocument,
  expected: LogicalDocument,
): void {
  if (
    document.logicalText !== expected.logicalText ||
    document.lineEnding !== expected.lineEnding
  ) {
    throw staleError(displayPath);
  }
}

function operationLabel(operation: HashlineOperation): string {
  switch (operation.kind) {
    case "replace":
      return `PUT ${operation.start}.=${operation.end}`;
    case "cut":
      return `CUT ${operation.start}.=${operation.end}`;
    case "insert-before":
      return `PUT <${operation.line}`;
    case "insert-after":
      return `PUT >${operation.line}`;
    case "append":
      return "PUT >$";
  }
}

function uncoveredRanges(
  seenRanges: readonly LineRange[],
  start: number,
  end: number,
): LineRange[] {
  const missing: LineRange[] = [];
  let cursor = start;
  for (const seen of mergeRanges(seenRanges)) {
    if (seen.end < cursor) continue;
    if (seen.start > end) break;
    if (seen.start > cursor) {
      missing.push({ start: cursor, end: Math.min(end, seen.start - 1) });
    }
    cursor = Math.max(cursor, seen.end + 1);
    if (cursor > end) break;
  }
  if (cursor <= end) missing.push({ start: cursor, end });
  return missing;
}

function formatReadRanges(ranges: readonly LineRange[]): string {
  return ranges
    .map((range) =>
      range.start === range.end
        ? `${range.start}`
        : `${range.start}-${range.end}`,
    )
    .join(",");
}
function finalNewlineOverride(mode: FinalNewlineMode): boolean | undefined {
  return mode === "preserve" ? undefined : mode === "present";
}

/**
 * Validate one base-frame operation against the tagged snapshot: bounds plus
 * seen-range display authorization. Thrown errors are the tool's ordinary
 * rejection messages; dual splices catch them and fall back to text match.
 */
function validateCoordinateOperation(
  displayPath: string,
  operation: HashlineOperation,
  lineCount: number,
  seenRanges: readonly LineRange[],
): void {
  const legacyAnchor = getLegacyInsertionAnchor(operation);
  if (legacyAnchor) {
    const label = `legacy PUT ${legacyAnchor.kind === "before" ? "<" : ">"}${legacyAnchor.line}`;
    if (legacyAnchor.line > lineCount) {
      throw new Error(
        `${label} is out of bounds for ${displayPath} (${lineCount} line(s)).`,
      );
    }
    if (!rangesCover(seenRanges, legacyAnchor.line, legacyAnchor.line)) {
      throw new Error(
        `${label} targets an anchor line that was not displayed by the tagged read. Reread that range first.`,
      );
    }
    return;
  }
  const target = operationRange(operation)!;
  if (target.end > lineCount) {
    throw new Error(
      `${operationLabel(operation)} is out of bounds for ${displayPath} (${lineCount} line(s)).`,
    );
  }
  const targetSeen = rangesCover(seenRanges, target.start, target.end);
  const leftBoundarySeen =
    operation.kind === "insert-before" &&
    operation.line > 1 &&
    rangesCover(seenRanges, operation.line - 1, operation.line - 1);
  if (!targetSeen && !leftBoundarySeen) {
    const missing = formatReadRanges(
      uncoveredRanges(seenRanges, target.start, target.end),
    );
    throw new Error(
      `${operationLabel(operation)} targets lines that were not displayed by the tagged read. ` +
        `Read ${displayPath} with ranges "${missing}", then retry using the returned tag.`,
    );
  }
}

/**
 * Resolve one exact-text splice against the current lines. A unique match
 * replaces (or deletes) those lines; zero or multiple matches fail closed.
 */
function resolveTextSplice(
  displayPath: string,
  splice: TextSplice,
  lines: readonly string[],
): HashlineOperation {
  const match = matchUniqueLines(lines, splice.oldLines);
  if (!match) {
    throw new Error(
      `${displayPath} edit ${splice.editIndex + 1}: oldText does not appear in the current file. Copy the exact current lines from a fresh read.`,
    );
  }
  if (match.count > 1) {
    throw new Error(
      `${displayPath} edit ${splice.editIndex + 1}: oldText appears more than once; include more surrounding lines so it is unique.`,
    );
  }
  return splice.newLines.length === 0
    ? { kind: "cut", start: match.start, end: match.end }
    : {
        kind: "replace",
        start: match.start,
        end: match.end,
        rows: splice.newLines,
      };
}

function prepareEdit(
  displayPath: string,
  tag: string,
  record: HashlineRecord,
  seenRanges: readonly LineRange[],
  baseDocument: LogicalDocument,
  currentDocument: LogicalDocument,
  section: HashlineSection,
  newlineOverride?: boolean,
): Pick<
  PlannedFile,
  | "operations"
  | "oldDocument"
  | "newLogicalText"
  | "changedSpans"
  | "recoveryWarnings"
  | "recovered"
  | "firstChangedLine"
> {
  const warnings: string[] = [];
  const resolved: HashlineOperation[] = [];
  const label = formatHashlineHeader(displayPath, tag);

  if (snapshotMatches(currentDocument, record)) {
    // Matched frame: base snapshot coordinates equal live coordinates.
    for (const operation of section.operations) {
      const anchor = getDualTextSplice(operation);
      if (!anchor) {
        resolved.push(operation);
        continue;
      }
      try {
        validateCoordinateOperation(
          displayPath,
          operation,
          record.lineCount,
          seenRanges,
        );
        resolved.push(operation);
      } catch (error) {
        try {
          resolved.push(
            resolveTextSplice(displayPath, anchor, baseDocument.lines),
          );
        } catch {
          throw error;
        }
        warnings.push(
          `${displayPath}: edit ${anchor.editIndex + 1} used unique text match (line coordinates failed: ${error instanceof Error ? error.message : String(error)}).`,
        );
      }
    }
    for (const splice of section.textSplices) {
      resolved.push(resolveTextSplice(displayPath, splice, baseDocument.lines));
    }
    const applied = applyHashlineOperations({
      lines: baseDocument.lines,
      finalNewline: baseDocument.finalNewline,
      operations: resolved,
      label,
      ...(newlineOverride !== undefined
        ? { finalNewlineOverride: newlineOverride }
        : {}),
    });
    if (applied.logicalText === baseDocument.logicalText) {
      throw new Error(
        `Hashline edit for ${displayPath} is a no-op; the file was not written.`,
      );
    }
    return {
      operations: resolved,
      oldDocument: currentDocument,
      newLogicalText: applied.logicalText,
      changedSpans: applied.changedSpans,
      recoveryWarnings: warnings,
      recovered: false,
      ...(applied.firstChangedLine !== undefined
        ? { firstChangedLine: applied.firstChangedLine }
        : {}),
    };
  }

  // Stale frame: translate base operations onto the live document, with
  // exact-text fallback for dual splices. Anything unresolvable fails closed.
  if (newlineOverride !== undefined) throw staleError(displayPath);
  const translated = translateOperations(
    baseDocument,
    currentDocument,
    section.operations,
  );
  section.operations.forEach((operation, index) => {
    const translatedOperation = translated[index];
    if (translatedOperation) {
      resolved.push(translatedOperation);
      return;
    }
    const anchor = getDualTextSplice(operation);
    if (anchor) {
      try {
        resolved.push(
          resolveTextSplice(displayPath, anchor, currentDocument.lines),
        );
      } catch {
        throw staleError(displayPath);
      }
      warnings.push(
        `${displayPath}: edit ${anchor.editIndex + 1} used unique text match after stale recovery failed.`,
      );
      return;
    }
    throw staleError(displayPath);
  });
  for (const splice of section.textSplices) {
    try {
      resolved.push(
        resolveTextSplice(displayPath, splice, currentDocument.lines),
      );
    } catch {
      throw staleError(displayPath);
    }
  }
  const applied = applyHashlineOperations({
    lines: currentDocument.lines,
    finalNewline: currentDocument.finalNewline,
    operations: resolved,
    label,
  });
  if (applied.logicalText === currentDocument.logicalText) {
    throw new Error(
      `Hashline edit for ${displayPath} is a no-op; the file was not written.`,
    );
  }
  warnings.push(
    `${displayPath}: preserved non-overlapping changes made after the tagged read.`,
  );
  return {
    operations: resolved,
    oldDocument: currentDocument,
    newLogicalText: applied.logicalText,
    changedSpans: applied.changedSpans,
    recoveryWarnings: warnings,
    recovered: true,
    ...(applied.firstChangedLine !== undefined
      ? { firstChangedLine: applied.firstChangedLine }
      : {}),
  };
}

async function buildPlan(
  input: EditParams,
  cwd: string,
  registry: HashlineRegistry,
  snapshots: HashlineSnapshotStore,
): Promise<PlannedFile[]> {
  if (
    Buffer.byteLength(JSON.stringify(input), "utf8") >
    HASHLINE_SNAPSHOT_CAP_BYTES
  ) {
    throw new Error("Hashline edit input exceeds the 4 MiB input cap.");
  }
  if (input.files.length === 0) {
    throw new Error("Hashline edit requires at least one file section.");
  }
  if (input.files.length > MAX_EDIT_TARGETS) {
    throw new Error(
      `Hashline edit accepts at most ${MAX_EDIT_TARGETS} file sections per call.`,
    );
  }
  const operationCount = input.files.reduce(
    (total, file) =>
      total +
      file.edits.length +
      (file.appendLines.length > 0 ? 1 : 0) +
      (file.finalNewline === "preserve" ? 0 : 1),
    0,
  );
  if (operationCount === 0 || operationCount > MAX_EDIT_OPERATIONS) {
    throw new Error(
      `Hashline edit accepts 1 to ${MAX_EDIT_OPERATIONS} changes per call.`,
    );
  }
  let aggregatePlanBytes = 0;
  const planned: PlannedFile[] = [];
  const targets = new Set<string>();
  const targetInodes = new Set<string>();

  for (const fileInput of input.files) {
    if (
      !fileInput.path.trim() ||
      /[\u0000-\u001F\u007F]/u.test(fileInput.path)
    ) {
      throw new Error(
        "Hashline edit paths must be non-blank and contain no control characters.",
      );
    }
    const resolved = resolveLocalPath(cwd, fileInput.path);
    let canonicalPath: string;
    let device: number;
    let inode: number;
    try {
      const info = await stat(resolved);
      if (!info.isFile()) {
        throw new Error(`${fileInput.path} is not a regular file.`);
      }
      if (info.nlink > 1) {
        throw new Error(
          `${fileInput.path} has multiple hard links; hashline editing requires one filesystem path.`,
        );
      }
      canonicalPath = await realpath(resolved);
      device = info.dev;
      inode = info.ino;
    } catch (error) {
      if (error instanceof Error && error.message.endsWith("regular file.")) {
        throw error;
      }
      throw new Error(
        `Cannot hashline-edit ${fileInput.path}: the file does not exist.`,
      );
    }
    if (targets.has(canonicalPath)) {
      throw new Error(
        `Hashline edit targets ${fileInput.path} more than once; merge its entries.`,
      );
    }
    targets.add(canonicalPath);
    const inodeIdentity = `${device}:${inode}`;
    if (targetInodes.has(inodeIdentity)) {
      throw new Error(
        "Hashline edit targets two hard-link aliases of the same file; keep one path.",
      );
    }
    targetInodes.add(inodeIdentity);

    const oldDocument = await readEligibleFile(canonicalPath);
    const found = registry.lookup(canonicalPath, fileInput.tag.toUpperCase(), {
      fullDigest: computeFullDigest(oldDocument.logicalText),
      lineEnding: oldDocument.lineEnding,
      finalNewline: oldDocument.finalNewline,
      lineCount: oldDocument.lines.length,
    });
    if (!found) {
      throw new Error(
        `Unknown tag ${fileInput.tag} for ${fileInput.path}. Use a tag returned by read or edit on the current session branch.`,
      );
    }
    if ("ambiguous" in found) {
      throw new Error(
        `Tag ${fileInput.tag} is ambiguous for ${fileInput.path}; reread the file.`,
      );
    }
    const section = toHashlineSection(fileInput, found.record.lineCount);
    const newlineOverride = finalNewlineOverride(fileInput.finalNewline);

    for (const operation of section.operations) {
      // Dual splices defer validation to prepareEdit, where a failed
      // coordinate path can still fall back to the unique text match.
      if (getDualTextSplice(operation)) continue;
      if (getLegacyInsertionAnchor(operation)) {
        // Legacy anchors keep their dedicated bounds check before the
        // append branch, as they did before the text-fallback rework.
        validateCoordinateOperation(
          fileInput.path,
          operation,
          found.record.lineCount,
          found.seenRanges,
        );
        continue;
      }
      if (operation.kind === "append") {
        if (!found.eofSeen) {
          throw new Error(
            `${operationLabel(operation)} requires a tagged read that displayed EOF.`,
          );
        }
        continue;
      }
      validateCoordinateOperation(
        fileInput.path,
        operation,
        found.record.lineCount,
        found.seenRanges,
      );
    }
    if (newlineOverride !== undefined && !found.eofSeen) {
      throw new Error(
        `Changing the terminal newline for ${fileInput.path} requires a tagged read that displayed EOF.`,
      );
    }

    const baseDocument = snapshotMatches(oldDocument, found.record)
      ? oldDocument
      : snapshots.lookup(found.record)?.document;
    if (!baseDocument) {
      throw staleError(fileInput.path);
    }
    snapshots.record(found.record, baseDocument);
    const prepared = prepareEdit(
      fileInput.path,
      found.record.tag,
      found.record,
      found.seenRanges,
      baseDocument,
      oldDocument,
      section,
      newlineOverride,
    );
    const physical = encodePhysicalText(
      prepared.newLogicalText,
      prepared.oldDocument.lineEnding,
    );
    if (Buffer.byteLength(physical, "utf8") > HASHLINE_SNAPSHOT_CAP_BYTES) {
      throw new Error(
        `Hashline edit would grow ${fileInput.path} beyond the ${HASHLINE_SNAPSHOT_CAP_BYTES}-byte snapshot cap.`,
      );
    }
    aggregatePlanBytes +=
      Buffer.byteLength(baseDocument.logicalText, "utf8") +
      Buffer.byteLength(oldDocument.logicalText, "utf8") +
      Buffer.byteLength(prepared.newLogicalText, "utf8");
    if (aggregatePlanBytes > MAX_AGGREGATE_PLAN_BYTES) {
      throw new Error(
        `Hashline edit plan exceeds the ${MAX_AGGREGATE_PLAN_BYTES}-byte aggregate safety cap. Split the edit into smaller calls.`,
      );
    }
    planned.push({
      displayPath: fileInput.path,
      canonicalPath,
      record: found.record,
      seenRanges: found.seenRanges,
      section,
      baseDocument,
      ...prepared,
      ...(newlineOverride !== undefined
        ? { finalNewlineOverride: newlineOverride }
        : {}),
      device,
      inode,
    });
  }
  return planned;
}

function withSortedLocks<T>(
  paths: readonly string[],
  callback: () => Promise<T>,
  index = 0,
): Promise<T> {
  const path = paths[index];
  if (!path) return callback();
  return withFileMutationQueue(path, () =>
    withSortedLocks(paths, callback, index + 1),
  );
}

export function compareCanonicalPaths(left: string, right: string): -1 | 0 | 1 {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function applyPlan(
  files: readonly PlannedFile[],
  snapshots: HashlineSnapshotStore,
  signal?: AbortSignal,
): Promise<{
  details: BetterEditDetails;
  windows: string[];
}> {
  const ordered = [...files].sort((a, b) =>
    compareCanonicalPaths(a.canonicalPath, b.canonicalPath),
  );
  const lockPaths = [
    ...new Set(ordered.map((file) => file.canonicalPath)),
  ].sort(compareCanonicalPaths);
  return withSortedLocks(lockPaths, async () => {
    let aggregatePlanBytes = 0;
    for (const file of ordered) {
      throwIfAborted(signal);
      await access(file.canonicalPath, constants.R_OK | constants.W_OK);
      const info = await stat(file.canonicalPath);
      if (info.dev !== file.device || info.ino !== file.inode) {
        throw staleError(file.displayPath);
      }
      const document = await readEligibleFile(file.canonicalPath);
      const prepared = prepareEdit(
        file.displayPath,
        file.record.tag,
        file.record,
        file.seenRanges,
        file.baseDocument,
        document,
        file.section,
        file.finalNewlineOverride,
      );
      file.operations = prepared.operations;
      file.oldDocument = prepared.oldDocument;
      file.newLogicalText = prepared.newLogicalText;
      file.changedSpans = prepared.changedSpans;
      file.recoveryWarnings = prepared.recoveryWarnings;
      if (prepared.firstChangedLine === undefined) {
        delete file.firstChangedLine;
      } else {
        file.firstChangedLine = prepared.firstChangedLine;
      }
      const physical = encodePhysicalText(
        file.newLogicalText,
        file.oldDocument.lineEnding,
      );
      if (Buffer.byteLength(physical, "utf8") > HASHLINE_SNAPSHOT_CAP_BYTES) {
        throw new Error(
          `Hashline edit would grow ${file.displayPath} beyond the ${HASHLINE_SNAPSHOT_CAP_BYTES}-byte snapshot cap.`,
        );
      }
      aggregatePlanBytes +=
        Buffer.byteLength(file.baseDocument.logicalText, "utf8") +
        Buffer.byteLength(file.oldDocument.logicalText, "utf8") +
        Buffer.byteLength(file.newLogicalText, "utf8");
      if (aggregatePlanBytes > MAX_AGGREGATE_PLAN_BYTES) {
        throw new Error(
          `Hashline edit plan exceeds the ${MAX_AGGREGATE_PLAN_BYTES}-byte aggregate safety cap. Split the edit into smaller calls.`,
        );
      }
    }

    const anchors: HashlineRecord[] = [];
    const windows: string[] = [];
    const diffs: string[] = [];
    const patches: string[] = [];
    const fileEdits: BetterEditDetails["fileEdits"] = [];
    const newDocuments: LogicalDocument[] = [];
    for (const file of files) {
      const physical = encodePhysicalText(
        file.newLogicalText,
        file.oldDocument.lineEnding,
      );
      const document = decodeEligibleText(Buffer.from(physical, "utf8"));
      // Lines outside the changed spans are byte-identical to what the
      // tagged read displayed, so their display authorization carries
      // forward. A stale-recovered edit maps base ranges onto a live file
      // that moved underneath — conservatively authorize only the window.
      const inherited = !file.recovered
        ? mapSeenRangesThroughEdit(
            file.record.seenRanges,
            file.operations,
            file.baseDocument.lines.length,
          )
        : { ranges: [], eofSeen: false };
      const provisional = createHashlineRecord({
        canonicalPath: file.canonicalPath,
        displayPath: file.displayPath,
        document,
        seenRanges: [],
        eofSeen: false,
        producer: "edit",
      });
      const window = renderChangedHashline(
        provisional,
        document.lines,
        file.changedSpans,
      );
      const anchor: HashlineRecord = {
        ...provisional,
        seenRanges: mergeRanges([...window.seenRanges, ...inherited.ranges]),
        eofSeen: window.eofSeen || inherited.eofSeen,
      };
      anchors.push(anchor);
      newDocuments.push(document);
      windows.push(window.text);
      const generated = generateDiffString(
        file.oldDocument.logicalText,
        file.newLogicalText,
      );
      const patch = generateUnifiedPatch(
        file.displayPath,
        file.oldDocument.logicalText,
        file.newLogicalText,
      );
      diffs.push(
        files.length > 1
          ? `--- ${file.displayPath}\n${generated.diff}`
          : generated.diff,
      );
      patches.push(patch);
      fileEdits.push({
        path: file.displayPath,
        diff: generated.diff,
        patch,
        ...(file.firstChangedLine !== undefined
          ? { firstChangedLine: file.firstChangedLine }
          : {}),
      });
    }

    const recoveryWarnings = [
      ...new Set(files.flatMap((file) => file.recoveryWarnings)),
    ];
    const visibleOutput = windows.join("\n\n");
    const warningOutput = recoveryWarnings.length
      ? `\n\nWarnings:\n${recoveryWarnings.map((warning) => `- ${warning}`).join("\n")}`
      : "";
    const successOutput = `Updated ${files.length} file(s).\n\n${visibleOutput}${warningOutput}`;
    const combinedDiff = diffs.join("\n");
    const combinedPatch = patches.join("\n");
    const firstChangedLine = files[0]?.firstChangedLine;
    const firstAnchor = anchors[0]!;
    const details: BetterEditDetails = {
      diff: combinedDiff,
      patch: combinedPatch,
      ...(firstChangedLine !== undefined ? { firstChangedLine } : {}),
      files: files.map((file) => file.displayPath),
      fileEdits,
      hashlineAnchor: firstAnchor,
      hashlineAnchors: anchors,
      ...(recoveryWarnings.length > 0 ? { recoveryWarnings } : {}),
    };
    if (
      Buffer.byteLength(successOutput, "utf8") > DEFAULT_MAX_BYTES ||
      successOutput.split("\n").length > DEFAULT_MAX_LINES
    ) {
      throw new Error(
        "Hashline edit result would exceed Pi's output cap. Split the edit into smaller calls.",
      );
    }
    if (
      Buffer.byteLength(JSON.stringify(details), "utf8") >
      HASHLINE_SNAPSHOT_CAP_BYTES
    ) {
      throw new Error(
        "Serialized hashline edit details would exceed the 4 MiB session cap. Split the edit into smaller calls.",
      );
    }
    // Do not observe cancellation between writes: all paths were preflighted,
    // and stopping mid-sequence would create an avoidable partial commit.
    throwIfAborted(signal);
    const committed: string[] = [];
    for (const file of ordered) {
      try {
        // Reverify immediately before each write. External processes do not
        // participate in Pi's queue, so this narrows but cannot remove that race.
        const info = await stat(file.canonicalPath);
        if (info.dev !== file.device || info.ino !== file.inode) {
          throw staleError(file.displayPath);
        }
        verifyUnchanged(
          file.displayPath,
          await readEligibleFile(file.canonicalPath),
          file.oldDocument,
        );
        await writeFile(
          file.canonicalPath,
          encodePhysicalText(file.newLogicalText, file.oldDocument.lineEnding),
          "utf8",
        );
        committed.push(file.displayPath);
      } catch (error) {
        const suffix = committed.length
          ? ` Already committed: ${committed.join(", ")}.`
          : " No earlier files were committed.";
        throw new Error(
          `Failed while writing ${file.displayPath}; that target may be partially modified.${suffix} ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    for (const [index, anchor] of anchors.entries()) {
      snapshots.record(anchor, newDocuments[index]!);
    }

    return { windows, details };
  });
}

export default function registerEditTool(
  pi: ExtensionAPI,
  snapshots: HashlineSnapshotStore,
): void {
  pi.registerTool({
    name: "edit",
    label: "edit",
    description:
      "Edit tagged local text with structured line splices. Each file needs the path and the 16-character tag from read/edit. A splice starts at an original line, deletes deleteCount lines, then inserts newLines; omit unused fields. Replaced or deleted lines must have been displayed by the tagged read. When line numbers are uncertain or many lines look identical, anchor by oldText (exact current lines, unique in the file) with newText instead of counting.",
    promptSnippet:
      "Edit tagged text with structured original-coordinate line splices",
    promptGuidelines: [
      "Use each file's own tag from read/edit; it authorizes only lines that read displayed.",
      "Every replaced or deleted line must be displayed — reading only the range boundaries is insufficient.",
      "Never count occurrences among identical lines: anchor by oldText (widened with a unique heading or neighbor) and newText; a splice with both tries coordinates first, then the text match.",
      "Omit appendLines and finalNewline unless appending or changing the terminal newline; both require a read that displayed EOF.",
      "On unseen-range errors, read the suggested ranges and retry with the returned tag.",
    ],
    parameters: editSchema,
    prepareArguments: normalizeEditArguments,
    async execute(_toolCallId, params: EditParams, signal, _onUpdate, ctx) {
      const input = normalizeEditArguments(params) as EditParams;
      if (!input?.files) {
        throw new Error("edit requires at least one structured file entry.");
      }
      const registry = HashlineRegistry.fromBranch(
        ctx.sessionManager.getBranch(),
      );
      const plan = await buildPlan(input, ctx.cwd, registry, snapshots);
      const applied = await applyPlan(plan, snapshots, signal);
      return {
        content: [
          {
            type: "text" as const,
            text: `Updated ${applied.details.files.length} file(s).\n\n${applied.windows.join("\n\n")}${applied.details.recoveryWarnings?.length ? `\n\nWarnings:\n${applied.details.recoveryWarnings.map((warning) => `- ${warning}`).join("\n")}` : ""}`,
          },
        ],
        details: applied.details,
      };
    },
  });
}
