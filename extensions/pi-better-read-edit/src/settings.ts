import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CONFIG_DIR_NAME,
  getAgentDir,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

export const SETTINGS_KEY = "betterReadEdit";
export const AVOID_MODELS_KEY = "avoidModels";

export type BetterReadEditSettings = {
  avoidModels: string[];
};

export type LoadedBetterReadEditSettings = {
  settings: BetterReadEditSettings;
  sources: string[];
  warnings: string[];
};

export const DEFAULT_SETTINGS: Readonly<BetterReadEditSettings> = {
  avoidModels: [],
};

type SettingsContext = Pick<ExtensionContext, "cwd" | "isProjectTrusted">;

export function loadBetterReadEditSettings(
  ctx: SettingsContext,
  agentDir = getAgentDir(),
): LoadedBetterReadEditSettings {
  const warnings: string[] = [];
  const sources: string[] = [];
  let avoidModels = [...DEFAULT_SETTINGS.avoidModels];
  const paths = [join(agentDir, "settings.json")];
  if (ctx.isProjectTrusted()) {
    paths.push(join(ctx.cwd, CONFIG_DIR_NAME, "settings.json"));
  }

  for (const filePath of paths) {
    const override = readAvoidModels(filePath, warnings);
    if (override === undefined) continue;
    avoidModels = override;
    sources.push(filePath);
  }

  return { settings: { avoidModels }, sources, warnings };
}

function readAvoidModels(
  filePath: string,
  warnings: string[],
): string[] | undefined {
  let document: unknown;
  try {
    document = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      warnings.push(`Ignoring ${filePath}: ${formatError(error)}`);
    }
    return undefined;
  }

  if (!isRecord(document)) {
    warnings.push(`Ignoring ${filePath}: expected a JSON object.`);
    return undefined;
  }
  const block = document[SETTINGS_KEY];
  if (block === undefined) return undefined;
  if (!isRecord(block)) {
    warnings.push(`Ignoring ${filePath}:${SETTINGS_KEY}: expected an object.`);
    return undefined;
  }
  const rawPatterns = block[AVOID_MODELS_KEY];
  if (rawPatterns === undefined) return undefined;
  if (
    !Array.isArray(rawPatterns) ||
    rawPatterns.some(
      (pattern) => typeof pattern !== "string" || pattern.trim().length === 0,
    )
  ) {
    warnings.push(
      `Ignoring ${filePath}:${SETTINGS_KEY}.${AVOID_MODELS_KEY}: expected an array of non-empty strings.`,
    );
    return undefined;
  }

  return [...new Set(rawPatterns.map((pattern: string) => pattern.trim()))];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
