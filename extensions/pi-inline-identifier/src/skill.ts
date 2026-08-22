import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  escapeRegex,
  identifierColor,
  type InlineIdentifierDefinition,
  type InlineIdentifierFeature,
  registerInlineIdentifierFeature,
} from "./core.ts";

const SKILL_TOKEN_START = "(?<![a-z0-9._%+-])";
const SKILL_TOKEN_END = "(?![a-z0-9_-]|\\.[a-z0-9])";
const SKILL_ALIAS_RE = new RegExp(
  `${SKILL_TOKEN_START}\\$([a-z0-9][a-z0-9-]{0,63})${SKILL_TOKEN_END}`,
  "g",
);
const SKILL_AUTOCOMPLETE_RE = /(?:^|[ \t])(\$[a-z0-9-]*)$/;
const SKILL_AUTOCOMPLETE_STOP_RE = /(?:^|[ \t])\$[a-z0-9-]*[ \t]$/;
// Colors come from the session theme (mdLink token); see core.ts.
const FG_RESET = "\x1b[39m";

type PiCommand = ReturnType<ExtensionAPI["getCommands"]>[number];

function skillName(command: PiCommand): string | undefined {
  if (command.source !== "skill") return undefined;
  const name = command.name.startsWith("skill:")
    ? command.name.slice("skill:".length)
    : command.name;
  return name || undefined;
}

export function getSkillDefinitions(
  pi: Pick<ExtensionAPI, "getCommands">,
): InlineIdentifierDefinition[] {
  const definitions = new Map<string, InlineIdentifierDefinition>();
  for (const command of pi.getCommands()) {
    const name = skillName(command);
    if (!name || definitions.has(name)) continue;
    definitions.set(name, {
      kind: "skill",
      name,
      token: `$${name}`,
      ...(command.description ? { description: command.description } : {}),
    });
  }
  return [...definitions.values()];
}

export function referencedSkills(
  text: string,
  definitions: InlineIdentifierDefinition[],
): InlineIdentifierDefinition[] {
  const byName = new Map(
    definitions.map((definition) => [definition.name, definition]),
  );
  const referenced = new Map<string, InlineIdentifierDefinition>();
  for (const match of text.matchAll(SKILL_ALIAS_RE)) {
    const name = match[1];
    const definition = name ? byName.get(name) : undefined;
    if (definition) referenced.set(definition.name, definition);
  }
  return [...referenced.values()];
}

export function colorizeSkillAliases(
  line: string,
  definitions: InlineIdentifierDefinition[],
): string {
  if (definitions.length === 0 || !line.includes("$")) return line;
  const alternatives = [...definitions]
    .sort((a, b) => b.name.length - a.name.length)
    .map((definition) => escapeRegex(definition.name))
    .join("|");
  const pattern = new RegExp(
    `${SKILL_TOKEN_START}\\$(${alternatives})${SKILL_TOKEN_END}`,
    "g",
  );
  return line.replace(pattern, (match) => {
    const color = identifierColor("skill");
    return color ? `${color}${match}${FG_RESET}` : match;
  });
}

export default function inlineSkillIdentifier(pi: ExtensionAPI): void {
  const feature: InlineIdentifierFeature = {
    kind: "skill",
    triggerCharacter: "$",
    listDefinitions: () => getSkillDefinitions(pi),
    matchAutocomplete(beforeCursor) {
      if (SKILL_AUTOCOMPLETE_STOP_RE.test(beforeCursor)) return "stop";
      const prefix = beforeCursor.match(SKILL_AUTOCOMPLETE_RE)?.[1];
      return prefix ? { prefix, query: prefix.slice(1) } : undefined;
    },
    findReferences: referencedSkills,
    colorizeLine: colorizeSkillAliases,
    transform(text, definition) {
      return {
        action: "transform",
        text: `/skill:${definition.name} ${text}`,
      };
    },
  };

  registerInlineIdentifierFeature(pi, feature);
}
