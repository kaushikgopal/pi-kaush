import type {
  CompactionEntry,
  CompactionResult,
} from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";

export const EXTENSION_SETTINGS_KEY = "openaiNativeCompaction";
export const EXTENSION_SETTINGS_FILE = "settings.json";
export const DEFAULT_SUPPORTED_PROVIDERS = [
  "openai",
  "instacart-openai",
] as const;
export const DEFAULT_SUPPORTED_APIS = ["openai-responses"] as const;
export const NATIVE_COMPACTION_STRATEGY = "openai-native-compact-v1";
export const NATIVE_COMPACTION_SHIM_SUMMARY =
  "[OpenAI native compaction checkpoint]";
export const NATIVE_COMPACTION_DISPLAY_MESSAGE_TYPE =
  "openai-native-compaction-display";
export const NATIVE_COMPACTION_DISPLAY_TEXT = [
  "OpenAI native compaction was used for this checkpoint.",
  "",
  "Pi will create portable context before an incompatible model switch. Run /native-compaction-detach before disabling or removing the extension.",
].join("\n");

export type ExtensionSettings = {
  enabled: boolean;
  supportedProviders: string[];
  supportedApis: string[];
};

export type LoadedExtensionSettings = {
  settings: ExtensionSettings;
  sources: string[];
  warnings: string[];
};

export type NativeCompactionStrategy = typeof NATIVE_COMPACTION_STRATEGY;
export type NativeCompactionShimSummary = typeof NATIVE_COMPACTION_SHIM_SUMMARY;

export type NativeCompactionRequestMeta = {
  reason?: "manual" | "threshold" | "overflow";
  willRetry?: boolean;
  tokensBefore?: number;
  previousSummaryPresent?: boolean;
};

export type NativeCompactionIdentity = {
  provider: string;
  api: string;
  model: string;
  baseUrl: string;
};

export type NativeCompactionDetails = NativeCompactionIdentity & {
  strategy: NativeCompactionStrategy;
  compactedWindow: unknown[];
  compactResponseId?: string;
  createdAt: string;
  requestMeta?: NativeCompactionRequestMeta;
};

export type NativeCompactionEntry = CompactionEntry<NativeCompactionDetails>;

export type CreateNativeCompactionDetailsInput = NativeCompactionIdentity & {
  compactedWindow: unknown[];
  compactResponseId?: string;
  createdAt?: string;
  requestMeta?: NativeCompactionRequestMeta;
};

export type CreateNativeCompactionShimResultInput = {
  firstKeptEntryId: string;
  tokensBefore: number;
  usage?: Usage;
  details: NativeCompactionDetails;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isFiniteNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function normalizeString(value: string): string {
  return value.trim();
}

function isStructuredValue(value: unknown): boolean {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return true;
  }

  if (Array.isArray(value)) {
    return value.every(isStructuredValue);
  }

  if (isRecord(value)) {
    return Object.values(value).every(isStructuredValue);
  }

  return false;
}

function cloneStructuredValue(value: unknown): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(cloneStructuredValue);
  }

  if (isRecord(value)) {
    const clone: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      clone[key] = cloneStructuredValue(nested);
    }
    return clone;
  }

  throw new Error(`Unsupported structured value: ${typeof value}`);
}

function isCompactedWindowItem(
  value: unknown,
): value is Record<string, unknown> {
  return isRecord(value) && Object.values(value).every(isStructuredValue);
}

export function isNativeCompactionRequestMeta(
  value: unknown,
): value is NativeCompactionRequestMeta {
  if (!isRecord(value)) {
    return false;
  }

  const { reason, willRetry, tokensBefore, previousSummaryPresent } = value;
  if (
    reason !== undefined &&
    reason !== "manual" &&
    reason !== "threshold" &&
    reason !== "overflow"
  ) {
    return false;
  }
  if (willRetry !== undefined && typeof willRetry !== "boolean") {
    return false;
  }
  if (tokensBefore !== undefined && !isFiniteNonNegativeNumber(tokensBefore)) {
    return false;
  }

  if (
    previousSummaryPresent !== undefined &&
    typeof previousSummaryPresent !== "boolean"
  ) {
    return false;
  }

  return true;
}

export function isNativeCompactionIdentity(
  value: unknown,
): value is NativeCompactionIdentity {
  if (!isRecord(value)) {
    return false;
  }

  return (
    isNonEmptyString(value.provider) &&
    isNonEmptyString(value.api) &&
    isNonEmptyString(value.model) &&
    isNonEmptyString(value.baseUrl)
  );
}

export function isNativeCompactionDetails(
  value: unknown,
): value is NativeCompactionDetails {
  if (!isRecord(value)) {
    return false;
  }

  const identityValid = isNativeCompactionIdentity(value);
  const details: Record<string, unknown> = value;

  return (
    details.strategy === NATIVE_COMPACTION_STRATEGY &&
    identityValid &&
    Array.isArray(details.compactedWindow) &&
    details.compactedWindow.every(isCompactedWindowItem) &&
    isNonEmptyString(details.createdAt) &&
    (details.compactResponseId === undefined ||
      isNonEmptyString(details.compactResponseId)) &&
    (details.requestMeta === undefined ||
      isNativeCompactionRequestMeta(details.requestMeta))
  );
}

export function isNativeCompactionEntry(
  value: unknown,
): value is NativeCompactionEntry {
  return (
    isRecord(value) &&
    value.type === "compaction" &&
    isNativeCompactionDetails(value.details)
  );
}

export function isNativeCompactionShimSummary(
  value: unknown,
): value is NativeCompactionShimSummary {
  return value === NATIVE_COMPACTION_SHIM_SUMMARY;
}

export function createNativeCompactionDetails(
  input: CreateNativeCompactionDetailsInput,
): NativeCompactionDetails {
  return {
    strategy: NATIVE_COMPACTION_STRATEGY,
    provider: normalizeString(input.provider),
    api: normalizeString(input.api),
    model: normalizeString(input.model),
    baseUrl: normalizeString(input.baseUrl),
    compactedWindow: input.compactedWindow.map((item) =>
      cloneStructuredValue(item),
    ),
    compactResponseId: isNonEmptyString(input.compactResponseId)
      ? normalizeString(input.compactResponseId)
      : undefined,
    createdAt: isNonEmptyString(input.createdAt)
      ? normalizeString(input.createdAt)
      : new Date().toISOString(),
    requestMeta: input.requestMeta
      ? {
          ...(input.requestMeta.reason !== undefined
            ? { reason: input.requestMeta.reason }
            : {}),
          ...(input.requestMeta.willRetry !== undefined
            ? { willRetry: input.requestMeta.willRetry }
            : {}),
          ...(input.requestMeta.tokensBefore !== undefined
            ? { tokensBefore: input.requestMeta.tokensBefore }
            : {}),
          ...(input.requestMeta.previousSummaryPresent !== undefined
            ? {
                previousSummaryPresent:
                  input.requestMeta.previousSummaryPresent,
              }
            : {}),
        }
      : undefined,
  };
}

export function createNativeCompactionShimSummary(): NativeCompactionShimSummary {
  return NATIVE_COMPACTION_SHIM_SUMMARY;
}

export function createNativeCompactionShimResult(
  input: CreateNativeCompactionShimResultInput,
): CompactionResult<NativeCompactionDetails> {
  return {
    summary: createNativeCompactionShimSummary(),
    firstKeptEntryId: input.firstKeptEntryId,
    tokensBefore: input.tokensBefore,
    ...(input.usage ? { usage: input.usage } : {}),
    details: input.details,
  };
}

export const DEFAULT_EXTENSION_SETTINGS: ExtensionSettings = {
  enabled: true,
  supportedProviders: [...DEFAULT_SUPPORTED_PROVIDERS],
  supportedApis: [...DEFAULT_SUPPORTED_APIS],
};
