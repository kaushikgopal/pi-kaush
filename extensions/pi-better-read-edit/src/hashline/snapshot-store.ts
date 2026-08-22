import {
  decodeEligibleText,
  type HashlineRecord,
  type LineEnding,
  type LogicalDocument,
} from "./contract.ts";

export type HashlineSnapshot = {
  canonicalPath: string;
  fullDigest: string;
  logicalText: string;
  lineEnding: LineEnding;
  finalNewline: boolean;
  lineCount: number;
  recordedAt: number;
};

export type SnapshotStoreOptions = {
  maxPaths?: number;
  maxVersionsPerPath?: number;
  maxTotalBytes?: number;
};

const DEFAULT_MAX_PATHS = 30;
const DEFAULT_MAX_VERSIONS_PER_PATH = 4;
const DEFAULT_MAX_TOTAL_BYTES = 64 * 1024 * 1024;

function snapshotBytes(snapshot: HashlineSnapshot): number {
  return Buffer.byteLength(snapshot.logicalText, "utf8");
}

function snapshotDocument(snapshot: HashlineSnapshot): LogicalDocument {
  const decoded = decodeEligibleText(Buffer.from(snapshot.logicalText, "utf8"));
  return { ...decoded, lineEnding: snapshot.lineEnding };
}

/**
 * Bounded full-text history for one extension runtime. Pi creates a fresh
 * extension instance for session replacement and reload, so retained text
 * never authorizes another live session.
 */
export class HashlineSnapshotStore {
  private readonly histories = new Map<string, HashlineSnapshot[]>();
  private readonly maxPaths: number;
  private readonly maxVersionsPerPath: number;
  private readonly maxTotalBytes: number;
  private totalBytes = 0;

  constructor(options: SnapshotStoreOptions = {}) {
    this.maxPaths = options.maxPaths ?? DEFAULT_MAX_PATHS;
    this.maxVersionsPerPath =
      options.maxVersionsPerPath ?? DEFAULT_MAX_VERSIONS_PER_PATH;
    this.maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  }

  record(record: HashlineRecord, document: LogicalDocument): void {
    const path = record.canonicalPath;
    const history = this.histories.get(path) ?? [];
    const existing = history.find(
      (snapshot) =>
        snapshot.fullDigest === record.fullDigest &&
        snapshot.logicalText === document.logicalText &&
        snapshot.lineEnding === document.lineEnding,
    );
    if (existing) {
      existing.recordedAt = Date.now();
      this.histories.delete(path);
      this.histories.set(path, [
        existing,
        ...history.filter((snapshot) => snapshot !== existing),
      ]);
      return;
    }

    const snapshot: HashlineSnapshot = {
      canonicalPath: path,
      fullDigest: record.fullDigest,
      logicalText: document.logicalText,
      lineEnding: document.lineEnding,
      finalNewline: document.finalNewline,
      lineCount: document.lines.length,
      recordedAt: Date.now(),
    };
    const next = [snapshot, ...history].slice(0, this.maxVersionsPerPath);
    this.replaceHistory(path, next);
    this.evictToLimits();
  }

  lookup(
    record: HashlineRecord,
  ): { snapshot: HashlineSnapshot; document: LogicalDocument } | undefined {
    const history = this.histories.get(record.canonicalPath);
    const matches = history?.filter(
      (snapshot) =>
        snapshot.fullDigest === record.fullDigest &&
        snapshot.lineEnding === record.lineEnding &&
        snapshot.finalNewline === record.finalNewline &&
        snapshot.lineCount === record.lineCount,
    );
    if (!matches || matches.length !== 1) return undefined;
    this.histories.delete(record.canonicalPath);
    this.histories.set(record.canonicalPath, history!);
    return {
      snapshot: { ...matches[0]! },
      document: snapshotDocument(matches[0]!),
    };
  }

  clear(): void {
    this.histories.clear();
    this.totalBytes = 0;
  }

  private replaceHistory(path: string, history: HashlineSnapshot[]): void {
    const previous = this.histories.get(path) ?? [];
    this.totalBytes -= previous.reduce(
      (total, snapshot) => total + snapshotBytes(snapshot),
      0,
    );
    this.histories.delete(path);
    this.histories.set(path, history);
    this.totalBytes += history.reduce(
      (total, snapshot) => total + snapshotBytes(snapshot),
      0,
    );
  }

  private evictToLimits(): void {
    while (
      this.histories.size > this.maxPaths ||
      this.totalBytes > this.maxTotalBytes
    ) {
      const oldestPath = this.histories.keys().next().value as
        | string
        | undefined;
      if (!oldestPath) break;
      this.replaceHistory(oldestPath, []);
      this.histories.delete(oldestPath);
    }
  }
}
