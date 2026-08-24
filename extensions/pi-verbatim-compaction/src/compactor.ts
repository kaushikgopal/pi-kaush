import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import type {
  CompactionResult,
  ExtensionContext,
  SessionBeforeCompactEvent,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { runPlanner } from "./planner.ts";
import { applyCompaction, selectRangesForRetention } from "./ranges.ts";
import {
  buildTranscript,
  digestText,
  parseSafeDeletionMarker,
} from "./transcript.ts";
import {
  STRATEGY,
  type ExtensionSettings,
  type PlannerResult,
  type Transcript,
  type SummaryProvenance,
  type VerbatimCompactionDetails,
} from "./types.ts";

export type SessionBeforeCompactResult = {
  cancel?: boolean;
  compaction?: CompactionResult;
};

export interface CompactionAttempt {
  result: SessionBeforeCompactResult;
  details: VerbatimCompactionDetails;
  planner: PlannerResult;
}

export interface PreparedCompaction {
  transcript: Transcript;
  objective: string;
  targetRetainedTokens: number;
  minimumRetainedTokens: number;
}

export function prepareCompaction(
  event: SessionBeforeCompactEvent,
  settings: ExtensionSettings,
): PreparedCompaction | undefined {
  const transcript = buildTranscript(
    {
      previousSummary: event.preparation.previousSummary,
      messagesToSummarize: event.preparation.messagesToSummarize,
      turnPrefixMessages: event.preparation.turnPrefixMessages,
    },
    {
      protectedContext: settings.protectedContext.enabled,
      previousSummaryProvenance: findSummaryProvenance(
        event.branchEntries,
        event.preparation.previousSummary,
      ),
    },
  );
  if (transcript.lines.length === 0) return undefined;

  const minimumRetainedTokens = Math.min(
    transcript.estimatedTokens,
    settings.retention.minimumTokens,
  );
  const targetRetainedTokens = Math.max(
    minimumRetainedTokens,
    Math.floor(transcript.estimatedTokens * settings.retention.ratio),
  );
  if (
    transcript.estimatedTokens - targetRetainedTokens <
    settings.retention.minimumReductionTokens
  ) {
    return undefined;
  }

  return {
    transcript,
    objective: findCurrentObjective(event.branchEntries),
    targetRetainedTokens,
    minimumRetainedTokens,
  };
}

export async function runForegroundCompaction(
  event: SessionBeforeCompactEvent,
  ctx: ExtensionContext,
  settings: ExtensionSettings,
  onPlannerResponse?: (usage: Usage) => void,
): Promise<CompactionAttempt | undefined> {
  const prepared = prepareCompaction(event, settings);
  if (prepared === undefined) return undefined;
  const planner = await runPlanner(
    {
      transcript: prepared.transcript,
      objective: prepared.objective,
      targetRetainedTokens: prepared.targetRetainedTokens,
      customInstructions: event.customInstructions,
    },
    settings.planner,
    ctx,
    event.signal,
    onPlannerResponse,
  );
  return createCompactionFromPlan(
    event,
    prepared,
    planner,
    settings,
    "foreground",
  );
}

export function createCompactionFromPlan(
  event: SessionBeforeCompactEvent,
  prepared: PreparedCompaction,
  planner: PlannerResult,
  settings: ExtensionSettings,
  planSource: "foreground" | "speculative",
): CompactionAttempt | undefined {
  const selected = selectRangesForRetention(
    prepared.transcript,
    planner.ranges,
    {
      targetRetainedTokens: prepared.targetRetainedTokens,
      minimumRetainedTokens: prepared.minimumRetainedTokens,
    },
  );
  if (selected.length === 0) return undefined;

  const applied = applyCompaction(prepared.transcript, selected);
  const reduction =
    prepared.transcript.estimatedTokens - applied.retainedTokens;
  if (
    reduction < settings.retention.minimumReductionTokens ||
    applied.retainedTokens > prepared.targetRetainedTokens ||
    applied.retainedTokens < prepared.minimumRetainedTokens ||
    applied.text.length === 0
  ) {
    return undefined;
  }

  const details: VerbatimCompactionDetails = {
    strategy: STRATEGY,
    strategyVersion: 1,
    plannerProvider: planner.provider,
    plannerModel: planner.model,
    sourceTokens: prepared.transcript.estimatedTokens,
    outputTokens: applied.retainedTokens,
    targetRetainedTokens: prepared.targetRetainedTokens,
    sourceLines: prepared.transcript.lines.length,
    deletedLines: applied.deletedLines,
    protectedLines: prepared.transcript.protectedLines.length,
    rangesProposed: planner.proposedCount,
    rangesApplied: applied.ranges.length,
    plannerLatencyMs: planner.latencyMs,
    plannerParseMode: planner.parseMode,
    plannerResponseDiagnostics: planner.responseDiagnostics,
    planSource,
    reason: event.reason,
    summaryDigest: applied.provenance.digest,
    protectedSummaryLines: applied.provenance.protectedLines,
    markerSummaryLines: applied.provenance.markerLines,
    structureSummaryLines: applied.provenance.structureLines,
  };

  return {
    planner,
    details,
    result: {
      compaction: {
        summary: applied.text,
        firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
        usage: planner.usage,
        details,
      },
    },
  };
}

export function findSummaryProvenance(
  entries: readonly SessionEntry[],
  summary: string | undefined,
): SummaryProvenance | undefined {
  if (summary === undefined) return undefined;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type !== "compaction" || entry.summary !== summary) continue;
    const details = entry.details as
      | Partial<VerbatimCompactionDetails>
      | undefined;
    const lineCount = summary.split("\n").length;
    if (
      details?.strategy !== STRATEGY ||
      details.strategyVersion !== 1 ||
      details.summaryDigest !== digestText(summary) ||
      !isLineNumberArray(details.protectedSummaryLines, lineCount) ||
      !isLineNumberArray(details.markerSummaryLines, lineCount) ||
      !isLineNumberArray(details.structureSummaryLines, lineCount) ||
      !hasCompleteProvenance(summary, {
        digest: details.summaryDigest,
        protectedLines: details.protectedSummaryLines,
        markerLines: details.markerSummaryLines,
        structureLines: details.structureSummaryLines,
      })
    ) {
      return undefined;
    }
    return {
      digest: details.summaryDigest,
      protectedLines: details.protectedSummaryLines,
      markerLines: details.markerSummaryLines,
      structureLines: details.structureSummaryLines,
    };
  }
  return undefined;
}

function isLineNumberArray(
  value: unknown,
  lineCount: number,
): value is number[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item, index) =>
        Number.isSafeInteger(item) &&
        item > 0 &&
        item <= lineCount &&
        (index === 0 || item > (value[index - 1] as number)),
    )
  );
}

function hasCompleteProvenance(
  summary: string,
  provenance: SummaryProvenance,
): boolean {
  const protectedLines = new Set(provenance.protectedLines);
  const markerLines = new Set(provenance.markerLines);
  const structureLines = new Set(provenance.structureLines);
  return summary.split("\n").every((line, index) => {
    const lineNumber = index + 1;
    const isMarker = parseSafeDeletionMarker(line) !== undefined;
    const isStructure = isValidStructureLine(line);
    return (
      !line.includes("<summary>") &&
      !line.includes("</summary>") &&
      markerLines.has(lineNumber) === isMarker &&
      structureLines.has(lineNumber) === isStructure &&
      (!isStructure || protectedLines.has(lineNumber)) &&
      (!isMarker || !protectedLines.has(lineNumber))
    );
  });
}

function isValidStructureLine(line: string): boolean {
  if (
    line === "[verbatim:unknown-part]" ||
    line === "[/verbatim:unknown-part]"
  ) {
    return true;
  }
  if (
    line === "[/verbatim:message]" ||
    line === "[/verbatim:field]" ||
    line === "[/verbatim:tool-call]"
  ) {
    return true;
  }
  const match =
    /^\[verbatim:(?:message|field|tool-call|image) (\{.*\})\]$/.exec(line);
  if (match === null) return false;
  try {
    const value = JSON.parse(match[1] ?? "null");
    return value !== null && typeof value === "object" && !Array.isArray(value);
  } catch {
    return false;
  }
}

export function findCurrentObjective(
  entries: SessionBeforeCompactEvent["branchEntries"],
): string {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type !== "message" || entry.message.role !== "user") continue;
    const text = textFromMessage(entry.message);
    if (text.trim().length > 0) return truncateObjective(text.trim());
  }
  return "Continue the current coding task.";
}

export function textFromMessage(message: AgentMessage): string {
  const record = message as unknown as {
    role?: string;
    content?: string | Array<{ type?: string; text?: string }>;
  };
  if (typeof record.content === "string") return record.content;
  if (!Array.isArray(record.content)) return "";
  return record.content
    .filter(
      (part): part is { type: "text"; text: string } =>
        part?.type === "text" && typeof part.text === "string",
    )
    .map((part) => part.text)
    .join("\n");
}

function truncateObjective(value: string): string {
  if (value.length <= 6_000) return value;
  return `${value.slice(0, 6_000)}\n[objective truncated]`;
}
