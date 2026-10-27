import { readFile, lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export type FirefoxRuntimeConfig = {
  binaryPath: string;
  timeoutMs: number;
  maxOutputBytes: number;
  summaryMaxBytes: number;
  scopedMaxBytes: number;
  settleTimeoutMs: number;
  statePath: string;
  screenshotDir: string;
  logPath: string;
  logLevel: "off" | "error" | "debug";
  namespace: string | null;
  agentId: string | null;
  defaultSession: string;
  defaultContainerId: string | null;
  containerNames: Record<string, string>;
};
export type FirefoxConfigResult =
  | { ok: true; config: FirefoxRuntimeConfig }
  | {
      ok: false;
      code: "config_invalid" | "config_read_failed" | "project_config_unsafe";
      message: string;
    };

const PROJECT_KEYS = new Set([
  "timeoutMs",
  "maxOutputBytes",
  "summaryMaxBytes",
  "scopedMaxBytes",
  "settleTimeoutMs",
]);
const STRING_KEYS = new Set([
  "binaryPath",
  "statePath",
  "screenshotDir",
  "logPath",
  "defaultSession",
]);
const OPTIONAL_STRING_KEYS = new Set([
  "namespace",
  "agentId",
  "defaultContainerId",
]);
const LIMITS: Record<string, readonly [number, number]> = {
  timeoutMs: [1, 120_000],
  maxOutputBytes: [4096, 10_000_000],
  summaryMaxBytes: [256, 16_000],
  scopedMaxBytes: [256, 16_000],
  settleTimeoutMs: [1, 30_000],
};
const ENV = {
  FFX_FIREFOX_CLI: "binaryPath",
  FFX_TIMEOUT_MS: "timeoutMs",
  FFX_MAX_OUTPUT_BYTES: "maxOutputBytes",
  FFX_MAX_BYTES: "summaryMaxBytes",
  FFX_SCOPED_MAX_BYTES: "scopedMaxBytes",
  FFX_SETTLE_TIMEOUT_MS: "settleTimeoutMs",
  FFX_STATE_PATH: "statePath",
  FFX_SCREENSHOT_DIR: "screenshotDir",
  FFX_LOG_PATH: "logPath",
  FFX_LOG_LEVEL: "logLevel",
  FFX_NAMESPACE: "namespace",
  FFX_AGENT_ID: "agentId",
  FFX_SESSION: "defaultSession",
  FFX_CONTAINER: "defaultContainerId",
} as const;

export async function loadFirefoxConfig(
  options: {
    cwd?: string;
    env?: Record<string, string | undefined>;
    home?: string;
  } = {},
): Promise<FirefoxConfigResult> {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const cwd = resolve(options.cwd ?? process.cwd());
  const configRoot = env.XDG_CONFIG_HOME || join(home, ".config");
  const cacheRoot = env.XDG_CACHE_HOME || join(home, ".cache");
  const base = join(cacheRoot, "firefox-agent");
  const defaults: FirefoxRuntimeConfig = {
    binaryPath: "firefox-cli",
    timeoutMs: 10_000,
    maxOutputBytes: 128_000,
    summaryMaxBytes: 4000,
    scopedMaxBytes: 16_000,
    settleTimeoutMs: 2000,
    statePath: join(base, "sessions.json"),
    screenshotDir: join(base, "screenshots"),
    logPath: join(base, "events.jsonl"),
    logLevel: "off",
    namespace: null,
    agentId: null,
    defaultSession: "default",
    defaultContainerId: null,
    containerNames: {},
  };
  try {
    const globalPath = env.FFX_CONFIG
      ? resolve(cwd, env.FFX_CONFIG)
      : join(configRoot, "firefox-agent", "config.json");
    const global = await readConfig(globalPath, Boolean(env.FFX_CONFIG));
    const project = await readConfig(join(cwd, ".pi-firefox.json"), false);
    if (Object.keys(project).some((key) => !PROJECT_KEYS.has(key))) {
      return {
        ok: false,
        code: "project_config_unsafe",
        message:
          "Project Firefox config may set output and timing limits only. Set paths, identity, and containers in trusted user config or FFX environment variables.",
      };
    }
    const overrides: Record<string, unknown> = {};
    for (const [name, key] of Object.entries(ENV)) {
      const value = env[name];
      if (value !== undefined)
        overrides[key] = Object.hasOwn(LIMITS, key) ? Number(value) : value;
    }
    const merged: Record<string, unknown> = {
      ...defaults,
      ...global,
      ...project,
      ...overrides,
    };
    for (const [key, value] of Object.entries(merged)) {
      if (STRING_KEYS.has(key)) {
        if (!safeString(value, key === "defaultSession" ? 80 : 4096))
          return invalid();
      } else if (OPTIONAL_STRING_KEYS.has(key)) {
        if (value !== null && !safeString(value, 200)) return invalid();
      } else if (Object.hasOwn(LIMITS, key)) {
        const bounds = LIMITS[key]!;
        if (
          typeof value !== "number" ||
          !Number.isSafeInteger(value) ||
          value < bounds[0] ||
          value > bounds[1]
        )
          return invalid();
      } else if (key === "logLevel") {
        if (value !== "off" && value !== "error" && value !== "debug")
          return invalid();
      } else if (key === "containerNames") {
        if (
          !record(value) ||
          Object.entries(value).length > 1000 ||
          Object.entries(value).some(
            ([id, label]) => !safeString(id, 200) || !safeString(label, 120),
          )
        )
          return invalid();
      } else return invalid();
    }
    // Validation above refines each field, without accepting executable project settings.
    const config: FirefoxRuntimeConfig = {
      binaryPath: String(merged.binaryPath),
      timeoutMs: Number(merged.timeoutMs),
      maxOutputBytes: Number(merged.maxOutputBytes),
      summaryMaxBytes: Number(merged.summaryMaxBytes),
      scopedMaxBytes: Number(merged.scopedMaxBytes),
      settleTimeoutMs: Number(merged.settleTimeoutMs),
      statePath: resolvePath(String(merged.statePath), home, cwd),
      screenshotDir: resolvePath(String(merged.screenshotDir), home, cwd),
      logPath: resolvePath(String(merged.logPath), home, cwd),
      logLevel:
        merged.logLevel === "debug"
          ? "debug"
          : merged.logLevel === "error"
            ? "error"
            : "off",
      namespace: typeof merged.namespace === "string" ? merged.namespace : null,
      agentId: typeof merged.agentId === "string" ? merged.agentId : null,
      defaultSession: String(merged.defaultSession),
      defaultContainerId:
        typeof merged.defaultContainerId === "string"
          ? merged.defaultContainerId
          : null,
      containerNames: Object.fromEntries(
        Object.entries(
          record(merged.containerNames) ? merged.containerNames : {},
        ).map(([key, value]) => [key, String(value)]),
      ),
    };
    return { ok: true, config };
  } catch (error) {
    if (error instanceof InvalidConfig) return invalid();
    return {
      ok: false,
      code: "config_read_failed",
      message:
        "Firefox configuration could not be read safely. Check the trusted user config and project limits file.",
    };
  }
}

class InvalidConfig extends Error {}
function invalid(): FirefoxConfigResult {
  return {
    ok: false,
    code: "config_invalid",
    message: "Firefox configuration contains invalid or unsupported settings.",
  };
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function safeString(value: unknown, max: number): value is string {
  return (
    typeof value === "string" &&
    value.trim() === value &&
    value.length > 0 &&
    value.length <= max &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}
function resolvePath(value: string, home: string, cwd: string): string {
  if (value.startsWith("~/")) return join(home, value.slice(2));
  return isAbsolute(value) ? value : resolve(cwd, value);
}
async function readConfig(
  path: string,
  required: boolean,
): Promise<Record<string, unknown>> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64_000)
      throw new InvalidConfig();
    const text = await readFile(path, "utf8");
    if (Buffer.byteLength(text) > 64_000) throw new InvalidConfig();
    const data: unknown = JSON.parse(text);
    if (!record(data)) throw new InvalidConfig();
    return data;
  } catch (error) {
    if (
      !required &&
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return {};
    if (error instanceof SyntaxError) throw new InvalidConfig();
    throw error;
  }
}
