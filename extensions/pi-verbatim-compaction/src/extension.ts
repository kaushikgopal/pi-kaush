import type { Usage } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import {
  findCurrentObjective,
  prepareCompaction,
  runForegroundCompaction,
  type SessionBeforeCompactResult,
} from "./compactor.ts";
import { PlannerFailure } from "./planner.ts";
import { registerRecallTool } from "./recall.ts";
import { loadExtensionSettings } from "./settings.ts";
import { SpeculationController } from "./speculation.ts";
import {
  STRATEGY,
  type ExtensionSettings,
  type RuntimeState,
  type VerbatimCompactionDetails,
} from "./types.ts";

export default function verbatimCompaction(pi: ExtensionAPI): void {
  let loaded = loadExtensionSettings();
  let settings = loaded.settings;
  const state: RuntimeState = {
    counters: {
      compactions: 0,
      fallbacks: 0,
      plannerResponses: 0,
      plannerInputTokens: 0,
      plannerOutputTokens: 0,
      plannerCostUsd: 0,
      speculationGenerated: 0,
      speculationHits: 0,
      speculationStale: 0,
      speculationErrors: 0,
    },
    currentObjective: "Continue the current coding task.",
  };
  const observePlannerResponse = (usage: Usage) =>
    recordPlannerUsage(state, usage);
  const speculation = new SpeculationController(state, observePlannerResponse);

  registerRecallTool(pi, () => settings);

  pi.on("session_start", (_event, ctx) => {
    speculation.invalidate(false);
    loaded = loadExtensionSettings();
    settings = loaded.settings;
    restoreState(ctx, state);
    state.currentObjective = findCurrentObjective(
      ctx.sessionManager.getBranch(),
    );
    for (const warning of loaded.warnings) {
      if (ctx.hasUI) ctx.ui.notify(warning, "warning");
    }
  });

  pi.on("input", (event) => {
    if (event.source !== "extension") speculation.invalidate();
  });

  pi.on("before_agent_start", (event) => {
    speculation.invalidate();
    state.currentObjective = truncateObjective(event.prompt.trim());
  });

  pi.on("turn_end", (_event, ctx) => {
    if (settings.enabled) speculation.consider(ctx, settings);
    else speculation.invalidate(false);
  });

  pi.on("session_before_compact", async (event, ctx) => {
    if (!settings.enabled) return;
    return handleCompaction(event, ctx, settings, state, speculation);
  });

  pi.on("session_compact", (event) => {
    const details = event.compactionEntry.details;
    if (isVerbatimDetails(details)) {
      state.lastCompaction = details;
      state.counters.compactions += 1;
    }
    speculation.invalidate(false);
  });

  pi.on("session_tree", () => speculation.invalidate());
  pi.on("model_select", () => speculation.invalidate());
  pi.on("thinking_level_select", () => speculation.invalidate());
  pi.on("session_shutdown", () => speculation.invalidate(false));

  pi.registerCommand("verbatim-context", {
    description: "Show verbatim compaction status and last-run metrics",
    handler: async (_args, ctx) => {
      ctx.ui.notify(formatStatus(settings, state), "info");
    },
  });

  pi.registerCommand("verbatim-compact", {
    description: "Run Pi compaction through the verbatim strategy",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();
      const customInstructions = args.trim();
      ctx.compact({
        ...(customInstructions ? { customInstructions } : {}),
        onComplete: () =>
          ctx.ui.notify("Verbatim compaction completed.", "info"),
        onError: (error) => ctx.ui.notify(error.message, "error"),
      });
    },
  });
}

async function handleCompaction(
  event: SessionBeforeCompactEvent,
  ctx: ExtensionContext,
  settings: ExtensionSettings,
  state: RuntimeState,
  speculation: SpeculationController,
): Promise<SessionBeforeCompactResult | undefined> {
  const compactionEvent = event;
  const prepared = prepareCompaction(compactionEvent, settings);
  if (prepared === undefined) {
    state.counters.fallbacks += 1;
    return undefined;
  }

  if (ctx.hasUI)
    ctx.ui.setStatus("verbatim-compaction", "planning verbatim compaction");
  try {
    const speculative = await speculation.consume(
      compactionEvent,
      prepared,
      settings,
      ctx,
    );
    if (speculative !== undefined) return speculative.result;

    const foreground = await runForegroundCompaction(
      compactionEvent,
      ctx,
      settings,
      (usage) => recordPlannerUsage(state, usage),
    );
    if (foreground === undefined) {
      state.counters.fallbacks += 1;
      notifyFallback(
        ctx,
        settings,
        "Planner ranges did not meet the retention target.",
      );
      return undefined;
    }
    return foreground.result;
  } catch (error) {
    if (compactionEvent.signal.aborted) {
      return { cancel: true };
    }
    state.counters.fallbacks += 1;
    notifyFallback(ctx, settings, plannerErrorMessage(error));
    return undefined;
  } finally {
    if (ctx.hasUI) ctx.ui.setStatus("verbatim-compaction", undefined);
  }
}

function restoreState(ctx: ExtensionContext, state: RuntimeState): void {
  Object.assign(state.counters, {
    compactions: 0,
    fallbacks: 0,
    plannerResponses: 0,
    plannerInputTokens: 0,
    plannerOutputTokens: 0,
    plannerCostUsd: 0,
    speculationGenerated: 0,
    speculationHits: 0,
    speculationStale: 0,
    speculationErrors: 0,
  });
  state.lastCompaction = undefined;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "compaction" || !isVerbatimDetails(entry.details))
      continue;
    state.counters.compactions += 1;
    state.lastCompaction = entry.details;
  }
}

function isVerbatimDetails(value: unknown): value is VerbatimCompactionDetails {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const details = value as Partial<VerbatimCompactionDetails>;
  return (
    details.strategy === STRATEGY &&
    details.strategyVersion === 1 &&
    typeof details.sourceTokens === "number" &&
    typeof details.outputTokens === "number" &&
    (details.planSource === "foreground" ||
      details.planSource === "speculative")
  );
}

function notifyFallback(
  ctx: ExtensionContext,
  settings: ExtensionSettings,
  message: string,
): void {
  if (settings.debug && ctx.hasUI) {
    ctx.ui.notify(`Verbatim compaction fell back to Pi: ${message}`, "warning");
  }
}

function plannerErrorMessage(error: unknown): string {
  if (error instanceof PlannerFailure)
    return `${error.reason}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

function recordPlannerUsage(state: RuntimeState, usage: Usage): void {
  state.counters.plannerResponses += 1;
  state.counters.plannerInputTokens += usage.input;
  state.counters.plannerOutputTokens += usage.output;
  state.counters.plannerCostUsd += usage.cost.total;
}

function formatStatus(
  settings: ExtensionSettings,
  state: RuntimeState,
): string {
  const last = state.lastCompaction;
  return [
    `Verbatim compaction: ${settings.enabled ? "enabled" : "disabled"}`,
    `Planner: ${settings.planner.model}`,
    `Retention target: ${(settings.retention.ratio * 100).toFixed(0)}%`,
    `Compactions: ${state.counters.compactions}`,
    `Native fallbacks: ${state.counters.fallbacks}`,
    `Speculation: ${settings.speculation.enabled ? "enabled" : "disabled"}`,
    `Speculation generated/hit/stale/error: ${state.counters.speculationGenerated}/${state.counters.speculationHits}/${state.counters.speculationStale}/${state.counters.speculationErrors}`,
    `Planner responses/tokens/cost: ${state.counters.plannerResponses} / ${state.counters.plannerInputTokens.toLocaleString()} in + ${state.counters.plannerOutputTokens.toLocaleString()} out / $${state.counters.plannerCostUsd.toFixed(4)}`,
    ...(last
      ? [
          "Last compaction:",
          `  ${last.sourceTokens.toLocaleString()} → ${last.outputTokens.toLocaleString()} estimated tokens`,
          `  ${last.deletedLines.toLocaleString()} lines removed in ${last.rangesApplied} ranges`,
          `  ${last.planSource} ${last.plannerProvider}/${last.plannerModel}, ${last.plannerLatencyMs}ms`,
        ]
      : ["Last compaction: none in this branch"]),
  ].join("\n");
}

function truncateObjective(value: string): string {
  if (value.length === 0) return "Continue the current coding task.";
  return value.length <= 6_000
    ? value
    : `${value.slice(0, 6_000)}\n[objective truncated]`;
}
