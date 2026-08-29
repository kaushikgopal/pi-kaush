// Polished markdown report generation from a public bundle.
//
// generateReport() is pure: identical public data always produces
// identical markdown. It renders a headline summary, per-fixture arm
// comparison tables, per-model detail tables, and a failure-classification
// section. It never touches the private raw record. Every identifier that
// reaches a table cell is Markdown-escaped (backslash, pipe, newline).

import { aggregateArmRuns } from "./scoring.mjs";
import { formatBytes, formatMs } from "./config.mjs";

/** Render the full report markdown for one public bundle. */
export function generateReport({ manifest, results }) {
  const arms = results.arms;
  const modelList = [...new Set(arms.map((arm) => md(arm.model)))].sort();
  const lines = [];
  lines.push(`# ${md(manifest.runId)}`);
  lines.push("");
  lines.push(
    `A/B bench of the local **pi-better-read-edit** extension ("better") ` +
      `against Pi's built-in read/edit ("builtin") on exact fixture edits.`,
  );
  lines.push("");
  lines.push("## Configuration");
  lines.push("");
  lines.push(
    `- Run: \`${md(manifest.runId)}\` (created ${manifest.createdAt})`,
  );
  lines.push(
    `- Models: ${manifest.config.models
      .map((m) => `\`${md(m.id)}\` (thinking ${md(m.thinking ?? "off")})`)
      .join(", ")}`,
  );
  lines.push(`- Fixtures: ${manifest.config.fixtures.map(md).join(", ")}`);
  lines.push(
    `- Trials per cell: ${manifest.config.trials} (seed ${manifest.config.seed})`,
  );
  lines.push(
    `- Per-arm timeout: ${formatMs(manifest.config.timeoutMs)}, max tool calls: ${manifest.config.maxCalls} (cap triggers at count >= max)`,
  );
  lines.push(
    `- Pi: \`${md(manifest.config.piBin)}\` ${manifest.config.piVersion ?? "(unknown version)"}`,
  );
  lines.push(
    `- Isolation: ${md(manifest.config.agentDirMode)} private \`PI_CODING_AGENT_DIR\` per arm; ` +
      `auth.json/models.json/models-store.json copied 0600, settings.json forced to ` +
      `betterReadEdit.avoidModels=[] — workspace in the system temp dir, no OS sandbox`,
  );
  lines.push("");
  lines.push(
    `> **Trust boundary:** this is not an OS sandbox. Models and their tools run as your ` +
      `user and may read or write beyond the scratch workspace. Benchmark only models you trust.`,
  );
  lines.push("");

  const summary = overallSummary(arms);
  const pairs = comparablePairs(arms);
  const comparableBetter = pairs.map((pair) => pair.better);
  const comparableBuiltin = pairs.map((pair) => pair.builtin);
  const betterComparable = aggregateArmRuns(comparableBetter);
  const builtinComparable = aggregateArmRuns(comparableBuiltin);
  lines.push("## Summary");
  lines.push("");
  lines.push(
    `Comparable completed pairs: **${pairs.length} / ${summary.totalPairs}**. Within those pairs, ` +
      `better was exact in **${betterComparable.passed}/${pairs.length}** and builtin in ` +
      `**${builtinComparable.passed}/${pairs.length}**.`,
  );
  lines.push(
    `All attempted arms: ${summary.treeExact}/${arms.length} tree-exact; outcomes: ${
      Object.entries(summary.outcomes)
        .map(([outcome, count]) => `${md(outcome)} ${count}`)
        .join(", ") || "none"
    }.`,
  );
  lines.push("");
  lines.push("### Comparable results by model");
  lines.push("");
  lines.push(
    "| Model | Pairs | Better exact | Builtin exact | Better median | Builtin median | Better tokens | Builtin tokens |",
  );
  lines.push(
    "|-------|-------|--------------|---------------|---------------|----------------|---------------|----------------|",
  );
  for (const model of modelList) {
    const modelPairs = pairs.filter((pair) => md(pair.better.model) === model);
    const better = aggregateArmRuns(modelPairs.map((pair) => pair.better));
    const builtin = aggregateArmRuns(modelPairs.map((pair) => pair.builtin));
    lines.push(
      `| ${model} | ${modelPairs.length} | ${better.passed}/${modelPairs.length} | ` +
        `${builtin.passed}/${modelPairs.length} | ${formatMs(better.medianWallMs)} | ` +
        `${formatMs(builtin.medianWallMs)} | ${better.sumTokens} | ${builtin.sumTokens} |`,
    );
  }
  lines.push("");

  const fixtures = [...new Set(arms.map((arm) => md(arm.fixture)))].sort();
  for (const fixture of fixtures) {
    lines.push(`## ${fixture}`);
    lines.push("");
    lines.push(
      "Tree scoring is byte-exact over the complete workspace: only regular files are " +
        "hashed, and any missing, extra, or changed file fails the arm.",
    );
    lines.push("");
    const fixtureArms = arms.filter((arm) => md(arm.fixture) === fixture);
    lines.push(
      "| Arm | Attempts | Completed | Exact / completed | Median wall | Mean tools | Mean edit bytes | Tokens (sum) | Tool errors |",
    );
    lines.push(
      "|-----|----------|-----------|-------------------|-------------|------------|-----------------|--------------|-------------|",
    );
    const byArm = groupByArm(fixtureArms);
    for (const arm of ["better", "builtin"]) {
      const attempts = byArm[arm] ?? [];
      const completed = attempts.filter((run) => run.outcome === "completed");
      const agg = aggregateArmRuns(completed);
      lines.push(
        `| ${arm} | ${attempts.length} | ${completed.length} | ${agg.passed}/${completed.length} | ` +
          `${formatMs(agg.medianWallMs)} | ${fmt(agg.meanToolCalls)} | ` +
          `${formatBytes(agg.meanEditArgsBytes)} | ${agg.sumTokens} | ${agg.toolErrors} |`,
      );
    }
    lines.push("");
    if (modelList.length > 1) {
      lines.push("### By model");
      lines.push("");
      lines.push(
        "| Model | Arm | Trial | Outcome | Tree | Wall | Tools | Edit bytes | First edit |",
      );
      lines.push(
        "|-------|-----|-------|---------|------|------|-------|------------|------------|",
      );
      for (const model of modelList) {
        for (const arm of ["better", "builtin"]) {
          const modelArms = fixtureArms.filter(
            (a) => md(a.model) === model && a.arm === arm,
          );
          for (const trialArm of modelArms.sort((a, b) => a.trial - b.trial)) {
            lines.push(
              `| ${model} | ${arm} | ${trialArm.trial} | ${md(trialArm.outcome)} | ` +
                `${trialArm.treeMatch ? "EXACT" : "MISMATCH"} | ${formatMs(trialArm.wallMs)} | ` +
                `${trialArm.metrics.toolCalls.total} | ${formatBytes(trialArm.metrics.editArgsBytes)} | ` +
                `${md(trialArm.metrics.firstEdit.status)} |`,
            );
          }
        }
      }
      lines.push("");
    }
  }

  lines.push("## Failures and classifications");
  lines.push("");
  const failed = arms.filter(
    (arm) => !arm.treeMatch || arm.outcome !== "completed",
  );
  if (failed.length === 0) {
    lines.push("No failed or incomplete arms.");
  } else {
    lines.push("| Model | Fixture | Arm | Outcome | Tree | Notes |");
    lines.push("|-------|---------|-----|---------|------|-------|");
    for (const arm of failed) {
      lines.push(
        `| ${md(arm.model)} | ${md(arm.fixture)} | ${arm.arm} | ${md(arm.outcome)} | ${arm.treeMatch ? "EXACT" : "MISMATCH"} | ${md(failureNote(arm))} |`,
      );
    }
  }
  lines.push("");
  lines.push(
    "Outcome codes: `completed` agent finished; `timeout` killed after per-arm timeout; `tool-call-limit` killed at the max-calls cap; `output-limit` killed after an oversized protocol line; `provider-error` provider retry failed (final attempt); `assistant-error` final assistant stop-reason error; `process-error` non-zero exit; `parse-error` unusable protocol stream; `no-agent-end` clean exit without agent_end.",
  );
  lines.push("");
  lines.push(
    `Generated by the pi-better-read-edit bench harness (schema ${md(manifest.schema)}).`,
  );
  lines.push("");
  return lines.join("\n");
}

function overallSummary(arms) {
  const pairKeys = new Set(
    arms.map((arm) => JSON.stringify([arm.model, arm.fixture, arm.trial])),
  );
  return {
    totalPairs: pairKeys.size,
    treeExact: arms.filter((arm) => arm.treeMatch).length,
    outcomes: Object.fromEntries(
      Object.entries(
        arms.reduce((counts, arm) => {
          counts[arm.outcome] = (counts[arm.outcome] ?? 0) + 1;
          return counts;
        }, {}),
      ).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    ),
  };
}

function comparablePairs(arms) {
  const grouped = new Map();
  for (const arm of arms) {
    const key = JSON.stringify([arm.model, arm.fixture, arm.trial]);
    const pair = grouped.get(key) ?? {};
    pair[arm.arm] = arm;
    grouped.set(key, pair);
  }
  return [...grouped.values()].filter(
    (pair) =>
      pair.better?.outcome === "completed" &&
      pair.builtin?.outcome === "completed",
  );
}

function groupByArm(arms) {
  const groups = { better: [], builtin: [] };
  for (const arm of arms) (groups[arm.arm] ?? (groups[arm.arm] = [])).push(arm);
  return groups;
}

function failureNote(arm) {
  if (arm.treeMatch)
    return arm.outcome === "completed"
      ? "completed but tree mismatch"
      : arm.outcome;
  const mismatch =
    arm.treeDiff.missing.length +
    arm.treeDiff.extra.length +
    arm.treeDiff.changed.length;
  return `${arm.outcome}; ${mismatch} tree file(s) differ`;
}

function fmt(value) {
  return value == null ? "—" : String(Math.round(value * 10) / 10);
}

/** Escape a value for a Markdown table cell / inline code. */
function md(value) {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/\n/g, " ")
    .replace(/\r/g, "");
}
