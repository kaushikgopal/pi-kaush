import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export const SUBAGENT_TRACE_PREVIEW_BYTES = 64 * 1024;
export const SUBAGENT_OUTPUT_PREVIEW_BYTES = 64 * 1024;
export const SUBAGENT_STDERR_PREVIEW_BYTES = 32 * 1024;

export interface TranscriptMetadata {
  rootSessionId: string;
  parentSessionId: string;
  parentToolCallId: string;
  depth: number;
  agent: string;
  task: string;
}

export interface TranscriptArtifact {
  readonly path?: string | undefined;
  readonly error?: string | undefined;
  append(stream: "stdout" | "stderr", data: string): boolean;
  resumeWhenWritable(callback: () => void): void;
  close(exitCode: number): Promise<void>;
}

class JsonlTranscriptArtifact implements TranscriptArtifact {
  readonly path: string;
  private readonly stream: fs.WriteStream;
  private streamError?: string;
  private closePromise?: Promise<void>;

  constructor(filePath: string, fd: number, metadata: TranscriptMetadata) {
    this.path = filePath;
    this.stream = fs.createWriteStream(filePath, { fd, autoClose: true });
    this.stream.on("error", (error) => {
      this.streamError = error.message;
    });
    this.stream.write(
      `${JSON.stringify({ record: "header", version: 1, createdAt: new Date().toISOString(), ...metadata })}\n`,
    );
  }

  get error(): string | undefined {
    return this.streamError;
  }

  append(stream: "stdout" | "stderr", data: string): boolean {
    if (this.streamError || this.stream.destroyed) return true;
    return this.stream.write(
      `${JSON.stringify({ record: "stream", at: Date.now(), stream, data })}\n`,
    );
  }

  resumeWhenWritable(callback: () => void): void {
    if (
      this.streamError ||
      this.stream.destroyed ||
      !this.stream.writableNeedDrain
    ) {
      queueMicrotask(callback);
      return;
    }
    let resumed = false;
    const resume = () => {
      if (resumed) return;
      resumed = true;
      this.stream.off("drain", resume);
      this.stream.off("error", resume);
      callback();
    };
    this.stream.once("drain", resume);
    this.stream.once("error", resume);
  }

  close(exitCode: number): Promise<void> {
    if (this.closePromise) return this.closePromise;
    if (this.stream.destroyed) return Promise.resolve();
    this.closePromise = new Promise((resolve) => {
      let resolved = false;
      const done = () => {
        if (resolved) return;
        resolved = true;
        this.stream.off("close", done);
        this.stream.off("error", done);
        resolve();
      };
      this.stream.once("close", done);
      this.stream.once("error", done);
      this.stream.end(
        `${JSON.stringify({ record: "footer", completedAt: new Date().toISOString(), exitCode })}\n`,
      );
    });
    return this.closePromise;
  }
}

class UnavailableTranscriptArtifact implements TranscriptArtifact {
  readonly path = undefined;
  constructor(readonly error: string) {}
  append(): boolean {
    return true;
  }
  resumeWhenWritable(callback: () => void): void {
    queueMicrotask(callback);
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

export function createTranscriptArtifact(
  agentDir: string,
  metadata: TranscriptMetadata,
): TranscriptArtifact {
  try {
    const rootKey = createHash("sha256")
      .update(metadata.rootSessionId)
      .digest("hex")
      .slice(0, 16);
    const runsDir = path.join(agentDir, "subagent-runs");
    const rootDir = path.join(runsDir, rootKey);
    fs.mkdirSync(rootDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(runsDir, 0o700);
    fs.chmodSync(rootDir, 0o700);

    const timestamp = new Date().toISOString().replace(/[.:]/g, "-");
    const filePath = path.join(rootDir, `${timestamp}-${randomUUID()}.jsonl`);
    const fd = fs.openSync(filePath, "wx", 0o600);
    return new JsonlTranscriptArtifact(filePath, fd, metadata);
  } catch (error) {
    return new UnavailableTranscriptArtifact(
      error instanceof Error ? error.message : String(error),
    );
  }
}

function decodeUtf8(buffer: Buffer): string {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    return decoder.decode(buffer);
  } catch {
    return "";
  }
}

export function truncateUtf8Head(
  value: string,
  maxBytes: number,
): { value: string; truncated: boolean } {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return { value, truncated: false };
  for (
    let end = Math.max(0, maxBytes);
    end >= Math.max(0, maxBytes - 3);
    end--
  ) {
    const decoded = decodeUtf8(bytes.subarray(0, end));
    if (decoded || end === 0) return { value: decoded, truncated: true };
  }
  return { value: "", truncated: true };
}

export function truncateUtf8Tail(
  value: string,
  maxBytes: number,
): { value: string; truncated: boolean } {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return { value, truncated: false };
  const start = Math.max(0, bytes.length - maxBytes);
  for (
    let offset = start;
    offset <= Math.min(bytes.length, start + 3);
    offset++
  ) {
    const decoded = decodeUtf8(bytes.subarray(offset));
    if (decoded || offset === bytes.length)
      return { value: decoded, truncated: true };
  }
  return { value: "", truncated: true };
}

export function appendBoundedJsonValue<T>(
  values: T[],
  value: T,
  maxBytes: number,
): boolean {
  const valueBytes = Buffer.byteLength(JSON.stringify(value), "utf8");
  if (valueBytes > maxBytes) return true;

  values.push(value);
  let totalBytes = values.reduce(
    (total, item) => total + Buffer.byteLength(JSON.stringify(item), "utf8"),
    0,
  );
  let truncated = false;
  while (values.length > 0 && totalBytes > maxBytes) {
    const removed = values.shift();
    if (removed !== undefined)
      totalBytes -= Buffer.byteLength(JSON.stringify(removed), "utf8");
    truncated = true;
  }
  return truncated;
}

function encodeSessionBucket(cwd: string): string {
  return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

/**
 * Locate a persisted child session file by its session UUID.
 *
 * Mirrors pi's `~/.pi/agent/sessions/--<encoded-cwd>--/<timestamp>_<uuid>.jsonl` layout:
 * tries the child cwd's bucket first (canonicalized to match the child's process.cwd())
 * and falls back to a one-level scan across all project buckets.
 */
export function resolveSessionFilePath(
  agentDir: string,
  childCwd: string,
  sessionId: string,
): string | undefined {
  const sessionsRoot = path.join(agentDir, "sessions");
  const suffix = `_${sessionId}.jsonl`;
  const findInBucket = (bucketPath: string): string | undefined => {
    try {
      const match = fs
        .readdirSync(bucketPath)
        .find((file) => file.endsWith(suffix));
      return match ? path.join(bucketPath, match) : undefined;
    } catch {
      return undefined;
    }
  };
  try {
    const direct = findInBucket(
      path.join(sessionsRoot, encodeSessionBucket(fs.realpathSync(childCwd))),
    );
    if (direct) return direct;
  } catch {
    /* child cwd unavailable or bucket missing; fall through to the full scan */
  }
  try {
    for (const entry of fs.readdirSync(sessionsRoot)) {
      const found = findInBucket(path.join(sessionsRoot, entry));
      if (found) return found;
    }
  } catch {
    /* sessions root missing */
  }
  return undefined;
}
