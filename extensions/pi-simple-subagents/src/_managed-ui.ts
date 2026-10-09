import * as path from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Key, Text, matchesKey, type Component } from "@earendil-works/pi-tui";
import type { ManagedRuntime, ManagedWorkerView } from "./_managed.ts";
import {
  footerWorkerLabel,
  formatWorkerInspection,
  stateLabel,
  workerLabel,
} from "./_managed-format.ts";
import { errorText, isStaleContextError } from "./_parse.ts";

/**
 * `below-footer:` statuses are a contract with pi-footer-minimal, which
 * renders each line as its own row; Pi's native footer flattens them.
 */
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

/** Whether a worker result was already reported or collected in the parent. */
export type IsReported = (
  ctx: ExtensionContext,
  handle: string,
  assignmentId: string,
) => boolean;

/** Without a reporting source, every retained terminal result stays visible. */
const NOTHING_REPORTED: IsReported = () => false;

function hasUnreportedTerminalAssignment(
  ctx: ExtensionContext,
  worker: ManagedWorkerView,
  isReported: IsReported,
): boolean {
  return worker.recentAssignments.some(
    (assignment) =>
      assignment.terminal &&
      !isReported(ctx, worker.handle, assignment.mergedInto ?? assignment.id),
  );
}

function notify(
  ctx: ExtensionContext,
  message: string,
  type: "info" | "warning" | "error" = "info",
): void {
  if (ctx.hasUI) ctx.ui.notify(message, type);
}

async function inspectWorker(
  ctx: ExtensionContext,
  worker: ManagedWorkerView,
): Promise<void> {
  const content = formatWorkerInspection(worker);
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

type ActionId = "open" | "inspect" | "steer" | "followUp" | "resume" | "stop";

const ACTION_LABELS: Readonly<Record<ActionId, string>> = {
  open: "Open child",
  inspect: "Inspect latest assignments",
  steer: "Send / steer",
  followUp: "Queue follow-up",
  resume: "Resume",
  stop: "Stop",
};

function availableActions(worker: ManagedWorkerView): readonly ActionId[] {
  const resumable =
    worker.lifecycle !== "running" && worker.lifecycle !== "starting";
  return [
    "open",
    "inspect",
    "steer",
    "followUp",
    ...(resumable ? (["resume"] as const) : []),
    "stop",
  ];
}

async function runAction(
  ctx: ExtensionContext,
  runtime: ManagedRuntime,
  worker: ManagedWorkerView,
  action: ActionId,
): Promise<void> {
  try {
    switch (action) {
      case "open": {
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
      case "inspect": {
        await inspectWorker(ctx, runtime.status(worker.handle));
        return;
      }
      case "steer": {
        const message = await ctx.ui.input(
          `Send / steer · ${worker.handle}`,
          "Message to managed worker",
        );
        if (!message?.trim()) return;
        const assignment = runtime.send(worker.handle, message.trim(), "auto");
        notify(ctx, `Sent to ${worker.handle} as ${assignment.assignmentId}.`);
        return;
      }
      case "followUp": {
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
      case "resume": {
        const resumed = await runtime.resume(worker.handle);
        notify(ctx, `Resumed ${worker.handle} (${stateLabel(resumed)}).`);
        return;
      }
      case "stop": {
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
      default: {
        const unhandled: never = action;
        return unhandled;
      }
    }
  } catch (error) {
    notify(ctx, errorText(error), "error");
  }
}

/** Picks one item by its unique display label; undefined when dismissed. */
async function selectByLabel<T>(
  ctx: ExtensionContext,
  title: string,
  items: readonly T[],
  label: (item: T) => string,
): Promise<T | undefined> {
  const labels = items.map(label);
  const selected = await ctx.ui.select(title, labels);
  if (selected === undefined) return undefined;
  return items[labels.indexOf(selected)];
}

/** Footer rows: live workers first, then unreported results, newest first. */
function footerRows(
  ctx: ExtensionContext,
  workers: readonly ManagedWorkerView[],
  isReported: IsReported,
): string[] {
  const liveWorkers = workers.filter((worker) => worker.live);
  const pendingWorkers = workers
    .filter(
      (worker) =>
        !worker.live &&
        hasUnreportedTerminalAssignment(ctx, worker, isReported),
    )
    .sort((a, b) => b.createdAt - a.createdAt);
  const visibleWorkers = [...liveWorkers, ...pendingWorkers];
  const rows = visibleWorkers
    .slice(0, FOOTER_WORKER_LIMIT)
    .map(footerWorkerLabel);
  if (visibleWorkers.length > FOOTER_WORKER_LIMIT)
    rows.push(`+${visibleWorkers.length - FOOTER_WORKER_LIMIT} more`);
  return rows;
}

/** Logs each distinct unexpected background failure once instead of every tick. */
function createBackgroundErrorLog(scope: string): (error: unknown) => void {
  const logged = new Set<string>();
  return (error) => {
    const text = errorText(error);
    if (logged.has(text)) return;
    logged.add(text);
    console.error(`[pi-simple-subagents] ${scope}:`, error);
  };
}

export function registerManagedUi(
  pi: ExtensionAPI,
  getRuntime: (ctx: ExtensionContext) => ManagedRuntime,
  isReported?: IsReported,
): void {
  const reported = isReported ?? NOTHING_REPORTED;
  const logRefreshError = createBackgroundErrorLog("managed footer refresh");
  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  let statusContext: ExtensionContext | undefined;

  const clearStatus = (ctx: ExtensionContext | undefined) => {
    if (ctx?.mode !== "tui" || !ctx.hasUI) return;
    try {
      ctx.ui.setStatus(MANAGED_FOOTER_STATUS_KEY, undefined);
    } catch (error) {
      // The UI may already be torn down during reload or session replacement.
      if (!isStaleContextError(error)) logRefreshError(error);
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
      // The parent integration owns session identity and gate rebinding; it
      // throws in child sessions and before its session is ready.
      runtime = getRuntime(ctx);
    } catch {
      return;
    }
    if (ctx.mode !== "tui" || !ctx.hasUI) return;

    statusContext = ctx;
    const refresh = () => {
      try {
        const rows = footerRows(ctx, runtime.list(), reported);
        if (rows.length === 0) clearStatus(ctx);
        else ctx.ui.setStatus(MANAGED_FOOTER_STATUS_KEY, rows.join("\n"));
      } catch (error) {
        if (!isStaleContextError(error)) logRefreshError(error);
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

        const worker = await selectByLabel(
          ctx,
          "Managed subagents · choose a worker",
          workers,
          workerLabel,
        );
        if (!worker) return;

        const action = await selectByLabel(
          ctx,
          workerLabel(worker),
          availableActions(worker),
          (id) => ACTION_LABELS[id],
        );
        if (action) await runAction(ctx, runtime, worker, action);
      } catch (error) {
        notify(ctx, errorText(error), "error");
      }
    },
  });
}
