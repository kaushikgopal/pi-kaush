import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { createRuntimeHeaders } from "./compact-client";
import {
  findEntriesStrictlyAfterCompactionBoundary,
  serializeLiveTailToResponsesInput,
} from "./payload-rewrite";
import type { NativeCompactionRuntime } from "./runtime";
import {
  isNativeCompactionDetails,
  NATIVE_COMPACTION_SHIM_SUMMARY,
  type NativeCompactionDetails,
  type NativeCompactionEntry,
} from "./types";

export const PORTABLE_SUMMARY_ENTRY_TYPE =
  "openai-native-compaction-portable-summary";
export const PORTABLE_SUMMARY_MESSAGE_TYPE =
  "openai-native-compaction-portable-context";
const PORTABLE_SUMMARY_VERSION = 1;
const REQUEST_TIMEOUT_MS = 60_000;
const SUMMARY_INSTRUCTIONS = `Create a concise structured checkpoint for another coding model to continue this conversation. Return only the checkpoint. Include the current goal, completed work, material decisions and rationale, changed files, commands and test results, unresolved blockers, next steps, and critical context. Preserve exact names and paths when they matter. Do not continue the task.`;

export type PortableSummaryState = {
  version: typeof PORTABLE_SUMMARY_VERSION;
  sourceCompactionEntryId: string;
  source: Pick<
    NativeCompactionDetails,
    "provider" | "api" | "model" | "baseUrl"
  >;
  summary: string;
  createdAt: string;
  usage?: Record<string, number>;
};

export type PortableSummaryResult =
  | { ok: true; state: PortableSummaryState }
  | {
      ok: false;
      reason:
        | "invalid-checkpoint"
        | "network-error"
        | "non-2xx"
        | "malformed-response"
        | "empty-summary";
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isPortableSummaryState(value: unknown): value is PortableSummaryState {
  if (!isRecord(value) || !isRecord(value.source)) return false;
  return (
    value.version === PORTABLE_SUMMARY_VERSION &&
    typeof value.sourceCompactionEntryId === "string" &&
    value.sourceCompactionEntryId.length > 0 &&
    typeof value.summary === "string" &&
    value.summary.trim().length > 0 &&
    typeof value.createdAt === "string" &&
    typeof value.source.provider === "string" &&
    typeof value.source.api === "string" &&
    typeof value.source.model === "string" &&
    typeof value.source.baseUrl === "string"
  );
}

function latestCompactionEntry(
  entries: readonly SessionEntry[],
): { entry: SessionEntry; index: number } | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    if (entries[index]?.type === "compaction")
      return { entry: entries[index]!, index };
  }
  return undefined;
}

export function findActivePortableSummary(
  entries: readonly SessionEntry[],
): PortableSummaryState | undefined {
  return findActivePortableSummaryEntry(entries)?.state;
}

export function findActivePortableSummaryEntry(
  entries: readonly SessionEntry[],
):
  | { state: PortableSummaryState; entryId: string; contextVisible: boolean }
  | undefined {
  const latestCompaction = latestCompactionEntry(entries);
  if (!latestCompaction || latestCompaction.entry.type !== "compaction")
    return undefined;
  if (!isNativeCompactionDetails(latestCompaction.entry.details))
    return undefined;

  for (
    let index = entries.length - 1;
    index > latestCompaction.index;
    index--
  ) {
    const entry = entries[index];
    const state =
      entry?.type === "custom" &&
      entry.customType === PORTABLE_SUMMARY_ENTRY_TYPE
        ? entry.data
        : entry?.type === "custom_message" &&
            entry.customType === PORTABLE_SUMMARY_MESSAGE_TYPE
          ? entry.details
          : undefined;
    if (!isPortableSummaryState(state)) continue;
    if (state.sourceCompactionEntryId === latestCompaction.entry.id) {
      return {
        state,
        entryId: entry.id,
        contextVisible: entry.type === "custom_message",
      };
    }
  }
  return undefined;
}

export function hasActivePortableSummary(
  entries: readonly SessionEntry[],
): boolean {
  return findActivePortableSummary(entries) !== undefined;
}

export function projectPortableSummary(
  messages: readonly AgentMessage[],
  entries: readonly SessionEntry[],
): AgentMessage[] {
  const portable = findActivePortableSummaryEntry(entries);
  if (!portable) return [...messages];
  if (portable.contextVisible) {
    return messages.filter(
      (message) =>
        message.role !== "compactionSummary" ||
        message.summary !== NATIVE_COMPACTION_SHIM_SUMMARY,
    );
  }
  return messages.map((message) => {
    if (
      message.role !== "compactionSummary" ||
      message.summary !== NATIVE_COMPACTION_SHIM_SUMMARY
    )
      return message;
    return { ...message, summary: portable.state.summary };
  });
}

function buildResponsesUrl(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, "");
  return normalized.endsWith("/responses")
    ? normalized
    : `${normalized}/responses`;
}

function extractSummary(output: unknown): string | undefined {
  if (!Array.isArray(output)) return undefined;
  const text = output
    .flatMap((item) =>
      isRecord(item) && Array.isArray(item.content) ? item.content : [],
    )
    .filter(isRecord)
    .filter(
      (item) => item.type === "output_text" && typeof item.text === "string",
    )
    .map((item) => item.text as string)
    .join("\n")
    .trim();
  return text || undefined;
}

function sanitizeUsage(value: unknown): Record<string, number> | undefined {
  if (!isRecord(value)) return undefined;
  const usage = Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, number] =>
        typeof entry[1] === "number" && Number.isFinite(entry[1]),
    ),
  );
  return Object.keys(usage).length > 0 ? usage : undefined;
}

export async function createPortableSummary<TApi extends Api>(args: {
  runtime: NativeCompactionRuntime;
  model: Model<TApi>;
  compactionEntry: NativeCompactionEntry;
  branchEntries: readonly SessionEntry[];
  includeTail?: boolean;
  signal?: AbortSignal;
}): Promise<PortableSummaryResult> {
  const details = args.compactionEntry.details;
  const tail = findEntriesStrictlyAfterCompactionBoundary(
    args.branchEntries,
    args.compactionEntry.id,
  );
  if (!isNativeCompactionDetails(details) || !tail)
    return { ok: false, reason: "invalid-checkpoint" };

  const input = [
    ...details.compactedWindow.map((item) => structuredClone(item)),
    ...(args.includeTail
      ? serializeLiveTailToResponsesInput({ model: args.model, entries: tail })
      : []),
  ];

  let response: Response;
  try {
    const requestSignal = args.signal
      ? AbortSignal.any([args.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
      : AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    response = await fetch(buildResponsesUrl(args.runtime.baseUrl), {
      method: "POST",
      headers: createRuntimeHeaders(args.runtime),
      body: JSON.stringify({
        model: args.model.id,
        store: false,
        stream: false,
        reasoning: { effort: "low" },
        text: { verbosity: "low" },
        instructions: SUMMARY_INSTRUCTIONS,
        input,
      }),
      signal: requestSignal,
    });
  } catch {
    return { ok: false, reason: "network-error" };
  }
  if (!response.ok) return { ok: false, reason: "non-2xx" };

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return { ok: false, reason: "malformed-response" };
  }
  if (
    !isRecord(parsed) ||
    parsed.object !== "response" ||
    parsed.status !== "completed"
  ) {
    return { ok: false, reason: "malformed-response" };
  }
  const summary = extractSummary(parsed.output);
  if (!summary) return { ok: false, reason: "empty-summary" };

  return {
    ok: true,
    state: {
      version: PORTABLE_SUMMARY_VERSION,
      sourceCompactionEntryId: args.compactionEntry.id,
      source: {
        provider: details.provider,
        api: details.api,
        model: details.model,
        baseUrl: details.baseUrl,
      },
      summary,
      createdAt: new Date().toISOString(),
      usage: sanitizeUsage(parsed.usage),
    },
  };
}
