import type { ManagedAssignmentView, ManagedWorkerView } from "./_managed.ts";
import { formatUsageDetailed } from "./_usage.ts";

/** Shown when an agent definition has no emoji. */
const DEFAULT_WORKER_EMOJI = "🤖";

function workerEmoji(agent: { readonly emoji?: string }): string {
  return agent.emoji ?? DEFAULT_WORKER_EMOJI;
}

/** `🤖 name · profile`, the worker's identity without state or handle. */
export function workerIdentity(worker: {
  readonly agent: { readonly name: string; readonly emoji?: string };
  readonly profile?: string;
}): string {
  const profile = worker.profile ? ` · ${worker.profile}` : "";
  return `${workerEmoji(worker.agent)} ${worker.agent.name}${profile}`;
}

/** The active assignment, else the last one, else the newest retained one. */
function latestAssignment(
  worker: ManagedWorkerView,
): ManagedAssignmentView | undefined {
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

export function stateLabel(worker: ManagedWorkerView): string {
  const assignment = latestAssignment(worker);
  const workerState = worker.live
    ? (worker.childState ?? worker.lifecycle)
    : worker.lifecycle;
  if (!assignment) return workerState;
  if (assignment.state === "running") return "running";
  if (assignment.terminal) return `${assignment.state} · ${workerState}`;
  return assignment.state;
}

/** Picker label; unique per worker because it ends with the handle. */
export function workerLabel(worker: ManagedWorkerView): string {
  return `${workerIdentity(worker)} · ${stateLabel(worker)} · ${worker.handle}`;
}

/** One single-line footer row, state before name so it survives clipping. */
export function footerWorkerLabel(worker: ManagedWorkerView): string {
  const profile = worker.profile ? ` ${worker.profile}` : "";
  return `${workerEmoji(worker.agent)}${profile} · ${stateLabel(worker)} · ${worker.agent.name} · ${worker.handle}`.replace(
    /[\r\n]+/g,
    " ",
  );
}

export function formatWorkerInspection(worker: ManagedWorkerView): string {
  const lines = [
    workerIdentity(worker),
    `Handle: ${worker.handle}`,
    `State: ${stateLabel(worker)}`,
    `Model: ${worker.model ?? "(not reported)"}`,
    `Worker usage: ${formatUsageDetailed(worker.usage)}`,
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
      `Usage: ${formatUsageDetailed(assignment.usage)}`,
    );
    const artifacts = assignment.outcome?.artifacts ?? [];
    if (artifacts.length > 0)
      lines.push("Artifacts:", ...artifacts.map((artifact) => `- ${artifact}`));
  }
  return lines.join("\n");
}
