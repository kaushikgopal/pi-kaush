import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { createBrowserCli } from "./browser-cli.js";
import { createFirefoxBrowserInternal } from "./sessions.js";
import { createFirefoxStateStore, type StateJson } from "./state-store.js";
import { getLocalFirefoxEpoch } from "./browser-identity.js";
import {
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_SETTLE_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
  fail,
  safeUrl,
  validSession,
  validateEnsureInput,
  validateOptions,
  type BrowserConfig,
  type BrowserSession,
  type FirefoxBrowserFailure,
  type FirefoxBrowserOptions,
  type TabInfo,
} from "./browser-types.js";

type PersistentOptions = FirefoxBrowserOptions & {
  statePath: string;
  namespace: string;
  agentId: string;
  getEpoch?: () => Promise<string | null>;
};

type PersistedBinding = {
  version: 1;
  session: string;
  epoch: string;
  kind: "binding";
  tabId: number;
  windowId: number;
  cookieStoreId: string;
  expectedContainerId?: string;
  safeUrl: string;
  urlWasRedacted: boolean;
  closed: boolean;
  uncertain: boolean;
  lastUsedAtMs: number | null;
  documentEpoch: number;
  completedOperationId?: string;
};

type PersistedEmpty = {
  version: 1;
  session: string;
  epoch: string;
  kind: "empty";
  completedOperationId: string;
};

type PersistedOrphan = {
  version: 1;
  session: string;
  epoch: string;
  kind: "orphaned";
  closed: false;
  uncertain: true;
  lastUsedAtMs: number | null;
};

type PersistedSession = PersistedBinding | PersistedEmpty | PersistedOrphan;
type PersistedMarker = {
  version: 1;
  epoch: string;
  operationId: string;
};
type RecoveryResult =
  | FirefoxBrowserFailure
  | {
      ok: true;
      session: string;
      tab: { id: number; windowId: number; url: string };
      container: {
        cookieStoreId: string;
        name: string | null;
        evidence: "verified";
      };
      recovered: true;
    };
type AsyncIntent = {
  session?: string;
  mode: "ensure" | "normal";
  signal?: AbortSignal;
};

class PersistentStateCorrupt extends Error {
  readonly code = "malformed_state";
}

function corruptState(): PersistentStateCorrupt {
  return new PersistentStateCorrupt("Persistent state is invalid.");
}

function onlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

const MAX_EPOCH_LENGTH = 256;
const MAX_IDENTITY_LENGTH = 256;
const UNVERIFIED_SESSION: BrowserSession = {
  tabId: -1,
  windowId: -1,
  cookieStoreId: "",
  expectedUrl: "about:blank",
  closed: false,
  uncertain: true,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validIdentity(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_IDENTITY_LENGTH &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function validEpoch(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_EPOCH_LENGTH &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function isRedacted(fullUrl: string): boolean {
  const clean = safeUrl(fullUrl);
  if (clean !== fullUrl) return true;
  try {
    const url = new URL(fullUrl);
    return Boolean(url.search || url.hash || url.username || url.password);
  } catch {
    return false;
  }
}

function transientUrl(value: string): string {
  try {
    const url = new URL(value);
    if (
      (url.protocol === "http:" || url.protocol === "https:") &&
      !url.username &&
      !url.password
    )
      return value;
  } catch {
    if (value === "about:blank") return value;
  }
  return safeUrl(value);
}

function validOperationId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 80;
}

function parseStored(
  value: StateJson | undefined,
  expectedSession: string,
): PersistedSession | undefined {
  if (value === undefined) return undefined;
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    value.session !== expectedSession
  ) {
    throw corruptState();
  }
  if (
    value.kind === "empty" &&
    onlyKeys(value, [
      "version",
      "session",
      "epoch",
      "kind",
      "completedOperationId",
    ]) &&
    validEpoch(value.epoch) &&
    validOperationId(value.completedOperationId)
  ) {
    return value as PersistedEmpty;
  }
  if (
    value.kind === "orphaned" &&
    onlyKeys(value, [
      "version",
      "session",
      "epoch",
      "kind",
      "closed",
      "uncertain",
      "lastUsedAtMs",
    ]) &&
    value.closed === false &&
    value.uncertain === true &&
    validEpoch(value.epoch) &&
    (value.lastUsedAtMs === null ||
      (typeof value.lastUsedAtMs === "number" &&
        Number.isSafeInteger(value.lastUsedAtMs)))
  ) {
    return value as PersistedOrphan;
  }
  if (
    value.kind !== "binding" ||
    !onlyKeys(value, [
      "version",
      "session",
      "epoch",
      "kind",
      "tabId",
      "windowId",
      "cookieStoreId",
      "expectedContainerId",
      "safeUrl",
      "urlWasRedacted",
      "closed",
      "uncertain",
      "lastUsedAtMs",
      "documentEpoch",
      "completedOperationId",
    ]) ||
    !validEpoch(value.epoch) ||
    !Number.isSafeInteger(value.tabId) ||
    (value.tabId as number) < 0 ||
    !Number.isSafeInteger(value.windowId) ||
    (value.windowId as number) < 0 ||
    typeof value.cookieStoreId !== "string" ||
    value.cookieStoreId.length === 0 ||
    value.cookieStoreId.length > 200 ||
    (value.expectedContainerId !== undefined &&
      (typeof value.expectedContainerId !== "string" ||
        value.expectedContainerId.length === 0 ||
        value.expectedContainerId.length > 200)) ||
    typeof value.safeUrl !== "string" ||
    safeUrl(value.safeUrl) !== value.safeUrl ||
    typeof value.urlWasRedacted !== "boolean" ||
    typeof value.closed !== "boolean" ||
    typeof value.uncertain !== "boolean" ||
    (value.lastUsedAtMs !== null &&
      (typeof value.lastUsedAtMs !== "number" ||
        !Number.isSafeInteger(value.lastUsedAtMs))) ||
    !Number.isSafeInteger(value.documentEpoch) ||
    (value.documentEpoch as number) < 0 ||
    (value.completedOperationId !== undefined &&
      !validOperationId(value.completedOperationId))
  ) {
    throw corruptState();
  }
  return value as PersistedBinding;
}

function parseMarker(
  value: StateJson | undefined,
): PersistedMarker | undefined {
  if (value === undefined) return undefined;
  if (
    !isRecord(value) ||
    !onlyKeys(value, ["version", "epoch", "operationId"]) ||
    value.version !== 1 ||
    !validEpoch(value.epoch) ||
    typeof value.operationId !== "string" ||
    value.operationId.length < 1 ||
    value.operationId.length > 80
  ) {
    throw corruptState();
  }
  return value as PersistedMarker;
}

function toBinding(
  state: PersistedBinding,
  url = state.safeUrl,
): BrowserSession {
  return {
    tabId: state.tabId,
    windowId: state.windowId,
    cookieStoreId: state.cookieStoreId,
    ...(state.expectedContainerId
      ? { expectedContainerId: state.expectedContainerId }
      : {}),
    expectedUrl: url,
    closed: state.closed,
    uncertain: state.uncertain,
    ...(state.lastUsedAtMs !== null
      ? { lastUsedAtMs: state.lastUsedAtMs }
      : {}),
    documentEpoch: state.documentEpoch,
  };
}

function toOrphan(): BrowserSession {
  return { ...UNVERIFIED_SESSION };
}

function toPersisted(
  session: string,
  epoch: string,
  binding: BrowserSession | undefined,
  previous?: PersistedSession,
  observedUrl?: string,
): PersistedSession | undefined {
  if (!binding) return undefined;
  if (
    !Number.isSafeInteger(binding.tabId) ||
    binding.tabId < 0 ||
    !Number.isSafeInteger(binding.windowId) ||
    binding.windowId < 0 ||
    !binding.cookieStoreId
  ) {
    return {
      version: 1,
      session,
      epoch,
      kind: "orphaned",
      closed: false,
      uncertain: true,
      lastUsedAtMs: binding.lastUsedAtMs ?? null,
    };
  }
  const previousRedacted =
    previous?.kind === "binding" ? previous.urlWasRedacted : false;
  return {
    version: 1,
    session,
    epoch,
    kind: "binding",
    tabId: binding.tabId,
    windowId: binding.windowId,
    cookieStoreId: binding.cookieStoreId,
    ...(binding.expectedContainerId
      ? { expectedContainerId: binding.expectedContainerId }
      : {}),
    safeUrl: safeUrl(binding.expectedUrl),
    urlWasRedacted:
      previousRedacted ||
      isRedacted(binding.expectedUrl) ||
      (observedUrl !== undefined && isRedacted(observedUrl)),
    closed: binding.closed,
    uncertain: binding.uncertain,
    lastUsedAtMs: binding.lastUsedAtMs ?? null,
    documentEpoch: binding.documentEpoch ?? 0,
    ...(previous && "completedOperationId" in previous
      ? { completedOperationId: previous.completedOperationId }
      : {}),
  };
}

function matches(
  binding: BrowserSession | undefined,
  state: PersistedBinding,
): binding is BrowserSession {
  return Boolean(
    binding &&
      binding.tabId === state.tabId &&
      binding.windowId === state.windowId &&
      binding.cookieStoreId === state.cookieStoreId,
  );
}

function isFailure(value: unknown): value is FirefoxBrowserFailure {
  return (
    isRecord(value) &&
    value.ok === false &&
    typeof value.code === "string" &&
    typeof value.message === "string" &&
    (value.recovery === null || isRecord(value.recovery))
  );
}

function safeStateFailure(error: unknown): FirefoxBrowserFailure {
  const code =
    isRecord(error) && typeof error.code === "string" ? error.code : "";
  if (code === "aborted")
    return fail("aborted", "The persistent browser operation was cancelled.");
  if (code === "malformed_state" || code === "unsafe_path")
    return fail(
      "state_corrupt",
      "Persistent Firefox session state is unavailable.",
    );
  return fail(
    "state_error",
    "Persistent Firefox session state is unavailable.",
  );
}

function epochFailure(): FirefoxBrowserFailure {
  return fail(
    "browser_epoch_unknown",
    "Firefox instance identity is unavailable. Stored sessions cannot be used safely.",
  );
}

export function createPersistentFirefoxBrowser(options: PersistentOptions) {
  if (
    !validIdentity(options?.namespace) ||
    !validIdentity(options?.agentId) ||
    typeof options.statePath !== "string" ||
    options.statePath.length === 0 ||
    (options.getEpoch !== undefined && typeof options.getEpoch !== "function")
  ) {
    throw new Error("Persistent Firefox browser options are invalid.");
  }

  const state = createFirefoxStateStore({ path: options.statePath });
  const checkedOptions = validateOptions(options);
  const browserConfig: BrowserConfig = checkedOptions.ok
    ? checkedOptions.value
    : {
        binaryPath: "",
        timeoutMs: DEFAULT_TIMEOUT_MS,
        maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
        settleTimeoutMs: DEFAULT_SETTLE_TIMEOUT_MS,
        containerNames: {},
      };
  const browserCli = createBrowserCli(browserConfig);
  const scopeHash = createHash("sha256")
    .update(JSON.stringify([options.namespace, options.agentId]), "utf8")
    .digest("hex");
  const scopePrefix = `firefox-session:v1:${scopeHash}:`;
  const sessionKey = (session: string) =>
    scopePrefix + createHash("sha256").update(session, "utf8").digest("hex");
  const markerKey = (session: string) => sessionKey(session) + ":inflight";
  const sessionState = new Map<string, BrowserSession>();
  const activeSessions = new Map<string, number>();
  const hydratedEpoch = new Map<string, string>();
  const intents = new AsyncLocalStorage<AsyncIntent>();
  const getEpoch = options.getEpoch ?? getLocalFirefoxEpoch;

  function enterSession(session: string): void {
    activeSessions.set(session, (activeSessions.get(session) ?? 0) + 1);
  }

  function leaveSession(session: string): void {
    const count = activeSessions.get(session) ?? 0;
    if (count <= 1) activeSessions.delete(session);
    else activeSessions.set(session, count - 1);
  }

  async function trackSessionCall<T>(
    session: unknown,
    mode: AsyncIntent["mode"],
    signal: AbortSignal | undefined,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (!validSession(session)) return operation();
    enterSession(session);
    try {
      return await intents.run(
        { session, mode, ...(signal ? { signal } : {}) },
        operation,
      );
    } finally {
      leaveSession(session);
    }
  }

  const freshEpoch = async (): Promise<string | null> => {
    try {
      const epoch = await getEpoch();
      return validEpoch(epoch) ? epoch : null;
    } catch {
      return null;
    }
  };

  async function putMarker(
    session: string,
    epoch: string,
  ): Promise<{ marker: PersistedMarker; created: boolean }> {
    return state.withEntry<{ marker: PersistedMarker; created: boolean }>(
      markerKey(session),
      async (raw) => {
        let existing: PersistedMarker | undefined;
        try {
          existing = parseMarker(raw);
        } catch {
          throw corruptState();
        }
        if (existing)
          return { entry: raw, result: { marker: existing, created: false } };
        const marker = {
          version: 1 as const,
          epoch,
          operationId: randomUUID(),
        };
        return { entry: marker, result: { marker, created: true } };
      },
    );
  }

  async function clearMarkerIfMatches(
    session: string,
    operationId: string,
  ): Promise<boolean> {
    return state.withEntry(markerKey(session), async (raw) => {
      let marker: PersistedMarker | undefined;
      try {
        marker = parseMarker(raw);
      } catch {
        throw corruptState();
      }
      if (!marker || marker.operationId !== operationId)
        return { entry: raw, result: false };
      return { entry: undefined, result: true };
    });
  }

  async function verifyLive(
    stored: PersistedBinding,
    signal?: AbortSignal,
  ): Promise<
    { ok: true; tab: TabInfo } | { ok: false; error: FirefoxBrowserFailure }
  > {
    const windows = await browserCli.listWindows(signal);
    if (!windows.ok) return windows;
    const window = windows.value.find((item) => item.id === stored.windowId);
    if (!window || window.private)
      return {
        ok: false,
        error: fail(
          "window_verification_failed",
          "The persisted Firefox window is not available in this instance.",
        ),
      };
    const tabs = await browserCli.listTabs(stored.windowId, signal);
    if (!tabs.ok) return tabs;
    const tab = tabs.value.find((item) => item.id === stored.tabId);
    if (!tab)
      return {
        ok: false,
        error: fail(
          "owned_tab_missing",
          "The persisted Firefox tab is missing.",
        ),
      };
    if (
      tab.private ||
      tab.windowId !== stored.windowId ||
      tab.cookieStoreId !== stored.cookieStoreId ||
      (stored.expectedContainerId !== undefined &&
        tab.cookieStoreId !== stored.expectedContainerId)
    )
      return {
        ok: false,
        error: fail(
          "tab_verification_failed",
          "The persisted Firefox tab ownership metadata changed.",
        ),
      };
    return { ok: true, tab };
  }

  function failureValue<T>(failure: FirefoxBrowserFailure): T {
    return failure as T;
  }

  async function runSession<T>(
    session: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    enterSession(session);
    try {
      const epoch = await freshEpoch();
      if (!epoch) return failureValue(epochFailure());
      let keepMarker = false;
      let operationId: string | undefined;
      let hydratedAfterCommit = false;
      const outcome = await state.withEntry(
        sessionKey(session),
        async (raw) => {
          let stored: PersistedSession | undefined;
          try {
            stored = parseStored(raw, session);
          } catch {
            throw corruptState();
          }

          let markerState = await putMarker(session, epoch);
          if (
            !markerState.created &&
            stored &&
            "completedOperationId" in stored &&
            stored.completedOperationId === markerState.marker.operationId
          ) {
            await clearMarkerIfMatches(session, markerState.marker.operationId);
            markerState = await putMarker(session, epoch);
          }
          operationId = markerState.marker.operationId;

          if (!markerState.created) {
            keepMarker = true;
            const uncertain =
              stored?.kind === "binding"
                ? {
                    ...stored,
                    uncertain: true,
                    ...(stored.epoch !== epoch ? { closed: true } : {}),
                  }
                : undefined;
            const binding = uncertain ? toBinding(uncertain) : toOrphan();
            sessionState.set(session, binding);
            const entry = uncertain ?? {
              version: 1 as const,
              session,
              epoch,
              kind: "orphaned" as const,
              closed: false as const,
              uncertain: true as const,
              lastUsedAtMs: null,
            };
            return {
              entry,
              result: failureValue<T>(
                fail(
                  "mutation_uncertain",
                  "A prior browser operation did not complete. Recover the session before retrying.",
                ),
              ),
            };
          }

          let binding = sessionState.get(session);
          let observedUrl: string | undefined;
          if (stored?.kind === "orphaned") {
            keepMarker = true;
            sessionState.set(session, toOrphan());
            return {
              entry: stored,
              result: failureValue<T>(
                fail(
                  "mutation_uncertain",
                  "This session has no verified browser binding and cannot be replayed.",
                ),
              ),
            };
          }

          if (stored?.kind === "binding") {
            if (stored.epoch !== epoch) {
              binding = toBinding({ ...stored, closed: true });
              sessionState.set(session, binding);
              const intent = intents.getStore();
              if (intent?.session !== session || intent.mode !== "ensure") {
                const completed = {
                  ...stored,
                  closed: true,
                  completedOperationId: operationId!,
                };
                return {
                  entry: completed,
                  result: failureValue<T>(
                    fail(
                      "browser_epoch_changed",
                      "This session belongs to another Firefox instance. Call sessionEnsure explicitly before use.",
                    ),
                  ),
                };
              }
            } else if (stored.uncertain) {
              binding = toBinding(stored);
              sessionState.set(session, binding);
              keepMarker = true;
              return {
                entry: stored,
                result: failureValue<T>(
                  fail(
                    "mutation_uncertain",
                    "The previous browser operation has an uncertain outcome.",
                  ),
                ),
              };
            } else if (stored.closed) {
              binding = toBinding(stored);
              sessionState.set(session, binding);
            } else {
              const previous = sessionState.get(session);
              const locallyHydrated =
                hydratedEpoch.get(session) === epoch &&
                matches(previous, stored) &&
                previous.uncertain === stored.uncertain &&
                previous.closed === stored.closed &&
                (previous.documentEpoch ?? 0) === stored.documentEpoch &&
                safeUrl(previous.expectedUrl) === stored.safeUrl;
              if (locallyHydrated) {
                binding = previous;
              } else {
                const verified = await verifyLive(stored);
                if (!verified.ok) {
                  binding = toBinding({ ...stored, uncertain: true });
                  sessionState.set(session, binding);
                  const next = {
                    ...stored,
                    uncertain: true,
                    completedOperationId: operationId!,
                  };
                  return {
                    entry: next,
                    result: failureValue<T>(verified.error),
                  };
                }
                observedUrl = verified.tab.url;
                const refreshed = toBinding(
                  stored,
                  transientUrl(verified.tab.url),
                );
                if (
                  hydratedEpoch.get(session) === epoch &&
                  matches(previous, stored)
                ) {
                  if (previous.pending) refreshed.pending = previous.pending;
                  if (previous.lastUsedAtMs !== undefined)
                    refreshed.lastUsedAtMs = previous.lastUsedAtMs;
                }
                binding = refreshed;
                sessionState.set(session, binding);
              }
            }
          } else if (binding) {
            binding.uncertain = true;
            sessionState.set(session, binding);
            keepMarker = true;
            return {
              entry: toPersisted(session, epoch, binding) ?? {
                version: 1,
                session,
                epoch,
                kind: "orphaned",
                closed: false,
                uncertain: true,
                lastUsedAtMs: binding.lastUsedAtMs ?? null,
              },
              result: failureValue<T>(
                fail(
                  "mutation_uncertain",
                  "The persisted binding is missing. Verify the session before use.",
                ),
              ),
            };
          } else {
            sessionState.delete(session);
          }

          let result: T;
          let threw = false;
          try {
            result = await operation();
          } catch {
            threw = true;
            const current = sessionState.get(session);
            if (current) current.uncertain = true;
            result = failureValue<T>(
              fail(
                "mutation_uncertain",
                "The browser operation failed unexpectedly. Do not retry it automatically.",
              ),
            );
          }
          binding = sessionState.get(session);
          const contextSignal = intents.getStore()?.signal;
          const uncertain =
            threw ||
            contextSignal?.aborted === true ||
            binding?.uncertain === true ||
            (isFailure(result) &&
              (result.code === "mutation_uncertain" ||
                result.code === "aborted"));
          if (contextSignal?.aborted && !isFailure(result)) {
            result = failureValue<T>(
              fail(
                "mutation_uncertain",
                "The operation was cancelled after browser work began. Recover the session before retrying.",
              ),
            );
          }
          if (uncertain) {
            keepMarker = true;
            if (binding) binding.uncertain = true;
          }
          const staleUnchanged =
            stored?.kind === "binding" &&
            stored.epoch !== epoch &&
            matches(binding, stored) &&
            binding.closed;
          const persistedEpoch =
            staleUnchanged && stored?.kind === "binding" ? stored.epoch : epoch;
          let next = toPersisted(
            session,
            persistedEpoch,
            binding,
            stored,
            observedUrl,
          );
          if (uncertain) {
            next ??= {
              version: 1,
              session,
              epoch,
              kind: "orphaned",
              closed: false,
              uncertain: true,
              lastUsedAtMs: null,
            };
          } else if (next?.kind === "binding") {
            next.completedOperationId = operationId!;
          } else if (!next) {
            next = {
              version: 1,
              session,
              epoch,
              kind: "empty",
              completedOperationId: operationId!,
            };
          }
          hydratedAfterCommit =
            !uncertain && persistedEpoch === epoch && Boolean(binding);
          return { entry: next, result };
        },
      );

      if (hydratedAfterCommit) hydratedEpoch.set(session, epoch);
      else hydratedEpoch.delete(session);
      if (!keepMarker && operationId)
        await clearMarkerIfMatches(session, operationId);
      return outcome;
    } catch (error) {
      return failureValue<T>(safeStateFailure(error));
    } finally {
      leaveSession(session);
    }
  }

  const browser = createFirefoxBrowserInternal(options, {
    sessionState,
    runSession,
  });

  async function readState(
    session: string,
    signal?: AbortSignal,
  ): Promise<PersistedSession | undefined> {
    const all = await state.list(signal ? { signal } : {});
    try {
      return parseStored(all[sessionKey(session)], session);
    } catch {
      throw corruptState();
    }
  }

  async function preparedEnsureInput(
    input: {
      session: string;
      url?: string;
      containerId?: string;
      windowId?: number;
    },
    signal?: AbortSignal,
  ): Promise<
    | { ok: true; input: typeof input }
    | { ok: false; error: FirefoxBrowserFailure }
  > {
    const epoch = await freshEpoch();
    if (!epoch) return { ok: false, error: epochFailure() };
    let stored: PersistedSession | undefined;
    try {
      stored = await readState(input.session, signal);
    } catch (error) {
      return { ok: false, error: safeStateFailure(error) };
    }
    if (stored?.kind !== "binding") return { ok: true, input };
    const stale = stored.epoch !== epoch;
    if (!stale && !stored.closed) return { ok: true, input };
    if (stored.urlWasRedacted && input.url === undefined)
      return {
        ok: false,
        error: fail(
          "session_url_required",
          "The previous URL omitted a query or fragment. Supply the full URL to recreate this session.",
        ),
      };
    if (input.url !== undefined) return { ok: true, input };
    return { ok: true, input: { ...input, url: stored.safeUrl } };
  }

  async function hydrateScope(
    signal?: AbortSignal,
    onlySession?: string,
  ): Promise<FirefoxBrowserFailure | null> {
    if (!checkedOptions.ok) return checkedOptions.error;
    const epoch = await freshEpoch();
    if (!epoch) return epochFailure();
    let all: Record<string, StateJson>;
    try {
      all = await state.list(signal ? { signal } : {});
    } catch (error) {
      return safeStateFailure(error);
    }
    for (const key of Object.keys(all)) {
      if (!key.startsWith(scopePrefix) || key.endsWith(":inflight")) continue;
      let candidate: PersistedSession;
      try {
        const raw = all[key];
        if (typeof raw !== "object" || raw === null || Array.isArray(raw))
          throw corruptState();
        const session = (raw as Record<string, StateJson>).session;
        if (typeof session !== "string" || !validSession(session))
          throw corruptState();
        if (key !== sessionKey(session)) throw corruptState();
        if (onlySession && session !== onlySession) continue;
        candidate = parseStored(raw, session)!;
      } catch {
        return fail(
          "state_corrupt",
          "Persistent Firefox session state is invalid.",
        );
      }
      if (candidate.kind === "empty") {
        if (!activeSessions.has(candidate.session)) {
          sessionState.delete(candidate.session);
          hydratedEpoch.delete(candidate.session);
        }
        continue;
      }
      if (activeSessions.has(candidate.session)) continue;

      try {
        const learnedEpoch = await state.withEntry(
          key,
          async (currentRaw) => {
            let current: PersistedSession | undefined;
            try {
              current = parseStored(currentRaw, candidate.session);
            } catch {
              throw corruptState();
            }
            if (!current || activeSessions.has(candidate.session))
              return { entry: currentRaw, result: undefined };
            let marker = await state.withEntry(
              markerKey(candidate.session),
              async (markerRaw) => {
                let parsed: PersistedMarker | undefined;
                try {
                  parsed = parseMarker(markerRaw);
                } catch {
                  throw corruptState();
                }
                return { entry: markerRaw, result: parsed };
              },
            );
            if (current.kind === "orphaned") {
              if (!activeSessions.has(candidate.session)) {
                sessionState.set(candidate.session, toOrphan());
                hydratedEpoch.delete(candidate.session);
              }
              return { entry: current, result: undefined };
            }
            if (current.kind === "empty") {
              if (!activeSessions.has(candidate.session)) {
                sessionState.delete(candidate.session);
                hydratedEpoch.delete(candidate.session);
              }
              return { entry: current, result: undefined };
            }
            if (marker && current.completedOperationId === marker.operationId) {
              await clearMarkerIfMatches(candidate.session, marker.operationId);
              marker = undefined;
            }
            if (marker || current.uncertain) {
              const uncertain = {
                ...current,
                uncertain: true,
                ...(current.epoch !== epoch ? { closed: true } : {}),
              };
              if (!activeSessions.has(candidate.session)) {
                sessionState.set(candidate.session, toBinding(uncertain));
                hydratedEpoch.delete(candidate.session);
              }
              return { entry: uncertain, result: undefined };
            }
            if (current.epoch !== epoch) {
              const closed = { ...current, closed: true };
              if (!activeSessions.has(candidate.session)) {
                sessionState.set(candidate.session, toBinding(closed));
                hydratedEpoch.delete(candidate.session);
              }
              return { entry: closed, result: undefined };
            }
            if (current.closed) {
              if (!activeSessions.has(candidate.session)) {
                sessionState.set(candidate.session, toBinding(current));
                hydratedEpoch.delete(candidate.session);
              }
              return { entry: current, result: undefined };
            }
            const local = sessionState.get(candidate.session);
            if (
              hydratedEpoch.get(candidate.session) === epoch &&
              matches(local, current) &&
              local.closed === current.closed &&
              local.uncertain === current.uncertain &&
              (local.documentEpoch ?? 0) === current.documentEpoch &&
              safeUrl(local.expectedUrl) === current.safeUrl
            )
              return { entry: current, result: undefined };
            const verified = await verifyLive(current, signal);
            if (!verified.ok) {
              const uncertain = { ...current, uncertain: true };
              if (!activeSessions.has(candidate.session)) {
                sessionState.set(candidate.session, toBinding(uncertain));
                hydratedEpoch.delete(candidate.session);
              }
              return { entry: uncertain, result: undefined };
            }
            const binding = toBinding(current, transientUrl(verified.tab.url));
            const canCache = !activeSessions.has(candidate.session);
            if (canCache) sessionState.set(candidate.session, binding);
            const updated = toPersisted(
              candidate.session,
              epoch,
              binding,
              current,
              verified.tab.url,
            );
            return { entry: updated, result: canCache };
          },
          signal ? { signal } : {},
        );
        if (learnedEpoch) hydratedEpoch.set(candidate.session, epoch);
      } catch (error) {
        return safeStateFailure(error);
      }
    }
    return null;
  }

  async function sessionList(
    input: { session?: string } = {},
    callOptions: { signal?: AbortSignal } = {},
  ) {
    if (callOptions.signal?.aborted)
      return fail("aborted", "The browser operation was cancelled.");
    if (!input || (input.session !== undefined && !validSession(input.session)))
      return fail("invalid_input", "Session list options are invalid.");
    const error = await hydrateScope(callOptions.signal, input.session);
    if (error) return error;
    return browser.sessionList(input, callOptions);
  }

  async function sessionCleanup(
    input: Parameters<typeof browser.sessionCleanup>[0],
    callOptions: { signal?: AbortSignal } = {},
  ) {
    if (
      !input ||
      !Number.isSafeInteger(input.idleAfterMs) ||
      input.idleAfterMs < 1 ||
      input.idleAfterMs > 365 * 24 * 60 * 60 * 1_000 ||
      (input.dryRun !== undefined && typeof input.dryRun !== "boolean")
    )
      return fail("invalid_input", "Session cleanup options are invalid.");
    const error = await hydrateScope(callOptions.signal);
    if (error) return error;
    return intents.run(
      {
        mode: "normal",
        ...(callOptions.signal ? { signal: callOptions.signal } : {}),
      },
      () => browser.sessionCleanup(input, callOptions),
    );
  }

  async function recoverSession(
    input: { session: string },
    callOptions: { signal?: AbortSignal } = {},
  ) {
    if (!input || !validSession(input.session))
      return fail("invalid_input", "Session recovery options are invalid.");
    if (!checkedOptions.ok) return checkedOptions.error;
    if (callOptions.signal?.aborted)
      return fail("aborted", "The recovery was cancelled.");
    const epoch = await freshEpoch();
    if (!epoch) return epochFailure();

    const session = input.session;
    enterSession(session);
    try {
      let verifiedBinding: BrowserSession | undefined;
      let recoveryMarkerId: string | undefined;
      const stored = await state.withEntry<RecoveryResult>(
        sessionKey(session),
        async (raw) => {
          let current: PersistedSession | undefined;
          try {
            current = parseStored(raw, session);
          } catch {
            throw corruptState();
          }
          const marker = await state.withEntry(
            markerKey(session),
            async (markerRaw) => {
              try {
                return { entry: markerRaw, result: parseMarker(markerRaw) };
              } catch {
                throw corruptState();
              }
            },
          );
          if (current?.kind !== "binding") {
            return {
              entry: current,
              result: fail(
                "recovery_unavailable",
                "No exact persisted Firefox binding is available to verify.",
              ),
            };
          }
          if (current.epoch !== epoch)
            return {
              entry: current,
              result: fail(
                "browser_epoch_changed",
                "The stored binding belongs to another Firefox instance.",
              ),
            };
          if (current.closed)
            return {
              entry: current,
              result: fail("session_closed", "The Firefox session is closed."),
            };
          if (!current.uncertain && !marker)
            return {
              entry: current,
              result: fail(
                "session_not_uncertain",
                "This Firefox session does not need recovery.",
              ),
            };
          recoveryMarkerId = marker?.operationId;
          const check = await verifyLive(current, callOptions.signal);
          if (!check.ok)
            return {
              entry: { ...current, uncertain: true },
              result: check.error,
            };

          verifiedBinding = {
            ...toBinding(current, transientUrl(check.tab.url)),
            closed: false,
            uncertain: false,
            lastUsedAtMs: Date.now(),
          };
          const updated = toPersisted(
            session,
            epoch,
            verifiedBinding,
            current,
            check.tab.url,
          );
          if (updated?.kind === "binding" && recoveryMarkerId)
            updated.completedOperationId = recoveryMarkerId;
          return {
            entry: updated,
            result: {
              ok: true as const,
              session,
              tab: {
                id: check.tab.id,
                windowId: check.tab.windowId,
                url: safeUrl(check.tab.url),
              },
              container: {
                cookieStoreId: check.tab.cookieStoreId!,
                name:
                  options.containerNames?.[check.tab.cookieStoreId!] ?? null,
                evidence: "verified" as const,
              },
              recovered: true as const,
            },
          };
        },
        callOptions.signal ? { signal: callOptions.signal } : {},
      );

      if (verifiedBinding) sessionState.set(session, verifiedBinding);
      if (verifiedBinding && recoveryMarkerId)
        await clearMarkerIfMatches(session, recoveryMarkerId);
      return stored;
    } catch (error) {
      return safeStateFailure(error);
    } finally {
      leaveSession(session);
    }
  }

  return {
    ...browser,
    sessionEnsure: (
      input: Parameters<typeof browser.sessionEnsure>[0],
      callOptions: { signal?: AbortSignal } = {},
    ) =>
      trackSessionCall(
        input?.session,
        "ensure",
        callOptions.signal,
        async () => {
          if (!input || !validSession(input.session))
            return browser.sessionEnsure(input, callOptions);
          const invalid = validateEnsureInput(input);
          if (invalid) return invalid;
          if (!checkedOptions.ok)
            return browser.sessionEnsure(input, callOptions);
          const prepared = await preparedEnsureInput(input, callOptions.signal);
          if (!prepared.ok) return prepared.error;
          return intents.run(
            {
              session: input.session,
              mode: "ensure",
              ...(callOptions.signal ? { signal: callOptions.signal } : {}),
            },
            () => browser.sessionEnsure(prepared.input, callOptions),
          );
        },
      ),
    go: (
      input: Parameters<typeof browser.go>[0],
      callOptions: { signal?: AbortSignal } = {},
    ) =>
      trackSessionCall(input?.session, "normal", callOptions.signal, () =>
        browser.go(input, callOptions),
      ),
    read: (
      input: Parameters<typeof browser.read>[0],
      callOptions: { signal?: AbortSignal } = {},
    ) =>
      trackSessionCall(input?.session, "normal", callOptions.signal, () =>
        browser.read(input, callOptions),
      ),
    sessionClose: (
      input: Parameters<typeof browser.sessionClose>[0],
      callOptions: { signal?: AbortSignal } = {},
    ) =>
      trackSessionCall(input?.session, "normal", callOptions.signal, () =>
        browser.sessionClose(input, callOptions),
      ),
    confirmReplacement: (
      input: Parameters<typeof browser.confirmReplacement>[0],
      callOptions: { signal?: AbortSignal } = {},
    ) =>
      trackSessionCall(input?.session, "normal", callOptions.signal, () =>
        browser.confirmReplacement(input, callOptions),
      ),
    snapshot: (
      input: Parameters<typeof browser.snapshot>[0],
      callOptions: { signal?: AbortSignal } = {},
    ) =>
      trackSessionCall(input?.session, "normal", callOptions.signal, () =>
        browser.snapshot(input, callOptions),
      ),
    locate: (
      input: Parameters<typeof browser.locate>[0],
      callOptions: { signal?: AbortSignal } = {},
    ) =>
      trackSessionCall(input?.session, "normal", callOptions.signal, () =>
        browser.locate(input, callOptions),
      ),
    act: (
      input: Parameters<typeof browser.act>[0],
      callOptions: { signal?: AbortSignal } = {},
    ) =>
      trackSessionCall(input?.session, "normal", callOptions.signal, () =>
        browser.act(input, callOptions),
      ),
    wait: (
      input: Parameters<typeof browser.wait>[0],
      callOptions: { signal?: AbortSignal } = {},
    ) =>
      trackSessionCall(input?.session, "normal", callOptions.signal, () =>
        browser.wait(input, callOptions),
      ),
    network: (
      input: Parameters<typeof browser.network>[0],
      callOptions: { signal?: AbortSignal } = {},
    ) =>
      trackSessionCall(input?.session, "normal", callOptions.signal, () =>
        browser.network(input, callOptions),
      ),
    screenshot: (
      input: Parameters<typeof browser.screenshot>[0],
      callOptions: { signal?: AbortSignal } = {},
    ) =>
      trackSessionCall(input?.session, "normal", callOptions.signal, () =>
        browser.screenshot(input, callOptions),
      ),
    readText: (
      input: Parameters<typeof browser.readText>[0],
      callOptions: { signal?: AbortSignal } = {},
    ) =>
      trackSessionCall(input?.session, "normal", callOptions.signal, () =>
        browser.readText(input, callOptions),
      ),
    sessionList,
    sessionCleanup,
    recoverSession,
  };
}
