import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  mergeRanges,
  normalizeHashlineRecord,
  type HashlineRecord,
  type LineRange,
} from "./contract.ts";

type StoredRecord = {
  record: HashlineRecord;
  seenRanges: LineRange[];
  eofSeen: boolean;
};

function anchorsFromDetails(details: unknown): HashlineRecord[] {
  if (typeof details !== "object" || details === null) return [];
  const value = details as Record<string, unknown>;
  const candidates = [
    value.hashlineAnchor,
    ...(Array.isArray(value.hashlineAnchors) ? value.hashlineAnchors : []),
  ];
  return candidates
    .map(normalizeHashlineRecord)
    .filter((record): record is HashlineRecord => record !== undefined);
}

function toolResultFromEntry(
  entry: SessionEntry,
): { isError?: boolean; details?: unknown } | undefined {
  if (entry.type !== "message") return undefined;
  const message = entry.message as unknown;
  if (typeof message !== "object" || message === null) return undefined;
  const result = message as {
    role?: string;
    toolName?: string;
    isError?: boolean;
    details?: unknown;
  };
  if (
    result.role !== "toolResult" ||
    (result.toolName !== "read" && result.toolName !== "edit")
  ) {
    return undefined;
  }
  return result.isError === false ? result : undefined;
}

function recordIdentity(record: HashlineRecord): string {
  return `${record.fullDigest}:${record.lineEnding}:${record.finalNewline ? "1" : "0"}:${record.lineCount}`;
}

export class HashlineRegistry {
  private readonly byPath = new Map<
    string,
    Map<string, Map<string, StoredRecord>>
  >();

  static fromBranch(
    branch: readonly SessionEntry[] | undefined,
  ): HashlineRegistry {
    const registry = new HashlineRegistry();
    for (const entry of branch ?? []) {
      const result = toolResultFromEntry(entry);
      if (!result || result.isError) continue;
      registry.addDetails(result.details);
    }
    return registry;
  }

  addDetails(details: unknown): void {
    for (const record of anchorsFromDetails(details)) this.add(record);
  }

  add(record: HashlineRecord): void {
    let byTag = this.byPath.get(record.canonicalPath);
    if (!byTag) {
      byTag = new Map();
      this.byPath.set(record.canonicalPath, byTag);
    }
    let byDigest = byTag.get(record.tag);
    if (!byDigest) {
      byDigest = new Map();
      byTag.set(record.tag, byDigest);
    }
    const identity = recordIdentity(record);
    const existing = byDigest.get(identity);
    if (existing) {
      existing.seenRanges = mergeRanges([
        ...existing.seenRanges,
        ...record.seenRanges,
      ]);
      existing.eofSeen ||= record.eofSeen;
      existing.record = { ...record };
      return;
    }
    byDigest.set(identity, {
      record: {
        ...record,
        seenRanges: record.seenRanges.map((range) => ({ ...range })),
      },
      seenRanges: record.seenRanges.map((range) => ({ ...range })),
      eofSeen: record.eofSeen,
    });
  }

  lookup(
    canonicalPath: string,
    tag: string,
    live?: Pick<
      HashlineRecord,
      "fullDigest" | "lineEnding" | "finalNewline" | "lineCount"
    >,
  ):
    | { record: HashlineRecord; seenRanges: LineRange[]; eofSeen: boolean }
    | { ambiguous: number }
    | undefined {
    const records = this.byPath.get(canonicalPath)?.get(tag);
    if (!records || records.size === 0) return undefined;
    const matching = live
      ? records.get(
          `${live.fullDigest}:${live.lineEnding}:${live.finalNewline ? "1" : "0"}:${live.lineCount}`,
        )
      : undefined;
    if (matching) {
      return {
        record: { ...matching.record },
        seenRanges: matching.seenRanges.map((range) => ({ ...range })),
        eofSeen: matching.eofSeen,
      };
    }
    if (records.size > 1) return { ambiguous: records.size };
    const stored = records.values().next().value as StoredRecord;
    return {
      record: { ...stored.record },
      seenRanges: stored.seenRanges.map((range) => ({ ...range })),
      eofSeen: stored.eofSeen,
    };
  }
}

export function recordsInDetails(details: unknown): HashlineRecord[] {
  return anchorsFromDetails(details);
}
