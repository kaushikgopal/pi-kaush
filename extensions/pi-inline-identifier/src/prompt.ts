import { readFileSync } from "node:fs";
import {
  parseFrontmatter,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
  escapeRegex,
  type InlineIdentifierDefinition,
  type InlineIdentifierFeature,
  registerInlineIdentifierFeature,
} from "./core.ts";

const PROMPT_NAME_PREFIX = "pi-prompt-";
const PROMPT_TOKEN_START = "(?<![a-z0-9._%+/-])";
const PROMPT_TOKEN_END = "(?![a-z0-9_/-]|\\.[a-z0-9])";
const PROMPT_AUTOCOMPLETE_RE = /(?:^|[ \t])(\/[a-z0-9-]*)$/i;
const PROMPT_AUTOCOMPLETE_STOP_RE = /(?:^|[ \t])\/pi-prompt-[a-z0-9-]*[ \t]$/i;
const GREEN = "\x1b[38;2;166;227;161m";
const FG_RESET = "\x1b[39m";
const ARGUMENT_PATTERN =
  /\$\{(\d+|ARGUMENTS|@):-([^}]*)\}|\$\{@:(\d+)(?::(\d+))?\}|\$(ARGUMENTS|@|\d+)/g;

type PromptMetadata = {
  filePath: string;
};

export type InlineTemplateExpansion = {
  text: string;
  insertedRequest: boolean;
};

export function getPromptDefinitions(
  pi: Pick<ExtensionAPI, "getCommands">,
): InlineIdentifierDefinition[] {
  const definitions = new Map<string, InlineIdentifierDefinition>();
  for (const command of pi.getCommands()) {
    if (
      command.source !== "prompt" ||
      !command.name.startsWith(PROMPT_NAME_PREFIX) ||
      definitions.has(command.name)
    ) {
      continue;
    }

    definitions.set(command.name, {
      kind: "prompt",
      name: command.name,
      token: `/${command.name}`,
      ...(command.description ? { description: command.description } : {}),
      metadata: { filePath: command.sourceInfo.path } satisfies PromptMetadata,
    });
  }
  return [...definitions.values()];
}

function promptAliasPattern(names: string[]): RegExp | undefined {
  if (names.length === 0) return undefined;
  const alternatives = [...names]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegex)
    .join("|");
  return new RegExp(
    `${PROMPT_TOKEN_START}\/(${alternatives})${PROMPT_TOKEN_END}`,
    "g",
  );
}

export function referencedPrompts(
  text: string,
  definitions: InlineIdentifierDefinition[],
): InlineIdentifierDefinition[] {
  const byName = new Map(
    definitions.map((definition) => [definition.name, definition]),
  );
  const pattern = promptAliasPattern(
    definitions.map((definition) => definition.name),
  );
  if (!pattern) return [];

  const referenced = new Map<string, InlineIdentifierDefinition>();
  for (const match of text.matchAll(pattern)) {
    const definition = match[1] ? byName.get(match[1]) : undefined;
    if (definition) referenced.set(definition.name, definition);
  }
  return [...referenced.values()];
}

export function colorizePromptAliases(
  line: string,
  definitions: InlineIdentifierDefinition[],
): string {
  if (definitions.length === 0 || !line.includes("/")) return line;
  const pattern = promptAliasPattern(
    definitions.map((definition) => definition.name),
  );
  if (!pattern) return line;
  return line.replace(pattern, (match) => `${GREEN}${match}${FG_RESET}`);
}

/**
 * Inline references treat the surrounding request as one argument. This keeps
 * it intact for $1 and $@ instead of splitting ordinary prose into positions.
 */
export function expandInlineTemplate(
  content: string,
  request: string,
): InlineTemplateExpansion {
  let insertedRequest = false;
  const args = [request];
  const allArgs = request;

  const text = content.replace(
    ARGUMENT_PATTERN,
    (
      _match,
      defaultTarget: string | undefined,
      defaultValue: string | undefined,
      sliceStart: string | undefined,
      sliceLength: string | undefined,
      simple: string | undefined,
    ) => {
      if (defaultTarget) {
        const isAll = defaultTarget === "@" || defaultTarget === "ARGUMENTS";
        const index = isAll ? 0 : Number.parseInt(defaultTarget, 10) - 1;
        const value = isAll ? allArgs : args[index];
        if (value) {
          if (isAll || index === 0) insertedRequest = true;
          return value;
        }
        return defaultValue ?? "";
      }

      if (sliceStart) {
        const start = Math.max(0, Number.parseInt(sliceStart, 10) - 1);
        const length = sliceLength
          ? Number.parseInt(sliceLength, 10)
          : undefined;
        const selected =
          length === undefined
            ? args.slice(start)
            : args.slice(start, start + length);
        if (start === 0 && selected.length > 0) insertedRequest = true;
        return selected.join(" ");
      }

      if (simple === "ARGUMENTS" || simple === "@") {
        insertedRequest = true;
        return allArgs;
      }

      const index = Number.parseInt(simple ?? "0", 10) - 1;
      const value = args[index] ?? "";
      if (index === 0 && value) insertedRequest = true;
      return value;
    },
  );

  return { text, insertedRequest };
}

function loadPromptBody(
  definition: InlineIdentifierDefinition,
): string | undefined {
  const metadata = definition.metadata as PromptMetadata;
  try {
    const { body } = parseFrontmatter(readFileSync(metadata.filePath, "utf8"));
    const content = body.trim();
    return content || undefined;
  } catch {
    return undefined;
  }
}

export default function inlinePromptIdentifier(pi: ExtensionAPI): void {
  const feature: InlineIdentifierFeature = {
    kind: "prompt",
    triggerCharacter: "/",
    listDefinitions: () => getPromptDefinitions(pi),
    matchAutocomplete(beforeCursor) {
      if (PROMPT_AUTOCOMPLETE_STOP_RE.test(beforeCursor)) return "stop";
      const prefix = beforeCursor.match(PROMPT_AUTOCOMPLETE_RE)?.[1];
      return prefix ? { prefix, query: prefix.slice(1) } : undefined;
    },
    findReferences: referencedPrompts,
    colorizeLine: colorizePromptAliases,
    transform(text, definition) {
      const body = loadPromptBody(definition);
      if (!body) return { action: "continue" };

      const expanded = expandInlineTemplate(body, text);
      const templateSection = `Inline prompt template "/${definition.name}":\n\n${expanded.text}`;
      return {
        action: "transform",
        // The label keeps already-expanded content out of Pi's subsequent
        // leading-slash expansion pass.
        text: expanded.insertedRequest
          ? templateSection
          : `${templateSection}\n\n---\n\nOriginal request:\n${text}`,
      };
    },
  };

  registerInlineIdentifierFeature(pi, feature);
}
