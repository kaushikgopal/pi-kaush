// This file is intentionally self-contained: it imports only public Pi
// packages, never other modules in this extension, so it can be lifted into
// another extension (e.g. pi-tool-call-markers) as a single drop-in file.
// Keep it that way — put integration glue in extension.ts, not here.
import type {
  ExtensionAPI,
  SessionCompactEvent,
  Theme,
  ThemeColor,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import {
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

export const COMPACTION_LOG_TYPE = "verbatim-compaction-log";

export interface CompactionLogData {
  version: 1;
  kind: "verbatim" | "native" | "extension";
  /** Absent means the strategy succeeded. */
  status?: "failed" | "cancelled";
  reason?: "manual" | "threshold" | "overflow";
  willRetry?: boolean;
  tokensBefore?: number;
  outputTokens?: number;
  deletedLines?: number;
  rangesApplied?: number;
  rangesProposed?: number;
  protectedLines?: number;
  targetRetainedTokens?: number;
  plannerModel?: string;
  plannerLatencyMs?: number;
  planSource?: "foreground" | "speculative";
  plannerParseMode?: "tool" | "text-strict" | "text-recovered";
  plannerStopReason?: string;
  plannerOutputCharacters?: number;
  plannerOutputLines?: number;
  plannerRangeLikeLines?: number;
  plannerIgnoredLines?: number;
  summaryDigest?: string;
  summaryTokens?: number;
  strategyName?: string;
  errorMessage?: string;
}

// Structural mirror of VerbatimCompactionDetails, so this file stays free of
// project-local imports. extension.ts passes the real details object.
export type VerbatimLogDetailsLike = Pick<
  CompactionLogData,
  | "reason"
  | "deletedLines"
  | "rangesApplied"
  | "rangesProposed"
  | "protectedLines"
  | "targetRetainedTokens"
  | "plannerModel"
  | "plannerLatencyMs"
  | "plannerParseMode"
  | "planSource"
  | "summaryDigest"
> & {
  sourceTokens: number;
  outputTokens: number;
  plannerResponseDiagnostics?: {
    stopReason: string;
    outputCharacters: number;
    outputLines: number;
    rangeLikeLines: number;
    ignoredNonblankLines: number;
  };
};

export function verbatimLogData(
  details: VerbatimLogDetailsLike,
): CompactionLogData {
  return {
    version: 1,
    kind: "verbatim",
    reason: details.reason,
    tokensBefore: details.sourceTokens,
    outputTokens: details.outputTokens,
    deletedLines: details.deletedLines,
    rangesApplied: details.rangesApplied,
    rangesProposed: details.rangesProposed,
    protectedLines: details.protectedLines,
    targetRetainedTokens: details.targetRetainedTokens,
    plannerModel: details.plannerModel,
    plannerLatencyMs: details.plannerLatencyMs,
    planSource: details.planSource,
    plannerParseMode: details.plannerParseMode,
    plannerStopReason: details.plannerResponseDiagnostics?.stopReason,
    plannerOutputCharacters:
      details.plannerResponseDiagnostics?.outputCharacters,
    plannerOutputLines: details.plannerResponseDiagnostics?.outputLines,
    plannerRangeLikeLines: details.plannerResponseDiagnostics?.rangeLikeLines,
    plannerIgnoredLines:
      details.plannerResponseDiagnostics?.ignoredNonblankLines,
    summaryDigest: details.summaryDigest,
  };
}

export function verbatimFailedLogData(
  message: string,
  reason: CompactionLogData["reason"],
): CompactionLogData {
  return {
    version: 1,
    kind: "verbatim",
    status: "failed",
    ...(reason ? { reason } : {}),
    errorMessage: sanitizeAndBoundErrorMessage(message),
  };
}

export function nativeLogData(event: SessionCompactEvent): CompactionLogData {
  const details = event.compactionEntry.details;
  const strategyName =
    event.fromExtension &&
    details !== null &&
    typeof details === "object" &&
    !Array.isArray(details) &&
    typeof (details as { strategy?: unknown }).strategy === "string"
      ? (details as { strategy: string }).strategy.slice(0, 80)
      : undefined;
  return {
    version: 1,
    kind: event.fromExtension ? "extension" : "native",
    reason: event.reason,
    willRetry: event.willRetry,
    tokensBefore: event.compactionEntry.tokensBefore,
    summaryTokens: estimateSummaryTokens(event.compactionEntry.summary),
    ...(strategyName ? { strategyName } : {}),
  };
}

// Mirrors transcript.ts's estimateLineTokens, duplicated deliberately so this
// file has no project-local imports and stays drop-in portable.
function estimateSummaryTokens(text: string): number {
  return Math.max(1, Math.ceil(Buffer.byteLength(text, "utf8") / 4));
}

// Pi 0.84.3 fires this event but does not re-export its type from the package
// root, so keep the structural contract local.
export interface CompactionFailedEventLike {
  reason: "manual" | "threshold" | "overflow";
  willRetry: boolean;
  aborted: boolean;
  fromExtension: boolean;
  errorMessage?: string;
}

export function failedLogData(
  event: CompactionFailedEventLike,
): CompactionLogData {
  return {
    version: 1,
    kind: event.fromExtension ? "verbatim" : "native",
    status: event.aborted ? "cancelled" : "failed",
    reason: event.reason,
    willRetry: event.willRetry,
    ...(event.errorMessage
      ? { errorMessage: sanitizeAndBoundErrorMessage(event.errorMessage) }
      : {}),
  };
}

export function registerCompactionChatLog(pi: ExtensionAPI): void {
  pi.registerEntryRenderer(COMPACTION_LOG_TYPE, renderCompactionLogEntry);
}

export function appendCompactionLog(
  pi: ExtensionAPI,
  data: CompactionLogData,
): void {
  pi.appendEntry(COMPACTION_LOG_TYPE, data);
}

export function renderCompactionLogEntry(
  entry: { data?: unknown },
  options: { expanded: boolean },
  theme: Theme,
): Component | undefined {
  const data = parseCompactionLogData(entry.data);
  if (data === undefined) return undefined;
  return new CompactionLogComponent(data, options.expanded, theme);
}

function parseCompactionLogData(value: unknown): CompactionLogData | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const data = value as Partial<CompactionLogData>;
  if (
    data.version !== 1 ||
    (data.kind !== "verbatim" &&
      data.kind !== "native" &&
      data.kind !== "extension") ||
    (data.status !== undefined &&
      data.status !== "failed" &&
      data.status !== "cancelled")
  ) {
    return undefined;
  }
  return data as CompactionLogData;
}

// Geometry contract with tool-call rows (pi-tool-call-markers): the marker
// sits on the two-column transcript inset and body text starts two columns
// after it, sharing the text column used by grouped tool children.
// ≡ (identical-to) reads as a compressed stack of lines — the compaction
// metaphor — and stays visually distinct from the ─ header rule.
const OUTER_INSET = 2;
const RULE_WIDTH = 72;
const LOG_MARKER = "≡";
// Below this body width, wrapping a failure message is worse than cutting it.
const STATUS_WRAP_MIN_WIDTH = 20;
const MAX_ERROR_MESSAGE_CHARACTERS = 4_096;
const UNSAFE_ERROR_MESSAGE_CHARACTERS =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;

class CompactionLogComponent implements Component {
  constructor(
    private readonly data: CompactionLogData,
    private readonly expanded: boolean,
    private readonly theme: Theme,
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    const inset = width > OUTER_INSET * 2 ? OUTER_INSET : 0;
    const margin = " ".repeat(inset);
    const contentWidth = Math.max(1, width - inset);
    return [
      ...this.headerLine(contentWidth),
      ...this.bodyLines(contentWidth),
    ].map((line) => margin + truncateToWidth(line, contentWidth, "", false));
  }

  private headerLine(contentWidth: number): string[] {
    const accent = headerColor(this.data);
    const title = titleFor(this.data);
    const styled =
      `${this.theme.fg(accent, LOG_MARKER)} ` +
      this.theme.fg(accent, this.theme.bold(title));
    const used = 2 + visibleWidth(title);
    const ruleBudget = Math.min(contentWidth, RULE_WIDTH) - used - 1;
    if (ruleBudget < 3) return [styled];
    return [`${styled} ${this.theme.fg("dim", "─".repeat(ruleBudget))}`];
  }

  private bodyLines(contentWidth: number): string[] {
    const muted = (text: string) => this.theme.fg("muted", text);
    // Body rows sit two columns in from the header; that prefix consumes some
    // of the width available to status summaries and wrapped error messages.
    const bodyWidth = Math.max(1, contentWidth - 2);
    return bodyLinesFor(this.data, this.expanded, bodyWidth).map((line) =>
      muted(`  ${line}`),
    );
  }
}

function headerColor(data: CompactionLogData): ThemeColor {
  if (data.status === "failed") return "error";
  if (data.status === "cancelled") return "warning";
  return "toolTitle";
}

function titleFor(data: CompactionLogData): string {
  switch (data.kind) {
    case "verbatim":
      return "verbatim compaction";
    case "native":
      return "native compaction";
    case "extension":
      return data.strategyName !== undefined && data.strategyName.length > 0
        ? `${data.strategyName} compaction`
        : "extension compaction";
  }
}

function bodyLinesFor(
  data: CompactionLogData,
  expanded: boolean,
  width: number,
): string[] {
  // A failed or cancelled card reports only its own outcome — the strategy
  // never ran to completion, so there are no metrics to show.
  if (data.status !== undefined) return statusBodyLines(data, expanded, width);
  switch (data.kind) {
    case "verbatim":
      return verbatimBodyLines(data, expanded);
    case "native":
    case "extension":
      return nativeBodyLines(data, expanded);
  }
}

function verbatimBodyLines(
  data: CompactionLogData,
  expanded: boolean,
): string[] {
  const lines = [
    `${formatCount(data.tokensBefore)} → ${formatCount(data.outputTokens)} tokens (${retainedPercent(data)}% kept) · ${formatCount(data.deletedLines)} lines removed`,
    `${formatCount(data.protectedLines)} pinned ${plural(data.protectedLines, "line")} · ${data.plannerModel ?? "unknown planner"} · ${formatLatency(data.plannerLatencyMs)} · ${data.planSource ?? "foreground"}`,
  ];
  if (expanded) {
    lines.push(
      `target ≤ ${formatCount(data.targetRetainedTokens)} tokens · ${formatCount(data.rangesProposed)} ranges proposed · digest ${(data.summaryDigest ?? "").slice(0, 12)}`,
      `planner response: ${data.plannerParseMode ?? "unknown"} · ${data.plannerStopReason ?? "unknown stop"} · ${formatCount(data.plannerOutputCharacters)} chars / ${formatCount(data.plannerOutputLines)} lines${typeof data.plannerIgnoredLines === "number" && data.plannerIgnoredLines > 0 ? ` · ${formatCount(data.plannerIgnoredLines)} wrapper lines ignored` : ""}`,
    );
  }
  return lines;
}

function nativeBodyLines(data: CompactionLogData, expanded: boolean): string[] {
  const lines = [
    `${formatCount(data.tokensBefore)} → ~${formatCount(data.summaryTokens)} tokens · ${reasonLabel(data.reason)}${data.willRetry === true ? " · retrying turn" : ""}`,
  ];
  if (expanded && data.strategyName !== undefined) {
    lines.push(`strategy: ${data.strategyName}`);
  }
  return lines;
}

// Failure cards keep to a readable slice of the message when collapsed;
// Ctrl+O (expanded) reveals the bounded message, wrapped so it stays on-card.
function statusBodyLines(
  data: CompactionLogData,
  expanded: boolean,
  width: number,
): string[] {
  const summary = statusSummary(data);
  const message = data.errorMessage
    ? sanitizeAndBoundErrorMessage(data.errorMessage)
    : undefined;
  if (message === undefined || message.length === 0) return [summary];
  if (!expanded || width < STATUS_WRAP_MIN_WIDTH) {
    return [fitStatusLine(`${summary} · ${message}`, width)];
  }
  return [summary, ...wrapTextWithAnsi(message, width)];
}

function statusSummary(data: CompactionLogData): string {
  const parts: string[] = [reasonLabel(data.reason)];
  if (data.status === "cancelled") parts.push("cancelled");
  if (data.willRetry === true) parts.push("turn retry expected");
  return parts.join(" · ");
}

// Collapsed failure lines end in an ellipsis (not a hard cut at the card
// edge), so the marker signals that Ctrl+O reveals the rest.
function fitStatusLine(text: string, width: number): string {
  if (visibleWidth(text) <= width) return text;
  if (width <= 1) return truncateToWidth(text, width, "", false);
  return `${truncateToWidth(text, width - 1, "", false)}…`;
}

function sanitizeAndBoundErrorMessage(message: string): string {
  const sanitized = message.replace(UNSAFE_ERROR_MESSAGE_CHARACTERS, "�");
  if (sanitized.length <= MAX_ERROR_MESSAGE_CHARACTERS) return sanitized;
  return `${sanitized.slice(0, MAX_ERROR_MESSAGE_CHARACTERS - 1)}…`;
}

function retainedPercent(data: CompactionLogData): string {
  if (
    typeof data.tokensBefore !== "number" ||
    typeof data.outputTokens !== "number" ||
    data.tokensBefore <= 0
  ) {
    return "?";
  }
  return ((data.outputTokens / data.tokensBefore) * 100)
    .toFixed(1)
    .replace(/\.0$/, "");
}

function reasonLabel(reason: CompactionLogData["reason"] | undefined): string {
  if (reason === "threshold") return "auto (context full)";
  if (reason === "overflow") return "auto (overflow)";
  return "manual";
}

function formatCount(value: number | undefined): string {
  return typeof value === "number" ? value.toLocaleString("en-US") : "?";
}

function formatLatency(ms: number | undefined): string {
  if (typeof ms !== "number") return "?";
  return ms >= 1_000 ? `${(ms / 1_000).toFixed(1)}s` : `${ms}ms`;
}

function plural(count: number | undefined, noun: string): string {
  return count === 1 ? noun : `${noun}s`;
}
