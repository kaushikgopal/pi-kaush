import * as path from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Key, Text, matchesKey, type Component } from "@earendil-works/pi-tui";
import type { ManagedRuntime, ManagedWorkerView } from "./_managed.ts";
export const MANAGED_FOOTER_STATUS_KEY = "below-footer:managed-subagents";
const STATUS_REFRESH_MS = 1_000;
const FOOTER_WORKER_LIMIT = 5;

function fishQuote(value: string): string {
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

/** Manual fallback for workers that cannot be attached to a native Herdr pane. */
export function formatManualManagedOpenHint(worker: ManagedWorkerView): string {
  const command = worker.sessionFile
    ? `pi --session ${fishQuote(worker.sessionFile)}`
    : `pi --session-dir ${fishQuote(path.join(worker.dir, "session"))} --session-id ${fishQuote(worker.sessionId)}`;
  return [
    "Cannot automatically open subagent.",
    worker.live
      ? `Stop running headless worker ${worker.handle} first to avoid two writers.`
      : `Worker ${worker.handle} is saved; no stop is needed.`,
    "Open a new terminal tab and run:",
    `  ${command}`,
    "This opens a standalone Pi session, not a live attachment. Close it before resuming this worker from the parent.",
  ].join("\n");
}

type IsReported = (
  ctx: ExtensionContext,
  handle: string,
  assignmentId: string,
) => boolean;

function latestAssignment(worker: ManagedWorkerView) {
  return (
    worker.recentAssignments.find(
      (assignment) => assignment.id === worker.activeAssignmentId,
    ) ??
    worker.recentAssignments.find(
      (assignment) => assignment.id === worker.lastAssignmentId,
    ) ??
    worker.recentAssignments[worker.recentAssignments.length - 1]
  );
}

function stateLabel(worker: ManagedWorkerView): string {
  const assignment = latestAssignment(worker);
  const workerState = worker.live
    ? (worker.childState ?? worker.lifecycle)
    : worker.lifecycle;
  if (!assignment) return workerState;
  if (assignment.state === "running") return "running";
  if (assignment.terminal) return `${assignment.state} · ${workerState}`;
  return assignment.state;
}

function hasUnreportedTerminalAssignment(
  ctx: ExtensionContext,
  worker: ManagedWorkerView,
  isReported?: IsReported,
): boolean {
  return worker.recentAssignments.some(
    (assignment) =>
      assignment.terminal &&
      !(
        isReported?.(
          ctx,
          worker.handle,
          assignment.mergedInto ?? assignment.id,
        ) ?? false
      ),
  );
}

function workerLabel(worker: ManagedWorkerView): string {
  const emoji = worker.agent.emoji ?? "🤖";
  const profile = worker.profile ? ` · ${worker.profile}` : "";
  return `${emoji} ${worker.agent.name}${profile} · ${stateLabel(worker)} · ${worker.handle}`;
}

function footerWorkerLabel(worker: ManagedWorkerView): string {
  const profile = worker.profile ? ` ${worker.profile}` : "";
  return `${worker.agent.emoji ?? "🤖"}${profile} · ${stateLabel(worker)} · ${worker.agent.name} · ${worker.handle}`.replace(
    /[\r\n]+/g,
    " ",
  );
}

function usageLabel(usage: ManagedWorkerView["usage"]): string {
  return `in ${usage.input} · out ${usage.output} · cache ${usage.cacheRead}+${usage.cacheWrite} · context ${usage.contextTokens} · ${usage.turns} turns · $${usage.cost.toFixed(4)}`;
}

function formatInspection(worker: ManagedWorkerView): string {
  const lines = [
    `${worker.agent.emoji ?? "🤖"} ${worker.agent.name}${worker.profile ? ` · ${worker.profile}` : ""}`,
    `Handle: ${worker.handle}`,
    `State: ${stateLabel(worker)}`,
    `Model: ${worker.model ?? "(not reported)"}`,
    `Worker usage: ${usageLabel(worker.usage)}`,
    `Session: ${worker.sessionId}`,
    `Session file: ${worker.sessionFile ?? "(not available)"}`,
    `Working directory: ${worker.cwd}`,
    "",
    "Latest assignments",
  ];
  const assignments = [...worker.recentAssignments].reverse();
  if (assignments.length === 0) {
    lines.push("No assignments recorded.");
    return lines.join("\n");
  }

  for (const assignment of assignments) {
    lines.push(
      "",
      `--- ${assignment.id} · ${assignment.state} ---`,
      `Task: ${assignment.preview}`,
      `Result: ${assignment.outcome?.result ?? "(no result recorded)"}`,
      `Model: ${assignment.model ?? worker.model ?? "(not reported)"}`,
      `Usage: ${usageLabel(assignment.usage)}`,
    );
    const artifacts = assignment.outcome?.artifacts ?? [];
    if (artifacts.length > 0)
      lines.push("Artifacts:", ...artifacts.map((artifact) => `- ${artifact}`));
  }
  return lines.join("\n");
}

function notify(
  ctx: ExtensionContext,
  message: string,
  type: "info" | "warning" | "error" = "info",
): void {
  if (ctx.hasUI) ctx.ui.notify(message, type);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function inspectWorker(
  ctx: ExtensionContext,
  worker: ManagedWorkerView,
): Promise<void> {
  const content = formatInspection(worker);
  if (ctx.mode !== "tui") {
    notify(ctx, content);
    return;
  }

  await ctx.ui.custom<void>((_tui, _theme, _keybindings, done) => {
    const text = new Text(content, 1, 1);
    const component: Component & { handleInput(data: string): void } = {
      render: (width) => text.render(width),
      invalidate: () => text.invalidate(),
      handleInput(data) {
        if (matchesKey(data, Key.escape)) done(undefined);
      },
    };
    return component;
  });
}

async function runAction(
  ctx: ExtensionContext,
  runtime: ManagedRuntime,
  worker: ManagedWorkerView,
  action: string,
): Promise<void> {
  try {
    switch (action) {
      case "Open child": {
        const current = runtime.status(worker.handle);
        if (current.hostKind === "rpc") {
          notify(ctx, formatManualManagedOpenHint(current), "warning");
          return;
        }
        if (current.lifecycle === "suspended")
          await runtime.resume(worker.handle);
        await runtime.open(worker.handle);
        notify(ctx, `Focused ${worker.handle}.`);
        return;
      }
      case "Inspect latest assignments": {
        await inspectWorker(ctx, runtime.status(worker.handle));
        return;
      }
      case "Send / steer": {
        const message = await ctx.ui.input(
          `Send / steer · ${worker.handle}`,
          "Message to managed worker",
        );
        if (!message?.trim()) return;
        const assignment = runtime.send(worker.handle, message.trim(), "auto");
        notify(ctx, `Sent to ${worker.handle} as ${assignment.assignmentId}.`);
        return;
      }
      case "Queue follow-up": {
        const message = await ctx.ui.input(
          `Queue follow-up · ${worker.handle}`,
          "Follow-up for managed worker",
        );
        if (!message?.trim()) return;
        const assignment = runtime.send(
          worker.handle,
          message.trim(),
          "followUp",
        );
        notify(ctx, `Queued ${assignment.assignmentId} for ${worker.handle}.`);
        return;
      }
      case "Resume": {
        const resumed = await runtime.resume(worker.handle);
        notify(ctx, `Resumed ${worker.handle} (${stateLabel(resumed)}).`);
        return;
      }
      case "Stop": {
        const confirmed = await ctx.ui.confirm(
          "Stop managed worker?",
          `Stop ${worker.handle}? Its session and transcripts will be retained.`,
        );
        if (!confirmed) return;
        await runtime.stop(worker.handle);
        notify(
          ctx,
          `Stopped ${worker.handle}; its session and transcripts were retained.`,
        );
        return;
      }
    }
  } catch (error) {
    notify(ctx, errorMessage(error), "error");
  }
}

function actionOptions(worker: ManagedWorkerView): string[] {
  const actions = [
    "Open child",
    "Inspect latest assignments",
    "Send / steer",
    "Queue follow-up",
  ];
  if (worker.lifecycle !== "running" && worker.lifecycle !== "starting")
    actions.push("Resume");
  actions.push("Stop");
  return actions;
}

export function registerManagedUi(
  pi: ExtensionAPI,
  getRuntime: (ctx: ExtensionContext) => ManagedRuntime,
  isReported?: IsReported,
): void {
  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  let statusContext: ExtensionContext | undefined;

  const clearStatus = (ctx: ExtensionContext | undefined) => {
    if (ctx?.mode !== "tui" || !ctx.hasUI) return;
    try {
      ctx.ui.setStatus(MANAGED_FOOTER_STATUS_KEY, undefined);
    } catch {
      // The UI may already be torn down during reload or session replacement.
    }
  };

  const stopRefresh = () => {
    if (refreshTimer !== undefined) clearInterval(refreshTimer);
    refreshTimer = undefined;
    clearStatus(statusContext);
    statusContext = undefined;
  };

  pi.on("session_start", (_event, ctx) => {
    stopRefresh();
    let runtime: ManagedRuntime;
    try {
      // The parent integration owns session identity and gate rebinding.
      runtime = getRuntime(ctx);
    } catch {
      return;
    }
    if (ctx.mode !== "tui" || !ctx.hasUI) return;

    statusContext = ctx;
    const refresh = () => {
      try {
        const workers = runtime.list();
        const liveWorkers = workers.filter((worker) => worker.live);
        const pendingWorkers = workers
          .filter(
            (worker) =>
              !worker.live &&
              hasUnreportedTerminalAssignment(ctx, worker, isReported),
          )
          .sort((a, b) => b.createdAt - a.createdAt);
        const visibleWorkers = [...liveWorkers, ...pendingWorkers];
        if (visibleWorkers.length === 0) {
          clearStatus(ctx);
          return;
        }
        const rows = visibleWorkers
          .slice(0, FOOTER_WORKER_LIMIT)
          .map(footerWorkerLabel);
        if (visibleWorkers.length > FOOTER_WORKER_LIMIT)
          rows.push(`+${visibleWorkers.length - FOOTER_WORKER_LIMIT} more`);
        ctx.ui.setStatus(MANAGED_FOOTER_STATUS_KEY, rows.join("\n"));
      } catch {
        clearStatus(ctx);
      }
    };
    refresh();
    refreshTimer = setInterval(refresh, STATUS_REFRESH_MS);
    refreshTimer.unref?.();
  });

  pi.on("session_shutdown", () => {
    stopRefresh();
  });

  pi.registerCommand("subagent", {
    description: "Inspect and control managed subagents",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;

      try {
        const runtime = getRuntime(ctx);
        const workers = runtime.list();
        if (workers.length === 0) {
          notify(ctx, "No managed subagents in this session.");
          return;
        }

        const labels = workers.map(workerLabel);
        const selectedWorker = await ctx.ui.select(
          "Managed subagents · choose a worker",
          labels,
        );
        if (!selectedWorker) return;
        const worker = workers.find(
          (candidate) => workerLabel(candidate) === selectedWorker,
        );
        if (!worker) return;

        const selectedAction = await ctx.ui.select(
          workerLabel(worker),
          actionOptions(worker),
        );
        if (selectedAction)
          await runAction(ctx, runtime, worker, selectedAction);
      } catch (error) {
        notify(ctx, errorMessage(error), "error");
      }
    },
  });
}
