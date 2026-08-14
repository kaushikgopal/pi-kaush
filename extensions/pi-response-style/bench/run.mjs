#!/usr/bin/env node
// pi-response-style bench entry point.
//
// Runs pi in print mode twice per case (style OFF vs ON) under full
// isolation, collects deterministic metrics, prints a console summary, and
// writes a JSON result file to bench/results/<timestamp>.json.
//
// Usage:
//   npm run bench                      # readability + deliverable (+ coding
//                                       if the first sets are clean & fast)
//   BENCH_MODEL=openai/gpt-4o-mini npm run bench
//   BENCH_STYLE=hemingway npm run bench
//   BENCH_SKIP_CODING=1 npm run bench  # force-skip the coding set
//   BENCH_FORCE_CODING=1 npm run bench # force-run the coding set
//
// Env:
//   BENCH_MODEL             default fireworks-kimi/kimi-k3-fast
//   BENCH_STYLE             default simplicity
//   BENCH_PER_CALL_TIMEOUT_MS  default 120000
//   BENCH_CODING_BUDGET_MS  default 480000 (skip coding if first sets exceed)
//   BENCH_SKIP_CODING=1     never run coding
//   BENCH_FORCE_CODING=1    always run coding

import { fileURLToPath } from "node:url";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CODING_CASES,
  DELIVERABLE_CASES,
  READABILITY_CASES,
} from "./cases.mjs";
import {
  DEFAULT_MODEL,
  DEFAULT_STYLE,
  extractCodeBlock,
  loadProviderDef,
  runArm,
  runCodingTest,
} from "./runner.mjs";
import { deliverablePurity, readabilityMetrics } from "./metrics.mjs";

const model = process.env.BENCH_MODEL || DEFAULT_MODEL;
const styleName = process.env.BENCH_STYLE || DEFAULT_STYLE;
const perCallTimeoutMs = Number(
  process.env.BENCH_PER_CALL_TIMEOUT_MS || 120000,
);
const codingBudgetMs = Number(process.env.BENCH_CODING_BUDGET_MS || 480000);
const extensionPath =
  process.env.BENCH_EXTENSION_PATH ||
  fileURLToPath(new URL("../src/index.ts", import.meta.url));

const resultsDir = fileURLToPath(new URL("./results", import.meta.url));
mkdirSync(resultsDir, { recursive: true });

function armError(result) {
  if (result.spawnError) return `spawn: ${result.spawnError}`;
  if (result.timedOut) return "timeout";
  if (result.exitCode !== 0) return `exit:${result.exitCode}`;
  return null;
}

// ---- metric appliers (one per set) -----------------------------------------

function readabilityApplier(caseDef, result) {
  return { error: armError(result), ...readabilityMetrics(result.reply) };
}

function deliverableApplier(caseDef, result) {
  const purity = deliverablePurity(result.reply);
  return { error: armError(result), ...purity };
}

async function codingApplier(caseDef, result) {
  const error = armError(result);
  if (error) {
    return { error, extracted: null, test: null };
  }
  const extracted = extractCodeBlock(result.reply);
  const test = await runCodingTest(extracted, caseDef.test);
  return { error: null, extracted, test };
}

// ---- set runner ------------------------------------------------------------

async function runSet(setName, cases, applier) {
  const results = [];
  for (const caseDef of cases) {
    process.stderr.write(`  [${setName}] ${caseDef.id} off... `);
    const off = await runArm({
      caseDef,
      model,
      styleName,
      extensionPath,
      providerDef,
      arm: "off",
      timeoutMs: perCallTimeoutMs,
    });
    process.stderr.write(`on... `);
    const on = await runArm({
      caseDef,
      model,
      styleName,
      extensionPath,
      providerDef,
      arm: "on",
      timeoutMs: perCallTimeoutMs,
    });
    process.stderr.write(
      `done (off ${off.elapsedMs}ms, on ${on.elapsedMs}ms)\n`,
    );
    results.push({
      id: caseDef.id,
      prompt: caseDef.prompt,
      off: { ...off, stderr: off.stderr.slice(-400) },
      on: { ...on, stderr: on.stderr.slice(-400) },
      offMetrics: await applier(caseDef, off),
      onMetrics: await applier(caseDef, on),
    });
  }
  return results;
}

// ---- stats helpers ---------------------------------------------------------

function mean(nums) {
  if (nums.length === 0) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}
function median(nums) {
  if (nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}
function rate(bools) {
  if (bools.length === 0) return null;
  return bools.filter(Boolean).length / bools.length;
}
function pctDelta(off, on) {
  if (off === null || off === 0) return null;
  return ((on - off) / off) * 100;
}
function fmtNum(x) {
  if (x === null || x === undefined) return "-";
  return Number.isInteger(x) ? String(x) : x.toFixed(1);
}
function pct(x) {
  if (x === null || x === undefined) return "-";
  return (x * 100).toFixed(0) + "%";
}
function pad(s, n) {
  return String(s).padEnd(n);
}

// ---- summaries -------------------------------------------------------------

function summarizeReadability(results) {
  const clean = results.filter(
    (r) => !r.offMetrics.error && !r.onMetrics.error,
  );
  const pick = (arm, key) => clean.map((r) => r[`${arm}Metrics`][key]);
  const row = (label, key) => {
    const offV = pick("off", key);
    const onV = pick("on", key);
    return {
      label,
      offMean: mean(offV),
      offMedian: median(offV),
      onMean: mean(onV),
      onMedian: median(onV),
      deltaPct: pctDelta(median(offV), median(onV)),
    };
  };
  return {
    n: clean.length,
    errored: results.length - clean.length,
    chars: row("chars", "chars"),
    words: row("words", "words"),
    wordsBeforeBold: row("words before 1st bold", "wordsBeforeBold"),
    longestBlock: row("longest block (words)", "longestBlockWords"),
    hasBold: {
      off: rate(pick("off", "hasBold")),
      on: rate(pick("on", "hasBold")),
    },
    answerInFirstLine: {
      off: rate(pick("off", "answerInFirstLine")),
      on: rate(pick("on", "answerInFirstLine")),
    },
  };
}

function summarizeDeliverable(results) {
  const clean = results.filter(
    (r) => !r.offMetrics.error && !r.onMetrics.error,
  );
  const pick = (arm, key) => clean.map((r) => r[`${arm}Metrics`][key]);
  return {
    n: clean.length,
    errored: results.length - clean.length,
    pure: { off: rate(pick("off", "pure")), on: rate(pick("on", "pure")) },
    wrappedStart: {
      off: rate(pick("off", "wrappedStart")),
      on: rate(pick("on", "wrappedStart")),
    },
    wrappedEnd: {
      off: rate(pick("off", "wrappedEnd")),
      on: rate(pick("on", "wrappedEnd")),
    },
  };
}

function summarizeCoding(results) {
  const offPass = results.filter(
    (r) => !r.offMetrics.error && r.offMetrics.test?.passes,
  ).length;
  const onPass = results.filter(
    (r) => !r.onMetrics.error && r.onMetrics.test?.passes,
  ).length;
  const offError = results.filter((r) => r.offMetrics.error).length;
  const onError = results.filter((r) => r.onMetrics.error).length;
  return {
    n: results.length,
    offPass,
    onPass,
    offError,
    onError,
    equal: offPass === onPass,
    perCase: results.map((r) => ({
      id: r.id,
      off: r.offMetrics.error
        ? `error:${r.offMetrics.error}`
        : r.offMetrics.test?.passes
          ? "pass"
          : "fail",
      on: r.onMetrics.error
        ? `error:${r.onMetrics.error}`
        : r.onMetrics.test?.passes
          ? "pass"
          : "fail",
    })),
  };
}

// ---- console printing ------------------------------------------------------

function printReadabilityTable(s) {
  console.log("\nReadability (mean / median over n=" + s.n + "):");
  console.log(
    pad("  metric", 26) + pad("OFF", 18) + pad("ON", 18) + "delta (median)",
  );
  const lines = [
    ["chars", s.chars],
    ["words", s.words],
    ["words before 1st bold", s.wordsBeforeBold],
    ["longest block (words)", s.longestBlock],
  ];
  for (const [label, r] of lines) {
    const off = `${fmtNum(r.offMean)} / ${fmtNum(r.offMedian)}`;
    const on = `${fmtNum(r.onMean)} / ${fmtNum(r.onMedian)}`;
    const d =
      r.deltaPct === null
        ? "-"
        : `${r.deltaPct >= 0 ? "+" : ""}${r.deltaPct.toFixed(0)}%`;
    console.log(pad(`  ${label}`, 26) + pad(off, 18) + pad(on, 18) + d);
  }
  console.log(
    pad("  has bold", 26) +
      pad(pct(s.hasBold.off), 18) +
      pad(pct(s.hasBold.on), 18),
  );
  console.log(
    pad("  answer in 1st line", 26) +
      pad(pct(s.answerInFirstLine.off), 18) +
      pad(pct(s.answerInFirstLine.on), 18),
  );
  if (s.errored > 0) console.log(`  (${s.errored} errored case(s) excluded)`);
}

function printDeliverableTable(s) {
  console.log("\nDeliverable purity (n=" + s.n + "):");
  console.log(pad("  metric", 26) + pad("OFF", 18) + pad("ON", 18));
  console.log(
    pad("  pure deliverable", 26) +
      pad(pct(s.pure.off), 18) +
      pad(pct(s.pure.on), 18),
  );
  console.log(
    pad("  wrapped start", 26) +
      pad(pct(s.wrappedStart.off), 18) +
      pad(pct(s.wrappedStart.on), 18),
  );
  console.log(
    pad("  wrapped end", 26) +
      pad(pct(s.wrappedEnd.off), 18) +
      pad(pct(s.wrappedEnd.on), 18),
  );
  if (s.errored > 0) console.log(`  (${s.errored} errored case(s) excluded)`);
}

function printCodingTable(s) {
  console.log("\nCoding (pass rate, n=" + s.n + "):");
  console.log(pad("  metric", 26) + pad("OFF", 18) + pad("ON", 18));
  console.log(
    pad("  pass rate", 26) +
      pad(`${s.offPass}/${s.n}`, 18) +
      pad(`${s.onPass}/${s.n}`, 18),
  );
  console.log("  per case:");
  for (const c of s.perCase) {
    console.log(`    ${c.id}: off=${c.off}  on=${c.on}`);
  }
  console.log(
    s.equal
      ? "  work-equivalence: equal pass rates — work unchanged."
      : "  work-equivalence: pass rates DIFFER — investigate.",
  );
}

// ---- main ------------------------------------------------------------------

let providerDef;
try {
  providerDef = loadProviderDef(model);
} catch (err) {
  console.error(String(err.message ?? err));
  process.exit(1);
}

const startedAt = Date.now();
const iso = new Date().toISOString();
console.log(`pi-response-style bench`);
console.log(`  model: ${model}`);
console.log(`  style: ${styleName}`);
console.log(`  extension: ${extensionPath}`);
console.log(
  `  provider: ${providerDef.provider} (seeded from real models.json)`,
);
console.log(`  per-call timeout: ${perCallTimeoutMs}ms`);
console.log("");

const readabilityResults = await runSet(
  "readability",
  READABILITY_CASES,
  readabilityApplier,
);
const deliverableResults = await runSet(
  "deliverable",
  DELIVERABLE_CASES,
  deliverableApplier,
);

const firstSetsElapsedMs = Date.now() - startedAt;
const firstSetsErrors = [...readabilityResults, ...deliverableResults].filter(
  (r) => r.offMetrics.error || r.onMetrics.error,
).length;

let codingResults = null;
let codingSkipped = null;
if (process.env.BENCH_FORCE_CODING === "1") {
  codingResults = await runSet("coding", CODING_CASES, codingApplier);
} else if (process.env.BENCH_SKIP_CODING === "1") {
  codingSkipped = "BENCH_SKIP_CODING=1";
} else if (firstSetsErrors > 0) {
  codingSkipped = `${firstSetsErrors} error(s) in readability/deliverable`;
} else if (firstSetsElapsedMs > codingBudgetMs) {
  codingSkipped = `first sets took ${(firstSetsElapsedMs / 1000).toFixed(0)}s, over ${codingBudgetMs / 1000}s budget`;
} else {
  codingResults = await runSet("coding", CODING_CASES, codingApplier);
}

const elapsedMs = Date.now() - startedAt;

const readabilitySummary = summarizeReadability(readabilityResults);
const deliverableSummary = summarizeDeliverable(deliverableResults);
const codingSummary = codingResults ? summarizeCoding(codingResults) : null;

console.log("");
console.log(
  `Ran ${readabilityResults.length + deliverableResults.length + (codingResults ? codingResults.length : 0)} cases (2 arms each) in ${(elapsedMs / 1000).toFixed(0)}s.`,
);
if (codingSkipped) console.log(`Skipped coding: ${codingSkipped}.`);

printReadabilityTable(readabilitySummary);
printDeliverableTable(deliverableSummary);
if (codingSummary) printCodingTable(codingSummary);

const report = {
  meta: {
    ranAt: iso,
    elapsedMs,
    model,
    style: styleName,
    extension: extensionPath,
    provider: providerDef.provider,
    perCallTimeoutMs,
    piFlags: {
      off: [
        "-p",
        "--model",
        model,
        "--no-session",
        "--no-extensions",
        "--no-tools",
        "--no-context-files",
      ],
      on: [
        "-p",
        "--model",
        model,
        "--no-session",
        "--no-extensions",
        "--no-tools",
        "--no-context-files",
        "-e",
        extensionPath,
      ],
    },
    setsRun: {
      readability: readabilityResults.length,
      deliverable: deliverableResults.length,
      coding: codingResults ? codingResults.length : 0,
    },
    codingSkipped,
  },
  summary: {
    readability: readabilitySummary,
    deliverable: deliverableSummary,
    coding: codingSummary,
  },
  results: {
    readability: readabilityResults,
    deliverable: deliverableResults,
    coding: codingResults,
  },
};

const ts = iso.replace(/[:.]/g, "-");
const outFile = join(resultsDir, `${ts}.json`);
writeFileSync(outFile, JSON.stringify(report, null, 2));
console.log(`\nWrote ${outFile}`);
