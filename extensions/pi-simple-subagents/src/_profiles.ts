/**
 * Profiles layer for the subagent tool, backed by the canonical
 * @pi-kaush/pi-model-profiles package (the shared machine-local
 * ~/.pi/agent/profiles.yaml). This module keeps the subagent-facing names and
 * adds the reload + diagnostics helpers the delegation flow needs; parsing,
 * validation, and candidate formatting live in the canonical package.
 */
import {
  formatProfileCandidate as formatModelProfileCandidate,
  formatProfileGuidance as formatModelProfileGuidance,
  loadModelProfiles,
  parseModelProfiles,
  resolveProfilesPath as resolveModelProfilesPath,
  type ModelProfile,
  type ModelProfileCandidate,
  type ModelProfilesConfig,
} from "@pi-kaush/pi-model-profiles";
import * as fs from "node:fs";

export type ProfileThinkingLevel = ModelProfileCandidate["thinkingLevel"];
export type SubagentProfileCandidate = ModelProfileCandidate;
export type SubagentProfile = ModelProfile;
export type SubagentProfilesConfig = ModelProfilesConfig;

export function parseSubagentProfiles(value: unknown): SubagentProfilesConfig {
  return parseModelProfiles(value);
}

export function loadSubagentProfiles(filePath: string): SubagentProfilesConfig {
  return loadModelProfiles(filePath);
}

/** Cached profiles snapshot keyed by source-file mtime. */
export interface SubagentProfilesCache {
  mtimeMs: number;
  config: SubagentProfilesConfig;
}

/**
 * Re-read profiles.yaml only when its mtime changed, so long-running parent
 * sessions pick up ladder edits without a restart. Parse errors propagate:
 * a broken file surfaces on the next delegation call with the detailed
 * loader error instead of silently serving the stale snapshot.
 */
export function loadSubagentProfilesCurrent(
  filePath: string,
  cache?: SubagentProfilesCache,
): SubagentProfilesCache {
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(filePath).mtimeMs;
  } catch {
    // Unreadable/missing file: NaN never equals the cache, forcing the
    // reload so loadModelProfiles reports the detailed error.
    mtimeMs = Number.NaN;
  }
  if (cache && cache.mtimeMs === mtimeMs) return cache;
  return { mtimeMs, config: loadModelProfiles(filePath) };
}

/** Reports why configured profile candidates are absent from Pi's available catalog. */
export function formatProfileEligibilityError(
  profileName: string,
  candidates: readonly SubagentProfileCandidate[],
  availableModels: ReadonlySet<string>,
  catalogSize?: number,
): string {
  const lines = candidates.map((candidate) => {
    const eligible = availableModels.has(candidate.model.toLowerCase());
    return `- ${formatModelProfileCandidate(candidate)}: ${eligible ? "eligible" : "not available (unknown model or provider authentication missing)"}`;
  });
  const catalog =
    catalogSize === undefined ? "" : ` (${catalogSize} available models)`;
  return [
    `Profile "${profileName}" has no available candidate models (0 of ${candidates.length} in Pi's model catalog${catalog}):`,
    ...lines,
  ].join("\n");
}

/**
 * Aggregated failure diagnostics for a profile whose candidates all ran and
 * failed. Reports each attempt's resolved model and failure reason so the
 * caller sees the whole ladder outcome, not just the last error.
 */
export function formatProfileAttemptSummaries(
  profileName: string,
  attempts: readonly {
    model?: string;
    requestedModel?: string;
    errorMessage?: string;
    exitCode: number;
  }[],
): string {
  const parts = attempts.map((attempt) => {
    const model = attempt.model ?? attempt.requestedModel ?? "unknown model";
    const rawReason =
      attempt.errorMessage?.trim() || `exit code ${attempt.exitCode}`;
    const reason =
      rawReason.length > 200 ? `${rawReason.slice(0, 197)}...` : rawReason;
    return `${model} — ${reason.replace(/\s+/g, " ")}`;
  });
  return `Profile "${profileName}" exhausted ${attempts.length} candidate(s). Attempts: ${parts.join("; ")}.`;
}

/** Resolve the shared runtime profiles file under Pi's agent directory (pass getAgentDir()). */
export function resolveProfilesPath(agentDir: string): string {
  return resolveModelProfilesPath(agentDir);
}

export function formatProfileCandidate(
  candidate: SubagentProfileCandidate,
): string {
  return formatModelProfileCandidate(candidate);
}

export function formatProfileGuidance(config: SubagentProfilesConfig): string {
  return formatModelProfileGuidance(config);
}
