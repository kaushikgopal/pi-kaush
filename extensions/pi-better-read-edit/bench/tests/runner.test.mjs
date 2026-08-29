// End-to-end runner/orchestrator tests against a fake pi binary. No live
// model calls anywhere: the fake pi emits canned JSON-mode streams and,
// in happy-edit mode, actually edits the workspace so the tree passes.

import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, describe, expect, test } from "vitest";
import { resolveConfig, AGENT_CONFIG_FILES } from "../config.mjs";
import { runBench } from "../orchestrator.mjs";
import { writePublished } from "../publish.mjs";
import { requestedIdentity, verifyRun } from "../verify.mjs";
import { createIsolation } from "../isolation.mjs";
import { benchDir, extensionRoot, pidAlive, tryJson } from "../util.mjs";

let tmpBase;
let fakePiBin;
let realAgentDir;
const keepEnv = {};
const roots = [];

async function makeFakePiBin(base, { exec }) {
  const fakePiJs = join(benchDir(), "tests", "helpers", "fake-pi.mjs");
  const bin = join(base, "fake-pi-bin");
  const body = exec
    ? `#!/bin/sh\nexec node "${fakePiJs}" "$@"\n`
    : `#!/bin/sh\nnode "${fakePiJs}" "$@"\n`; // no exec: the sh stays alive
  await writeFile(bin, body, { mode: 0o755 });
  return bin;
}

async function makeFakeAgentDir(base) {
  const dir = join(base, "real-agent");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "auth.json"),
    JSON.stringify({ tokens: "DUMMY_AUTH_SECRET_SENTINEL" }),
  );
  await writeFile(
    join(dir, "models.json"),
    JSON.stringify({ providers: { fake: {} } }),
  );
  await writeFile(
    join(dir, "models-store.json"),
    JSON.stringify({ huggingface: { models: {} } }),
  );
  await writeFile(
    join(dir, "settings.json"),
    JSON.stringify({ betterReadEdit: { avoidModels: ["*"] } }),
  );
  return dir;
}

function baseConfig(overrides = {}) {
  return resolveConfig(
    {
      models: [{ id: "fake/model", thinking: "off" }],
      fixtures: ["two-splices"],
      trials: 1,
      seed: 1,
      timeoutMs: 5_000,
      maxCalls: 50,
      piBin: fakePiBin,
      agentDir: realAgentDir,
      runsDir: join(tmpBase, "runs"),
      publishedDir: join(tmpBase, "published"),
      fixturesDir: join(benchDir(), "fixtures"),
      extensionPath: join(extensionRoot(), "src", "index.ts"),
      ...overrides,
    },
    {},
  );
}

function freshRunId() {
  return `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function setMode(mode) {
  keepEnv.prev = process.env.FAKE_PI_MODE;
  process.env.FAKE_PI_MODE = mode;
}

function restoreMode() {
  if (keepEnv.prev === undefined) delete process.env.FAKE_PI_MODE;
  else process.env.FAKE_PI_MODE = keepEnv.prev;
}

function setChildPidfile() {
  keepEnv.prevPidfile = process.env.FAKE_PI_CHILD_PIDFILE;
  process.env.FAKE_PI_CHILD_PIDFILE = join(tmpBase, "grandchild.pid");
  return process.env.FAKE_PI_CHILD_PIDFILE;
}

function restorePidfile() {
  if (keepEnv.prevPidfile === undefined)
    delete process.env.FAKE_PI_CHILD_PIDFILE;
  else process.env.FAKE_PI_CHILD_PIDFILE = keepEnv.prevPidfile;
}

beforeEach(async () => {
  const base = await mkdtemp(join(tmpdir(), "bench-e2e-"));
  roots.push(base);
  tmpBase = base;
  fakePiBin = await makeFakePiBin(base, { exec: true });
  realAgentDir = await makeFakeAgentDir(base);
});

afterEach(async () => {
  restoreMode();
  restorePidfile();
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

/** Wait until a pid is no longer alive (or the timeout elapses). */
async function waitDead(pid, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !pidAlive(pid);
}

test("requested identity preserves slashes inside provider model ids", () => {
  expect(requestedIdentity("huggingface/zai-org/GLM-5.2")).toEqual({
    provider: "huggingface",
    model: "zai-org/GLM-5.2",
  });
});

describe("runBench with fake pi", () => {
  test("happy stream: raw.json, manifest, per-arm journals, isolated arms", async () => {
    setMode("happy");
    const config = baseConfig();
    const { runDir, raw } = await runBench(config, silentIo());
    expect(raw.arms).toHaveLength(2);
    for (const arm of raw.arms) {
      expect(arm.outcome).toBe("completed");
      expect(["better", "builtin"]).toContain(arm.arm);
      expect(arm.metrics.toolCalls.total).toBe(2);
      expect(arm.tree.match).toBe(false); // fake pi never edits the workspace
      expect(arm.metrics.tokens).toMatchObject({ total: 45, source: "summed" });
      // pi-reported identity is captured and matches the requested bare id.
      expect(arm.reported).toEqual({ provider: "fake", model: "model" });
    }
    // Per-arm journals exist and end with an arm_end line.
    const journalFiles = await readdir(join(runDir, "arms"));
    expect(journalFiles.filter((name) => name.endsWith(".jsonl"))).toHaveLength(
      2,
    );
    for (const name of journalFiles) {
      const lines = (await readFile(join(runDir, "arms", name), "utf8"))
        .trim()
        .split("\n");
      expect(JSON.parse(lines[lines.length - 1]).type).toBe("arm_end");
    }
    // Manifest carries fixture facts (descriptor + start/expected trees).
    const manifest = tryJson(
      await readFile(join(runDir, "manifest.json"), "utf8"),
    ).value;
    expect(
      manifest.fixtureFacts["two-splices"].expectedTree.files[
        "src/greeting.ts"
      ],
    ).toBeDefined();
    expect(manifest.fixtureFacts["two-splices"].descriptorSha256).toMatch(
      /^[0-9a-f]{64}$/,
    );
    expect(manifest.copiedConfigFiles).toEqual(AGENT_CONFIG_FILES);
    expect(manifest.agentDirMode).toBe("copied-config");
    expect(manifest.extension.sourceDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  test("auth and settings isolation: private records never contain config contents", async () => {
    setMode("happy");
    const config = baseConfig();
    const { raw } = await runBench(config, silentIo());
    const serialized = JSON.stringify(raw);
    expect(serialized).not.toContain("DUMMY_AUTH_SECRET_SENTINEL");
    expect(serialized).not.toContain("avoidModels");
    expect(serialized).not.toContain(realAgentDir); // real path never recorded
  });

  test("positive end-to-end: fake pi actually edits the workspace and the tree passes", async () => {
    setMode("happy-edit");
    const config = baseConfig();
    const { raw } = await runBench(config, silentIo());
    expect(raw.arms).toHaveLength(2);
    for (const arm of raw.arms) {
      expect(arm.outcome).toBe("completed");
      expect(arm.tree.match).toBe(true);
      expect(arm.tree.score).toBe(1);
      expect(arm.tree.missing).toEqual([]);
      expect(arm.tree.extra).toEqual([]);
      expect(arm.tree.changed).toEqual([]);
    }
  });

  test("timeout kills slow arms and classifies them", async () => {
    setMode("slow");
    const config = baseConfig({ timeoutMs: 500, maxCalls: 500 });
    const { raw } = await runBench(config, silentIo());
    for (const arm of raw.arms) {
      expect(arm.outcome).toBe("timeout");
      expect(arm.killReason).toBe("timeout");
      expect(arm.wallMs).toBeGreaterThanOrEqual(400);
    }
  });

  test("timeout kills the WHOLE process group: a grandchild under a non-exec launcher dies too", async () => {
    fakePiBin = await makeFakePiBin(tmpBase, { exec: false }); // sh + node stay separate
    const pidfile = setChildPidfile();
    setMode("slow");
    const config = baseConfig({ timeoutMs: 500, maxCalls: 500 });
    const { raw } = await runBench(config, silentIo());
    expect(raw.arms).toHaveLength(2);
    for (const arm of raw.arms) {
      expect(arm.outcome).toBe("timeout");
      expect(arm.killReason).toBe("timeout");
    }
    const grandchildPid = Number(
      (await readFile(pidfile, "utf8")).trim().split("\n")[0],
    );
    expect(Number.isInteger(grandchildPid)).toBe(true);
    await expect(waitDead(grandchildPid)).resolves.toBe(true);
  });

  test("max-calls cap triggers AT the cap and kills the process group incl. descendants", async () => {
    fakePiBin = await makeFakePiBin(tmpBase, { exec: false });
    const pidfile = setChildPidfile();
    setMode("spam");
    const config = baseConfig({ maxCalls: 3 });
    const { raw } = await runBench(config, silentIo());
    for (const arm of raw.arms) {
      expect(arm.outcome).toBe("tool-call-limit");
      expect(arm.killReason).toBe("max-calls");
      // cap triggers at >= maxCalls; buffered lines may raise the count.
      expect(arm.metrics.toolCalls.total).toBeGreaterThanOrEqual(3);
      expect(arm.metrics.toolCalls.total).toBeLessThanOrEqual(1000);
    }
    const grandchildPid = Number(
      (await readFile(pidfile, "utf8")).trim().split("\n")[0],
    );
    await expect(waitDead(grandchildPid)).resolves.toBe(true);
  });

  test("oversized protocol lines are bounded and classified", async () => {
    setMode("oversized-output");
    const config = baseConfig({ maxProtocolLineChars: 1_024 });
    const { raw } = await runBench(config, silentIo());
    for (const arm of raw.arms) {
      expect(arm.outcome).toBe("output-limit");
      expect(arm.killReason).toBe("output-limit");
      expect(arm.errors.parse).toEqual([
        expect.objectContaining({ reason: "line-too-large" }),
      ]);
    }
  });

  test("recovered provider retries are not permanent failures", async () => {
    setMode("recovered-retry");
    const config = baseConfig();
    const { raw } = await runBench(config, silentIo());
    for (const arm of raw.arms) {
      expect(arm.outcome).toBe("completed");
      expect(arm.errors.provider.length).toBeGreaterThan(0); // still surfaced
    }
  });

  test("final failed retry classifies as provider-error", async () => {
    setMode("final-retry-fail");
    const config = baseConfig();
    const { raw } = await runBench(config, silentIo());
    for (const arm of raw.arms) {
      expect(arm.outcome).toBe("provider-error");
    }
  });

  test("final lifecycle: an earlier willRetry agent_end is overruled by the completing one", async () => {
    setMode("agent-end-retry");
    const config = baseConfig();
    const { raw } = await runBench(config, silentIo());
    for (const arm of raw.arms) {
      expect(arm.outcome).toBe("completed");
    }
  });

  test("nonzero exit without agent_end classifies as process-error", async () => {
    setMode("nonzero");
    const config = baseConfig();
    const { raw } = await runBench(config, silentIo());
    for (const arm of raw.arms) {
      expect(arm.outcome).toBe("process-error");
      expect(arm.exitCode).toBe(3);
    }
  });

  test("same seed reproduces the same arm order", async () => {
    setMode("happy");
    const config = baseConfig({
      trials: 2,
      fixtures: ["two-splices", "two-files"],
    });
    const first = await runBench(
      baseConfig({ ...config, seed: 42, runId: freshRunId() }),
      silentIo(),
    );
    const second = await runBench(
      baseConfig({ ...config, seed: 42, runId: freshRunId() }),
      silentIo(),
    );
    const key = (run) =>
      run.raw.arms
        .map((arm) => `${arm.arm}.${arm.fixture}.${arm.model.id}.${arm.trial}`)
        .join("|");
    expect(key(second)).toBe(key(first));
  });

  test("dry-run validates and prints the plan without creating a run", async () => {
    const { dryRun } = await import("../orchestrator.mjs");
    const config = baseConfig();
    const out = [];
    await dryRun(config, { log: (line) => out.push(line), error: () => {} });
    expect(out.join("\n")).toContain("DRY RUN");
    expect(out.join("\n")).toContain("--mode json");
    expect(out.join("\n")).toContain("-e "); // better arm loads the extension
    expect(out.join("\n")).toContain("(0600)"); // copy-not-symlink story
    expect(existsSync(join(config.runsDir, config.runId))).toBe(false);
  });

  test("private run artifacts are 0700/0600", async () => {
    setMode("happy");
    const config = baseConfig();
    const { runDir } = await runBench(config, silentIo());
    expect((await stat(runDir)).mode & 0o777).toBe(0o700);
    for (const name of ["manifest.json", "raw.json"]) {
      expect((await stat(join(runDir, name))).mode & 0o777).toBe(0o600);
    }
    expect((await stat(join(runDir, "arms"))).mode & 0o777).toBe(0o700);
    const journals = await readdir(join(runDir, "arms"));
    for (const name of journals) {
      if (name.endsWith(".jsonl")) {
        expect((await stat(join(runDir, "arms", name))).mode & 0o777).toBe(
          0o600,
        );
      }
    }
  });
});

describe("publish + verify round trip", () => {
  test("published bundle regenerates identically and verifies clean", async () => {
    setMode("happy");
    const config = baseConfig();
    const { runDir, raw } = await runBench(config, silentIo());
    await writePublished({
      publishedDir: config.publishedDir,
      runId: config.runId,
      raw,
      io: silentIo(),
    });

    const bundleDir = join(config.publishedDir, config.runId);
    for (const name of [
      "manifest.json",
      "results.json",
      "report.md",
      "checksums.txt",
    ]) {
      expect(existsSync(join(bundleDir, name))).toBe(true);
    }
    const resultsText = await readFile(join(bundleDir, "results.json"), "utf8");
    expect(resultsText).not.toContain("DUMMY_AUTH_SECRET_SENTINEL");
    expect(resultsText).not.toContain("avoidModels");
    expect(resultsText).not.toContain("/Users/");

    const result = await verifyRun({
      runDir,
      publishedDir: config.publishedDir,
      fixturesDir: config.fixturesDir,
      io: silentIo(),
    });
    expect(result.ok).toBe(true);
    const names = result.checks.map((check) => check.name);
    for (const required of [
      "published-file-set",
      "published-checksums",
      "published-results.json",
      "published-report.md",
      "published-projection",
      "published-scoring",
      "fixture-determinism",
      "extension-digest",
    ]) {
      expect(names).toContain(required);
    }
  });

  test("publish is idempotent (atomic replace) and verify still passes", async () => {
    setMode("happy");
    const config = baseConfig();
    const { runDir, raw } = await runBench(config, silentIo());
    await writePublished({
      publishedDir: config.publishedDir,
      runId: config.runId,
      raw,
      io: silentIo(),
    });
    await writePublished({
      publishedDir: config.publishedDir,
      runId: config.runId,
      raw,
      io: silentIo(),
    });
    const result = await verifyRun({
      runDir,
      publishedDir: config.publishedDir,
      fixturesDir: config.fixturesDir,
      io: silentIo(),
    });
    expect(result.ok).toBe(true);
  });

  test("verify rejects extra files and tampered checksums in the bundle", async () => {
    setMode("happy");
    const config = baseConfig();
    const { runDir, raw } = await runBench(config, silentIo());
    await writePublished({
      publishedDir: config.publishedDir,
      runId: config.runId,
      raw,
      io: silentIo(),
    });
    const bundleDir = join(config.publishedDir, config.runId);
    await writeFile(join(bundleDir, "evil.txt"), "tampered\n");

    let result = await verifyRun({
      runDir,
      publishedDir: config.publishedDir,
      fixturesDir: config.fixturesDir,
      io: silentIo(),
    });
    expect(result.ok).toBe(false);
    expect(
      result.checks.some(
        (check) => !check.ok && check.name === "published-file-set",
      ),
    ).toBe(true);
    expect(
      result.checks.some(
        (check) => !check.ok && check.name === "published-extras",
      ),
    ).toBe(true);

    await rm(join(bundleDir, "evil.txt"));
    // Tamper: modify a metric in the published results.json.
    const resultsPath = join(bundleDir, "results.json");
    const results = JSON.parse(await readFile(resultsPath, "utf8"));
    results.arms[0].wallMs = 999999;
    await writeFile(resultsPath, `${JSON.stringify(results, null, 2)}\n`);

    result = await verifyRun({
      runDir,
      publishedDir: config.publishedDir,
      fixturesDir: config.fixturesDir,
      io: silentIo(),
    });
    expect(result.ok).toBe(false);
    expect(
      result.checks.some(
        (check) => !check.ok && check.name === "published-checksums",
      ),
    ).toBe(true);
    expect(
      result.checks.some(
        (check) => !check.ok && check.name === "published-results.json",
      ),
    ).toBe(true);
  });

  test("verify fails on tampered raw: metric recompute, identity, digest", async () => {
    setMode("happy");
    const config = baseConfig();
    const { runDir } = await runBench(config, silentIo());
    const rawPath = join(runDir, "raw.json");
    const raw = JSON.parse(await readFile(rawPath, "utf8"));

    // 1. Stored metrics no longer match a recomputation from events.
    raw.arms[0].metrics.toolCalls.total = 999;
    await writeFile(rawPath, `${JSON.stringify(raw, null, 2)}\n`);
    let result = await verifyRun({
      runDir,
      publishedDir: config.publishedDir,
      fixturesDir: config.fixturesDir,
      io: silentIo(),
    });
    expect(result.ok).toBe(false);
    expect(
      result.checks.some((check) => !check.ok && check.name === "metrics"),
    ).toBe(true);

    // 2. Reported identity that does not match the requested model.
    raw.arms[0].reported.model = "some-other-model";
    await writeFile(rawPath, `${JSON.stringify(raw, null, 2)}\n`);
    result = await verifyRun({
      runDir,
      publishedDir: config.publishedDir,
      fixturesDir: config.fixturesDir,
      io: silentIo(),
    });
    expect(result.ok).toBe(false);
    expect(
      result.checks.some((check) => !check.ok && check.name === "metrics"),
    ).toBe(true);

    // 3. Extension source digest pointing at a different src tree.
    raw.extension.sourceDigest = "0".repeat(64);
    await writeFile(rawPath, `${JSON.stringify(raw, null, 2)}\n`);
    result = await verifyRun({
      runDir,
      publishedDir: config.publishedDir,
      fixturesDir: config.fixturesDir,
      io: silentIo(),
    });
    expect(result.ok).toBe(false);
    expect(
      result.checks.some(
        (check) => !check.ok && check.name === "extension-digest",
      ),
    ).toBe(true);
  });

  test("verify rejects scoring evidence that contradicts the manifest", async () => {
    setMode("happy-edit");
    const config = baseConfig();
    const { runDir, raw } = await runBench(config, silentIo());
    await writePublished({
      publishedDir: config.publishedDir,
      runId: config.runId,
      raw,
      io: silentIo(),
    });
    // Corrupt the published results: claim a tree mismatch with an empty diff.
    const resultsPath = join(config.publishedDir, config.runId, "results.json");
    const results = JSON.parse(await readFile(resultsPath, "utf8"));
    results.arms[0].treeMatch = false;
    results.arms[0].score = 0;
    await writeFile(resultsPath, `${JSON.stringify(results, null, 2)}\n`);
    // checksums.txt is now stale too; rewrite it so only scoring fails.
    const { createHash } = await import("node:crypto");
    const checksumsPath = join(
      config.publishedDir,
      config.runId,
      "checksums.txt",
    );
    const digestLine = async (name) => {
      const content = await readFile(
        join(config.publishedDir, config.runId, name),
      );
      return `${createHash("sha256").update(content).digest("hex")}  ${name}`;
    };
    await writeFile(
      checksumsPath,
      [
        await digestLine("manifest.json"),
        await digestLine("results.json"),
        await digestLine("report.md"),
      ].join("\n") + "\n",
    );
    const result = await verifyRun({
      runDir,
      publishedDir: config.publishedDir,
      fixturesDir: config.fixturesDir,
      io: silentIo(),
    });
    expect(
      result.checks.some(
        (check) => !check.ok && check.name === "published-scoring",
      ),
    ).toBe(true);
  });
});

describe("isolation unit", () => {
  test("copies only existing config/auth files with 0600, forces empty avoidModels, never symlinks", async () => {
    const iso = await createIsolation({
      tmpBaseDir: tmpBase,
      key: "iso-test",
      realAgentDir,
    });
    try {
      expect(iso.copied).toEqual(AGENT_CONFIG_FILES);
      expect(iso.settingsForced).toBe(true);
      expect((await stat(iso.agentDir)).mode & 0o777).toBe(0o700);
      for (const name of AGENT_CONFIG_FILES) {
        const path = join(iso.agentDir, name);
        expect((await lstat(path)).isSymbolicLink()).toBe(false);
        expect((await stat(path)).mode & 0o777).toBe(0o600);
      }
      const settings = JSON.parse(
        await readFile(join(iso.agentDir, "settings.json"), "utf8"),
      );
      expect(settings).toEqual({ betterReadEdit: { avoidModels: [] } });
      expect(
        (await stat(join(iso.agentDir, "settings.json"))).mode & 0o777,
      ).toBe(0o600);
      await iso.cleanup();
      expect(existsSync(iso.workspaceDir)).toBe(false);
      expect(existsSync(iso.agentDir)).toBe(false);
    } finally {
      await rm(iso.workspaceDir, { recursive: true, force: true }).catch(
        () => {},
      );
      await rm(iso.agentDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  test("missing real files are skipped gracefully", async () => {
    const empty = await mkdtemp(join(tmpBase, "empty-agent-"));
    const iso = await createIsolation({
      tmpBaseDir: tmpBase,
      key: "iso-empty",
      realAgentDir: empty,
    });
    try {
      expect(iso.copied).toEqual([]);
      // The forced settings file is still written.
      expect(
        JSON.parse(await readFile(join(iso.agentDir, "settings.json"), "utf8")),
      ).toEqual({ betterReadEdit: { avoidModels: [] } });
    } finally {
      await iso.cleanup();
      await rm(empty, { recursive: true, force: true });
    }
  });
});

function silentIo() {
  return { log: () => {}, error: () => {} };
}
