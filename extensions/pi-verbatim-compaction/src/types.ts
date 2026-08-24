import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";

export const STRATEGY = "verbatim-lines-v1" as const;
export const SETTINGS_KEY = "verbatimCompaction";
export const SETTINGS_FILE = "settings.json";
export const DELETION_MARKER_PATTERN =
  /^\[verbatim-compaction: (\d+) lines removed\]$/;

export type LineKind = "content" | "structure" | "marker";

export interface TranscriptLine {
  id: number;
  text: string;
  kind: LineKind;
  protected: boolean;
  estimatedTokens: number;
}

export interface Transcript {
  lines: TranscriptLine[];
  text: string;
  numberedText: string;
  estimatedTokens: number;
  protectedLines: number[];
}

export interface InclusiveRange {
  start: number;
  end: number;
}

export interface ParsedPlannerRanges {
  ranges: InclusiveRange[];
  proposedCount: number;
}

export interface SummaryProvenance {
  digest: string;
  protectedLines: number[];
  markerLines: number[];
  structureLines: number[];
}

export interface AppliedCompaction {
  text: string;
  ranges: InclusiveRange[];
  deletedLines: number;
  deletedTokens: number;
  retainedTokens: number;
  provenance: SummaryProvenance;
}

export interface RetentionSettings {
  ratio: number;
  minimumTokens: number;
  minimumReductionTokens: number;
}

export interface PlannerSettings {
  model: string;
  maxOutputTokens: number;
  timeoutMs: number;
}

export interface ProtectedContextSettings {
  enabled: boolean;
}

export interface RecallSettings {
  enabled: boolean;
  maxResults: number;
  maxCharacters: number;
}

export interface SpeculationSettings {
  enabled: boolean;
  triggerRatio: number;
}

export interface ExtensionSettings {
  enabled: boolean;
  retention: RetentionSettings;
  planner: PlannerSettings;
  protectedContext: ProtectedContextSettings;
  recall: RecallSettings;
  speculation: SpeculationSettings;
  debug: boolean;
}

export interface LoadedExtensionSettings {
  settings: ExtensionSettings;
  sources: string[];
  warnings: string[];
}

export interface VerbatimCompactionDetails {
  strategy: typeof STRATEGY;
  strategyVersion: 1;
  plannerProvider: string;
  plannerModel: string;
  sourceTokens: number;
  outputTokens: number;
  targetRetainedTokens: number;
  sourceLines: number;
  deletedLines: number;
  protectedLines: number;
  rangesProposed: number;
  rangesApplied: number;
  plannerLatencyMs: number;
  planSource: "foreground" | "speculative";
  reason: "manual" | "threshold" | "overflow";
  summaryDigest: string;
  protectedSummaryLines: number[];
  markerSummaryLines: number[];
  structureSummaryLines: number[];
}

export interface PlannerInput {
  transcript: Transcript;
  objective: string;
  targetRetainedTokens: number;
  customInstructions?: string;
}

export interface PlannerResult {
  ranges: InclusiveRange[];
  proposedCount: number;
  usage?: Usage;
  latencyMs: number;
  provider: string;
  model: string;
}

export interface CompactionSource {
  previousSummary?: string;
  messagesToSummarize: AgentMessage[];
  turnPrefixMessages: AgentMessage[];
}

export interface RuntimeCounters {
  compactions: number;
  fallbacks: number;
  plannerResponses: number;
  plannerInputTokens: number;
  plannerOutputTokens: number;
  plannerCostUsd: number;
  speculationGenerated: number;
  speculationHits: number;
  speculationStale: number;
  speculationErrors: number;
}

export interface RuntimeState {
  counters: RuntimeCounters;
  lastCompaction?: VerbatimCompactionDetails;
  currentObjective: string;
}
