// Inline aliases for Pi's named subagents.
//
// Minimal by design: no editor replacement, agent runner, or background work.
// This only:
// - discovers Pi agent definitions when a compatible named-agent subagent tool exists
// - completes known agent names after `&` using Pi's native autocomplete
// - colors known `&agent-name` tokens in the existing Pi editor render output
// - rewrites exactly one known reference into an explicit delegation request, while
//   leaving execution and policy decisions to the existing subagent tool.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import {
  CONFIG_DIR_NAME,
  getAgentDir,
  parseFrontmatter,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
  type AutocompleteItem,
  type AutocompleteProvider,
  Editor,
  visibleWidth,
} from "@earendil-works/pi-tui";

const AGENT_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const AGENT_TOKEN_START = "(?<![a-z0-9._%+&-])";
const AGENT_TOKEN_END = "(?![a-z0-9_-])";
const AGENT_AUTOCOMPLETE_RE = /(?:^|[ \t])(&[a-z0-9_-]*)$/i;
const AGENT_AUTOCOMPLETE_STOP_RE = /(?:^|[ \t])&[a-z0-9_-]*[ \t]$/i;
const MAX_AUTOCOMPLETE_ITEMS = 20;
const EDITOR_PATCH_VERSION = 2;
const EDITOR_PATCH_FLAG = Symbol.for(
  "kg.pi.inlineAgentIdentifiers.editorRenderPatch",
);
const DECORATION_STATE_KEY = Symbol.for(
  "kg.pi.inlineAgentIdentifiers.decorationState",
);
// Resolved from the session theme on session_start (borderAccent token).
let agentColor: string | undefined;
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

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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
      continue;
    }
    if (
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
      // A malformed or unreadable definition must not hide other agents.
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
    agents.set(agent.name.toLowerCase(), agent);
  }

  if (includeProject) {
    const projectDir = nearestProjectAgentsDir(cwd);
    if (projectDir) {
      for (const agent of loadAgentsFromDir(projectDir, "project")) {
        agents.set(agent.name.toLowerCase(), agent);
      }
    }
  }

  return [...agents.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function agentAutocompleteItems(
  agents: AgentDefinition[],
  query: string,
): AutocompleteItem[] {
  return agents
    .filter((agent) => agent.name.toLowerCase().startsWith(query.toLowerCase()))
    .slice(0, MAX_AUTOCOMPLETE_ITEMS)
    .map((agent) => ({
      value: `&${agent.name}`,
      label: `&${agent.name}`,
      ...(agent.description ? { description: agent.description } : {}),
    }));
}

export function createAgentAutocompleteProvider(
  current: AutocompleteProvider,
  getAgents: () => AgentDefinition[],
): AutocompleteProvider {
  return {
    triggerCharacters: ["&"],

    async getSuggestions(lines, cursorLine, cursorCol, options) {
      const beforeCursor = (lines[cursorLine] ?? "").slice(0, cursorCol);
      if ((lines[0] ?? "").trimStart().startsWith("/")) {
        return current.getSuggestions(lines, cursorLine, cursorCol, options);
      }

      if (!options.force && AGENT_AUTOCOMPLETE_STOP_RE.test(beforeCursor)) {
        return null;
      }

      const prefix = beforeCursor.match(AGENT_AUTOCOMPLETE_RE)?.[1];
      if (!prefix) {
        return current.getSuggestions(lines, cursorLine, cursorCol, options);
      }

      const items = agentAutocompleteItems(getAgents(), prefix.slice(1));
      if (items.length === 0) {
        return current.getSuggestions(lines, cursorLine, cursorCol, options);
      }

      return { prefix, items };
    },

    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      return current.applyCompletion(
        lines,
        cursorLine,
        cursorCol,
        item,
        prefix,
      );
    },

    shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
      return (
        current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ??
        true
      );
    },
  };
}

function agentAliasPattern(agentNames: string[]): RegExp | undefined {
  if (agentNames.length === 0) return undefined;
  const alternatives = [...agentNames]
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
  knownAgents: AgentDefinition[],
): AgentDefinition[] {
  const byName = new Map(
    knownAgents.map((agent) => [agent.name.toLowerCase(), agent]),
  );
  const pattern = agentAliasPattern(knownAgents.map((agent) => agent.name));
  if (!pattern) return [];

  const referenced: AgentDefinition[] = [];
  for (const match of text.matchAll(pattern)) {
    const agent = match[1] ? byName.get(match[1].toLowerCase()) : undefined;
    if (
      agent &&
      !referenced.some((candidate) => candidate.name === agent.name)
    ) {
      referenced.push(agent);
    }
  }
  return referenced;
}

export function colorizeAgentAliases(
  line: string,
  agentNames: string[],
  color = agentColor,
): string {
  if (agentNames.length === 0 || !line.includes("&")) return line;
  const pattern = agentAliasPattern(agentNames);
  if (!pattern) return line;

  const colored = line.replace(pattern, (match) =>
    color ? `${color}${match}${FG_RESET}` : match,
  );
  return visibleWidth(colored) === visibleWidth(line) ? colored : line;
}

type DecorationState = {
  colorizeLine?: (line: string, agentNames: string[]) => string;
  getAgentNames?: () => string[];
  owner?: object;
  patchedPrototype?: Editor;
  patchVersion?: number;
};

function decorationState(): DecorationState {
  const globals = globalThis as Record<symbol, unknown>;
  const existing = globals[DECORATION_STATE_KEY];
  if (existing) return existing as DecorationState;

  const state: DecorationState = {};
  globals[DECORATION_STATE_KEY] = state;
  return state;
}

function installEditorRenderPatch(): void {
  const state = decorationState();
  const prototype = Editor.prototype as Editor & Record<symbol, unknown>;
  if (
    state.patchedPrototype === prototype &&
    state.patchVersion === EDITOR_PATCH_VERSION
  ) {
    return;
  }

  const originalRender = prototype.render;
  prototype.render = function renderWithInlineAgentIdentifiers(
    width: number,
  ): string[] {
    const lines = originalRender.call(this, width);
    if (!lines.some((line) => line.includes("&"))) return lines;

    const current = decorationState();
    const agentNames = current.getAgentNames?.() ?? [];
    const colorizeLine = current.colorizeLine;
    return colorizeLine
      ? lines.map((line) => colorizeLine(line, agentNames))
      : lines;
  };

  state.patchedPrototype = prototype;
  state.patchVersion = EDITOR_PATCH_VERSION;
  if (!prototype[EDITOR_PATCH_FLAG]) {
    Object.defineProperty(prototype, EDITOR_PATCH_FLAG, { value: true });
  }
}

export default function inlineAgentIdentifier(pi: ExtensionAPI): void {
  const decorationOwner = {};

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;

    // Colors come from the session theme (borderAccent token); every pi
    // theme provides it. Uncolored without a TUI theme.
    try {
      agentColor = ctx.ui.theme.getFgAnsi("borderAccent");
    } catch {
      agentColor = undefined;
    }
    const support = getNamedSubagentSupport(pi);
    if (!support.available) return;

    const getAgents = () =>
      discoverAgentDefinitions(
        ctx.cwd,
        support.supportsProjectScope && ctx.isProjectTrusted(),
      );
    const state = decorationState();
    state.colorizeLine = colorizeAgentAliases;
    state.getAgentNames = () => getAgents().map((agent) => agent.name);
    state.owner = decorationOwner;
    installEditorRenderPatch();

    ctx.ui.addAutocompleteProvider((current) =>
      createAgentAutocompleteProvider(current, getAgents),
    );
  });

  pi.on("session_shutdown", () => {
    const state = decorationState();
    if (state.owner !== decorationOwner) return;
    agentColor = undefined;
    delete state.colorizeLine;
    delete state.getAgentNames;
    delete state.owner;
  });

  pi.on("input", (event, ctx) => {
    if (event.source === "extension") return { action: "continue" };
    if (!event.text.includes("&")) return { action: "continue" };
    if (event.text.trimStart().startsWith("/")) return { action: "continue" };

    const support = getNamedSubagentSupport(pi);
    if (!support.available) return { action: "continue" };

    const agents = discoverAgentDefinitions(
      ctx.cwd,
      support.supportsProjectScope && ctx.isProjectTrusted(),
    );
    const referenced = referencedAgents(event.text, agents);
    if (referenced.length !== 1) return { action: "continue" };

    const agent = referenced[0]!;
    const projectScope =
      agent.source === "project"
        ? ' Set agentScope to "both" so the project agent is available.'
        : "";
    return {
      action: "transform",
      text: `Delegate this request to the "${agent.name}" subagent by calling the subagent tool.${projectScope} Use the full original request below as its task.\n\n${event.text}`,
    };
  });
}
