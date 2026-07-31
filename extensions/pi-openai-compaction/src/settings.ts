import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_EXTENSION_SETTINGS,
  EXTENSION_SETTINGS_FILE,
  EXTENSION_SETTINGS_KEY,
  type ExtensionSettings,
  type LoadedExtensionSettings,
} from "./types";

const GLOBAL_SETTINGS_PATH = path.join(
  os.homedir(),
  ".pi",
  "agent",
  "settings.json",
);
const ENV_PREFIX = "PI_OPENAI_NATIVE_COMPACTION_";
const PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const EXTENSION_SETTINGS_PATH = path.join(
  PACKAGE_ROOT,
  EXTENSION_SETTINGS_FILE,
);

type PartialSettings = Partial<ExtensionSettings>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readJsonObject(
  filePath: string,
  warnings: string[],
): Record<string, unknown> | undefined {
  try {
    if (!fs.statSync(filePath).isFile()) return undefined;
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (isRecord(parsed)) return parsed;
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

function toStringArray(
  value: unknown,
  field: string,
  warnings: string[],
): string[] | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || !item.trim())
  ) {
    warnings.push(`Ignoring ${field}: expected a non-empty string array.`);
    return undefined;
  }
  return [...new Set(value.map((item) => item.trim()))];
}

function readConfigBlock(
  settings: Record<string, unknown> | undefined,
  settingsPath: string,
  packageFile: boolean,
  warnings: string[],
): PartialSettings {
  if (!settings) return {};
  const raw = packageFile
    ? (settings[EXTENSION_SETTINGS_KEY] ?? settings)
    : settings[EXTENSION_SETTINGS_KEY];
  if (raw === undefined) return {};
  if (!isRecord(raw)) {
    warnings.push(
      `Ignoring ${settingsPath}:${EXTENSION_SETTINGS_KEY}: expected an object.`,
    );
    return {};
  }

  const result: PartialSettings = {};
  if (raw.enabled !== undefined) {
    if (typeof raw.enabled === "boolean") result.enabled = raw.enabled;
    else
      warnings.push(
        `Ignoring ${settingsPath}:${EXTENSION_SETTINGS_KEY}.enabled: expected a boolean.`,
      );
  }
  result.supportedProviders = toStringArray(
    raw.supportedProviders,
    `${settingsPath}:${EXTENSION_SETTINGS_KEY}.supportedProviders`,
    warnings,
  );
  result.supportedApis = toStringArray(
    raw.supportedApis,
    `${settingsPath}:${EXTENSION_SETTINGS_KEY}.supportedApis`,
    warnings,
  );
  return Object.fromEntries(
    Object.entries(result).filter((entry) => entry[1] !== undefined),
  ) as PartialSettings;
}

function applyEnv(settings: ExtensionSettings): ExtensionSettings {
  const enabled = process.env[`${ENV_PREFIX}ENABLED`]?.trim().toLowerCase();
  const parseCsv = (name: string): string[] | undefined => {
    const values = process.env[`${ENV_PREFIX}${name}`]
      ?.split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    return values?.length ? [...new Set(values)] : undefined;
  };
  return {
    enabled:
      enabled === undefined
        ? settings.enabled
        : ["1", "true", "yes", "on"].includes(enabled),
    supportedProviders:
      parseCsv("SUPPORTED_PROVIDERS") ?? settings.supportedProviders,
    supportedApis: parseCsv("SUPPORTED_APIS") ?? settings.supportedApis,
  };
}

export function loadExtensionSettings(_cwd?: string): LoadedExtensionSettings {
  const warnings: string[] = [];
  const sources: string[] = [];
  let settings = { ...DEFAULT_EXTENSION_SETTINGS };

  for (const [settingsPath, packageFile] of [
    [EXTENSION_SETTINGS_PATH, true],
    [GLOBAL_SETTINGS_PATH, false],
  ] as const) {
    const block = readConfigBlock(
      readJsonObject(settingsPath, warnings),
      settingsPath,
      packageFile,
      warnings,
    );
    if (Object.keys(block).length > 0) {
      settings = { ...settings, ...block };
      sources.push(settingsPath);
    }
  }

  return { settings: applyEnv(settings), sources, warnings };
}
