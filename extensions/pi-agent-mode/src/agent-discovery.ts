/**
 * Agent discovery for `/agent` mode activation.
 *
 * Discovery reads Markdown agent definitions from Pi's user agent directory
 * and the nearest project `agents/` directory. Agent Markdown files remain
 * the source of persona/model/tool definitions; this module never spawns
 * children or runs delegated subagents.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  CONFIG_DIR_NAME,
  getAgentDir,
  parseFrontmatter,
} from "@earendil-works/pi-coding-agent";

export type AgentScope = "user" | "project" | "both";

export interface AgentConfig {
  name: string;
  description: string;
  emoji?: string;
  tools?: string[];
  model?: string;
  confirmProjectAgents?: boolean;
  systemPrompt: string;
  source: "user" | "project";
  filePath: string;
}

interface AgentFrontmatter extends Record<string, unknown> {
  name?: string;
  description?: string;
  emoji?: string;
  tools?: string;
  model?: string;
  confirmProjectAgents?: boolean;
}

export interface AgentDiscoveryResult {
  agents: AgentConfig[];
  projectAgentsDir: string | null;
}

export interface AgentIdentity {
  name: string;
  emoji?: string;
}

export function formatAgentDisplayName(agent: AgentIdentity): string {
  const emoji = agent.emoji?.trim();
  return emoji ? `${emoji} ${agent.name}` : agent.name;
}

function loadAgentsFromDir(
  dir: string,
  source: "user" | "project",
): AgentConfig[] {
  const agents: AgentConfig[] = [];

  if (!fs.existsSync(dir)) {
    return agents;
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return agents;
  }

  for (const entry of entries) {
    if (!entry.name.endsWith(".md")) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;

    const filePath = path.join(dir, entry.name);
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }

    const { frontmatter, body } = parseFrontmatter<AgentFrontmatter>(content);

    if (!frontmatter.name || !frontmatter.description) {
      continue;
    }

    const tools = frontmatter.tools
      ?.split(",")
      .map((t: string) => t.trim())
      .filter(Boolean);

    const emoji = frontmatter.emoji?.trim();
    agents.push({
      name: frontmatter.name,
      description: frontmatter.description,
      ...(emoji ? { emoji } : {}),
      ...(tools && tools.length > 0 ? { tools } : {}),
      ...(frontmatter.model ? { model: frontmatter.model } : {}),
      ...(typeof frontmatter.confirmProjectAgents === "boolean"
        ? { confirmProjectAgents: frontmatter.confirmProjectAgents }
        : {}),
      systemPrompt: body,
      source,
      filePath,
    });
  }

  return agents;
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function findNearestProjectAgentsDir(cwd: string): string | null {
  let currentDir = cwd;
  while (true) {
    const candidate = path.join(currentDir, CONFIG_DIR_NAME, "agents");
    if (isDirectory(candidate)) return candidate;

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) return null;
    currentDir = parentDir;
  }
}

export function discoverAgents(
  cwd: string,
  scope: AgentScope,
): AgentDiscoveryResult {
  const userDir = path.join(getAgentDir(), "agents");
  const projectAgentsDir = findNearestProjectAgentsDir(cwd);

  const userAgents =
    scope === "project" ? [] : loadAgentsFromDir(userDir, "user");
  const projectAgents =
    scope === "user" || !projectAgentsDir
      ? []
      : loadAgentsFromDir(projectAgentsDir, "project");

  const agentMap = new Map<string, AgentConfig>();

  if (scope === "both") {
    for (const agent of userAgents) agentMap.set(agent.name, agent);
    for (const agent of projectAgents) agentMap.set(agent.name, agent);
  } else if (scope === "user") {
    for (const agent of userAgents) agentMap.set(agent.name, agent);
  } else {
    for (const agent of projectAgents) agentMap.set(agent.name, agent);
  }

  return { agents: Array.from(agentMap.values()), projectAgentsDir };
}

export function shouldConfirmProjectAgent(
  agent: AgentConfig,
  invocationSetting?: boolean,
): boolean {
  return invocationSetting ?? agent.confirmProjectAgents ?? true;
}
