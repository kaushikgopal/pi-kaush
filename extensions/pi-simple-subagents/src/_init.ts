/**
 * First-run scaffold behind `subagent { action: "init" }`. Writes a starter
 * agent definition and a minimal profiles file, never overwriting anything.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const AGENT_TEMPLATE = [
  "---",
  "emoji: 🐝",
  "profile: quick",
  "---",
  "",
  "You are a general worker bee. Complete the delegated task, then call the",
  "yield tool exactly once with a concise structured result.",
  "",
  "- Do the work directly with your available tools. Verify claims with real",
  "  command output or file contents; a check you did not run is not a result.",
  "- Set status to completed only when the task is done; blocked when external",
  "  input or access is required; failed when it cannot be completed; paused",
  "  when you must stop without an answer while the work stays resumable.",
  "- Keep the full handoff in result and put artifact paths in artifacts.",
  "",
].join("\n");

const PROFILES_TEMPLATE = [
  "# Execution profiles: ordered model-candidate ladders shared with",
  "# @pi-kaush/pi-agent-mode and @pi-kaush/pi-model-profiles.",
  "# Replace the candidate with any provider/model you are authenticated for.",
  "version: 1",
  "profiles:",
  "  quick:",
  "    description: Fast, low-cost execution for simple tasks.",
  "    candidates:",
  "      - model: anthropic/claude-haiku-4-5",
  "",
].join("\n");

export interface ScaffoldOutcome {
  readonly file: string;
  readonly created: boolean;
  readonly error?: string;
}

/** Writes missing starter files under the agent dir; never overwrites. */
export function initScaffoldFiles(agentDir: string): ScaffoldOutcome[] {
  const agentsDir = path.join(agentDir, "agents");
  const targets: { readonly file: string; readonly content: string }[] = [
    { file: path.join(agentsDir, "bee.md"), content: AGENT_TEMPLATE },
    { file: path.join(agentDir, "profiles.yaml"), content: PROFILES_TEMPLATE },
  ];
  try {
    mkdirSync(agentsDir, { recursive: true });
  } catch (error) {
    const message = errorText(error);
    return targets.map((target) => ({
      file: target.file,
      created: false,
      error: message,
    }));
  }
  return targets.map((target) => {
    if (existsSync(target.file)) return { file: target.file, created: false };
    try {
      writeFileSync(target.file, target.content, { mode: 0o600 });
      return { file: target.file, created: true };
    } catch (error) {
      return { file: target.file, created: false, error: errorText(error) };
    }
  });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
