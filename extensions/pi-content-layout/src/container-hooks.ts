// Shared chat-container composition contract. pi-content-layout and
// pi-tool-call-markers each replace Container.prototype.render for different
// concerns (system-text inset vs tool grouping), and a whole-container
// wrapper always shadows whatever wrapped the prototype before it. Both
// packages instead run every registered hook before rendering and restore
// after, so child-level decoration composes in either load order. The
// registry is a globalThis set keyed by a well-known symbol: no module
// coupling, and an empty registry is a no-op when the other package is
// absent. pi-tool-call-markers carries a deliberate copy of this file
// (decision: duplicate tiny contracts over runtime dependencies).

export type ChatContainerHook = (
  container: object,
  children: unknown[],
  width: number,
) => (() => void) | undefined;

export const CHAT_CONTAINER_HOOKS = Symbol.for("kg.pi.chatContainerHooks.v1");

type HookRegistry = Set<ChatContainerHook>;

export function chatContainerHooks(): HookRegistry {
  const root = globalThis as Record<symbol, HookRegistry | undefined>;
  const existing = root[CHAT_CONTAINER_HOOKS];
  if (existing) return existing;
  const created: HookRegistry = new Set();
  root[CHAT_CONTAINER_HOOKS] = created;
  return created;
}

export function runChatContainerHooks(
  container: object,
  children: unknown,
  width: number,
): () => void {
  const restores: Array<() => void> = [];
  if (Array.isArray(children)) {
    for (const hook of chatContainerHooks()) {
      try {
        const restore = hook(container, children, width);
        if (typeof restore === "function") restores.push(restore);
      } catch {
        // Hooks are cosmetic; one failing hook must not break rendering.
      }
    }
  }
  return () => {
    for (const restore of restores.reverse()) {
      try {
        restore();
      } catch {
        // Best-effort restore; rendering already completed.
      }
    }
  };
}
