/**
 * Pure precedence rules for choosing which model(s) a delegated agent runs on:
 * an explicit model beats an invocation profile, which beats the agent's
 * frontmatter profile, which beats the agent's frontmatter model.
 */
import {
  formatProfileCandidate,
  type ModelProfilesConfig,
} from "@pi-kaush/pi-model-profiles";
import type { AgentConfig } from "./_definition.ts";
import { formatProfileEligibilityError } from "./_profiles.ts";

export type ProfileAttemptPlan =
  /** The request cannot run; `profile` is the profile it was attributed to. */
  | {
      readonly kind: "rejected";
      readonly problem:
        | "conflictingAgentConfig"
        | "unknownProfile"
        | "noEligibleCandidates";
      readonly profile: string;
      readonly reason: string;
    }
  /** Run once on the explicit model, or else the agent's own model (unresolved). */
  | { readonly kind: "direct"; readonly model?: string }
  /** Try eligible profile candidates in order until one is decisive. */
  | {
      readonly kind: "ladder";
      readonly profile: string;
      readonly candidates: readonly string[];
    };

export interface ProfileAttemptInput {
  readonly agentName: string;
  readonly agent: Pick<AgentConfig, "profile" | "model"> | undefined;
  readonly model?: string;
  readonly profile?: string;
  readonly profiles: ModelProfilesConfig;
  /** Lower-cased `provider/id` references Pi can currently run. */
  readonly availableModels: ReadonlySet<string>;
}

export function planProfileAttempts(
  input: ProfileAttemptInput,
): ProfileAttemptPlan {
  const { agent, agentName } = input;
  if (agent?.profile && agent.model)
    return {
      kind: "rejected",
      problem: "conflictingAgentConfig",
      profile: agent.profile,
      reason: `Agent "${agentName}": declare either "profile" or "model" in frontmatter, not both.`,
    };
  const profileName = input.profile?.trim() || agent?.profile;
  if (input.model?.trim() || !profileName)
    return input.model === undefined
      ? { kind: "direct" }
      : { kind: "direct", model: input.model };

  const profile = input.profiles.profiles[profileName];
  if (!profile)
    return {
      kind: "rejected",
      problem: "unknownProfile",
      profile: profileName,
      reason: `Unknown subagent profile "${profileName}". Available profiles: ${Object.keys(input.profiles.profiles).join(", ")}.`,
    };
  const candidates = profile.candidates.filter((candidate) =>
    input.availableModels.has(candidate.model.toLowerCase()),
  );
  if (candidates.length === 0)
    return {
      kind: "rejected",
      problem: "noEligibleCandidates",
      profile: profileName,
      reason: formatProfileEligibilityError(
        profileName,
        profile.candidates,
        input.availableModels,
        input.availableModels.size,
      ),
    };
  return {
    kind: "ladder",
    profile: profileName,
    candidates: candidates.map(formatProfileCandidate),
  };
}
