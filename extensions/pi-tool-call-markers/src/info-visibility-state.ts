// Shared toggle state for /toggle-info. Pi loads extension entrypoints through
// jiti with moduleCache disabled, so each entrypoint's relative-import chain
// gets its OWN module instances — a plain module-level boolean here would be
// duplicated between the main entrypoint (the /toggle-info command) and the
// thinking-block-merger entrypoint (the strip). globalThis keeps it singular.

type InfoVisibilityState = { hidden: boolean };

const STATE_KEY = Symbol.for("kg.pi.toolCallMarkers.infoVisibility.v1");

function infoVisibilityState(): InfoVisibilityState {
  const root = globalThis as Record<symbol, InfoVisibilityState | undefined>;
  return (root[STATE_KEY] ??= { hidden: false });
}

export function infoVisibilityHidden(): boolean {
  return infoVisibilityState().hidden;
}

export function setInfoVisibilityHidden(hidden: boolean): void {
  infoVisibilityState().hidden = hidden;
}
