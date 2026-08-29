// Bench configuration: constants, defaults, and the resolveConfig() merge.
//
// Precedence for every knob: CLI flags (parsed by cli.mjs) > BENCH_* env
// vars > defaults below. resolveConfig() receives the already-merged
// "raw overrides" object plus the parsed argv so dry runs and tests can
// reuse identical config construction.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  benchDir,
  extensionRoot,
  normalizePath,
  runIdNow,
  truncate,
  validateRunId,
} from "./util.mjs";

/** Schema tag stored in every raw/public artifact. */
export const SCHEMA = "pi-better-read-edit-bench/v1";

/**
 * Default model matrix. Each entry carries the thinking level this
 * extension is evaluated at; the matrix only defines the default, every
 * entry can be replaced with `--model provider/id[:thinking]` and narrowed
 * with `--model-filter`.
 */
export const DEFAULT_MODELS = [
  { id: "instacart-openai/gpt-5.6-luna", thinking: "low" },
  { id: "open-weights/deepseek-v4-flash-0731-priority", thinking: "off" },
  { id: "instacart-anthropic/claude-haiku-4-5@20251001", thinking: "off" },
  { id: "huggingface/zai-org/GLM-5.2", thinking: "low" },
];

export const DEFAULT_FIXTURES = [
  "two-splices",
  "repeated-context",
  "two-files",
  "large-delete",
];

export const DEFAULT_TRIALS = 1;
export const DEFAULT_SEED = 1;
export const DEFAULT_TIMEOUT_MS = 300_000; // per arm
export const DEFAULT_MAX_CALLS = 200; // per arm, hard safety cap (>= triggers)
export const DEFAULT_PI_BIN = "pi";

/**
 * Config/auth files COPIED from the real agent dir into the private
 * per-arm PI_CODING_AGENT_DIR (never symlinked, contents never read or
 * logged by the harness): provider auth and model definitions keep working
 * with 0600 copies. The private dir additionally gets a forced
 * settings.json whose betterReadEdit.avoidModels is empty, so the "better"
 * arm can never be silently routed onto the builtin tools by an avoidlist.
 */
export const AGENT_CONFIG_FILES = [
  "auth.json",
  "models.json",
  "models-store.json",
];

/** Settings forced into every private agent dir (see AGENT_CONFIG_FILES). */
export const FORCED_SETTINGS = {
  betterReadEdit: { avoidModels: [] },
};

/** Default location of user's real agent dir, unless PI_CODING_AGENT_DIR. */
export function defaultAgentDir(env = process.env) {
  return env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

/** Resolve the full benchmark config object. */
export function resolveConfig(overrides = {}, parsedArgs = {}) {
  const env = process.env;
  const runsDir = join(benchDir(), "runs");
  const publishedDir = join(benchDir(), "published");
  const fixturesDir = join(benchDir(), "fixtures");

  const timeoutMs = toPositiveInt(
    parsedArgs.timeout ?? env.BENCH_TIMEOUT_MS ?? overrides.timeoutMs,
    DEFAULT_TIMEOUT_MS,
    "timeout",
  );
  const maxCalls = toPositiveInt(
    parsedArgs.maxCalls ?? env.BENCH_MAX_CALLS ?? overrides.maxCalls,
    DEFAULT_MAX_CALLS,
    "max-calls",
  );
  const trials = toPositiveInt(
    parsedArgs.trials ?? env.BENCH_TRIALS ?? overrides.trials,
    DEFAULT_TRIALS,
    "trials",
  );
  const seed = Number(
    parsedArgs.seed ?? env.BENCH_SEED ?? overrides.seed ?? DEFAULT_SEED,
  );
  const envModels = commaList(env.BENCH_MODEL);
  const envFixtures = commaList(env.BENCH_FIXTURE);

  return {
    schema: SCHEMA,
    runId: String(
      parsedArgs.runId ?? env.BENCH_RUN_ID ?? overrides.runId ?? runIdNow(),
    ),
    models:
      overrides.models ??
      parsedArgs.models ??
      (envModels.length > 0 ? envModels : null), // resolved later
    fixtures: pickList(
      overrides.fixtures,
      parsedArgs.fixtures,
      envFixtures,
      DEFAULT_FIXTURES,
    ),
    trials,
    seed: Number.isFinite(seed) ? seed : DEFAULT_SEED,
    timeoutMs,
    maxCalls,
    maxProtocolLineChars: overrides.maxProtocolLineChars,
    dryRun: Boolean(
      parsedArgs.dryRun ?? env.BENCH_DRY_RUN === "1" ?? overrides.dryRun,
    ),
    keepWorkspaces: Boolean(
      parsedArgs.keepWorkspaces ?? overrides.keepWorkspaces,
    ),
    jsonOutput: Boolean(parsedArgs.json),
    piBin: resolveBinary(
      parsedArgs.pi ?? env.BENCH_PI_BIN ?? overrides.piBin ?? DEFAULT_PI_BIN,
    ),
    extensionPath: normalizePath(
      String(
        parsedArgs.extension ??
          env.BENCH_EXTENSION_PATH ??
          overrides.extensionPath ??
          join(extensionRoot(), "src", "index.ts"),
      ),
    ),
    agentDir: normalizePath(
      String(
        parsedArgs.agentDir ??
          env.BENCH_AGENT_DIR ??
          overrides.agentDir ??
          defaultAgentDir(),
      ),
    ),
    runsDir: normalizePath(
      String(
        parsedArgs.runsDir ??
          env.BENCH_RUNS_DIR ??
          overrides.runsDir ??
          runsDir,
      ),
    ),
    publishedDir: normalizePath(
      String(
        parsedArgs.publishedDir ??
          env.BENCH_PUBLISHED_DIR ??
          overrides.publishedDir ??
          publishedDir,
      ),
    ),
    fixturesDir: normalizePath(
      String(
        parsedArgs.fixturesDir ??
          env.BENCH_FIXTURES_DIR ??
          overrides.fixturesDir ??
          fixturesDir,
      ),
    ),
    modelFilter: String(parsedArgs.modelFilter ?? env.BENCH_MODEL_FILTER ?? ""),
    thinking: parsedArgs.thinking ?? env.BENCH_THINKING ?? undefined,
  };
}

/** Config knobs that matter for reproducibility (used in manifests). */
export function reproducibleConfig(config) {
  return {
    schema: config.schema,
    runId: config.runId,
    models: config.models.map(({ id, thinking }) => ({ id, thinking })),
    fixtures: [...config.fixtures],
    trials: config.trials,
    seed: config.seed,
    timeoutMs: config.timeoutMs,
    maxCalls: config.maxCalls,
    piBin: config.piBin,
    extensionPath: config.extensionPath,
    agentDirMode: config.agentDirMode ?? "copied-config",
    copiedConfigFiles: [...(config.copiedConfigFiles ?? AGENT_CONFIG_FILES)],
    settingsForced: config.settingsForced ?? true,
    realAgentDirResolved: Boolean(config.realAgentDirResolved),
    piVersion: config.piVersion ?? null,
  };
}

/** Human/machine validation for the resolved config; returns issues[]. */
export function validateConfig(config) {
  const issues = [];
  if (!config.models || config.models.length === 0) {
    issues.push("No models selected (use --model or --model-filter).");
  }
  if (config.trials < 1) issues.push("trials must be >= 1.");
  if (config.seed < 0 || !Number.isInteger(config.seed)) {
    issues.push("seed must be a non-negative integer.");
  }
  if (config.timeoutMs < 100) issues.push("timeout must be >= 100 ms.");
  if (config.maxCalls < 1) issues.push("max-calls must be >= 1.");
  if (config.fixtures.length === 0) issues.push("No fixtures selected.");
  if (!validateRunId(config.runId)) {
    issues.push(
      `run id "${truncate(config.runId, 40)}" is not a safe directory name ` +
        `(letters/digits/._- , alphanumeric start, max 81 chars).`,
    );
  }
  if (!existsSync(config.extensionPath)) {
    issues.push(
      `Better-arm extension entry ${config.extensionPath} is MISSING.`,
    );
  }
  if (!existsSync(config.agentDir)) {
    issues.push(`Agent dir ${config.agentDir} does not exist (--agent-dir).`);
  } else {
    const copied = AGENT_CONFIG_FILES.filter((name) =>
      existsSync(join(config.agentDir, name)),
    );
    if (copied.length === 0) {
      issues.push(
        `No copyable config/auth files found in ${config.agentDir}; model auth may fail.`,
      );
    }
  }
  return issues;
}

/** Format a number of bytes for human output. */
export function formatBytes(bytes) {
  if (bytes == null || !Number.isFinite(bytes)) return "—";
  const rounded = Math.round(bytes * 10) / 10;
  if (bytes < 1024) return `${rounded} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/** Format milliseconds for human output. */
export function formatMs(ms) {
  if (ms == null || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

function pickList(overrides, parsed, envList, fallback) {
  if (Array.isArray(overrides) && overrides.length > 0) return [...overrides];
  if (Array.isArray(parsed) && parsed.length > 0) return [...parsed];
  if (envList.length > 0) return [...envList];
  if (overrides !== undefined && !Array.isArray(overrides)) return overrides;
  return [...fallback];
}

function commaList(value) {
  if (value === undefined || value === null) return [];
  return String(value)
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * pi can stay a bare command (PATH lookup); anything that looks like a path
 * (contains a separator, or is ~/.-relative) is normalized to absolute.
 */
function resolveBinary(value) {
  const text = String(value).trim();
  if (
    text.includes("/") ||
    text.includes("\\") ||
    text.startsWith("~") ||
    text.startsWith(".")
  ) {
    return normalizePath(text);
  }
  return text;
}

export function toPositiveInt(value, fallback, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) {
    if (value !== undefined && value !== "") {
      process.stderr.write(
        `WARN: invalid ${label} "${truncate(value, 40)}", using ${fallback}\n`,
      );
    }
    return fallback;
  }
  return Math.round(parsed);
}
