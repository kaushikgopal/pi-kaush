#!/usr/bin/env node
// pi-better-read-edit bench CLI.
//
// Commands:
//   bench (default)   run the full A/B bench (better extension vs builtin)
//   publish <runId>   write the sanitized public bundle + checksums
//   report <runId>    regenerate report.md from raw.json (private runs dir)
//   verify <runId>    independently re-check a run and its bundle
//
// Usage examples (from the extension folder):
//   npm run bench                                        # full default matrix
//   npm run bench -- --dry-run                           # plan only, no calls
//   npm run bench -- --fixture two-splices --trials 1    # one fixture, 2 arms
//   npm run bench -- --model open-weights/qwen3.7-plus   # override matrix
//   npm run bench -- --model-filter "*luna*,GLM*"         # narrow matrix
//   npm run bench -- --timeout 120 --max-calls 100       # safety knobs
//   npm run bench -- publish <runId>
//   npm run bench -- report <runId> --output report.md
//   npm run bench -- verify <runId>
//
// Env-var equivalents (all optional): BENCH_MODEL, BENCH_FIXTURE,
// BENCH_MODEL_FILTER, BENCH_THINKING, BENCH_TRIALS, BENCH_SEED,
// BENCH_TIMEOUT_MS, BENCH_MAX_CALLS, BENCH_PI_BIN, BENCH_RUNS_DIR,
// BENCH_PUBLISHED_DIR, BENCH_FIXTURES_DIR, BENCH_RUN_ID, BENCH_AGENT_DIR,
// BENCH_EXTENSION_PATH, BENCH_DRY_RUN.
//
// Exit policy: `bench` exits nonzero only for an unusable infra/protocol
// run (pi could not start or no arm produced a usable protocol stream).
// Model-level failures — provider errors, timeouts, wrong trees — stay
// reportable and exit 0. publish/report/verify exit nonzero on any error
// or verification mismatch.
//
// Live model calls only happen under `bench`. publish/report/verify read
// existing run artifacts; tests never invoke live models.

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveConfig } from "./config.mjs";
import { runBench, dryRun } from "./orchestrator.mjs";
import {
  computePublicBundle,
  writePublished,
  writeReport,
} from "./publish.mjs";
import { verifyRun } from "./verify.mjs";
import { isUnusableOutcome } from "./protocol.mjs";
import { assertPathWithin, tryJson, validateRunId } from "./util.mjs";

const HELP = `
pi-better-read-edit bench — A/B the local extension against builtin read/edit.

Usage:
  node bench/cli.mjs [command] [options]

Commands:
  bench                 run the full bench (default)
  publish <runId>       sanitized public bundle under bench/published/<runId>/
  report <runId>        regenerate report.md from raw.json (default runs/<runId>/report.md)
  verify <runId>        re-check raw.json + published bundle

Bench options:
  --fixture <name>      repeatable; default all fixtures
  --model <id[:thinking]>  repeatable; replaces the default model matrix
  --model-filter <g>    comma-separated globs narrowing the matrix
  --thinking <level>    override thinking for every selected model
  --trials <n>          trials per model×fixture cell (default 1)
  --seed <n>            deterministic slot shuffle (default 1)
  --timeout <sec>       per-arm timeout (default 300)
  --max-calls <n>       per-arm tool-call safety cap (default 200, >= triggers)
  --dry-run             print the plan; spawn nothing
  --run-id <id>         explicit run directory name
  --pi <path>           pi binary (default "pi")
  --keep-workspaces     keep scratch workspaces for inspection
  --json                machine-readable summary on stdout

Report/verify options:
  --output <path>       where report.md goes (default runs/<runId>/report.md)
  --runs-dir <dir>      override runs base directory
  --published-dir <dir> override published base directory
  --fixtures-dir <dir>  override fixtures base directory
  --agent-dir <dir>     override the real agent dir used for copies
  -h, --help            show this help
`.trim();

const COMMANDS = new Set(["bench", "publish", "report", "verify", "help"]);

/** Minimal argv parser: --flag value, --flag=value, repeatable, positionals. */
export function parseArgs(argv) {
  const parsed = { _: [], models: [], fixtures: [] };
  const flags = {
    model: true,
    fixture: true,
    "model-filter": true,
    thinking: true,
    trials: true,
    seed: true,
    timeout: true,
    "max-calls": true,
    "run-id": true,
    pi: true,
    "runs-dir": true,
    "published-dir": true,
    "fixtures-dir": true,
    "agent-dir": true,
    output: true,
    extension: true,
    "dry-run": false,
    "keep-workspaces": false,
    json: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (arg.startsWith("--")) {
      const [name, inline] = arg.slice(2).split("=");
      if (!(name in flags))
        throw new Error(`Unknown flag --${name} (see --help).`);
      const key = name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      if (flags[name]) {
        const value = inline ?? argv[++index];
        if (value === undefined) throw new Error(`--${name} needs a value.`);
        if (name === "model") parsed.models.push(value);
        else if (name === "fixture") parsed.fixtures.push(value);
        else parsed[key] = value;
      } else {
        parsed[key] =
          inline === undefined ? true : inline === "1" || inline === "true";
      }
    } else if (arg === "-h") {
      parsed.help = true;
    } else {
      parsed._.push(arg);
    }
  }
  return parsed;
}

async function main(argv) {
  const parsed = parseArgs(argv);
  if (parsed.help) {
    console.log(HELP);
    return 0;
  }
  const command = parsed._[0] ?? "bench";
  if (!COMMANDS.has(command))
    throw new Error(`Unknown command "${command}" (see --help).`);
  if (command === "help") {
    console.log(HELP);
    return 0;
  }
  // CLI --timeout is in seconds; the config works in milliseconds.
  if (parsed.timeout !== undefined) {
    parsed.timeout = Number(parsed.timeout) * 1000;
  }
  const config = resolveConfig({}, parsed);
  if (command === "bench") {
    if (config.dryRun) {
      await dryRun(config);
      return 0;
    }
    const { runDir, raw, arms, summary } = await runBench(config);
    console.log("");
    console.log(`Run complete: ${runDir}`);
    printSummary(summary);
    if (config.jsonOutput) {
      console.log(
        JSON.stringify({
          runId: raw.runId,
          runDir,
          arms: arms.length,
          passed: summary.passed,
          rows: summary.rows,
        }),
      );
    }
    if (
      arms.length > 0 &&
      arms.every((arm) => isUnusableOutcome(arm.outcome))
    ) {
      console.error(
        "bench: every arm produced an unusable infra/protocol outcome " +
          `(${[...new Set(arms.map((arm) => arm.outcome))].join(", ")}); ` +
          "check the pi binary and the JSON protocol before trusting results.",
      );
      return 1;
    }
    return 0;
  }

  const runId = parsed._[1];
  if (!runId)
    throw new Error(
      `${command} needs a <runId> (a bench/runs/<runId> directory).`,
    );
  if (!validateRunId(runId)) {
    throw new Error(
      `Invalid run id "${runId}" (letters/digits/._- , alphanumeric start).`,
    );
  }
  const runDir = assertPathWithin(config.runsDir, join(config.runsDir, runId));
  if (!existsSync(runDir)) {
    throw new Error(`Run directory not found: ${runDir}`);
  }
  const rawPath = join(runDir, "raw.json");
  if (!existsSync(rawPath)) throw new Error(`No raw.json in ${runDir}.`);

  if (command === "publish") {
    const { value: raw } = tryJson(await readFile(rawPath, "utf8"));
    if (!raw) throw new Error(`Cannot parse ${rawPath}.`);
    assertPathWithin(config.publishedDir, join(config.publishedDir, runId));
    await writePublished({ publishedDir: config.publishedDir, runId, raw });
    return 0;
  }
  if (command === "report") {
    const { value: raw } = tryJson(await readFile(rawPath, "utf8"));
    if (!raw) throw new Error(`Cannot parse ${rawPath}.`);
    const { manifest, results, report } = computePublicBundle(raw);
    const output = parsed.output
      ? parsed.output
      : join(config.runsDir, runId, "report.md");
    await writeReport({ output, manifest, results, report });
    return 0;
  }
  if (command === "verify") {
    const result = await verifyRun({
      runDir,
      publishedDir: config.publishedDir,
      fixturesDir: config.fixturesDir,
    });
    return result.ok ? 0 : 1;
  }
  return 0;
}

function printSummary(summary) {
  if (summary.rows.length === 0) return;
  console.log("");
  console.table(
    summary.rows.map((row) => ({
      fixture: row.fixture,
      arm: row.arm,
      passed: `${row.passed}/${row.trials}`,
      "wall(ms)": row.medianWallMs,
      tools: row.meanToolCalls,
      editKiB:
        row.meanEditBytes == null
          ? null
          : (row.meanEditBytes / 1024).toFixed(1),
      tokens: row.sumTokens,
    })),
  );
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error) => {
    console.error(`bench: ${error.message}`);
    process.exit(1);
  },
);
