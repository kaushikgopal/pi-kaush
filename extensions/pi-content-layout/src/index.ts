import {
  AssistantMessageComponent,
  CustomEditor,
  type ExtensionAPI,
  type KeybindingsManager,
  type Theme,
  UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import {
  type EditorComponent,
  type EditorTheme,
  Loader,
  type TUI,
  visibleWidth,
} from "@earendil-works/pi-tui";
import {
  chatContainerHooks,
  runChatContainerHooks,
} from "./container-hooks.ts";
import {
  contentInset,
  insetLines,
  renderActiveEditor,
  renderSubmittedUserLines,
} from "./render.ts";

const ASSISTANT_RENDER_PATCH = Symbol.for(
  "kg.pi.contentLayout.assistantRender.v1",
);
const USER_RENDER_PATCH = Symbol.for("kg.pi.contentLayout.userRender.v1");
const SYSTEM_CONTAINER_RENDER_PATCH = Symbol.for(
  "kg.pi.contentLayout.systemContainerRender.v1",
);
const STATUS_LOADER_RENDER_PATCH = Symbol.for(
  "kg.pi.contentLayout.statusLoaderRender.v1",
);

type EditorFactory = (
  tui: TUI,
  theme: EditorTheme,
  keybindings: KeybindingsManager,
) => EditorComponent;

type ThemeGetter = () => Theme | undefined;

type RenderRow = {
  render(width: number): string[];
};

type ContainerRow = RenderRow & {
  children?: unknown[];
};

type NativeTextRow = RenderRow & {
  text?: string;
  paddingX?: number;
  paddingY?: number;
  customBgFn?: unknown;
};

type LoaderRow = RenderRow & {
  kind?: unknown;
  paddingX?: unknown;
};

type RenderPatchState = {
  originalRender: (this: RenderRow, width: number) => string[];
  patchedRender: (this: RenderRow, width: number) => string[];
  owners: Map<object, ThemeGetter>;
  cache: WeakMap<object, RenderCacheEntry>;
};

type RenderCacheEntry = {
  width: number;
  src: string[];
  lines: string[];
};

// ==================================================================
// Render memoization — PLEASE DO NOT REMOVE OR "SIMPLIFY" THIS CACHE.
// ==================================================================
//
// Pi's TUI re-renders the ENTIRE transcript on every keystroke (the frame
// walk is O(session) in pi-tui 0.84.x; upstream viewport-windowing work is
// not merged yet). Components normally stay fast because leaf components
// reuse cached line strings until their content changes. This package,
// however, decorates message lines AFTER rendering — building brand-new
// strings (insets, rails, backgrounds) for every line of every message on
// every frame. Measured on a ~1,000-message session that cost ~90 ms per
// keystroke and made the input box visibly lag as sessions grew.
//
// The cache below makes decoration cost O(changed messages) instead of
// O(all messages): decorators compare the freshly rendered source lines
// against the lines they decorated last frame BY IDENTITY (=== per element)
// and reuse the decorated output when nothing changed. Identity comparison
// is what makes the cache self-invalidating across every change path —
// streaming chunks, content edits, theme switches — because all of those
// regenerate the source strings upstream of us. This is why there is no
// explicit invalidate wiring here: partial invalidation would be worse than
// none, and identity checks can never miss a real change.
//
// If typing ever gets slow again in long sessions, suspect this cache first.
// ==================================================================
type RenderMemo = {
  /** Decorated lines from the last frame, when `src` is unchanged. */
  hit(src: string[]): string[] | undefined;
  /** Record decorated output keyed by the source lines that produced it. */
  store(src: string[], out: string[]): void;
};

type RenderDecorator = (
  original: RenderPatchState["originalRender"],
  row: RenderRow,
  width: number,
  theme: Theme,
  memo: RenderMemo,
) => string[];

type PatchableRenderPrototype = RenderRow &
  Record<symbol, RenderPatchState | undefined>;

function currentTheme(state: RenderPatchState): Theme | undefined {
  return [...state.owners.values()].at(-1)?.();
}

function installRenderPatch(
  prototype: PatchableRenderPrototype,
  key: symbol,
  owner: object,
  getTheme: ThemeGetter,
  decorate: RenderDecorator,
): RenderPatchState | undefined {
  try {
    const existing = prototype[key];
    if (existing) {
      existing.owners.set(owner, getTheme);
      return existing;
    }
    if (typeof prototype.render !== "function") return undefined;

    const state = {} as RenderPatchState;
    state.originalRender = prototype.render;
    state.owners = new Map([[owner, getTheme]]);
    state.cache = new WeakMap();
    state.patchedRender = function renderWithContentLayout(
      this: RenderRow,
      width: number,
    ): string[] {
      const theme = currentTheme(state);
      if (!theme) return state.originalRender.call(this, width);
      // See the memoization block above RenderMemo: decorators get a memo
      // bound to this row + width so unchanged rows skip string building.
      const entry = state.cache.get(this);
      const memo: RenderMemo = {
        hit: (src: string[]): string[] | undefined => {
          if (!entry || entry.width !== width) return undefined;
          const prev = entry.src;
          if (prev.length !== src.length) return undefined;
          for (let i = 0; i < src.length; i++) {
            if (prev[i] !== src[i]) return undefined;
          }
          return entry.lines;
        },
        store: (src: string[], out: string[]): void => {
          state.cache.set(this, { width, src, lines: out });
        },
      };
      try {
        return decorate(state.originalRender, this, width, theme, memo);
      } catch {
        return state.originalRender.call(this, width);
      }
    };

    prototype.render = state.patchedRender;
    Object.defineProperty(prototype, key, {
      configurable: true,
      value: state,
    });
    return state;
  } catch {
    return undefined;
  }
}

function uninstallRenderPatch(
  prototype: PatchableRenderPrototype,
  key: symbol,
  owner: object,
  state: RenderPatchState | undefined,
): void {
  if (!state || prototype[key] !== state) return;
  state.owners.delete(owner);
  if (state.owners.size > 0) return;

  if (prototype.render === state.patchedRender) {
    prototype.render = state.originalRender;
  }
  delete prototype[key];
}

function assistantDecorator(
  original: RenderPatchState["originalRender"],
  row: RenderRow,
  width: number,
  _theme: Theme,
  memo: RenderMemo,
): string[] {
  const nativeInset = Math.max(
    0,
    Number((row as RenderRow & { outputPad?: number }).outputPad) || 0,
  );
  const inset = Math.max(0, contentInset(width) - nativeInset);
  if (inset === 0) return original.call(row, width);
  const lines = original.call(row, Math.max(1, width - inset * 2));
  const cached = memo.hit(lines);
  if (cached) return cached;
  const decorated = insetLines(lines, width, inset);
  memo.store(lines, decorated);
  return decorated;
}

function isChatMessageChild(child: unknown): boolean {
  return (
    child instanceof AssistantMessageComponent ||
    child instanceof UserMessageComponent
  );
}

function isSystemTextChild(child: unknown): child is NativeTextRow {
  if (!child || typeof (child as NativeTextRow).render !== "function")
    return false;
  const text = child as NativeTextRow & { constructor?: { name?: string } };
  return (
    text.constructor?.name === "Text" &&
    typeof text.text === "string" &&
    text.paddingX === 1 &&
    text.paddingY === 0 &&
    text.customBgFn === undefined
  );
}

const knownChatContainers = new WeakSet<object>();

let systemTextHookActive = 0;

// The system-text inset decorates matching Text instances in place instead of
// intercepting the container's child list. Other whole-container wrappers
// (pi-tool-call-markers' grouping) run the shared hooks without delegating to
// this package's wrapper, and instance-level decoration is the only shape
// that composes in both load orders.
function systemTextHook(
  container: object,
  children: unknown[],
  width: number,
): (() => void) | undefined {
  if (systemTextHookActive > 0) {
    // A nested wrapper invoked the hooks for the same render pass; the
    // outermost call already decorated these children.
    systemTextHookActive += 1;
    return () => {
      systemTextHookActive -= 1;
    };
  }
  if (children.some(isChatMessageChild)) knownChatContainers.add(container);
  if (!knownChatContainers.has(container)) return undefined;

  const targetInset = contentInset(width);
  const restores: Array<() => void> = [];
  for (const child of children) {
    if (!isSystemTextChild(child)) continue;
    const extraInset = Math.max(0, targetInset - (child.paddingX ?? 0));
    if (extraInset === 0) continue;
    const originalRender = child.render;
    child.render = (childWidth: number): string[] =>
      insetLines(
        originalRender.call(child, Math.max(1, childWidth - extraInset * 2)),
        childWidth,
        extraInset,
      );
    restores.push(() => {
      delete (child as Partial<NativeTextRow>).render;
    });
  }
  if (restores.length === 0) return undefined;
  systemTextHookActive = 1;
  return () => {
    systemTextHookActive = 0;
    for (const restore of restores.reverse()) restore();
  };
}

// Status indicators (Working/Retry/Compaction/BranchSummary) sit in a
// sibling container that the chat-child hooks never see, so they need their
// own inset to line up with the chat content. StatusIndicator marks Loader
// subclasses with a `kind`; bare Loaders inside tool boxes keep native
// layout.
function statusLoaderDecorator(
  original: RenderPatchState["originalRender"],
  row: RenderRow,
  width: number,
): string[] {
  if (typeof (row as LoaderRow).kind !== "string")
    return original.call(row, width);
  const nativeInset = Math.max(0, Number((row as LoaderRow).paddingX) || 0);
  const inset = Math.max(0, contentInset(width) - nativeInset);
  if (inset === 0) return original.call(row, width);
  const lines = original.call(row, Math.max(1, width - inset * 2));
  return insetLines(lines, width, inset);
}

function systemContainerDecorator(
  original: RenderPatchState["originalRender"],
  row: RenderRow,
  width: number,
  _theme: Theme,
  memo: RenderMemo,
): string[] {
  const restore = runChatContainerHooks(
    row,
    (row as ContainerRow).children,
    width,
  );
  try {
    const lines = original.call(row, width);
    // Decoration happens inside the children during the original call, so
    // the decorated output IS the source output; cache it the same way so
    // downstream containers reuse the array instead of re-concatenating.
    const cached = memo.hit(lines);
    if (cached) return cached;
    memo.store(lines, lines);
    return lines;
  } finally {
    restore();
  }
}

function userDecorator(
  original: RenderPatchState["originalRender"],
  row: RenderRow,
  width: number,
  theme: Theme,
  memo: RenderMemo,
): string[] {
  const inset = contentInset(width);
  const bodyWidth = width - inset * 2 - 1;
  if (inset === 0 || bodyWidth < 1) return original.call(row, width);
  const lines = original.call(row, bodyWidth);
  const cached = memo.hit(lines);
  if (cached) return cached;
  const decorated = renderSubmittedUserLines(lines, width, theme, inset);
  memo.store(lines, decorated);
  return decorated;
}

function decorateEditor(
  editor: EditorComponent,
  getTheme: ThemeGetter,
): EditorComponent {
  const target = editor as EditorComponent & {
    borderColor?: (text: string) => string;
  };

  return new Proxy(target, {
    get(component, property) {
      if (property === "render") {
        return (width: number) => {
          const theme = getTheme();
          return theme
            ? renderActiveEditor(component, width, theme)
            : component.render(width);
        };
      }
      const value = Reflect.get(component, property, component) as unknown;
      return typeof value === "function" ? value.bind(component) : value;
    },
    set(component, property, value) {
      return Reflect.set(component, property, value, component);
    },
  });
}

export default function contentLayout(pi: ExtensionAPI): void {
  const owner = {};
  let activeTheme: Theme | undefined;
  let assistantPatch: RenderPatchState | undefined;
  let userPatch: RenderPatchState | undefined;
  let systemContainerPatch: RenderPatchState | undefined;
  let statusLoaderPatch: RenderPatchState | undefined;
  let editorRegistration:
    | {
        factory: EditorFactory;
        previous: EditorFactory | undefined;
      }
    | undefined;

  const getTheme = () => activeTheme;

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    activeTheme = ctx.ui.theme;

    const assistantPrototype =
      AssistantMessageComponent.prototype as unknown as PatchableRenderPrototype;
    const userPrototype =
      UserMessageComponent.prototype as unknown as PatchableRenderPrototype;
    assistantPatch = installRenderPatch(
      assistantPrototype,
      ASSISTANT_RENDER_PATCH,
      owner,
      getTheme,
      assistantDecorator,
    );
    userPatch = installRenderPatch(
      userPrototype,
      USER_RENDER_PATCH,
      owner,
      getTheme,
      userDecorator,
    );
    const hostContainerPrototype = Object.getPrototypeOf(
      AssistantMessageComponent.prototype,
    ) as PatchableRenderPrototype;
    chatContainerHooks().add(systemTextHook);
    systemContainerPatch = installRenderPatch(
      hostContainerPrototype,
      SYSTEM_CONTAINER_RENDER_PATCH,
      owner,
      getTheme,
      systemContainerDecorator,
    );
    statusLoaderPatch = installRenderPatch(
      Loader.prototype as unknown as PatchableRenderPrototype,
      STATUS_LOADER_RENDER_PATCH,
      owner,
      getTheme,
      statusLoaderDecorator,
    );

    const previous = ctx.ui.getEditorComponent() as EditorFactory | undefined;
    const factory: EditorFactory = (tui, editorTheme, keybindings) => {
      const editor = previous
        ? previous(tui, editorTheme, keybindings)
        : new CustomEditor(tui, editorTheme, keybindings);
      return decorateEditor(editor, getTheme);
    };
    editorRegistration = { factory, previous };
    ctx.ui.setEditorComponent(factory);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    chatContainerHooks().delete(systemTextHook);
    if (
      editorRegistration &&
      ctx.ui.getEditorComponent() === editorRegistration.factory
    ) {
      ctx.ui.setEditorComponent(editorRegistration.previous);
    }
    editorRegistration = undefined;

    uninstallRenderPatch(
      AssistantMessageComponent.prototype as unknown as PatchableRenderPrototype,
      ASSISTANT_RENDER_PATCH,
      owner,
      assistantPatch,
    );
    uninstallRenderPatch(
      UserMessageComponent.prototype as unknown as PatchableRenderPrototype,
      USER_RENDER_PATCH,
      owner,
      userPatch,
    );
    uninstallRenderPatch(
      Object.getPrototypeOf(
        AssistantMessageComponent.prototype,
      ) as PatchableRenderPrototype,
      SYSTEM_CONTAINER_RENDER_PATCH,
      owner,
      systemContainerPatch,
    );
    uninstallRenderPatch(
      Loader.prototype as unknown as PatchableRenderPrototype,
      STATUS_LOADER_RENDER_PATCH,
      owner,
      statusLoaderPatch,
    );
    assistantPatch = undefined;
    userPatch = undefined;
    systemContainerPatch = undefined;
    statusLoaderPatch = undefined;
    activeTheme = undefined;
  });
}
