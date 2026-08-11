/**
 * Parsing of agent-configured model specifications.
 *
 * Agent frontmatter `model` values may carry a thinking suffix such as
 * `:low`, `:high`, or `:max`. Unknown suffixes are left attached to the
 * model id so lookup can decide whether the id as a whole exists.
 */

export type ThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

const THINKING_LEVELS = new Set<ThinkingLevel>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

export interface AgentModelSpec {
  model: string;
  thinkingLevel?: ThinkingLevel;
}

export function parseAgentModelSpec(modelSpec: string): AgentModelSpec {
  const spec = modelSpec.trim();
  const separator = spec.lastIndexOf(":");
  if (separator <= 0 || separator === spec.length - 1) return { model: spec };

  const suffix = spec.slice(separator + 1) as ThinkingLevel;
  if (!THINKING_LEVELS.has(suffix)) return { model: spec };
  return { model: spec.slice(0, separator), thinkingLevel: suffix };
}
