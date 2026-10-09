import * as path from "node:path";
import type { AgentDiscoveryResult } from "./_definition.ts";
import type { ManagedLaunch, ManagedIsolation } from "./_managed.ts";
import {
  formatProfileCandidate,
  formatProfileEligibilityError,
  type SubagentProfilesConfig,
} from "./_profiles.ts";
import { resolveRequestedModel, type DelegationTrace } from "./_delegation.ts";
import { truncateUtf8Head } from "./_transcript.ts";

export interface ManagedIsolationOptions extends ManagedIsolation {
  readonly noMcp?: boolean;
}

export interface ManagedLaunchRequest {
  readonly agent: string;
  readonly task: string;
  readonly profile?: string;
  readonly model?: string;
  readonly cwd?: string;
  readonly tools?: readonly string[];
  readonly isolation?: ManagedIsolationOptions;
}

export type ManagedLaunchPreparation =
  | { readonly ok: true; readonly launch: ManagedLaunch }
  | { readonly ok: false; readonly error: string };

/** Resolve all parent-owned launch choices before asking the engine to start a worker. */
export function prepareManagedLaunch(input: {
  readonly discovery: AgentDiscoveryResult;
  readonly profiles: SubagentProfilesConfig;
  readonly availableModelReferences: ReadonlySet<string>;
  readonly resolveModel: (spec: string) => string | undefined;
  readonly defaultCwd: string;
  readonly trace: DelegationTrace;
  readonly context?: string;
  readonly request: ManagedLaunchRequest;
}): ManagedLaunchPreparation {
  const agent = input.discovery.agents.find(
    (candidate) => candidate.name === input.request.agent,
  );
  if (!input.request.agent.trim())
    return { ok: false, error: "Agent name must not be empty." };
  if (!input.request.task.trim())
    return { ok: false, error: "Managed worker task must not be empty." };
  if (!agent) {
    const available =
      input.discovery.agents
        .map((candidate) => `"${candidate.name}"`)
        .join(", ") || "none";
    return {
      ok: false,
      error: `Unknown agent: "${input.request.agent}". Available agents: ${available}.`,
    };
  }
  if (agent.profile && agent.model) {
    return {
      ok: false,
      error: `Agent "${agent.name}": declare either "profile" or "model" in frontmatter, not both.`,
    };
  }
  if (input.request.tools && input.request.tools.length === 0) {
    return {
      ok: false,
      error:
        "An empty tools override is not supported; omit tools to use the agent's configured tools.",
    };
  }
  if (input.request.isolation?.noMcp) {
    return {
      ok: false,
      error:
        'Managed workers do not support noMcp isolation yet. Use action "run" for a bounded isolated child.',
    };
  }

  const requestedModelSpec = input.request.model?.trim();
  const profileName = requestedModelSpec
    ? undefined
    : input.request.profile?.trim() || agent.profile;
  let modelCandidates: string[] = [];

  if (requestedModelSpec) {
    const model = resolveRequestedModel(
      requestedModelSpec,
      undefined,
      input.resolveModel,
    );
    if (!model) {
      return {
        ok: false,
        error: `Model "${requestedModelSpec}" is not available in Pi's model catalog or its provider has no authentication.`,
      };
    }
    modelCandidates = [model];
  } else if (profileName) {
    const profile = input.profiles.profiles[profileName];
    if (!profile) {
      return {
        ok: false,
        error: `Unknown subagent profile "${profileName}". Available profiles: ${Object.keys(input.profiles.profiles).join(", ")}.`,
      };
    }
    const candidates = profile.candidates.filter((candidate) =>
      input.availableModelReferences.has(candidate.model.toLowerCase()),
    );
    if (candidates.length === 0) {
      return {
        ok: false,
        error: formatProfileEligibilityError(
          profileName,
          profile.candidates,
          input.availableModelReferences,
          input.availableModelReferences.size,
        ),
      };
    }
    modelCandidates = candidates.map(formatProfileCandidate);
  } else if (agent.model?.trim()) {
    const model = resolveRequestedModel(
      undefined,
      agent.model,
      input.resolveModel,
    );
    if (!model) {
      return {
        ok: false,
        error: `Model "${agent.model.trim()}" is not available in Pi's model catalog or its provider has no authentication.`,
      };
    }
    modelCandidates = [model];
  }

  const tools = input.request.tools ?? agent.tools;
  const isolation = input.request.isolation;
  const launch: ManagedLaunch = {
    agent: {
      name: agent.name,
      source: agent.source,
      systemPrompt: agent.systemPrompt,
      ...(agent.emoji ? { emoji: agent.emoji } : {}),
      ...(tools ? { tools: [...tools] } : {}),
    },
    ...(profileName ? { profile: profileName } : {}),
    modelCandidates,
    cwd: path.resolve(input.defaultCwd, input.request.cwd?.trim() || "."),
    trace: input.trace,
    task: input.context?.trim()
      ? `Shared context:\n${input.context.trim()}\n\nAssigned task:\n${input.request.task}`
      : input.request.task,
    ...(isolation
      ? {
          isolation: {
            ...(isolation.noExtensions ? { noExtensions: true } : {}),
            ...(isolation.noSkills ? { noSkills: true } : {}),
            ...(isolation.noContextFiles ? { noContextFiles: true } : {}),
            ...(isolation.noPromptTemplates ? { noPromptTemplates: true } : {}),
          },
        }
      : {}),
  };
  return { ok: true, launch };
}

const CONTROL_FIELDS = [
  "handle",
  "assignmentId",
  "message",
  "delivery",
  "waitTimeoutMs",
] as const;
const INVOCATION_FIELDS = [
  "agent",
  "task",
  "profile",
  "model",
  "context",
  "tasks",
  "chain",
  "cwd",
  "agentScope",
  "confirmProjectAgents",
  "isolation",
  "tools",
] as const;

function supplied(value: unknown): boolean {
  return value !== undefined && value !== null;
}

/** Reject mixed control and launch requests instead of silently discarding input. */
export function validateManagedAction(
  action: string,
  params: Record<string, unknown>,
): string | undefined {
  const controls = CONTROL_FIELDS.filter((field) => supplied(params[field]));
  const invocation = INVOCATION_FIELDS.filter((field) =>
    supplied(params[field]),
  );
  const emptyToolOverride = (value: unknown): boolean =>
    Array.isArray(value) && value.length === 0;
  const taskOverrides = [params.tasks, params.chain].flatMap((value) =>
    Array.isArray(value)
      ? value.filter(
          (item): item is Record<string, unknown> =>
            typeof item === "object" && item !== null,
        )
      : [],
  );
  if (
    emptyToolOverride(params.tools) ||
    taskOverrides.some((item) => emptyToolOverride(item.tools))
  )
    return "An empty tools override is not supported; omit tools to use the agent's configured tools.";
  if (action === "run") {
    return controls.length > 0
      ? `Action "run" does not accept managed control fields: ${controls.join(", ")}.`
      : undefined;
  }
  if (action === "spawn") {
    if (controls.length > 0)
      return `Action "spawn" does not accept managed control fields: ${controls.join(", ")}.`;
    if (supplied(params.chain))
      return 'Managed spawn does not support chains; use action "run" for bounded chains.';
    const single = supplied(params.agent) || supplied(params.task);
    const batch = supplied(params.tasks);
    if (batch && (!Array.isArray(params.tasks) || params.tasks.length === 0))
      return 'Action "spawn" requires a non-empty tasks[] batch.';
    if (Number(single) + Number(batch) !== 1)
      return 'Action "spawn" requires exactly one agent/task or a tasks[] batch.';
    if (single && (!supplied(params.agent) || !supplied(params.task)))
      return 'Action "spawn" single mode requires both agent and task.';
    if (batch && (supplied(params.agent) || supplied(params.task)))
      return 'Action "spawn" tasks[] cannot be mixed with top-level agent or task.';
    if (batch && (supplied(params.profile) || supplied(params.model)))
      return 'Action "spawn" tasks[] takes profile/model on each task, not at the top level.';
    if (supplied(params.context) && !batch)
      return 'Action "spawn" context is supported only with tasks[].';
    return undefined;
  }
  if (!["status", "list", "send", "wait", "stop", "resume"].includes(action))
    return `Unknown subagent action "${action}".`;

  if (invocation.length > 0)
    return `Action "${action}" does not accept launch fields: ${invocation.join(", ")}.`;
  if (action === "list") {
    if (controls.length > 0)
      return `Action "list" does not accept control fields: ${controls.join(", ")}.`;
    return undefined;
  }
  if (
    !supplied(params.handle) ||
    typeof params.handle !== "string" ||
    !params.handle.trim()
  )
    return `Action "${action}" requires a non-empty handle.`;
  if (action === "send") {
    if (
      !supplied(params.message) ||
      typeof params.message !== "string" ||
      !params.message.trim()
    )
      return 'Action "send" requires a non-empty message.';
    if (supplied(params.assignmentId) || supplied(params.waitTimeoutMs))
      return 'Action "send" does not accept assignmentId or waitTimeoutMs.';
    if (
      supplied(params.delivery) &&
      params.delivery !== "auto" &&
      params.delivery !== "followUp"
    )
      return 'Action "send" delivery must be "auto" or "followUp".';
    return undefined;
  }
  if (action === "wait") {
    if (supplied(params.message) || supplied(params.delivery))
      return 'Action "wait" does not accept message or delivery.';
    if (
      supplied(params.waitTimeoutMs) &&
      (typeof params.waitTimeoutMs !== "number" ||
        !Number.isFinite(params.waitTimeoutMs) ||
        params.waitTimeoutMs < 0 ||
        params.waitTimeoutMs > 86_400_000)
    )
      return "waitTimeoutMs must be between 0 and 86400000.";
    if (
      supplied(params.assignmentId) &&
      (typeof params.assignmentId !== "string" || !params.assignmentId.trim())
    )
      return "assignmentId must be a non-empty string.";
    return undefined;
  }
  if (controls.some((field) => field !== "handle"))
    return `Action "${action}" accepts only handle.`;
  return undefined;
}

export const MANAGED_TOOL_OUTPUT_LIMIT_BYTES = 50 * 1024;

export function boundManagedToolOutput(text: string): string {
  const preview = truncateUtf8Head(text, MANAGED_TOOL_OUTPUT_LIMIT_BYTES);
  return preview.truncated
    ? `${preview.value}\n… managed result truncated; inspect the worker or assignment for details.`
    : text;
}

export function formatManagedWorkerSummary(worker: {
  readonly handle: string;
  readonly agent: { readonly name: string; readonly emoji?: string };
  readonly profile?: string;
  readonly model?: string;
  readonly lifecycle: string;
  readonly childState?: string;
  readonly hostKind: string;
  readonly activeAssignmentId?: string;
  readonly queued: number;
  readonly lastAssignmentId: string;
  readonly lastError?: string;
}): string {
  const state = worker.childState
    ? `${worker.lifecycle}/${worker.childState}`
    : worker.lifecycle;
  const profile = worker.profile ? ` · ${worker.profile}` : "";
  const model = worker.model ? ` · ${worker.model}` : "";
  const assignment = worker.activeAssignmentId
    ? ` · active ${worker.activeAssignmentId}`
    : ` · last ${worker.lastAssignmentId}`;
  const error = worker.lastError
    ? ` · error: ${worker.lastError.slice(0, 240)}`
    : "";
  return `${worker.handle} · ${worker.agent.emoji ?? "🤖"} ${worker.agent.name}${profile} · ${state} · ${worker.hostKind}${model}${assignment} · queued ${worker.queued}${error}`;
}

export function truncateManagedText(
  text: string,
  maxBytes = 12 * 1024,
): string {
  const preview = truncateUtf8Head(text, maxBytes);
  return preview.truncated
    ? `${preview.value}\n… result preview truncated.`
    : text;
}
