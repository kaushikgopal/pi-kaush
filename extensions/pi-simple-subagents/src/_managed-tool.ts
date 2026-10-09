import * as path from "node:path";
import type { AgentDiscoveryResult } from "./_definition.ts";
import type {
  ManagedIsolation,
  ManagedLaunch,
  ManagedWorkerView,
} from "./_managed.ts";
import { workerIdentity } from "./_managed-format.ts";
import type { ModelProfilesConfig } from "@pi-kaush/pi-model-profiles";
import { planProfileAttempts } from "./_profile-attempts.ts";
import { resolveRequestedModel, type DelegationTrace } from "./_delegation.ts";
import { truncateUtf8WithMarker } from "./_text.ts";

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
  readonly profiles: ModelProfilesConfig;
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
  const plan = planProfileAttempts({
    agentName: agent.name,
    agent,
    ...(input.request.model !== undefined
      ? { model: input.request.model }
      : {}),
    ...(input.request.profile !== undefined
      ? { profile: input.request.profile }
      : {}),
    profiles: input.profiles,
    availableModels: input.availableModelReferences,
  });
  if (plan.kind === "rejected" && plan.problem === "conflictingAgentConfig")
    return { ok: false, error: plan.reason };
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

  let profileName: string | undefined;
  let modelCandidates: string[] = [];
  switch (plan.kind) {
    case "rejected":
      return { ok: false, error: plan.reason };
    case "ladder":
      profileName = plan.profile;
      modelCandidates = [...plan.candidates];
      break;
    case "direct": {
      const requestedModelSpec = plan.model?.trim() || agent.model?.trim();
      if (!requestedModelSpec) break;
      const model = resolveRequestedModel(
        plan.model,
        agent.model,
        input.resolveModel,
      );
      if (!model)
        return {
          ok: false,
          error: `Model "${requestedModelSpec}" is not available in Pi's model catalog or its provider has no authentication.`,
        };
      modelCandidates = [model];
      break;
    }
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

export const MANAGED_TOOL_OUTPUT_LIMIT_BYTES = 50 * 1024;

/** Bounds a managed tool result to `MANAGED_TOOL_OUTPUT_LIMIT_BYTES`, marker included. */
export function boundManagedToolOutput(text: string): string {
  return truncateUtf8WithMarker(
    text,
    MANAGED_TOOL_OUTPUT_LIMIT_BYTES,
    "\n… managed result truncated; inspect the worker or assignment for details.",
  );
}

export function formatManagedWorkerSummary(worker: ManagedWorkerView): string {
  const state = worker.childState
    ? `${worker.lifecycle}/${worker.childState}`
    : worker.lifecycle;
  const model = worker.model ? ` · ${worker.model}` : "";
  const assignment = worker.activeAssignmentId
    ? ` · active ${worker.activeAssignmentId}`
    : ` · last ${worker.lastAssignmentId}`;
  const error = worker.lastError
    ? ` · error: ${worker.lastError.slice(0, 240)}`
    : "";
  return `${worker.handle} · ${workerIdentity(worker)} · ${state} · ${worker.hostKind}${model}${assignment} · queued ${worker.queued}${error}`;
}

export function truncateManagedText(
  text: string,
  maxBytes = 12 * 1024,
): string {
  return truncateUtf8WithMarker(
    text,
    maxBytes,
    "\n… result preview truncated.",
  );
}
