// Report + publication sanitization: pure, deterministic, allowlisted.

import { describe, expect, test } from "vitest";
import {
  computePublicBundle,
  sanitizeArm,
  sanitizeManifest,
  computeChecksums,
} from "../publish.mjs";
import { generateReport } from "../report.mjs";

function fakeArm(overrides = {}) {
  return {
    arm: "better",
    model: { id: "provider/m-1", thinking: "low" },
    fixture: "two-splices",
    trial: 0,
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:00:05.000Z",
    wallMs: 5000,
    exitCode: 0,
    killReason: null,
    outcome: "completed",
    outcomeDetail: null,
    reported: { provider: "provider", model: "m-1" },
    events: [
      { type: "tool_execution_start", id: "e1", name: "edit", argsBytes: 120 },
      {
        type: "auto_retry_start",
        attempt: 1,
        maxAttempts: 3,
        errorMessage: "upstream 429",
      },
    ],
    metrics: {
      tokens: {
        input: 100,
        output: 50,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 0,
        total: 150,
        costTotal: 0.02,
        source: "cumulative",
      },
      toolCalls: {
        total: 2,
        read: 1,
        edit: 1,
        errors: 0,
        byName: { read: 1, edit: 1 },
      },
      editArgsBytes: 120,
      readArgsBytes: 60,
      firstEdit: { status: "success", argsBytes: 120, index: 1 },
    },
    errors: {
      parse: [],
      unknownEventTypes: 0,
      provider: [
        {
          kind: "auto_retry",
          attempt: 1,
          message: "sk-fake-token-abcdef0123456789 /Users/me/.pi/agent",
        },
      ],
      assistant: [],
      stderrTail: "runtime error at /private/tmp/x\n",
    },
    tree: {
      match: true,
      score: 1,
      missing: [],
      extra: [],
      changed: [],
      actualTotalBytes: 200,
      expectedTotalBytes: 200,
    },
    ...overrides,
  };
}

function fakeRaw() {
  return {
    schema: "pi-better-read-edit-bench/v1",
    runId: "run-test",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:01:00.000Z",
    models: [
      { id: "provider/m-1", thinking: "low" },
      { id: "other/n-2", thinking: "off" },
    ],
    fixtures: ["two-splices"],
    trials: 1,
    seed: 1,
    timeoutMs: 300000,
    maxCalls: 200,
    piBin: "pi",
    piVersion: "0.0.0-test",
    extensionPath:
      "/Users/me/pi-kaush/extensions/pi-better-read-edit/src/index.ts",
    agentDirMode: "copied-config",
    copiedConfigFiles: ["auth.json", "models.json"],
    settingsForced: true,
    realAgentDirResolved: true,
    extension: { entry: "src/index.ts", sourceDigest: "c".repeat(64) },
    fixtureFacts: {
      "two-splices": {
        descriptorSha256: "b".repeat(64),
        startTree: {
          totalBytes: 200,
          files: { "src/greeting.ts": { bytes: 199, sha256: "a".repeat(64) } },
        },
        expectedTree: {
          totalBytes: 200,
          files: { "src/greeting.ts": { bytes: 199, sha256: "a".repeat(64) } },
        },
      },
    },
    arms: [
      fakeArm(),
      fakeArm({ arm: "builtin", model: { id: "other/n-2", thinking: "off" } }),
    ],
  };
}

describe("sanitization allowlist", () => {
  test("sanitizeArm drops events, error strings, prose, and absolute paths", () => {
    const clean = sanitizeArm(fakeArm());
    const serialized = JSON.stringify(clean);
    expect(serialized).not.toContain("tool_execution_start");
    expect(serialized).not.toContain("upstream 429");
    expect(serialized).not.toContain("sk-fake-token");
    expect(serialized).not.toContain("/Users/me");
    expect(serialized).not.toContain("stderr");
    expect(clean.metrics.firstEdit).toEqual({ status: "success" });
    expect(clean.metrics.toolCalls.errors).toBe(0);
    expect(clean.events).toBeUndefined();
    expect(clean.errors).toBeUndefined();
    expect(clean.reported).toEqual({ provider: "provider", model: "m-1" });
  });

  test("sanitizeArm keeps non-secret tree evidence: changed hashes and bytes", () => {
    const changed = [
      {
        path: "a.ts",
        actualSha256: "a".repeat(64),
        expectedSha256: "b".repeat(64),
        actualBytes: 10,
        expectedBytes: 11,
      },
    ];
    const clean = sanitizeArm(
      fakeArm({
        tree: {
          match: false,
          score: 0,
          missing: ["gone.ts"],
          extra: [],
          changed,
          actualTotalBytes: 200,
          expectedTotalBytes: 200,
        },
      }),
    );
    expect(clean.treeDiff.missing).toEqual(["gone.ts"]);
    expect(clean.treeDiff.changed).toEqual(changed);
    expect(JSON.stringify(clean.treeDiff.changed[0])).not.toContain("DUMMY");
    expect(clean.treeDiff.changed[0].actualSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("sanitizeManifest keeps numbers and names, no extension path", () => {
    const manifest = sanitizeManifest(fakeRaw());
    const serialized = JSON.stringify(manifest);
    expect(serialized).not.toContain("/Users/me");
    expect(serialized).not.toContain("src/index.ts");
    expect(manifest.config.models).toHaveLength(2);
    expect(manifest.config.trials).toBe(1);
    expect(manifest.config.agentDirMode).toBe("copied-config");
    expect(manifest.fixtures["two-splices"].expectedTree).toEqual({
      totalBytes: 200,
      files: { "src/greeting.ts": { bytes: 199, sha256: "a".repeat(64) } },
    });
  });

  test("computePublicBundle is deterministic and report has no undefined/NaN", () => {
    const raw = fakeRaw();
    const first = computePublicBundle(raw);
    const second = computePublicBundle(raw);
    expect(second.manifest).toEqual(first.manifest);
    expect(second.results).toEqual(first.results);
    expect(second.report).toBe(first.report);
    expect(first.report).not.toMatch(/undefined|NaN/);
  });

  test("checksums are deterministic and line-formatted", () => {
    const a = computeChecksums({ "a.txt": "hello", "b.txt": "world" });
    const b = computeChecksums({ "a.txt": "hello", "b.txt": "world" });
    expect(a).toBe(b);
    const lines = a.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^[0-9a-f]{64}  a.txt$/);
  });
});

describe("generateReport", () => {
  test("renders headline, summary, per-fixture tables and classifications", () => {
    const { manifest, results } = computePublicBundle(fakeRaw());
    const report = generateReport({ manifest, results });
    expect(report).toContain("# run-test");
    expect(report).toContain("two-splices");
    expect(report).toContain("better");
    expect(report).toContain("builtin");
    expect(report).toContain("provider/m-1");
    expect(report).toContain("Comparable completed pairs");
    expect(report).toContain("Outcome codes");
    expect(report).toContain("| Arm | Attempts | Completed |");
  });

  test("excludes non-completed pairs from the A/B headline", () => {
    const raw = fakeRaw();
    raw.arms = [
      fakeArm(),
      fakeArm({ arm: "builtin" }),
      fakeArm({
        arm: "better",
        fixture: "failed-case",
        outcome: "assistant-error",
        tree: { ...fakeArm().tree, match: false, score: 0 },
      }),
      fakeArm({ arm: "builtin", fixture: "failed-case" }),
    ];
    const { manifest, results } = computePublicBundle(raw);
    const report = generateReport({ manifest, results });
    expect(report).toContain("Comparable completed pairs: **1 / 2**");
    expect(report).toContain("better was exact in **1/1**");
    expect(report).toContain("builtin in **1/1**");
  });
  test("reports failed arms under failures and truncates notes on mismatch", () => {
    const raw = fakeRaw();
    raw.arms[0] = fakeArm({
      outcome: "timeout",
      tree: {
        match: false,
        score: 0,
        missing: ["x.ts"],
        extra: [],
        changed: [],
        actualTotalBytes: 1,
        expectedTotalBytes: 2,
      },
    });
    const { manifest, results } = computePublicBundle(raw);
    const report = generateReport({ manifest, results });
    expect(report).toContain("## Failures and classifications");
    expect(report).toContain("timeout");
    expect(report).toContain("1 tree file(s) differ");
  });

  test("per-model table appears with multiple models, omitted with one", () => {
    const single = fakeRaw();
    single.arms = [fakeArm()];
    const { manifest, results } = computePublicBundle(single);
    expect(generateReport({ manifest, results })).not.toContain("### By model");

    const multi = fakeRaw();
    const { manifest: multiManifest, results: multiResults } =
      computePublicBundle(multi);
    expect(
      generateReport({ manifest: multiManifest, results: multiResults }),
    ).toContain("### By model");
  });
});

describe("markdown escaping", () => {
  test("identifiers with pipes/backslashes/newlines are escaped in tables", () => {
    const raw = fakeRaw();
    raw.runId = "run|evil\\name";
    raw.models = [{ id: "pipe/provider|model", thinking: "off" }];
    raw.arms = [
      fakeArm({
        model: { id: "pipe/provider|model", thinking: "off" },
        fixture: "bad|fixture",
        outcome: "completed",
        reported: { provider: "p", model: "m" },
      }),
    ];
    const { manifest, results } = computePublicBundle(raw);
    const report = generateReport({ manifest, results });
    // Raw separator characters never leak into table text unescaped.
    expect(report).not.toContain("provider|model");
    expect(report).not.toContain("bad|fixture");
    // Escaped forms appear (backslash-pipe).
    expect(report).toContain("provider\\|model");
    expect(report).toContain("bad\\|fixture");
    expect(report).toContain("run\\|evil\\\\name");
    // Every table row is well-formed: >= 3 pipes to close 4+ cells.
    for (const row of report
      .split("\n")
      .filter((line) => line.startsWith("|"))) {
      expect(row.split("|").length).toBeGreaterThanOrEqual(4);
    }
  });
});
