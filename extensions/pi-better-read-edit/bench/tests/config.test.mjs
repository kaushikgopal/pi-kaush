// Config resolution: env-var knobs, path normalization, run-id safety.

import { afterEach, describe, expect, test } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  AGENT_CONFIG_FILES,
  FORCED_SETTINGS,
  defaultAgentDir,
  resolveConfig,
  validateConfig,
} from "../config.mjs";
import { resolveModels } from "../models.mjs";
import { assertPathWithin, normalizePath, validateRunId } from "../util.mjs";

const kept = new Map();
function setEnv(key, value) {
  if (!kept.has(key)) kept.set(key, process.env[key]);
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
afterEach(() => {
  for (const [key, value] of kept) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  kept.clear();
});

describe("BENCH_* env knobs", () => {
  test("BENCH_MODEL and BENCH_FIXTURE select models/fixtures", () => {
    setEnv("BENCH_MODEL", "openai/gpt-4o:low, anthropic/claude");
    setEnv("BENCH_FIXTURE", "two-splices, large-delete");
    const config = resolveConfig({}, {});
    expect(resolveModels({ specs: config.models }).map((m) => m.id)).toEqual([
      "openai/gpt-4o",
      "anthropic/claude",
    ]);
    expect(config.fixtures).toEqual(["two-splices", "large-delete"]);
  });

  test("CLI flags beat env vars, env beats defaults", () => {
    setEnv("BENCH_MODEL", "openai/gpt-4o");
    setEnv("BENCH_FIXTURE", "large-delete");
    const config = resolveConfig({}, { models: ["x/y"], fixtures: ["z"] });
    expect(config.models).toEqual(["x/y"]);
    expect(config.fixtures).toEqual(["z"]);
  });

  test("BENCH_RUN_ID, BENCH_PUBLISHED_DIR, BENCH_FIXTURES_DIR are honored", () => {
    const override = {
      runsDir: "/nonexistent/overrides/runs",
      publishedDir: "/nonexistent/overrides/published",
      fixturesDir: "/nonexistent/overrides/fixtures",
      agentDir: "/nonexistent/overrides/agent",
    };
    setEnv("BENCH_RUN_ID", "env-run");
    setEnv("BENCH_RUNS_DIR", override.runsDir);
    setEnv("BENCH_PUBLISHED_DIR", override.publishedDir);
    setEnv("BENCH_FIXTURES_DIR", override.fixturesDir);
    setEnv("BENCH_AGENT_DIR", override.agentDir);
    const config = resolveConfig({}, {});
    expect(config.runId).toBe("env-run");
    expect(config.runsDir).toBe(override.runsDir);
    expect(config.publishedDir).toBe(override.publishedDir);
    expect(config.fixturesDir).toBe(override.fixturesDir);
    expect(config.agentDir).toBe(override.agentDir);
  });
});

describe("path normalization", () => {
  test("normalizePath expands ~ and resolves relative paths", () => {
    expect(normalizePath("~")).toBe(homedir());
    expect(normalizePath("~/x/y")).toBe(join(homedir(), "x", "y"));
    expect(normalizePath("rel/dir")).toBe(join(process.cwd(), "rel", "dir"));
  });

  test("bare pi stays a PATH command; path-like pi binaries resolve", () => {
    setEnv("BENCH_PI_BIN", "pi");
    expect(resolveConfig({}, {}).piBin).toBe("pi");
    setEnv("BENCH_PI_BIN", "~/bin/pi");
    expect(resolveConfig({}, {}).piBin).toBe(join(homedir(), "bin", "pi"));
    setEnv("BENCH_PI_BIN", "./pi");
    expect(resolveConfig({}, {}).piBin).not.toBe("./pi");
  });

  test("defaultAgentDir respects PI_CODING_AGENT_DIR", () => {
    setEnv("PI_CODING_AGENT_DIR", join(homedir(), "custom-agent"));
    expect(defaultAgentDir()).toBe(join(homedir(), "custom-agent"));
  });
});

describe("run id + path containment validation", () => {
  test("validateRunId accepts safe names and rejects traversal/dots/slashes", () => {
    expect(validateRunId("run-2026-01-01T00-00-00Z")).toBe(true);
    expect(validateRunId("a.b_c")).toBe(true);
    expect(validateRunId("..")).toBe(false);
    expect(validateRunId("a/b")).toBe(false);
    expect(validateRunId("")).toBe(false);
    expect(validateRunId(".hidden")).toBe(false);
    expect(validateRunId("a".repeat(90))).toBe(false);
  });

  test("assertPathWithin rejects escapes", () => {
    expect(assertPathWithin("/base", "/base/run-1")).toBe("/base/run-1");
    expect(() => assertPathWithin("/base", "/base/../etc/passwd")).toThrow(
      /outside its base/,
    );
    expect(() => assertPathWithin("/base", "/elsewhere")).toThrow(
      /outside its base/,
    );
  });

  test("validateConfig flags bad run ids", () => {
    const config = resolveConfig(
      {
        models: [{ id: "a/b", thinking: "off" }],
        agentDir: "/nonexistent",
        extensionPath: "/nonexistent/index.ts",
        runId: "../evil",
      },
      {},
    );
    const issues = validateConfig(config);
    expect(issues.some((issue) => /run id/.test(issue))).toBe(true);
  });

  test("forced settings contract is stable", () => {
    expect(FORCED_SETTINGS).toEqual({ betterReadEdit: { avoidModels: [] } });
    expect(AGENT_CONFIG_FILES).toEqual([
      "auth.json",
      "models.json",
      "models-store.json",
    ]);
  });
});
