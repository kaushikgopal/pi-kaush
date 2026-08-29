// Orchestrator: plans the slot schedule, runs every arm with isolation +
// journals, and assembles the private run directory:
//
//   runs/<runId>/          chmod 0700
//     manifest.json        0600: reproducible config + fixture facts
//     raw.json             0600: normalized per-arm records (events, trees)
//     arms/*.jsonl         0600: per-arm streaming journals
//
// Workspace/agent scratch lives in the SYSTEM temp dir (os.tmpdir), never
// inside the repository. Nothing is written anywhere else; the published/
// bundle is produced by the separate publish command.

import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveModels } from "./models.mjs";
import {
  filterFixtureNames,
  fixtureNames,
  loadFixtures,
  materializeFiles,
} from "./fixtures.mjs";
import { planSlots, expandSlotArms, slotLabel } from "./scheduler.mjs";
import { runArm, buildPiArgs } from "./runner.mjs";
import { treeRecord, snapshotTree } from "./workspace.mjs";
import { aggregateArmRuns } from "./scoring.mjs";
import {
  AGENT_CONFIG_FILES,
  reproducibleConfig,
  validateConfig,
} from "./config.mjs";
import { digestTreeFiles, extensionRoot, isoNow } from "./util.mjs";

/** Print the deterministic plan without spawning anything. */
export async function dryRun(config, io = console) {
  const { models, fixtures } = await resolvePlanInputs(config);
  config.models = models;
  const issues = validateConfig(config);
  validateExistingAuth(config);
  const slots = planSlots({
    models,
    fixtures: fixtures.map((f) => f.name),
    trials: config.trials,
    seed: config.seed,
  });
  io.log(`DRY RUN — ${slots.length} slot(s), ${slots.length * 2} arm run(s)`);
  io.log(
    `Counterbalance: arm order alternates per trial and, at 1 trial, across adjacent cells.`,
  );
  for (const slot of slots) {
    for (const arm of expandSlotArms(slot)) {
      const argv = buildPiArgs({
        arm: arm.arm,
        model: arm.model,
        extensionPath: config.extensionPath,
        prompt: "<fixture prompt>",
      });
      io.log(slotLabel(arm));
      io.log(
        `  cwd: <fresh-workspace in system temp>  PI_CODING_AGENT_DIR: <private 0700 agent dir>`,
      );
      io.log(`  ${config.piBin} ${argv.join(" ")}`);
    }
  }
  io.log(`extension: ${config.extensionPath}`);
  io.log(
    `agent dir: copies ${AGENT_CONFIG_FILES.join(", ")} (0600) + forced settings.json ` +
      `(betterReadEdit.avoidModels: []) — no symlinks, contents never read.`,
  );
  if (issues.length > 0) {
    throw new Error(
      `Bench config invalid:\n${issues.map((issue) => `  - ${issue}`).join("\n")}`,
    );
  }
  return slots;
}

/** Resolve models + fixtures for a config, validating names. */
export async function resolvePlanInputs(config) {
  const models = resolveModels({
    specs: config.models ?? [],
    filter: config.modelFilter,
    thinking: config.thinking,
  });
  const names = filterFixtureNames(
    config.fixtures,
    await fixtureNames(config.fixturesDir),
  );
  const fixtures = await loadFixtures(names, config.fixturesDir);
  return { models, fixtures, names };
}

/** Run the full bench, returning { runDir, raw, arms, summary }. */
export async function runBench(config, io = console) {
  const { models, fixtures } = await resolvePlanInputs(config);
  config.models = models;
  const issues = validateConfig(config);
  if (issues.length > 0) {
    throw new Error(
      `Bench config invalid:\n${issues.map((issue) => `  - ${issue}`).join("\n")}`,
    );
  }
  validateExistingAuth(config);

  const runDir = join(config.runsDir, config.runId);
  config.runDir = runDir;
  if (existsSync(runDir)) {
    throw new Error(
      `Run directory already exists: ${runDir} (pick --run-id or remove it).`,
    );
  }
  await mkdir(runDir, { recursive: true });
  await chmod(runDir, 0o700);

  const startedAt = isoNow();
  io.log(
    `Run ${config.runId} — ${models.length} model(s) × ${fixtures.length} fixture(s) × ${config.trials} trial(s)`,
  );

  // Fixture facts (expected trees, start trees, descriptor hashes) are
  // snapshotted and cached BEFORE any arm runs: scoring compares against
  // byte-exact tree records, and the manifest records the same evidence.
  const tmpBaseDir = await mkdtemp(join(tmpdir(), "bre-bench-"));
  const fixtureFacts = {};
  try {
    for (const fixture of fixtures) {
      fixtureFacts[fixture.name] = await snapshotFixtureFacts(
        fixture,
        tmpBaseDir,
      );
    }

    const slots = planSlots({
      models,
      fixtures: fixtures.map((f) => f.name),
      trials: config.trials,
      seed: config.seed,
    });
    const arms = [];
    const realAgentDir = config.agentDir;
    const copiedNames = AGENT_CONFIG_FILES.filter((name) =>
      existsSync(join(realAgentDir, name)),
    );
    const byFixture = new Map(
      fixtures.map((fixture) => [fixture.name, fixture]),
    );

    const total = slots.length * 2;
    let done = 0;
    for (const slot of slots) {
      for (const arm of expandSlotArms(slot)) {
        done += 1;
        io.log(`[${done}/${total}] ${slotLabel(arm)}`);
        const fixture = byFixture.get(arm.fixture);
        const armResult = await runArm({
          config,
          slot: arm,
          fixture,
          expectedTree: fixtureFacts[arm.fixture].expectedTree,
          tmpBaseDir,
          realAgentDir,
          onEvent: ({ type, event }) => {
            if (
              type === "event" &&
              (event.type === "tool_execution_start" ||
                event.type === "auto_retry_start")
            ) {
              io.log(
                `  ↳ ${event.type === "tool_execution_start" ? `tool ${event.name}` : `provider retry ${event.attempt}`}`,
              );
            }
          },
        });
        arms.push(armResult);
        io.log(
          `  ↳ ${armResult.outcome}${armResult.tree.match ? " + tree=EXACT" : " + tree=MISMATCH"}` +
            ` (${armResult.wallMs} ms, tools=${armResult.metrics.toolCalls.total}, tokens=${armResult.metrics.tokens.total})`,
        );
      }
    }

    const piVersion = await detectPiVersion(config.piBin);
    config.piVersion = piVersion;
    const extensionDigest = await digestTreeFiles(
      join(extensionRoot(), "src"),
    ).catch(() => null);

    const manifest = {
      schema: config.schema,
      runId: config.runId,
      startedAt,
      endedAt: isoNow(),
      ...reproducibleConfig(config),
      copiedConfigFiles: copiedNames,
      fixtureFacts,
      extension: {
        entry: "src/index.ts",
        sourceDigest: extensionDigest,
      },
    };

    const raw = { ...manifest, arms };
    await writeFile(
      join(runDir, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { mode: 0o600 },
    );
    await writeFile(
      join(runDir, "raw.json"),
      `${JSON.stringify(raw, null, 2)}\n`,
      { mode: 0o600 },
    );

    const summary = summarize(arms);
    if (config.keepWorkspaces) {
      io.log(`Workspaces kept under ${tmpBaseDir} (--keep-workspaces).`);
    } else {
      await rm(tmpBaseDir, { recursive: true, force: true });
    }
    return { runDir, raw, arms, summary };
  } catch (error) {
    if (!config.keepWorkspaces) {
      await rm(tmpBaseDir, { recursive: true, force: true }).catch(() => {});
    }
    throw error;
  }
}

/** Compact console summary of a finished run. */
export function summarize(arms) {
  const byFixtureArm = new Map();
  for (const arm of arms) {
    const key = `${arm.fixture}::${arm.arm}`;
    const bucket = byFixtureArm.get(key) ?? [];
    bucket.push(arm);
    byFixtureArm.set(key, bucket);
  }
  const rows = [];
  for (const [key, bucket] of [...byFixtureArm.entries()].sort()) {
    const [fixture, arm] = key.split("::");
    const agg = aggregateArmRuns(bucket);
    rows.push({
      fixture,
      arm,
      trials: agg.trials,
      passed: agg.passed,
      outcomes: agg.outcomes,
      medianWallMs: Math.round(agg.medianWallMs ?? 0),
      meanToolCalls: round1(agg.meanToolCalls),
      meanEditBytes: Math.round(agg.meanEditArgsBytes ?? 0),
      sumTokens: agg.sumTokens,
    });
  }
  return {
    rows,
    arms: arms.length,
    passed: arms.filter((a) => a.tree.match).length,
  };
}

function round1(value) {
  return value == null ? null : Math.round(value * 10) / 10;
}

/** Query the pi binary version once per run (best effort). */
async function detectPiVersion(piBin) {
  return new Promise((resolve) => {
    execFile(piBin, ["--version"], { timeout: 5_000 }, (error, stdout) => {
      if (error) return resolve(null);
      resolve(String(stdout).trim().split("\n")[0] || null);
    });
  });
}

/**
 * Snapshot a fixture's start and expected trees into compact records.
 * Both are materialized fresh (proving generator determinism in-process)
 * and hashed; only the tree records (bytes + sha256) are kept.
 */
async function snapshotFixtureFacts(fixture, tmpBaseDir) {
  const dir = await mkdtemp(join(tmpBaseDir, `facts-${fixture.name}-`));
  try {
    const startDir = join(dir, "start");
    const expectedDir = join(dir, "expected");
    await mkdir(startDir, { recursive: true });
    await mkdir(expectedDir, { recursive: true });
    await materializeFiles(startDir, fixture.startFiles);
    await materializeFiles(expectedDir, fixture.expectedFiles);
    const startTree = treeRecord(await snapshotTree(startDir));
    const expectedTree = treeRecord(await snapshotTree(expectedDir));
    return {
      descriptorSha256: fixture.descriptorSha256,
      startTree,
      expectedTree,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Refuse to run when no config/auth sources exist at all. */
function validateExistingAuth(config) {
  const present = AGENT_CONFIG_FILES.filter((name) =>
    existsSync(join(config.agentDir, name)),
  );
  if (present.length === 0) {
    throw new Error(
      `No ${AGENT_CONFIG_FILES.join("/")} found in ${config.agentDir}; ` +
        `provider auth cannot work. Pass --agent-dir or set PI_CODING_AGENT_DIR.`,
    );
  }
}
