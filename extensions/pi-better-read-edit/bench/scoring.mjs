// Scoring helpers: turn tree diffs into the per-arm score and provide the
// aggregates the report layer renders. All functions are pure and
// deterministic.

import { mean, median } from "./util.mjs";

/** Arm-level score from a tree comparison. Exact: 1 or 0, no partial. */
export function scoreTree(treeDiff) {
  return treeDiff.match ? 1 : 0;
}

/**
 * Tree-match flag that tolerates both the private arm shape (tree.match)
 * and the public results shape (treeMatch).
 */
export function armTreeMatch(arm) {
  return Boolean(arm.treeMatch ?? arm.tree?.match ?? false);
}

/** Aggregate per-arm metrics across all trials of one (fixture, arm). */
export function aggregateArmRuns(arms) {
  const trials = arms.filter((arm) => arm.outcome === "completed");
  const matched = arms.filter((arm) => armTreeMatch(arm));
  return {
    trials: arms.length,
    completed: trials.length,
    passed: matched.length,
    treeMatchRate: arms.length === 0 ? 0 : matched.length / arms.length,
    medianWallMs: median(arms.map((arm) => arm.wallMs)),
    meanToolCalls: mean(arms.map((arm) => arm.metrics.toolCalls.total)),
    meanEditCalls: mean(arms.map((arm) => arm.metrics.toolCalls.edit)),
    meanEditArgsBytes: mean(arms.map((arm) => arm.metrics.editArgsBytes)),
    sumTokens: arms.reduce(
      (total, arm) => total + (arm.metrics.tokens.total ?? 0),
      0,
    ),
    toolErrors: arms.reduce(
      (total, arm) => total + (arm.metrics?.toolCalls?.errors ?? 0),
      0,
    ),
    providerErrors: arms.reduce(
      (total, arm) => total + (arm.errors?.provider?.length ?? 0),
      0,
    ),
    assistantErrors: arms.reduce(
      (total, arm) => total + (arm.errors?.assistant?.length ?? 0),
      0,
    ),
    outcomes: countBy(arms.map((arm) => arm.outcome)),
    firstEdits: countBy(arms.map((arm) => arm.metrics.firstEdit.status)),
  };
}

function countBy(values) {
  const counts = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}
