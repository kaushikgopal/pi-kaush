import {
  CustomEditor,
  type ExtensionAPI,
  type ExtensionContext,
  type InputEventResult,
} from "@earendil-works/pi-coding-agent";
import {
  type AutocompleteItem,
  type AutocompleteProvider,
  Editor,
  visibleWidth,
} from "@earendil-works/pi-tui";

const MAX_AUTOCOMPLETE_ITEMS = 20;
const REGISTRATION_CHANNEL = "pi-inline-identifier:register:v1";
const DECORATION_STATE_KEY = Symbol.for(
  "kg.pi.inlineIdentifier.decorationState.v1",
);
const EDITOR_PATCH_VERSION = 1;

export type InlineIdentifierKind = "skill" | "agent" | "prompt";

export type InlineIdentifierDefinition = {
  kind: InlineIdentifierKind;
  name: string;
  token: string;
  description?: string;
  metadata?: unknown;
};

export type AutocompleteMatch =
  | { prefix: string; query: string }
  | "stop"
  | undefined;

export type InlineIdentifierFeature = {
  kind: InlineIdentifierKind;
  triggerCharacter: string;
  listDefinitions(ctx: ExtensionContext): InlineIdentifierDefinition[];
  matchAutocomplete(beforeCursor: string): AutocompleteMatch;
  findReferences(
    text: string,
    definitions: InlineIdentifierDefinition[],
  ): InlineIdentifierDefinition[];
  colorizeLine(line: string, definitions: InlineIdentifierDefinition[]): string;
  transform(
    text: string,
    definition: InlineIdentifierDefinition,
    ctx: ExtensionContext,
  ): InputEventResult | Promise<InputEventResult>;
};

type Coordinator = {
  features: Map<InlineIdentifierKind, InlineIdentifierFeature>;
  installed: boolean;
  decorationOwner: object;
};

type FeatureRegistration = {
  feature: InlineIdentifierFeature;
  accepted: boolean;
};

type DecorationState = {
  decorateLines?: (lines: string[]) => string[];
  owner?: object;
  patchedPrototypes?: WeakSet<object>;
  patchVersion?: number;
};

type EditorPrototype = {
  render(width: number): string[];
  setAutocompleteTriggerCharacters?: (characters: string[]) => void;
};

type EditorAutocompleteInternals = EditorPrototype & {
  autocompleteTriggerCharacters?: string[];
  autocompleteTriggerPattern?: RegExp;
  autocompleteDebouncePattern?: RegExp;
};

function firstLineStartsWithSlash(text: string): boolean {
  return (text.split("\n", 1)[0] ?? "").trimStart().startsWith("/");
}

export function isNativeSlashInput(text: string): boolean {
  return firstLineStartsWithSlash(text);
}

function decorationState(): DecorationState {
  const globals = globalThis as Record<symbol, unknown>;
  const existing = globals[DECORATION_STATE_KEY];
  if (existing) return existing as DecorationState;

  const state: DecorationState = {};
  globals[DECORATION_STATE_KEY] = state;
  return state;
}

function escapeCharacterClass(character: string): string {
  return character.replace(/[\\^$.*+?()[\]{}|-]/g, "\\$&");
}

function triggerPattern(characters: string[]): RegExp {
  const escaped = characters.map(escapeCharacterClass);
  return new RegExp(`(?:^|[\\s])[${escaped.join("")}][^\\s]*$`);
}

function debouncePattern(characters: string[]): RegExp {
  const escapedWithoutAt = characters
    .filter((character) => character !== "@")
    .map(escapeCharacterClass);
  return new RegExp(
    `(?:^|[ \\t])(?:@(?:"[^"]*|[^\\s]*)|[${escapedWithoutAt.join("")}][^\\s]*)$`,
  );
}

function patchEditorPrototype(
  prototype: EditorPrototype,
  state: DecorationState,
): void {
  const patched = state.patchedPrototypes ?? new WeakSet<object>();
  state.patchedPrototypes = patched;
  if (patched.has(prototype)) return;

  const originalRender = prototype.render;
  prototype.render = function renderWithInlineIdentifiers(
    width: number,
  ): string[] {
    const lines = originalRender.call(this, width);
    return decorationState().decorateLines?.(lines) ?? lines;
  };

  // Pi reserves `/` for command completion and normally drops it from custom
  // trigger characters. Allow it only when a provider explicitly requests it;
  // the provider still delegates first-line command mode back to Pi.
  const originalSetTriggers = prototype.setAutocompleteTriggerCharacters;
  if (originalSetTriggers) {
    prototype.setAutocompleteTriggerCharacters =
      function setTriggersWithInlineSlash(characters: string[]): void {
        originalSetTriggers.call(this, characters);
        if (!characters.includes("/")) return;

        const editor = this as EditorAutocompleteInternals;
        const active = editor.autocompleteTriggerCharacters;
        if (!active || active.includes("/")) return;
        active.push("/");
        editor.autocompleteTriggerPattern = triggerPattern(active);
        editor.autocompleteDebouncePattern = debouncePattern(active);
      };
  }

  patched.add(prototype);
}

function installEditorRenderPatch(): void {
  const state = decorationState();
  if (state.patchVersion !== EDITOR_PATCH_VERSION) {
    state.patchedPrototypes = new WeakSet();
    state.patchVersion = EDITOR_PATCH_VERSION;
  }

  const editorPrototype = Editor.prototype as unknown as EditorPrototype;
  patchEditorPrototype(editorPrototype, state);

  // CustomEditor can inherit from a host-owned pi-tui copy while extensions
  // resolve their peer pi-tui from a different path. Patch that distinct
  // prototype too; when both resolve to one class, the base patch is enough.
  const customPrototype = CustomEditor.prototype as unknown as EditorPrototype;
  if (!Editor.prototype.isPrototypeOf(CustomEditor.prototype)) {
    patchEditorPrototype(customPrototype, state);
  }
}

function definitionsFor(
  feature: InlineIdentifierFeature,
  ctx: ExtensionContext,
): InlineIdentifierDefinition[] {
  try {
    return feature.listDefinitions(ctx);
  } catch {
    return [];
  }
}

function createAutocompleteProvider(
  current: AutocompleteProvider,
  coordinator: Coordinator,
  ctx: ExtensionContext,
): AutocompleteProvider {
  return {
    triggerCharacters: [...coordinator.features.values()].map(
      (feature) => feature.triggerCharacter,
    ),

    async getSuggestions(lines, cursorLine, cursorCol, options) {
      if ((lines[0] ?? "").trimStart().startsWith("/")) {
        return current.getSuggestions(lines, cursorLine, cursorCol, options);
      }

      const beforeCursor = (lines[cursorLine] ?? "").slice(0, cursorCol);
      for (const feature of coordinator.features.values()) {
        const match = feature.matchAutocomplete(beforeCursor);
        if (match === "stop") {
          return options.force
            ? current.getSuggestions(lines, cursorLine, cursorCol, options)
            : null;
        }
        if (!match) continue;

        const items: AutocompleteItem[] = definitionsFor(feature, ctx)
          .filter((definition) =>
            definition.name.toLowerCase().startsWith(match.query.toLowerCase()),
          )
          .slice(0, MAX_AUTOCOMPLETE_ITEMS)
          .map((definition) => ({
            value: definition.token,
            label: definition.token,
            ...(definition.description
              ? { description: definition.description }
              : {}),
          }));
        if (items.length > 0) return { prefix: match.prefix, items };
        return current.getSuggestions(lines, cursorLine, cursorCol, options);
      }

      return current.getSuggestions(lines, cursorLine, cursorCol, options);
    },

    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      const promptFeature = coordinator.features.get("prompt");
      const isInlinePrompt =
        !(lines[0] ?? "").trimStart().startsWith("/") &&
        prefix.startsWith("/") &&
        promptFeature !== undefined &&
        definitionsFor(promptFeature, ctx).some(
          (definition) => definition.token === item.value,
        );
      if (isInlinePrompt) {
        const line = lines[cursorLine] ?? "";
        const before = line.slice(0, cursorCol - prefix.length);
        const next = [...lines];
        next[cursorLine] = before + item.value + line.slice(cursorCol);
        return {
          lines: next,
          cursorLine,
          cursorCol: before.length + item.value.length,
        };
      }

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

function referencedDefinitions(
  text: string,
  coordinator: Coordinator,
  ctx: ExtensionContext,
): Array<{
  feature: InlineIdentifierFeature;
  definition: InlineIdentifierDefinition;
}> {
  const referenced = new Map<
    string,
    {
      feature: InlineIdentifierFeature;
      definition: InlineIdentifierDefinition;
    }
  >();

  for (const feature of coordinator.features.values()) {
    if (!text.includes(feature.triggerCharacter)) continue;
    for (const definition of feature.findReferences(
      text,
      definitionsFor(feature, ctx),
    )) {
      const key = `${definition.kind}:${definition.name.toLowerCase()}`;
      referenced.set(key, { feature, definition });
    }
  }

  return [...referenced.values()];
}

function installCoordinator(pi: ExtensionAPI, coordinator: Coordinator): void {
  coordinator.installed = true;

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;

    const decoration = decorationState();
    decoration.owner = coordinator.decorationOwner;
    decoration.decorateLines = (lines) => {
      if (isNativeSlashInput(ctx.ui.getEditorText())) return lines;

      const activeFeatures = [...coordinator.features.values()]
        .filter((feature) =>
          lines.some((line) => line.includes(feature.triggerCharacter)),
        )
        .map((feature) => ({
          definitions: definitionsFor(feature, ctx),
          feature,
        }));

      return lines.map((line) => {
        let decorated = line;
        for (const { definitions, feature } of activeFeatures) {
          if (!decorated.includes(feature.triggerCharacter)) continue;
          decorated = feature.colorizeLine(decorated, definitions);
        }
        return visibleWidth(decorated) === visibleWidth(line)
          ? decorated
          : line;
      });
    };
    installEditorRenderPatch();

    ctx.ui.addAutocompleteProvider((current) =>
      createAutocompleteProvider(current, coordinator, ctx),
    );
  });

  pi.on("session_shutdown", () => {
    const decoration = decorationState();
    if (decoration.owner === coordinator.decorationOwner) {
      delete decoration.decorateLines;
      delete decoration.owner;
    }

    coordinator.features.clear();
  });

  pi.on("input", async (event, ctx) => {
    if (event.source === "extension" || isNativeSlashInput(event.text)) {
      return { action: "continue" };
    }

    const referenced = referencedDefinitions(event.text, coordinator, ctx);
    if (referenced.length !== 1) return { action: "continue" };

    const reference = referenced[0];
    if (!reference) return { action: "continue" };
    return reference.feature.transform(event.text, reference.definition, ctx);
  });
}

export function registerInlineIdentifierFeature(
  pi: ExtensionAPI,
  feature: InlineIdentifierFeature,
): void {
  // Each entrypoint receives a distinct ExtensionAPI facade, but all facades in
  // one runtime share pi.events. Probe the bus synchronously so the first
  // enabled entrypoint becomes the coordinator and later entries join it.
  const registration: FeatureRegistration = { feature, accepted: false };
  pi.events.emit(REGISTRATION_CHANNEL, registration);
  if (registration.accepted) return;

  const coordinator: Coordinator = {
    features: new Map([[feature.kind, feature]]),
    installed: false,
    decorationOwner: {},
  };
  pi.events.on(REGISTRATION_CHANNEL, (candidate: unknown) => {
    const next = candidate as FeatureRegistration;
    if (!next || next.accepted || !next.feature) return;
    coordinator.features.set(next.feature.kind, next.feature);
    next.accepted = true;
  });
  installCoordinator(pi, coordinator);
}

export function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
