// Shared toggle state for /toggle-info. Pi loads extension entrypoints through
// jiti with moduleCache disabled, so each entrypoint's relative-import chain
// gets its OWN module instances — a plain module-level boolean here would be
// duplicated between the main entrypoint (the /toggle-info command) and the
// thinking-block-merger entrypoint (the strip). globalThis keeps it singular.

type InfoVisibilityState = { hidden: boolean; owners: number };

const STATE_KEY = Symbol.for("kg.pi.toolCallMarkers.infoVisibility.v1");

function infoVisibilityState(): InfoVisibilityState {
  const root = globalThis as Record<symbol, InfoVisibilityState | undefined>;
  return (root[STATE_KEY] ??= { hidden: false, owners: 0 });
}

export function infoVisibilityHidden(): boolean {
  return infoVisibilityState().hidden;
}

export function setInfoVisibilityHidden(hidden: boolean): void {
  infoVisibilityState().hidden = hidden;
}

// The filter hook lives in a process-global registry, so it is owned like the
// prototype patches: it outlives every install that loaded this module and
// disappears with the last one.
export function retainInfoVisibilityOwner(): void {
  infoVisibilityState().owners += 1;
}

// Returns the owners left after this release.
export function releaseInfoVisibilityOwner(): number {
  const state = infoVisibilityState();
  state.owners = Math.max(0, state.owners - 1);
  return state.owners;
}
