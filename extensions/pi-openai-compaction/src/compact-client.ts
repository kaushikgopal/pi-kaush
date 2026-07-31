import { calculateCost, type Usage } from "@earendil-works/pi-ai";
import type { NativeCompactionRuntime } from "./runtime";
import type { NativeCompactionRequestBody } from "./serializer";

const JSON_CONTENT_TYPE = "application/json";
const MAX_ATTEMPTS = 2;
const DEFAULT_RETRY_DELAY_MS = 250;
const MAX_RETRY_DELAY_MS = 2_000;
const MAX_COMPACT_RESPONSE_BYTES = 16 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 60_000;

type CompactResponseEnvelope = {
  object: "response.compaction";
  id?: string;
  created_at?: number | string;
  output: unknown[];
  usage?: unknown;
  [key: string]: unknown;
};

export type NativeCompactionClientFailureReason =
  | "aborted"
  | "network-error"
  | "non-2xx"
  | "empty-body"
  | "invalid-json"
  | "malformed-response"
  | "empty-output"
  | "oversized-output";

export type NativeCompactionClientSuccess = {
  ok: true;
  status: number;
  compactedWindow: unknown[];
  compactResponseId?: string;
  createdAt?: string;
  usage?: Usage;
};

export type NativeCompactionClientFailure = {
  ok: false;
  reason: NativeCompactionClientFailureReason;
  status?: number;
  errorMessage?: string;
};

export type NativeCompactionClientResult =
  | NativeCompactionClientSuccess
  | NativeCompactionClientFailure;

export type ExecuteNativeCompactionOptions = {
  runtime: NativeCompactionRuntime;
  request: NativeCompactionRequestBody;
  signal?: AbortSignal;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error &&
      (error.name === "AbortError" || error.name === "ABORT_ERR"))
  );
}

function normalizeResponseTimestamp(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(
      value > 1_000_000_000_000 ? value : value * 1000,
    ).toISOString();
  }
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? value.trim() : new Date(parsed).toISOString();
}

function isCompactResponseEnvelope(
  value: unknown,
): value is CompactResponseEnvelope {
  if (
    !isRecord(value) ||
    value.object !== "response.compaction" ||
    !Array.isArray(value.output)
  )
    return false;
  return (
    value.output.every(isRecord) &&
    value.output.some(
      (item) =>
        item.type === "compaction" &&
        typeof item.encrypted_content === "string" &&
        item.encrypted_content.length > 0,
    )
  );
}

function finiteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

function normalizeUsage(
  value: unknown,
  runtime: NativeCompactionRuntime,
): Usage | undefined {
  if (!isRecord(value)) return undefined;
  const inputDetails = isRecord(value.input_tokens_details)
    ? value.input_tokens_details
    : {};
  const outputDetails = isRecord(value.output_tokens_details)
    ? value.output_tokens_details
    : {};
  const inputTokens = finiteNumber(value.input_tokens);
  const cacheRead = finiteNumber(inputDetails.cached_tokens);
  const cacheWrite = finiteNumber(inputDetails.cache_write_tokens);
  const output = finiteNumber(value.output_tokens);
  const usage: Usage = {
    input: Math.max(0, inputTokens - cacheRead - cacheWrite),
    output,
    cacheRead,
    cacheWrite,
    reasoning: finiteNumber(outputDetails.reasoning_tokens),
    totalTokens: finiteNumber(value.total_tokens) || inputTokens + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  calculateCost(runtime.currentModel, usage);
  return usage;
}

export function createRuntimeHeaders(
  runtime: NativeCompactionRuntime,
): Record<string, string> {
  const headers = new Headers(runtime.headers ?? {});
  headers.set("accept", JSON_CONTENT_TYPE);
  headers.set("content-type", JSON_CONTENT_TYPE);
  if (runtime.apiKey && !headers.has("authorization"))
    headers.set("authorization", `Bearer ${runtime.apiKey}`);
  return Object.fromEntries(headers.entries());
}

function retryDelayMs(response: Response): number | undefined {
  if (response.status !== 429 && response.status < 500) return undefined;
  const raw = response.headers.get("retry-after")?.trim();
  if (!raw) return DEFAULT_RETRY_DELAY_MS;
  const seconds = Number(raw);
  const delay = Number.isFinite(seconds)
    ? seconds * 1000
    : Date.parse(raw) - Date.now();
  return delay >= 0 && delay <= MAX_RETRY_DELAY_MS ? delay : undefined;
}

export async function executeNativeCompaction(
  options: ExecuteNativeCompactionOptions,
): Promise<NativeCompactionClientResult> {
  const { runtime, request, signal } = options;
  if (signal?.aborted) return { ok: false, reason: "aborted" };
  const requestSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
    : AbortSignal.timeout(REQUEST_TIMEOUT_MS);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(runtime.compactUrl, {
        method: "POST",
        headers: createRuntimeHeaders(runtime),
        body: JSON.stringify(request),
        signal: requestSignal,
      });
      if (!response.ok) {
        const delay = retryDelayMs(response);
        if (attempt < MAX_ATTEMPTS && delay !== undefined) {
          await new Promise((resolve) => setTimeout(resolve, delay));
          if (signal?.aborted) return { ok: false, reason: "aborted" };
          continue;
        }
        return { ok: false, reason: "non-2xx", status: response.status };
      }
      const contentLength = Number(response.headers.get("content-length"));
      if (
        Number.isFinite(contentLength) &&
        contentLength > MAX_COMPACT_RESPONSE_BYTES
      ) {
        return {
          ok: false,
          reason: "oversized-output",
          status: response.status,
        };
      }

      const responseText = await response.text();
      if (!responseText.trim())
        return { ok: false, reason: "empty-body", status: response.status };
      if (
        new TextEncoder().encode(responseText).byteLength >
        MAX_COMPACT_RESPONSE_BYTES
      ) {
        return {
          ok: false,
          reason: "oversized-output",
          status: response.status,
        };
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(responseText);
      } catch {
        return { ok: false, reason: "invalid-json", status: response.status };
      }
      if (
        isRecord(parsed) &&
        Array.isArray(parsed.output) &&
        parsed.output.length === 0
      ) {
        return { ok: false, reason: "empty-output", status: response.status };
      }
      if (!isCompactResponseEnvelope(parsed)) {
        return {
          ok: false,
          reason: "malformed-response",
          status: response.status,
        };
      }

      return {
        ok: true,
        status: response.status,
        compactedWindow: [...parsed.output],
        compactResponseId:
          typeof parsed.id === "string" && parsed.id.trim()
            ? parsed.id.trim()
            : undefined,
        createdAt: normalizeResponseTimestamp(parsed.created_at),
        usage: normalizeUsage(parsed.usage, runtime),
      };
    } catch (error) {
      if (isAbortError(error) && signal?.aborted)
        return { ok: false, reason: "aborted" };
      if (attempt < MAX_ATTEMPTS) continue;
      return {
        ok: false,
        reason: "network-error",
      };
    }
  }
  return { ok: false, reason: "network-error" };
}
