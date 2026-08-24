import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  ExtensionAPI,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ExtensionSettings } from "./types.ts";

interface SearchChunk {
  entryId: string;
  label: string;
  text: string;
}

interface RecallMatch {
  entryId: string;
  label: string;
  excerpt: string;
}

const MAX_QUERY_CHARACTERS = 256;
const MAX_SCANNED_ENTRIES = 10_000;
const MAX_SCANNED_CHARACTERS = 2_000_000;
const MAX_CHUNKS_PER_ENTRY = 1_024;
const MAX_LABEL_CHARACTERS = 120;
const MAX_JSON_CHARACTERS = 16_000;
const MAX_JSON_NODES = 2_048;
const MAX_JSON_SOURCE_CHARACTERS = 2_000;

export function registerRecallTool(
  pi: ExtensionAPI,
  getSettings: () => ExtensionSettings,
): void {
  pi.registerTool({
    name: "verbatim_recall_history",
    label: "Verbatim Recall History",
    description:
      "Search the current branch's original uncompacted session history for an exact phrase, path, symbol, error, command, or other substring. Returns bounded verbatim excerpts. Assistant thinking, excluded bash history, and binary image data are excluded.",
    promptSnippet:
      "Search original session history for exact evidence removed from active context",
    promptGuidelines: [
      "Use verbatim_recall_history when exact older evidence may have been removed by compaction; search for a distinctive path, symbol, error, command, or phrase.",
    ],
    parameters: Type.Object({
      query: Type.String({
        minLength: 1,
        maxLength: MAX_QUERY_CHARACTERS,
        description: "Exact substring to find",
      }),
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 50,
          description: "Maximum excerpts",
        }),
      ),
      caseSensitive: Type.Optional(
        Type.Boolean({ description: "Match letter case exactly" }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const settings = getSettings().recall;
      if (!settings.enabled) {
        return {
          content: [
            {
              type: "text",
              text: "Historical recall is disabled in verbatimCompaction settings.",
            },
          ],
          details: { matches: 0, disabled: true },
        };
      }
      signal?.throwIfAborted();
      const limit = Math.min(
        params.limit ?? settings.maxResults,
        settings.maxResults,
      );
      const matches = searchSessionHistory(
        ctx.sessionManager.getBranch(),
        params.query,
        {
          limit,
          maxCharacters: settings.maxCharacters,
          caseSensitive: params.caseSensitive === true,
          signal,
        },
      );
      signal?.throwIfAborted();
      const text =
        matches.length === 0
          ? `No historical matches for: ${params.query}`
          : formatMatches(
              matches,
              settings.maxCharacters,
              params.query,
              params.caseSensitive === true,
            );
      return {
        content: [{ type: "text", text }],
        details: { matches: matches.length, queryLength: params.query.length },
      };
    },
  });
}

export function searchSessionHistory(
  entries: readonly SessionEntry[],
  query: string,
  options: {
    limit: number;
    maxCharacters: number;
    caseSensitive?: boolean;
    signal?: AbortSignal;
  },
): RecallMatch[] {
  if (
    query.length === 0 ||
    query.length > MAX_QUERY_CHARACTERS ||
    options.limit <= 0 ||
    options.maxCharacters <= 0
  ) {
    return [];
  }
  const findSubstring = createSubstringFinder(
    query,
    options.caseSensitive === true,
  );
  const results: RecallMatch[] = [];
  let remaining = options.maxCharacters;
  let scannedCharacters = 0;
  let scannedEntries = 0;
  outer: for (const entry of entries) {
    options.signal?.throwIfAborted();
    if (scannedEntries >= MAX_SCANNED_ENTRIES) break;
    scannedEntries += 1;
    for (const chunk of entryToChunks(entry)) {
      const available = MAX_SCANNED_CHARACTERS - scannedCharacters;
      if (available <= 0) break outer;
      const searchableText = chunk.text.slice(0, available);
      scannedCharacters += searchableText.length;
      let offset = 0;
      while (
        results.length < options.limit &&
        remaining >= Math.max(1, query.length)
      ) {
        const match = findSubstring(searchableText, offset);
        if (match === undefined) break;
        const excerpt = excerptAround(
          searchableText,
          match.index,
          match.length,
          Math.min(2_000, remaining),
        );
        results.push({
          entryId: safeLabel(chunk.entryId),
          label: safeLabel(chunk.label),
          excerpt,
        });
        remaining -= excerpt.length;
        offset = match.index + Math.max(1, match.length);
      }
      if (results.length >= options.limit || remaining <= 0) break outer;
    }
  }
  return results;
}

function entryToChunks(entry: SessionEntry): SearchChunk[] {
  const record = entry as unknown as Record<string, unknown> & {
    id?: string;
    type?: string;
  };
  const entryId = safeLabel(
    typeof record.id === "string" ? record.id : "unknown",
  );
  if (entry.type === "message") {
    return messageToChunks(entryId, entry.message);
  }
  if (entry.type === "compaction") {
    return [{ entryId, label: "compaction", text: entry.summary }];
  }
  if (entry.type === "branch_summary") {
    return [{ entryId, label: "branch summary", text: entry.summary }];
  }
  if (entry.type === "custom_message") {
    return contentChunks(
      entryId,
      `custom:${safeLabel(entry.customType)}`,
      entry.content,
    );
  }
  return [];
}

function messageToChunks(
  entryId: string,
  message: AgentMessage,
): SearchChunk[] {
  const record = message as unknown as Record<string, unknown> & {
    role?: string;
  };
  if (record.role === "assistant") {
    const chunks: SearchChunk[] = [];
    const content = Array.isArray(record.content) ? record.content : [];
    for (const part of (content as Array<Record<string, unknown>>).slice(
      0,
      MAX_CHUNKS_PER_ENTRY,
    )) {
      if (part.type === "text" && typeof part.text === "string") {
        chunks.push({ entryId, label: "assistant", text: part.text });
      } else if (part.type === "toolCall" && typeof part.name === "string") {
        const name = safeLabel(part.name);
        chunks.push({
          entryId,
          label: `tool call:${name}`,
          text: `${name} ${safeJson(part.arguments)}`,
        });
      }
    }
    if (typeof record.errorMessage === "string") {
      chunks.push({
        entryId,
        label: "assistant error",
        text: record.errorMessage,
      });
    }
    return chunks;
  }
  if (record.role === "toolResult") {
    return contentChunks(
      entryId,
      `tool result:${safeLabel(
        typeof record.toolName === "string" ? record.toolName : "unknown",
      )}`,
      record.content,
    );
  }
  if (record.role === "bashExecution") {
    if (record.excludeFromContext === true) return [];
    return [
      ...(typeof record.command === "string"
        ? [{ entryId, label: "bash command", text: record.command }]
        : []),
      ...(typeof record.output === "string"
        ? [{ entryId, label: "bash output", text: record.output }]
        : []),
    ];
  }
  const role = safeLabel(record.role ?? "message");
  const chunks = contentChunks(entryId, role, record.content);
  if (chunks.length > 0) return chunks;
  const summary = typeof record.summary === "string" ? record.summary : "";
  return summary.length > 0 ? [{ entryId, label: role, text: summary }] : [];
}

function contentChunks(
  entryId: string,
  label: string,
  content: unknown,
): SearchChunk[] {
  const safe = safeLabel(label);
  if (typeof content === "string")
    return [{ entryId, label: safe, text: content }];
  if (!Array.isArray(content)) return [];
  const chunks: SearchChunk[] = [];
  for (const part of content.slice(0, MAX_CHUNKS_PER_ENTRY)) {
    if (
      part !== null &&
      typeof part === "object" &&
      (part as { type?: unknown }).type === "text" &&
      typeof (part as { text?: unknown }).text === "string"
    ) {
      chunks.push({
        entryId,
        label: safe,
        text: (part as { text: string }).text,
      });
    }
  }
  return chunks;
}

function excerptAround(
  text: string,
  matchAt: number,
  matchLength: number,
  maximum: number,
): string {
  const lines = text.split("\n");
  let offset = 0;
  let matchLine = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const end = offset + (lines[index]?.length ?? 0) + 1;
    if (matchAt < end) {
      matchLine = index;
      break;
    }
    offset = end;
  }
  const from = Math.max(0, matchLine - 2);
  const to = Math.min(lines.length, matchLine + 3);
  const windowStart = lines
    .slice(0, from)
    .reduce((length, line) => length + line.length + 1, 0);
  const windowText = lines.slice(from, to).join("\n");
  if (windowText.length <= maximum) return windowText;

  const localMatch = Math.max(0, matchAt - windowStart);
  const half = Math.floor((maximum - Math.min(matchLength, maximum)) / 2);
  const start = Math.max(0, localMatch - half);
  return windowText.slice(start, start + maximum);
}

function formatMatches(
  matches: readonly RecallMatch[],
  maximum: number,
  query: string,
  caseSensitive: boolean,
): string {
  let output = "";
  const findSubstring = createSubstringFinder(query, caseSensitive);
  for (const [index, match] of matches.entries()) {
    const separator = output.length === 0 ? "" : "\n\n---\n\n";
    const header = `Match ${index + 1} — ${safeLabel(match.label)} (${safeLabel(match.entryId)})\n`;
    const available =
      maximum - output.length - separator.length - header.length;
    if (available < query.length) break;
    const found = findSubstring(match.excerpt, 0);
    if (found === undefined) continue;
    const excerpt = excerptAround(
      match.excerpt,
      found.index,
      found.length,
      available,
    );
    output += `${separator}${header}${excerpt}`;
  }
  return output;
}

function safeJson(value: unknown): string {
  try {
    const budget = {
      remaining: MAX_JSON_SOURCE_CHARACTERS,
      nodes: MAX_JSON_NODES,
    };
    const normalized = boundedJsonValue(value, budget, new WeakSet());
    const encoded = JSON.stringify(normalized) ?? "";
    if (encoded.length <= MAX_JSON_CHARACTERS) return encoded;
    let preview = encoded.slice(0, Math.floor(MAX_JSON_CHARACTERS / 4));
    let fallback = JSON.stringify({ preview, truncated: true });
    while (fallback.length > MAX_JSON_CHARACTERS && preview.length > 0) {
      preview = preview.slice(0, Math.floor(preview.length / 2));
      fallback = JSON.stringify({ preview, truncated: true });
    }
    return fallback;
  } catch {
    return JSON.stringify("[unserializable arguments]");
  }
}

function boundedJsonValue(
  value: unknown,
  budget: { remaining: number; nodes: number },
  ancestors: WeakSet<object>,
): unknown {
  if (budget.remaining <= 0 || budget.nodes <= 0) return "[truncated]";
  budget.nodes -= 1;
  if (typeof value === "string") {
    const kept = value.slice(0, budget.remaining);
    budget.remaining -= kept.length;
    return kept.length === value.length ? kept : `${kept}…[truncated]`;
  }
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return value;
  }
  if (typeof value === "bigint") return `${value}n`;
  if (typeof value !== "object") return null;
  if (ancestors.has(value)) return "[cycle]";
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const result: unknown[] = [];
      for (const item of value) {
        if (
          result.length >= 256 ||
          budget.remaining <= 0 ||
          budget.nodes <= 0
        ) {
          result.push("[truncated]");
          break;
        }
        result.push(boundedJsonValue(item, budget, ancestors));
      }
      return result;
    }
    const result: Record<string, unknown> = Object.create(null);
    let entries = 0;
    for (const key in value as Record<string, unknown>) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      if (entries >= 256 || budget.remaining <= 0 || budget.nodes <= 0) {
        result["[truncated]"] = true;
        break;
      }
      const safeKey = key.slice(0, 128);
      budget.remaining -= Math.min(budget.remaining, safeKey.length);
      result[safeKey] = boundedJsonValue(
        (value as Record<string, unknown>)[key],
        budget,
        ancestors,
      );
      entries += 1;
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

function safeLabel(value: unknown): string {
  const label = typeof value === "string" ? value : String(value);
  return label
    .replaceAll(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replaceAll(/\s+/g, " ")
    .slice(0, MAX_LABEL_CHARACTERS);
}

function createSubstringFinder(
  query: string,
  caseSensitive: boolean,
): (
  text: string,
  offset: number,
) => { index: number; length: number } | undefined {
  if (caseSensitive) {
    return (text, offset) => {
      const index = text.indexOf(query, offset);
      return index < 0 ? undefined : { index, length: query.length };
    };
  }
  const expression = new RegExp(escapeRegExp(query), "giu");
  return (text, offset) => {
    expression.lastIndex = offset;
    const match = expression.exec(text);
    return match === null
      ? undefined
      : { index: match.index, length: match[0].length };
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
