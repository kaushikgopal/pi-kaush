/**
 * Model profiles — shared, machine-local routing policy for Pi extensions.
 *
 * A model profile is a named, ordered list of model candidates with optional
 * thinking levels. Profiles describe compute, not behavior: consumers (e.g.
 * pi-agent-mode, the delegated-subagent extension) compose a profile with an
 * agent definition and decide how the winning candidate is applied.
 *
 * Configuration lives in one machine-local file, `~/.pi/agent/profiles.yaml`
 * (gitignored; `profiles.template.yaml` alongside it illustrates the schema).
 * This library never mutates session state, registers commands, or talks to
 * providers; it only parses, validates, and selects.
 */

import * as fs from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

export type ModelThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

const THINKING_LEVELS = new Set<ModelThinkingLevel>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
const PROFILE_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

export interface ModelProfileCandidate {
  /** Canonical `provider/model` reference; never a fuzzy pattern. */
  model: string;
  thinkingLevel?: ModelThinkingLevel;
}

export interface ModelProfile {
  description: string;
  /** Ordered fallback ladder; the first available candidate wins. */
  candidates: ModelProfileCandidate[];
}

export interface ModelProfilesConfig {
  version: 1;
  profiles: Record<string, ModelProfile>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
  throw new Error(`Invalid model profiles: ${message}`);
}

export function parseModelProfiles(value: unknown): ModelProfilesConfig {
  if (!isRecord(value)) fail("root must be an object");
  if (value.version !== 1) fail('"version" must be 1');
  if (!isRecord(value.profiles) || Object.keys(value.profiles).length === 0) {
    fail('"profiles" must be a non-empty object');
  }

  const profiles: Record<string, ModelProfile> = {};
  for (const [name, rawProfile] of Object.entries(value.profiles)) {
    if (!PROFILE_NAME_PATTERN.test(name))
      fail(`profile name "${name}" must use lowercase kebab-case`);
    if (!isRecord(rawProfile)) fail(`profile "${name}" must be an object`);

    const description = rawProfile.description;
    if (typeof description !== "string" || !description.trim()) {
      fail(`profile "${name}" must have a non-empty description`);
    }
    if (
      !Array.isArray(rawProfile.candidates) ||
      rawProfile.candidates.length === 0
    ) {
      fail(`profile "${name}" must have at least one candidate`);
    }

    const seenModels = new Set<string>();
    const candidates = rawProfile.candidates.map(
      (rawCandidate, index): ModelProfileCandidate => {
        if (!isRecord(rawCandidate))
          fail(`profile "${name}" candidate ${index + 1} must be an object`);
        const model = rawCandidate.model;
        if (
          typeof model !== "string" ||
          !model.trim() ||
          !model.includes("/")
        ) {
          fail(
            `profile "${name}" candidate ${index + 1} must use a canonical provider/model reference`,
          );
        }
        const normalizedModel = model.trim();
        if (seenModels.has(normalizedModel))
          fail(`profile "${name}" repeats model "${normalizedModel}"`);
        seenModels.add(normalizedModel);

        const thinkingLevel = rawCandidate.thinkingLevel;
        if (
          thinkingLevel !== undefined &&
          !THINKING_LEVELS.has(thinkingLevel as ModelThinkingLevel)
        ) {
          fail(
            `profile "${name}" candidate ${index + 1} has unsupported thinking level "${thinkingLevel}"`,
          );
        }
        return {
          model: normalizedModel,
          ...(thinkingLevel !== undefined
            ? { thinkingLevel: thinkingLevel as ModelThinkingLevel }
            : {}),
        };
      },
    );

    profiles[name] = { description: description.trim(), candidates };
  }

  return { version: 1, profiles };
}

export function loadModelProfiles(filePath: string): ModelProfilesConfig {
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    throw new Error(
      `Failed to read model profiles at ${filePath}: ${error instanceof Error ? error.message : error}`,
    );
  }

  try {
    return parseModelProfiles(parseYaml(content));
  } catch (error) {
    if (
      error instanceof SyntaxError ||
      (error instanceof Error && error.name === "YAMLParseError")
    ) {
      throw new Error(
        `Invalid YAML in model profiles at ${filePath}: ${error.message}`,
      );
    }
    throw error;
  }
}

/**
 * Resolve the machine-local profiles file under Pi's agent directory
 * (pass `getAgentDir()`). profiles.yaml is required (gitignored,
 * per-machine); profiles.template.yaml is a schema reference only and is
 * never loaded.
 * @throws if profiles.yaml is absent.
 */
export function resolveProfilesPath(agentDir: string): string {
  const local = join(agentDir, "profiles.yaml");
  if (!fs.existsSync(local)) {
    throw new Error(
      `Model profiles not found. Create ${local} with canonical provider/model references for this machine; see profiles.template.yaml in the same directory for the schema. profiles.yaml is gitignored and maintained per machine.`,
    );
  }
  return local;
}

export function formatProfileCandidate(
  candidate: ModelProfileCandidate,
): string {
  return candidate.thinkingLevel
    ? `${candidate.model}:${candidate.thinkingLevel}`
    : candidate.model;
}

export function formatProfileGuidance(config: ModelProfilesConfig): string {
  return Object.entries(config.profiles)
    .map(([name, profile]) => `${name}: ${profile.description}`)
    .join("; ");
}

/**
 * Split a profile's candidates into those accepted by `isAvailable` (in
 * order) and the rest. Fallback is a launch-time decision: consumers walk
 * `available` and must not silently switch models mid-request.
 */
export function selectProfileCandidates(
  profile: ModelProfile,
  isAvailable: (model: string) => boolean,
): {
  available: ModelProfileCandidate[];
  unavailable: ModelProfileCandidate[];
} {
  const available: ModelProfileCandidate[] = [];
  const unavailable: ModelProfileCandidate[] = [];
  for (const candidate of profile.candidates) {
    (isAvailable(candidate.model) ? available : unavailable).push(candidate);
  }
  return { available, unavailable };
}
