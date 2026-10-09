/**
 * Subagent-specific profile helpers: mtime-keyed reloads and diagnostics.
 * Parsing, validation, and candidate formatting come straight from the
 * canonical @pi-kaush/pi-model-profiles package (~/.pi/agent/profiles.yaml).
 */
import {
  formatProfileCandidate,
  loadModelProfiles,
  type ModelProfileCandidate,
  type ModelProfilesConfig,
} from "@pi-kaush/pi-model-profiles";
import * as fs from "node:fs";

/** Cached profiles snapshot keyed by source-file mtime. */
export interface SubagentProfilesCache {
  mtimeMs: number;
  config: ModelProfilesConfig;
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
  candidates: readonly ModelProfileCandidate[],
  availableModels: ReadonlySet<string>,
  catalogSize?: number,
): string {
  const lines = candidates.map((candidate) => {
    const eligible = availableModels.has(candidate.model.toLowerCase());
    return `- ${formatProfileCandidate(candidate)}: ${eligible ? "eligible" : "not available (unknown model or provider authentication missing)"}`;
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
