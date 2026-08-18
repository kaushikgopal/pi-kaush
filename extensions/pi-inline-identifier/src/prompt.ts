import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  parseFrontmatter,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  escapeRegex,
  type InlineIdentifierDefinition,
  type InlineIdentifierFeature,
  registerInlineIdentifierFeature,
} from "./core.ts";

const PROMPT_TOKEN_START = "(?<![a-z0-9._%+/-])";
const PROMPT_TOKEN_END = "(?![a-z0-9_/-]|\\.[a-z0-9])";
const PROMPT_AUTOCOMPLETE_RE = /(?:^|[ \t])(\/[a-z0-9-]*)$/i;
const PROMPT_AUTOCOMPLETE_STOP_RE = /(?:^|[ \t])\/[a-z0-9-]+[ \t]$/i;
const GREEN = "\x1b[38;2;166;227;161m";
const FG_RESET = "\x1b[39m";
const ARGUMENT_PATTERN =
  /\$\{(\d+|ARGUMENTS|@):-([^}]*)\}|\$\{@:(\d+)(?::(\d+))?\}|\$(ARGUMENTS|@|\d+)/g;
const PROMPT_REVISION_LENGTH = 12;

type PromptMetadata = {
  filePath: string;
};

type LoadedPrompt = {
  body: string;
  revision: string;
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
    if (command.source !== "prompt" || definitions.has(command.name)) {
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

function promptRevision(content: string): string {
  return createHash("sha256")
    .update(content)
    .digest("hex")
    .slice(0, PROMPT_REVISION_LENGTH);
}

function promptHeader(name: string, revision: string): string {
  return `Inline prompt template "/${name}" (revision ${revision}):`;
}

function userMessageText(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  const candidate = message as {
    role?: string;
    content?: string | Array<{ type?: string; text?: string }>;
  };
  if (candidate.role !== "user") return undefined;
  if (typeof candidate.content === "string") return candidate.content;
  if (!Array.isArray(candidate.content)) return undefined;

  return candidate.content
    .filter(
      (item): item is { type: "text"; text: string } =>
        item?.type === "text" && typeof item.text === "string",
    )
    .map((item) => item.text)
    .join("\n");
}

function contextHasPromptMarker(
  ctx: ExtensionContext,
  marker: string,
): boolean {
  const entries = ctx.sessionManager.buildContextEntries();
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (
      entry?.type === "message" &&
      userMessageText(entry.message)?.startsWith(marker)
    ) {
      return true;
    }
  }
  return false;
}

function replaceUserMessageText(message: unknown, text: string): boolean {
  if (!message || typeof message !== "object") return false;
  const candidate = message as {
    role?: string;
    content?: string | Array<{ type?: string; text?: string }>;
  };
  if (candidate.role !== "user") return false;
  if (typeof candidate.content === "string") {
    candidate.content = text;
    return true;
  }
  if (!Array.isArray(candidate.content)) return false;

  const textBlock = candidate.content.find((item) => item?.type === "text");
  if (!textBlock) return false;
  textBlock.text = text;
  return true;
}

function loadPrompt(
  definition: InlineIdentifierDefinition,
  cache: Map<string, LoadedPrompt>,
): LoadedPrompt | undefined {
  const metadata = definition.metadata as PromptMetadata;
  const cached = cache.get(metadata.filePath);
  if (cached) return cached;

  try {
    const { body } = parseFrontmatter(readFileSync(metadata.filePath, "utf8"));
    const content = body.trim();
    if (!content) return undefined;
    const loaded = { body: content, revision: promptRevision(content) };
    cache.set(metadata.filePath, loaded);
    return loaded;
  } catch {
    return undefined;
  }
}

export default function inlinePromptIdentifier(pi: ExtensionAPI): void {
  // Pi caches prompt content internally, but getCommands() intentionally exposes
  // only metadata. Keep our duplicate read lazy and session-scoped instead.
  const prompts = new Map<string, LoadedPrompt>();
  const reuseFallbacks = new Map<
    string,
    { marker: string; fullExpansion: string }
  >();

  pi.on("context", (event) => {
    if (reuseFallbacks.size === 0) return undefined;

    let changed = false;
    for (const [reminder, fallback] of reuseFallbacks) {
      const hasFullExpansion = event.messages.some((message) =>
        userMessageText(message)?.startsWith(fallback.marker),
      );
      if (hasFullExpansion) continue;

      for (let index = event.messages.length - 1; index >= 0; index -= 1) {
        const message = event.messages[index];
        if (userMessageText(message) !== reminder) continue;
        changed =
          replaceUserMessageText(message, fallback.fullExpansion) || changed;
        break;
      }
    }

    return changed ? { messages: event.messages } : undefined;
  });

  pi.on("agent_settled", () => {
    reuseFallbacks.clear();
  });

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
    transform(text, definition, ctx) {
      const prompt = loadPrompt(definition, prompts);
      if (!prompt) return { action: "continue" };

      const header = promptHeader(definition.name, prompt.revision);
      const marker = `${header}\n\n`;
      const expanded = expandInlineTemplate(prompt.body, text);
      const templateSection = `${marker}${expanded.text}`;
      const fullExpansion = expanded.insertedRequest
        ? templateSection
        : `${templateSection}\n\n---\n\nOriginal request:\n${text}`;

      if (contextHasPromptMarker(ctx, marker)) {
        const reminder = `Reuse the inline prompt template "/${definition.name}" (revision ${prompt.revision}) already supplied earlier in this conversation. Apply it as a fresh invocation to this request, replacing any request-specific values from the earlier use:\n\n${text}`;
        reuseFallbacks.set(reminder, { marker, fullExpansion });
        return { action: "transform", text: reminder };
      }

      return {
        action: "transform",
        // The label keeps already-expanded content out of Pi's subsequent
        // leading-slash expansion pass.
        text: fullExpansion,
      };
    },
  };

  registerInlineIdentifierFeature(pi, feature);
}
