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
import { Type } from "typebox";
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
  rangesCover,
  throwIfAborted,
  type HashlineRecord,
  type LogicalDocument,
} from "../hashline/contract.ts";
import {
  operationRange,
  parseHashlineScript,
  type HashlineOperation,
} from "../hashline/parser.ts";
import { HashlineRegistry } from "../hashline/registry.ts";
import { renderChangedHashline } from "../hashline/render.ts";
import { recoverNonOverlappingEdit } from "../hashline/recovery.ts";
import type { HashlineSnapshotStore } from "../hashline/snapshot-store.ts";
import { readBoundedFile } from "../read/bounded.ts";
import { resolveLocalPath } from "../read/artifacts.ts";
const MAX_EDIT_TARGETS = 16;
const MAX_EDIT_OPERATIONS = 1_000;
const MAX_AGGREGATE_PLAN_BYTES = 16 * 1024 * 1024;
const MAX_EDIT_SCRIPT_LINES = 20_000;

const editSchema = Type.Object(
  {
    script: Type.String({
      description:
        "Hashline edit script with one or more [path#TAG] sections and PUT/CUT operations. Coordinates refer to the original tagged read.",
      maxLength: HASHLINE_SNAPSHOT_CAP_BYTES,
    }),
  },
  { additionalProperties: false },
);

type EditParams = { script: string };

type PlannedFile = {
  displayPath: string;
  canonicalPath: string;
  record: HashlineRecord;
  operations: HashlineOperation[];
  baseDocument: LogicalDocument;
  oldDocument: LogicalDocument;
  newLogicalText: string;
  changedSpans: ChangedSpan[];
  recoveryWarnings: string[];
  firstChangedLine?: number;
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

function staleError(displayPath: string, currentTag?: string): Error {
  return new Error(
    `${displayPath} no longer matches the tagged read.${currentTag ? ` Current tag: ${currentTag}.` : ""} Reread the file and retry with the fresh tag.`,
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
    throw staleError(
      displayPath,
      computeFullDigest(document.logicalText).slice(0, 16),
    );
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
function prepareEdit(
  displayPath: string,
  tag: string,
  record: HashlineRecord,
  baseDocument: LogicalDocument,
  currentDocument: LogicalDocument,
  operations: readonly HashlineOperation[],
): Pick<
  PlannedFile,
  | "oldDocument"
  | "newLogicalText"
  | "changedSpans"
  | "recoveryWarnings"
  | "firstChangedLine"
> {
  const applied = applyHashlineOperations({
    lines: baseDocument.lines,
    finalNewline: baseDocument.finalNewline,
    operations,
    label: formatHashlineHeader(displayPath, tag),
  });
  if (applied.logicalText === baseDocument.logicalText) {
    throw new Error(
      `Hashline edit for ${displayPath} is a no-op; the file was not written.`,
    );
  }

  if (snapshotMatches(currentDocument, record)) {
    return {
      oldDocument: currentDocument,
      newLogicalText: applied.logicalText,
      changedSpans: applied.changedSpans,
      recoveryWarnings: [],
      ...(applied.firstChangedLine !== undefined
        ? { firstChangedLine: applied.firstChangedLine }
        : {}),
    };
  }

  const recovered = recoverNonOverlappingEdit(
    baseDocument,
    currentDocument,
    operations,
    formatHashlineHeader(displayPath, tag),
  );
  if (!recovered) {
    throw staleError(
      displayPath,
      computeFullDigest(currentDocument.logicalText).slice(0, 16),
    );
  }
  return {
    oldDocument: currentDocument,
    newLogicalText: recovered.logicalText,
    changedSpans: recovered.changedSpans,
    recoveryWarnings: [
      `${displayPath}: preserved non-overlapping changes made after the tagged read.`,
    ],
    ...(recovered.firstChangedLine !== undefined
      ? { firstChangedLine: recovered.firstChangedLine }
      : {}),
  };
}

async function buildPlan(
  script: string,
  cwd: string,
  registry: HashlineRegistry,
  snapshots: HashlineSnapshotStore,
): Promise<PlannedFile[]> {
  if (Buffer.byteLength(script, "utf8") > HASHLINE_SNAPSHOT_CAP_BYTES) {
    throw new Error("Hashline edit script exceeds the 4 MiB input cap.");
  }
  let scriptLines = script.length === 0 ? 0 : 1;
  for (let index = 0; index < script.length; index++) {
    if (script.charCodeAt(index) === 10) scriptLines++;
  }
  if (scriptLines > MAX_EDIT_SCRIPT_LINES) {
    throw new Error(
      `Hashline edit script exceeds the ${MAX_EDIT_SCRIPT_LINES}-line input cap.`,
    );
  }
  const sections = parseHashlineScript(script);
  if (sections.length > MAX_EDIT_TARGETS) {
    throw new Error(
      `Hashline edit accepts at most ${MAX_EDIT_TARGETS} file sections per call.`,
    );
  }
  const operationCount = sections.reduce(
    (total, section) => total + section.operations.length,
    0,
  );
  if (operationCount > MAX_EDIT_OPERATIONS) {
    throw new Error(
      `Hashline edit accepts at most ${MAX_EDIT_OPERATIONS} operations per call.`,
    );
  }
  let aggregatePlanBytes = 0;
  const planned: PlannedFile[] = [];
  const targets = new Set<string>();
  const targetInodes = new Set<string>();

  for (const section of sections) {
    const resolved = resolveLocalPath(cwd, section.displayPath);
    let canonicalPath: string;
    let device: number;
    let inode: number;
    try {
      const info = await stat(resolved);
      if (!info.isFile()) {
        throw new Error(`${section.displayPath} is not a regular file.`);
      }
      if (info.nlink > 1) {
        throw new Error(
          `${section.displayPath} has multiple hard links; hashline editing requires one filesystem path.`,
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
        `Cannot hashline-edit ${section.displayPath}: the file does not exist.`,
      );
    }
    if (targets.has(canonicalPath)) {
      throw new Error(
        `Hashline script targets ${section.displayPath} more than once; merge its sections.`,
      );
    }
    targets.add(canonicalPath);
    const inodeIdentity = `${device}:${inode}`;
    if (targetInodes.has(inodeIdentity)) {
      throw new Error(
        `Hashline script targets two hard-link aliases of the same file; keep one path.`,
      );
    }
    targetInodes.add(inodeIdentity);

    const oldDocument = await readEligibleFile(canonicalPath);
    const found = registry.lookup(canonicalPath, section.tag, {
      fullDigest: computeFullDigest(oldDocument.logicalText),
      lineEnding: oldDocument.lineEnding,
      finalNewline: oldDocument.finalNewline,
      lineCount: oldDocument.lines.length,
    });
    if (!found) {
      throw new Error(
        `Unknown tag ${section.tag} for ${section.displayPath}. Use a tag returned by read or edit on the current session branch.`,
      );
    }
    if ("ambiguous" in found) {
      throw new Error(
        `Tag ${section.tag} is ambiguous for ${section.displayPath}; reread the file.`,
      );
    }

    for (const operation of section.operations) {
      if (operation.kind === "append") {
        if (!found.eofSeen) {
          throw new Error(
            `${operationLabel(operation)} requires a tagged read that displayed EOF.`,
          );
        }
        continue;
      }
      const target = operationRange(operation)!;
      if (target.end > found.record.lineCount) {
        throw new Error(
          `${operationLabel(operation)} is out of bounds for ${section.displayPath} (${found.record.lineCount} line(s)).`,
        );
      }
      if (!rangesCover(found.seenRanges, target.start, target.end)) {
        throw new Error(
          `${operationLabel(operation)} targets lines that were not displayed by the tagged read. Reread that range first.`,
        );
      }
    }

    const baseDocument = snapshotMatches(oldDocument, found.record)
      ? oldDocument
      : snapshots.lookup(found.record)?.document;
    if (!baseDocument) {
      throw staleError(
        section.displayPath,
        computeFullDigest(oldDocument.logicalText).slice(0, 16),
      );
    }
    snapshots.record(found.record, baseDocument);
    const prepared = prepareEdit(
      section.displayPath,
      section.tag,
      found.record,
      baseDocument,
      oldDocument,
      section.operations,
    );
    const physical = encodePhysicalText(
      prepared.newLogicalText,
      prepared.oldDocument.lineEnding,
    );
    if (Buffer.byteLength(physical, "utf8") > HASHLINE_SNAPSHOT_CAP_BYTES) {
      throw new Error(
        `Hashline edit would grow ${section.displayPath} beyond the ${HASHLINE_SNAPSHOT_CAP_BYTES}-byte snapshot cap.`,
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
      displayPath: section.displayPath,
      canonicalPath,
      record: found.record,
      operations: section.operations,
      baseDocument,
      ...prepared,
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
        file.baseDocument,
        document,
        file.operations,
      );
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
        seenRanges: window.seenRanges,
        eofSeen: window.eofSeen,
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
    if (
      Buffer.byteLength(successOutput, "utf8") > DEFAULT_MAX_BYTES ||
      successOutput.split("\n").length > DEFAULT_MAX_LINES
    ) {
      throw new Error(
        "Hashline edit result would exceed Pi's output cap. Split the edit into smaller calls.",
      );
    }
    if (
      Buffer.byteLength(combinedDiff, "utf8") +
        Buffer.byteLength(combinedPatch, "utf8") >
      HASHLINE_SNAPSHOT_CAP_BYTES
    ) {
      throw new Error(
        "Hashline diff details would exceed the 4 MiB session cap. Split the edit into smaller calls.",
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

    const firstChangedLine = files[0]?.firstChangedLine;
    const firstAnchor = anchors[0]!;
    return {
      windows,
      details: {
        diff: combinedDiff,
        patch: combinedPatch,
        ...(firstChangedLine !== undefined ? { firstChangedLine } : {}),
        files: files.map((file) => file.displayPath),
        fileEdits,
        hashlineAnchor: firstAnchor,
        hashlineAnchors: anchors,
        ...(recoveryWarnings.length > 0 ? { recoveryWarnings } : {}),
      },
    };
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
      "Edit one or more tagged local text files with concise hashline operations. Each [path#TAG] must come from this session's read/edit output. PUT replaces or inserts lines; CUT deletes lines. All coordinates use the original tagged snapshot. Every target is preflighted before any write; retained snapshots can preserve exact non-overlapping drift, while unknown, overlapping, unseen, ambiguous, or unrecoverable edits fail closed.",
    promptSnippet:
      "Edit tagged text with concise PUT/CUT operations in original read coordinates",
    promptGuidelines: [
      "Use the [path#TAG] header emitted by read; tags authorize only the displayed ranges on that session branch.",
      "Use PUT N.=M: followed by + rows to replace lines, PUT <N:/PUT >N: to insert, PUT >$: to append after observing EOF, and CUT N.=M to delete.",
      "Combine disjoint changes, including multiple file sections, in one script. Every coordinate refers to the original tagged read, not an earlier operation.",
      "Reread after a stale-tag error. Retained snapshots recover only when each operation maps through unique unchanged context; duplicate, ambiguous, same-gap, or overlapping drift fails closed.",
    ],
    parameters: editSchema,
    async execute(_toolCallId, params: EditParams, signal, _onUpdate, ctx) {
      if (!params.script?.trim()) {
        throw new Error("edit requires a non-empty hashline script.");
      }
      const registry = HashlineRegistry.fromBranch(
        ctx.sessionManager.getBranch(),
      );
      const plan = await buildPlan(params.script, ctx.cwd, registry, snapshots);
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
