/**
 * Style selection state: resolution order and persistence.
 *
 * Resolution order: session pick (off is an explicit cascade stop) >
 * configured default > last-used > off. A name that no longer exists among
 * loaded styles falls through to the next layer with a warning.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface SessionPick {
  /** Style name, or null for an explicit off pick. */
  name: string | null;
}

export interface ResolveInput {
  pick: SessionPick | undefined;
  defaultName: string | undefined;
  lastUsed: string | undefined;
  styleNames: string[];
}

export interface ResolveResult {
  active: string | null;
  warning?: string;
}

export function resolveActive(input: ResolveInput): ResolveResult {
  const { pick, defaultName, lastUsed, styleNames } = input;
  if (pick !== undefined) {
    if (pick.name === null) return { active: null };
    if (styleNames.includes(pick.name)) return { active: pick.name };
    const rest = resolveActive({
      pick: undefined,
      defaultName,
      lastUsed,
      styleNames,
    });
    return {
      active: rest.active,
      warning:
        rest.warning ??
        `Session style "${pick.name}" no longer exists; falling back.`,
    };
  }
  if (defaultName !== undefined) {
    if (styleNames.includes(defaultName)) return { active: defaultName };
    const rest = resolveActive({
      pick: undefined,
      defaultName: undefined,
      lastUsed,
      styleNames,
    });
    return {
      active: rest.active,
      warning:
        rest.warning ??
        `Default style "${defaultName}" no longer exists; falling back.`,
    };
  }
  if (lastUsed !== undefined) {
    if (styleNames.includes(lastUsed)) return { active: lastUsed };
    return {
      active: null,
      warning: `Last-used style "${lastUsed}" no longer exists.`,
    };
  }
  return { active: null };
}

export const CONFIG_FILENAME = "config.json";

function readJsonObject(path: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function readName(path: string, key: string): string | undefined {
  const value = readJsonObject(path)[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function writeName(path: string, key: string, name: string): void {
  const config = readJsonObject(path);
  config[key] = name;
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
}

/** The default is config: it lives in the user styles dir so it can be committed to dotfiles. */
export function readDefaultName(userStylesDir: string): string | undefined {
  return readName(join(userStylesDir, CONFIG_FILENAME), "default");
}

export function writeDefaultName(userStylesDir: string, name: string): void {
  mkdirSync(userStylesDir, { recursive: true });
  writeName(join(userStylesDir, CONFIG_FILENAME), "default", name);
}

/** Last-used is churny state: it lives outside the (possibly symlinked) styles dir. */
export function readLastUsed(stateFile: string): string | undefined {
  return readName(stateFile, "lastUsed");
}

export function writeLastUsed(stateFile: string, name: string): void {
  writeName(stateFile, "lastUsed", name);
}
