import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  CONFIG_DIR_NAME,
  getAgentDir,
  parseFrontmatter,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  escapeRegex,
  identifierColor,
  type InlineIdentifierDefinition,
  type InlineIdentifierFeature,
  registerInlineIdentifierFeature,
} from "./core.ts";

const AGENT_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const AGENT_TOKEN_START = "(?<![a-z0-9._%+&-])";
const AGENT_TOKEN_END = "(?![a-z0-9_-]|\\.[a-z0-9])";
const AGENT_AUTOCOMPLETE_RE = /(?:^|[ \t])(&[a-z0-9_-]*)$/i;
const AGENT_AUTOCOMPLETE_STOP_RE = /(?:^|[ \t])&[a-z0-9_-]*[ \t]$/i;
// Colors come from the session theme (borderAccent token); see core.ts.
const FG_RESET = "\x1b[39m";

type AgentFrontmatter = {
  name?: unknown;
  description?: unknown;
};

export type AgentDefinition = {
  name: string;
  description?: string;
  source: "user" | "project";
  filePath: string;
};

export type NamedSubagentSupport = {
  available: boolean;
  supportsProjectScope: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function getNamedSubagentSupport(
  pi: Pick<ExtensionAPI, "getAllTools">,
): NamedSubagentSupport {
  const tool = pi
    .getAllTools()
    .find((candidate) => candidate.name === "subagent");
  if (!tool || !isRecord(tool.parameters)) {
    return { available: false, supportsProjectScope: false };
  }

  const properties = tool.parameters.properties;
  if (!isRecord(properties) || !("agent" in properties)) {
    return { available: false, supportsProjectScope: false };
  }

  return {
    available: true,
    supportsProjectScope: "agentScope" in properties,
  };
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function agentFiles(dir: string): string[] {
  if (!isDirectory(dir)) return [];

  const files: string[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  } catch {
    return [];
  }

  for (const entry of entries) {
    const filePath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...agentFiles(filePath));
    } else if (
      entry.name.endsWith(".md") &&
      (entry.isFile() || entry.isSymbolicLink())
    ) {
      files.push(filePath);
    }
  }
  return files;
}

function loadAgentsFromDir(
  dir: string,
  source: AgentDefinition["source"],
): AgentDefinition[] {
  const agents: AgentDefinition[] = [];
  for (const filePath of agentFiles(dir)) {
    try {
      const { frontmatter } = parseFrontmatter<AgentFrontmatter>(
        readFileSync(filePath, "utf8"),
      );
      const name =
        typeof frontmatter.name === "string" ? frontmatter.name.trim() : "";
      if (!AGENT_NAME_RE.test(name)) continue;

      const description =
        typeof frontmatter.description === "string"
          ? frontmatter.description.trim()
          : "";
      agents.push({
        name,
        ...(description ? { description } : {}),
        source,
        filePath,
      });
    } catch {
      // One malformed definition must not hide the remaining agents.
    }
  }
  return agents;
}

function nearestProjectAgentsDir(cwd: string): string | undefined {
  let current = cwd;
  while (true) {
    const candidate = join(current, CONFIG_DIR_NAME, "agents");
    if (isDirectory(candidate)) return candidate;

    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export function discoverAgentDefinitions(
  cwd: string,
  includeProject: boolean,
): AgentDefinition[] {
  const agents = new Map<string, AgentDefinition>();
  for (const agent of loadAgentsFromDir(
    join(getAgentDir(), "agents"),
    "user",
  )) {
    agents.set(agent.name, agent);
  }

  if (includeProject) {
    const projectDir = nearestProjectAgentsDir(cwd);
    if (projectDir) {
      for (const agent of loadAgentsFromDir(projectDir, "project")) {
        agents.set(agent.name, agent);
      }
    }
  }

  return [...agents.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function identifierDefinitions(
  agents: AgentDefinition[],
): InlineIdentifierDefinition[] {
  return agents.map((agent) => ({
    kind: "agent",
    name: agent.name,
    token: `&${agent.name}`,
    ...(agent.description ? { description: agent.description } : {}),
    metadata: agent,
  }));
}

function agentAliasPattern(names: string[]): RegExp | undefined {
  if (names.length === 0) return undefined;
  const alternatives = [...names]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegex)
    .join("|");
  return new RegExp(
    `${AGENT_TOKEN_START}&(${alternatives})${AGENT_TOKEN_END}`,
    "gi",
  );
}

export function referencedAgents(
  text: string,
  definitions: InlineIdentifierDefinition[],
): InlineIdentifierDefinition[] {
  const byName = new Map(
    definitions.map((definition) => [
      definition.name.toLowerCase(),
      definition,
    ]),
  );
  const pattern = agentAliasPattern(
    definitions.map((definition) => definition.name),
  );
  if (!pattern) return [];

  const referenced = new Map<string, InlineIdentifierDefinition>();
  for (const match of text.matchAll(pattern)) {
    const definition = match[1]
      ? byName.get(match[1].toLowerCase())
      : undefined;
    if (definition) referenced.set(definition.name, definition);
  }
  return [...referenced.values()];
}

export function colorizeAgentAliases(
  line: string,
  definitions: InlineIdentifierDefinition[],
): string {
  if (definitions.length === 0 || !line.includes("&")) return line;
  const pattern = agentAliasPattern(
    definitions.map((definition) => definition.name),
  );
  if (!pattern) return line;
  return line.replace(pattern, (match) => {
    const color = identifierColor("agent");
    return color ? `${color}${match}${FG_RESET}` : match;
  });
}

export default function inlineAgentIdentifier(pi: ExtensionAPI): void {
  let cachedKey: string | undefined;
  let cachedDefinitions: InlineIdentifierDefinition[] = [];

  const listDefinitions = (
    ctx: ExtensionContext,
  ): InlineIdentifierDefinition[] => {
    const support = getNamedSubagentSupport(pi);
    if (!support.available) return [];

    const includeProject =
      support.supportsProjectScope && ctx.isProjectTrusted();
    const key = `${ctx.cwd}\0${includeProject}`;
    if (cachedKey !== key) {
      cachedKey = key;
      cachedDefinitions = identifierDefinitions(
        discoverAgentDefinitions(ctx.cwd, includeProject),
      );
    }
    return cachedDefinitions;
  };

  const feature: InlineIdentifierFeature = {
    kind: "agent",
    triggerCharacter: "&",
    listDefinitions,
    matchAutocomplete(beforeCursor) {
      if (AGENT_AUTOCOMPLETE_STOP_RE.test(beforeCursor)) return "stop";
      const prefix = beforeCursor.match(AGENT_AUTOCOMPLETE_RE)?.[1];
      return prefix ? { prefix, query: prefix.slice(1) } : undefined;
    },
    findReferences: referencedAgents,
    colorizeLine: colorizeAgentAliases,
    transform(text, definition) {
      const agent = definition.metadata as AgentDefinition;
      const projectScope =
        agent.source === "project"
          ? ' Set agentScope to "both" so the project agent is available.'
          : "";
      return {
        action: "transform",
        text: `Delegate this request to the "${agent.name}" subagent by calling the subagent tool.${projectScope} Use the full original request below as its task.\n\n${text}`,
      };
    },
  };

  registerInlineIdentifierFeature(pi, feature);
}
