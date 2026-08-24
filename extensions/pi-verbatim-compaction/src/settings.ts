import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  SETTINGS_FILE,
  SETTINGS_KEY,
  type ExtensionSettings,
  type LoadedExtensionSettings,
} from "./types.ts";

const PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const PACKAGE_SETTINGS_PATH = path.join(PACKAGE_ROOT, SETTINGS_FILE);
const ENV_PREFIX = "PI_VERBATIM_COMPACTION_";

export const DEFAULT_SETTINGS: ExtensionSettings = {
  enabled: true,
  retention: {
    ratio: 0.5,
    minimumTokens: 8_000,
    minimumReductionTokens: 2_048,
  },
  planner: { model: "current", maxOutputTokens: 4_096, timeoutMs: 120_000 },
  protectedContext: { enabled: true },
  recall: { enabled: true, maxResults: 8, maxCharacters: 12_000 },
  speculation: { enabled: false, triggerRatio: 0.7 },
  debug: false,
};

type PartialSettings = {
  enabled?: boolean;
  retention?: Partial<ExtensionSettings["retention"]>;
  planner?: Partial<ExtensionSettings["planner"]>;
  protectedContext?: Partial<ExtensionSettings["protectedContext"]>;
  recall?: Partial<ExtensionSettings["recall"]>;
  speculation?: Partial<ExtensionSettings["speculation"]>;
  debug?: boolean;
};

export function loadExtensionSettings(): LoadedExtensionSettings {
  const warnings: string[] = [];
  const sources: string[] = [];
  let settings = cloneSettings(DEFAULT_SETTINGS);

  for (const [filePath, packageFile] of [
    [PACKAGE_SETTINGS_PATH, true],
    [path.join(getAgentDir(), "settings.json"), false],
  ] as const) {
    const document = readJsonObject(filePath, warnings);
    const block = readSettingsBlock(document, filePath, packageFile, warnings);
    if (Object.keys(block).length > 0) {
      settings = mergeSettings(settings, block);
      sources.push(filePath);
    }
  }

  return { settings: applyEnvironment(settings, warnings), sources, warnings };
}

function readSettingsBlock(
  document: Record<string, unknown> | undefined,
  filePath: string,
  packageFile: boolean,
  warnings: string[],
): PartialSettings {
  if (document === undefined) return {};
  const raw = packageFile
    ? (document[SETTINGS_KEY] ?? document)
    : document[SETTINGS_KEY];
  if (raw === undefined) return {};
  if (!isRecord(raw)) {
    warnings.push(`Ignoring ${filePath}:${SETTINGS_KEY}: expected an object.`);
    return {};
  }

  const result: PartialSettings = {};
  readBoolean(raw, "enabled", filePath, warnings, result);
  readBoolean(raw, "debug", filePath, warnings, result);
  result.retention = readNested(
    raw,
    "retention",
    filePath,
    warnings,
    (value, nestedPath) => ({
      ratio: readNumber(value, "ratio", nestedPath, warnings, 0.05, 0.95),
      minimumTokens: readInteger(
        value,
        "minimumTokens",
        nestedPath,
        warnings,
        0,
        10_000_000,
      ),
      minimumReductionTokens: readInteger(
        value,
        "minimumReductionTokens",
        nestedPath,
        warnings,
        1,
        10_000_000,
      ),
    }),
  );
  result.planner = readNested(
    raw,
    "planner",
    filePath,
    warnings,
    (value, nestedPath) => ({
      model: readString(value, "model", nestedPath, warnings),
      maxOutputTokens: readInteger(
        value,
        "maxOutputTokens",
        nestedPath,
        warnings,
        128,
        16_384,
      ),
      timeoutMs: readInteger(
        value,
        "timeoutMs",
        nestedPath,
        warnings,
        1_000,
        600_000,
      ),
    }),
  );
  result.protectedContext = readNested(
    raw,
    "protectedContext",
    filePath,
    warnings,
    (value, nestedPath) => ({
      enabled: readBooleanValue(value, "enabled", nestedPath, warnings),
    }),
  );
  result.recall = readNested(
    raw,
    "recall",
    filePath,
    warnings,
    (value, nestedPath) => ({
      enabled: readBooleanValue(value, "enabled", nestedPath, warnings),
      maxResults: readInteger(value, "maxResults", nestedPath, warnings, 1, 50),
      maxCharacters: readInteger(
        value,
        "maxCharacters",
        nestedPath,
        warnings,
        1_000,
        100_000,
      ),
    }),
  );
  result.speculation = readNested(
    raw,
    "speculation",
    filePath,
    warnings,
    (value, nestedPath) => ({
      enabled: readBooleanValue(value, "enabled", nestedPath, warnings),
      triggerRatio: readNumber(
        value,
        "triggerRatio",
        nestedPath,
        warnings,
        0.1,
        0.95,
      ),
    }),
  );

  return removeUndefined(result) as PartialSettings;
}

function applyEnvironment(
  settings: ExtensionSettings,
  warnings: string[],
): ExtensionSettings {
  const result = cloneSettings(settings);
  const boolean = (name: string): boolean | undefined => {
    const raw = process.env[`${ENV_PREFIX}${name}`];
    if (raw === undefined) return undefined;
    const normalized = raw.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
    warnings.push(`Ignoring ${ENV_PREFIX}${name}: expected a boolean.`);
    return undefined;
  };
  const number = (
    name: string,
    minimum: number,
    maximum: number,
    integer = false,
  ): number | undefined => {
    const raw = process.env[`${ENV_PREFIX}${name}`];
    if (raw === undefined) return undefined;
    const parsed = Number(raw);
    if (
      !Number.isFinite(parsed) ||
      parsed < minimum ||
      parsed > maximum ||
      (integer && !Number.isInteger(parsed))
    ) {
      warnings.push(
        `Ignoring ${ENV_PREFIX}${name}: expected ${integer ? "an integer" : "a number"} from ${minimum} to ${maximum}.`,
      );
      return undefined;
    }
    return parsed;
  };

  result.enabled = boolean("ENABLED") ?? result.enabled;
  result.debug = boolean("DEBUG") ?? result.debug;
  result.retention.ratio =
    number("RETENTION_RATIO", 0.05, 0.95) ?? result.retention.ratio;
  result.retention.minimumTokens =
    number("MINIMUM_TOKENS", 0, 10_000_000, true) ??
    result.retention.minimumTokens;
  result.retention.minimumReductionTokens =
    number("MINIMUM_REDUCTION_TOKENS", 1, 10_000_000, true) ??
    result.retention.minimumReductionTokens;
  result.planner.model =
    process.env[`${ENV_PREFIX}PLANNER_MODEL`]?.trim() || result.planner.model;
  result.planner.maxOutputTokens =
    number("PLANNER_MAX_OUTPUT_TOKENS", 128, 16_384, true) ??
    result.planner.maxOutputTokens;
  result.planner.timeoutMs =
    number("PLANNER_TIMEOUT_MS", 1_000, 600_000, true) ??
    result.planner.timeoutMs;
  result.protectedContext.enabled =
    boolean("PROTECTED_CONTEXT_ENABLED") ?? result.protectedContext.enabled;
  result.recall.enabled = boolean("RECALL_ENABLED") ?? result.recall.enabled;
  result.recall.maxResults =
    number("RECALL_MAX_RESULTS", 1, 50, true) ?? result.recall.maxResults;
  result.recall.maxCharacters =
    number("RECALL_MAX_CHARACTERS", 1_000, 100_000, true) ??
    result.recall.maxCharacters;
  result.speculation.enabled =
    boolean("SPECULATION_ENABLED") ?? result.speculation.enabled;
  result.speculation.triggerRatio =
    number("SPECULATION_TRIGGER_RATIO", 0.1, 0.95) ??
    result.speculation.triggerRatio;
  return result;
}

function mergeSettings(
  base: ExtensionSettings,
  partial: PartialSettings,
): ExtensionSettings {
  return {
    ...base,
    ...partial,
    retention: { ...base.retention, ...partial.retention },
    planner: { ...base.planner, ...partial.planner },
    protectedContext: { ...base.protectedContext, ...partial.protectedContext },
    recall: { ...base.recall, ...partial.recall },
    speculation: { ...base.speculation, ...partial.speculation },
  };
}

function cloneSettings(settings: ExtensionSettings): ExtensionSettings {
  return mergeSettings(settings, {});
}

function readJsonObject(
  filePath: string,
  warnings: string[],
): Record<string, unknown> | undefined {
  try {
    if (!fs.statSync(filePath).isFile()) return undefined;
    const value: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (isRecord(value)) return value;
    warnings.push(`Ignoring ${filePath}: expected a JSON object.`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      warnings.push(
        `Ignoring ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return undefined;
}

function readNested<T extends Record<string, unknown>>(
  source: Record<string, unknown>,
  key: string,
  filePath: string,
  warnings: string[],
  reader: (value: Record<string, unknown>, nestedPath: string) => T,
): T | undefined {
  const value = source[key];
  if (value === undefined) return undefined;
  const nestedPath = `${filePath}:${SETTINGS_KEY}.${key}`;
  if (!isRecord(value)) {
    warnings.push(`Ignoring ${nestedPath}: expected an object.`);
    return undefined;
  }
  return removeUndefined(reader(value, nestedPath)) as T;
}

function readBoolean(
  source: Record<string, unknown>,
  key: string,
  filePath: string,
  warnings: string[],
  target: PartialSettings,
): void {
  const value = readBooleanValue(
    source,
    key,
    `${filePath}:${SETTINGS_KEY}`,
    warnings,
  );
  if (value !== undefined) (target as Record<string, unknown>)[key] = value;
}

function readBooleanValue(
  source: Record<string, unknown>,
  key: string,
  pathPrefix: string,
  warnings: string[],
): boolean | undefined {
  const value = source[key];
  if (value === undefined) return undefined;
  if (typeof value === "boolean") return value;
  warnings.push(`Ignoring ${pathPrefix}.${key}: expected a boolean.`);
  return undefined;
}

function readString(
  source: Record<string, unknown>,
  key: string,
  pathPrefix: string,
  warnings: string[],
): string | undefined {
  const value = source[key];
  if (value === undefined) return undefined;
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  warnings.push(`Ignoring ${pathPrefix}.${key}: expected a non-empty string.`);
  return undefined;
}

function readInteger(
  source: Record<string, unknown>,
  key: string,
  pathPrefix: string,
  warnings: string[],
  minimum: number,
  maximum: number,
): number | undefined {
  return readNumber(source, key, pathPrefix, warnings, minimum, maximum, true);
}

function readNumber(
  source: Record<string, unknown>,
  key: string,
  pathPrefix: string,
  warnings: string[],
  minimum: number,
  maximum: number,
  integer = false,
): number | undefined {
  const value = source[key];
  if (value === undefined) return undefined;
  if (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= minimum &&
    value <= maximum &&
    (!integer || Number.isInteger(value))
  ) {
    return value;
  }
  warnings.push(
    `Ignoring ${pathPrefix}.${key}: expected ${integer ? "an integer" : "a number"} from ${minimum} to ${maximum}.`,
  );
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function removeUndefined(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  );
}
