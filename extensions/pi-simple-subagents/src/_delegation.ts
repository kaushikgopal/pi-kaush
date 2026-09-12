import type { SubagentLimitsConfig } from "./_limits.ts";

export type ModelAliasThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

const THINKING_LEVELS = new Set<ModelAliasThinkingLevel>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

interface AvailableModel {
  provider: string;
  id: string;
  name?: string;
}

function parseModelSpec(modelSpec: string): {
  model: string;
  thinkingLevel?: ModelAliasThinkingLevel;
} {
  const spec = modelSpec.trim();
  const separator = spec.lastIndexOf(":");
  if (separator <= 0 || separator === spec.length - 1) return { model: spec };

  const suffix = spec.slice(separator + 1) as ModelAliasThinkingLevel;
  if (!THINKING_LEVELS.has(suffix)) return { model: spec };
  return { model: spec.slice(0, separator), thinkingLevel: suffix };
}

function normalizeModelName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function formatModelReference(
  model: AvailableModel,
  thinkingLevel?: ModelAliasThinkingLevel,
): string {
  return thinkingLevel
    ? `${model.provider}/${model.id}:${thinkingLevel}`
    : `${model.provider}/${model.id}`;
}

/** Leading alphabetic run of a model id/name, lowercased (e.g. "glm-5.2-fast" -> "glm"). */
function brandOf(value: string): string {
  return value.toLowerCase().match(/^[a-z]+/)?.[0] ?? "";
}

/** First dotted version run of a model id/name (e.g. "glm 5.6" -> [5, 6], "kimi-k3" -> [3]). */
function versionOf(value: string): number[] | undefined {
  const match = value.toLowerCase().match(/(\d+(?:\.\d+)*)/);
  return match ? match[1]!.split(".").map(Number) : undefined;
}

/** Comparable magnitude for a version tuple so higher versions sort first on ties. */
function versionValue(version: number[] | undefined): number {
  if (!version) return -1;
  let value = 0;
  for (const part of version) value = value * 1000 + part;
  return value;
}

/** Component-wise distance; an undefined side is infinitely far so versioned queries avoid versionless models. */
function versionDistance(
  a: number[] | undefined,
  b: number[] | undefined,
): number {
  if (!a || !b) return Number.POSITIVE_INFINITY;
  const length = Math.max(a.length, b.length);
  let distance = 0;
  for (let i = 0; i < length; i++)
    distance = distance * 1000 + Math.abs((a[i] ?? 0) - (b[i] ?? 0));
  return distance;
}

/**
 * Pick the best candidate for a bare model id or display name, never crossing model families.
 *
 * Tiers, in order: exact id/name, normalized (alnum-only) id/name, then same-family ranked by
 * nearest version (exact wins), newest version on tie, and finally candidate order. A brandless
 * query or one whose brand matches no candidate returns undefined rather than guessing across families.
 */
function selectBestModel(
  query: string,
  models: ReadonlyArray<AvailableModel>,
): AvailableModel | undefined {
  const lowerQuery = query.toLowerCase();
  const exact = models.find(
    (model) =>
      model.id.toLowerCase() === lowerQuery ||
      model.name?.toLowerCase() === lowerQuery,
  );
  if (exact) return exact;

  const normalizedQuery = normalizeModelName(query);
  if (normalizedQuery) {
    const normalizedExact = models.find((model) =>
      [model.id, model.name].some(
        (name) => name && normalizeModelName(name) === normalizedQuery,
      ),
    );
    if (normalizedExact) return normalizedExact;
  }

  const queryBrand = brandOf(query);
  if (!queryBrand) return undefined;
  const queryVersion = versionOf(query);

  const sameFamily = models
    .map((model, index) => ({ model, index }))
    .filter(({ model }) =>
      [model.id, model.name].some(
        (name) => name && brandOf(name) === queryBrand,
      ),
    );
  if (sameFamily.length === 0) return undefined;

  const ranked = sameFamily.map(({ model, index }) => {
    const candidateVersion = versionOf(model.id) ?? versionOf(model.name ?? "");
    return {
      model,
      index,
      distance: versionDistance(queryVersion, candidateVersion),
      newest: versionValue(candidateVersion),
    };
  });
  ranked.sort(
    (a, b) =>
      a.distance - b.distance || b.newest - a.newest || a.index - b.index,
  );
  return ranked[0]!.model;
}

/**
 * Resolve a bare or qualified model spec to a canonical `provider/model` reference.
 *
 * - Qualified refs (containing `/`) are returned unchanged with their thinking level preserved.
 * - Bare ids and display names resolve against the supplied candidates: exact, normalized, then
 *   same-family nearest-version matching; unmatched specs return undefined rather than crossing families.
 */
export function resolveModelReference(
  modelSpec: string,
  availableModels: ReadonlyArray<AvailableModel>,
): string | undefined {
  const { model: baseSpec, thinkingLevel } = parseModelSpec(modelSpec);
  const slashIndex = baseSpec.indexOf("/");
  if (slashIndex > 0 && slashIndex < baseSpec.length - 1) {
    return thinkingLevel ? `${baseSpec}:${thinkingLevel}` : baseSpec;
  }

  const match = selectBestModel(baseSpec, availableModels);
  return match ? formatModelReference(match, thinkingLevel) : undefined;
}

export function delegationModelCandidates(
  scopedModels: ReadonlyArray<{ model: AvailableModel }>,
  availableModels: ReadonlyArray<AvailableModel>,
): ReadonlyArray<AvailableModel> {
  return scopedModels.length > 0
    ? scopedModels.map(({ model }) => model)
    : availableModels;
}

export function createModelResolver(
  availableModels: ReadonlyArray<AvailableModel>,
): (spec: string) => string | undefined {
  return (spec: string) => resolveModelReference(spec, availableModels);
}

export interface DelegationTrace {
  rootSessionId: string;
  parentSessionId: string;
  parentToolCallId: string;
  depth: number;
}

const ROOT_SESSION_ENV = "PI_SUBAGENT_ROOT_SESSION_ID";
const PARENT_SESSION_ENV = "PI_SUBAGENT_PARENT_SESSION_ID";
const PARENT_TOOL_CALL_ENV = "PI_SUBAGENT_PARENT_TOOL_CALL_ID";
const DEPTH_ENV = "PI_SUBAGENT_DEPTH";

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function inheritedDepth(env: NodeJS.ProcessEnv): number {
  const raw = env[DEPTH_ENV]?.trim();
  if (!raw || !/^\d+$/.test(raw)) return 0;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : 0;
}

export function currentDelegationDepth(
  env: NodeJS.ProcessEnv = process.env,
): number {
  return inheritedDepth(env);
}

export function createDelegationTrace(
  parentSessionId: string,
  parentToolCallId: string,
  env: NodeJS.ProcessEnv = process.env,
): DelegationTrace {
  return {
    rootSessionId: nonEmpty(env[ROOT_SESSION_ENV]) ?? parentSessionId,
    parentSessionId,
    parentToolCallId,
    depth: inheritedDepth(env) + 1,
  };
}

export function buildSubagentEnvironment(
  trace: DelegationTrace,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = { ...baseEnv };
  for (const key of Object.keys(env)) {
    if (key.toUpperCase().startsWith("HERDR_")) delete env[key];
  }

  env[ROOT_SESSION_ENV] = trace.rootSessionId;
  env[PARENT_SESSION_ENV] = trace.parentSessionId;
  env[PARENT_TOOL_CALL_ENV] = trace.parentToolCallId;
  env[DEPTH_ENV] = String(trace.depth);
  return env;
}

export function resolveRequestedModel(
  invocationModel?: string,
  agentModel?: string,
  resolveModel?: (spec: string) => string | undefined,
): string | undefined {
  const raw = nonEmpty(invocationModel) ?? nonEmpty(agentModel);
  if (!raw) return undefined;
  return resolveModel ? resolveModel(raw) : raw;
}

export function buildSharedTaskPrompt(task: string, context?: string): string {
  const shared = context?.trim();
  if (!shared) return task;
  return `Shared context:\n${shared}\n\nAssigned task:\n${task}`;
}

export function buildChildSessionName(agentName: string, task: string): string {
  const preview = task.replace(/\s+/g, " ").trim();
  if (!preview) return `subagent(${agentName})`;
  const clipped = preview.length > 60 ? `${preview.slice(0, 57)}...` : preview;
  return `subagent(${agentName}): ${clipped}`;
}

export function hasDelegatedToolActivity(
  messages: readonly {
    role: string;
    content?: string | readonly { type: string }[];
  }[],
): boolean {
  return messages.some(
    (message) =>
      message.role === "toolResult" ||
      (message.role === "assistant" &&
        Array.isArray(message.content) &&
        message.content.some((part) => part.type === "toolCall")),
  );
}

export function buildDelegatedSystemPrompt(
  agentPrompt: string,
  trace: DelegationTrace,
  limits: SubagentLimitsConfig,
): string {
  const delegationRule =
    trace.depth < limits.maxDepth
      ? `- You may use Pi subagents for bounded work. This child session may run at most ${limits.maxConcurrency} children at once and list at most ${limits.maxChildrenPerCall} children in one call; completed children release their slots.`
      : `- Do not invoke Pi subagents. Delegation depth ${limits.maxDepth} is the hard maximum and the subagent tool is intentionally unavailable.`;
  const boundary = [
    "## Delegated Pi execution boundary",
    `You are a Pi subagent at delegation depth ${trace.depth} of the hard maximum ${limits.maxDepth}. The calling chat remains the orchestrator.`,
    "- Never invoke or control herdr: do not use its skill, CLI, panes, agents, or socket. Herdr access is intentionally removed from delegated processes.",
    "- If work needs a visible long-running pane, report that need to the caller instead of creating one.",
    delegationRule,
    '- Finish by calling the "yield" tool exactly once with status, result, and any useful artifact paths. The tool terminates this child immediately.',
    "- Complete only the assigned scope and report blockers or follow-up work clearly.",
  ].join("\n");

  const prompt = agentPrompt.trim();
  return prompt ? `${prompt}\n\n${boundary}` : boundary;
}

export function sessionIdFromJsonEvent(event: unknown): string | undefined {
  if (!event || typeof event !== "object") return undefined;
  const candidate = event as { type?: unknown; id?: unknown };
  return candidate.type === "session" &&
    typeof candidate.id === "string" &&
    candidate.id.length > 0
    ? candidate.id
    : undefined;
}
