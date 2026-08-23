import {
  BashExecutionComponent,
  type ExtensionAPI,
  ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import { chatContainerHooks } from "./container-hooks.ts";
import {
  infoVisibilityHidden,
  setInfoVisibilityHidden,
} from "./info-visibility-state.ts";
import { refreshThinkingVisibility } from "./thinking-block-merger.ts";

function isExecutionRow(child: unknown): boolean {
  return (
    child instanceof ToolExecutionComponent ||
    child instanceof BashExecutionComponent
  );
}

// Chat-container hook: while hidden, tool and user-bash rows are lifted out of
// the child list for the render pass and restored afterwards, so grouping and
// insets run on prose only. Nested invocations are naturally idempotent: a
// second pass finds nothing left to remove.
function infoFilterHook(
  _container: object,
  children: unknown[],
): (() => void) | undefined {
  if (!infoVisibilityHidden()) return undefined;
  const removed: Array<[number, unknown]> = [];
  for (let index = children.length - 1; index >= 0; index--) {
    if (isExecutionRow(children[index])) {
      removed.push([index, children[index]!]);
      children.splice(index, 1);
    }
  }
  if (removed.length === 0) return undefined;
  return () => {
    for (const [index, child] of removed.reverse()) {
      children.splice(index, 0, child);
    }
  };
}

export function installInfoVisibility(pi: ExtensionAPI): void {
  // The hook registry is process-global; dedupe by name so hot reloads swap
  // rather than stack.
  const hooks = chatContainerHooks();
  for (const hook of [...hooks]) {
    if (hook.name === infoFilterHook.name) hooks.delete(hook);
  }
  hooks.add(infoFilterHook);

  pi.registerCommand("toggle-info", {
    description: "Hide tool calls and thinking, or restore them collapsed",
    handler: async (_args, ctx) => {
      const hidden = !infoVisibilityHidden();
      setInfoVisibilityHidden(hidden);
      // Thinking labels/blocks only rebuild on content updates, so replay the
      // last update per assistant row to apply the new state immediately.
      refreshThinkingVisibility();
      ctx.ui.notify(
        hidden
          ? "Tool calls and thinking hidden — /toggle-info restores them"
          : "Tool calls and thinking visible",
        "info",
      );
    },
  });

  // Every session starts in the default collapsed-but-visible state. No
  // shutdown reset: extra shutdown handlers would sit between this package's
  // owner-counted patch releases.
  pi.on("session_start", () => setInfoVisibilityHidden(false));
}
