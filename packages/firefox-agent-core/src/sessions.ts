import { randomUUID } from "node:crypto";
import { createBrowserCli } from "./browser-cli.js";
import { createBrowserOperations } from "./browser-api.js";
import type {
  BrowserConfig,
  BrowserSession,
  FirefoxBrowserFailure,
  FirefoxBrowserOptions,
  FirefoxBrowserResult,
  FirefoxBrowserTab,
  FirefoxReplacementConfirmation,
  FirefoxVerifiedContainer,
  TabInfo,
} from "./browser-types.js";
import {
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_SETTLE_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
  delay,
  fail,
  safeUrl,
  sameUrl,
  validateOptions,
  validSession,
  cloneConfirmation,
} from "./browser-types.js";

const CONFIRMATION_TTL_MS = 120_000;

export type FirefoxBrowserInternalOptions = {
  sessionState?: Map<string, BrowserSession>;
  runSession?: <T>(session: string, operation: () => Promise<T>) => Promise<T>;
};

export function createFirefoxBrowser(options: FirefoxBrowserOptions = {}) {
  return createFirefoxBrowserInternal(options);
}

export function createFirefoxBrowserInternal(
  options: FirefoxBrowserOptions = {},
  internal: FirefoxBrowserInternalOptions = {},
) {
  const config = validateOptions(options);
  const settings: BrowserConfig = config.ok
    ? config.value
    : {
        binaryPath: "",
        timeoutMs: DEFAULT_TIMEOUT_MS,
        maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
        settleTimeoutMs: DEFAULT_SETTLE_TIMEOUT_MS,
        containerNames: {},
      };
  const browserCli = createBrowserCli(settings);
  const { cli, jsonCommand, listWindows, listTabs, ensureHealth, getWarnings } =
    browserCli;
  const sessions = internal.sessionState ?? new Map<string, BrowserSession>();
  const queues = new Map<string, Promise<void>>();

  function enqueue<T>(
    session: string,
    operation: () => Promise<FirefoxBrowserResult<T>>,
  ): Promise<FirefoxBrowserResult<T>> {
    const previous = queues.get(session) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    queues.set(
      session,
      current.then(
        () => undefined,
        () => undefined,
      ),
    );
    return current;
  }

  async function withSession<T>(
    session: string,
    signal: AbortSignal | undefined,
    operation: () => Promise<FirefoxBrowserResult<T>>,
    options: { touch?: boolean } = {},
  ): Promise<FirefoxBrowserResult<T>> {
    if (!config.ok) return config.error;
    if (!validSession(session))
      return fail("invalid_session", "Session name is invalid.");
    if (signal?.aborted)
      return fail("aborted", "The browser operation was cancelled.");
    return enqueue(session, async () => {
      const execute = async () => {
        if (signal?.aborted)
          return fail("aborted", "The browser operation was cancelled.");
        const binding = sessions.get(session);
        if (binding && options.touch !== false)
          binding.lastUsedAtMs = Date.now();
        const checked = await ensureHealth(signal);
        if (!checked.ok) return checked;
        if (signal?.aborted)
          return fail("aborted", "The browser operation was cancelled.");
        return operation();
      };
      return internal.runSession
        ? internal.runSession(session, execute)
        : execute();
    });
  }

  function verifyTab(
    session: string,
    binding: BrowserSession,
    tabs: TabInfo[],
  ): FirefoxBrowserFailure | null {
    const tab = tabs.find((candidate) => candidate.id === binding.tabId);
    if (!tab)
      return fail(
        "owned_tab_missing",
        "The owned Firefox tab no longer exists.",
        { command: "ff_session_ensure", args: [session] },
      );
    if (
      tab.windowId !== binding.windowId ||
      tab.private ||
      !tab.cookieStoreId
    ) {
      return fail(
        "tab_verification_failed",
        "Firefox tab ownership metadata is missing or changed.",
      );
    }
    if (tab.cookieStoreId !== binding.cookieStoreId) {
      return fail(
        "container_conflict",
        "The owned Firefox tab changed containers.",
      );
    }
    return null;
  }

  function makeContainer(cookieStoreId: string): FirefoxVerifiedContainer {
    return {
      cookieStoreId,
      name: Object.hasOwn(settings.containerNames, cookieStoreId)
        ? (settings.containerNames[cookieStoreId] ?? null)
        : null,
      evidence: "verified",
    };
  }

  function publicTab(tab: TabInfo): FirefoxBrowserTab {
    return { id: tab.id, windowId: tab.windowId, url: safeUrl(tab.url) };
  }

  function success<T>(
    session: string,
    tab: TabInfo,
    result: T,
  ): FirefoxBrowserResult<T> {
    return {
      ok: true,
      session,
      tab: publicTab(tab),
      container: makeContainer(tab.cookieStoreId!),
      result,
      warnings: getWarnings(),
    };
  }

  async function checkedBinding(
    session: string,
    binding: BrowserSession,
    signal?: AbortSignal,
  ): Promise<
    { ok: true; tab: TabInfo } | { ok: false; error: FirefoxBrowserFailure }
  > {
    if (binding.closed)
      return {
        ok: false,
        error: fail("session_closed", "The Firefox session is closed."),
      };
    if (binding.uncertain)
      return {
        ok: false,
        error: fail(
          "mutation_uncertain",
          "The previous browser mutation has an uncertain outcome.",
        ),
      };
    if (binding.pending)
      return {
        ok: false,
        error: fail(
          "confirmation_pending",
          "Replacement confirmation is pending.",
        ),
      };
    const windows = await listWindows(signal);
    if (!windows.ok) return windows;
    const window = windows.value.find((item) => item.id === binding.windowId);
    if (!window || window.private)
      return {
        ok: false,
        error: fail(
          "window_verification_failed",
          "The owned Firefox window is missing or private.",
        ),
      };
    const listed = await listTabs(binding.windowId, signal);
    if (!listed.ok) return listed;
    const invalid = verifyTab(session, binding, listed.value);
    if (invalid) return { ok: false, error: invalid };
    return {
      ok: true,
      tab: listed.value.find((item) => item.id === binding.tabId)!,
    };
  }

  async function pollNavigation(
    session: string,
    binding: BrowserSession,
    before: Set<number>,
    expectedUrl: string,
    expectedContainerId: string | undefined,
    signal?: AbortSignal,
  ): Promise<
    { ok: true; tab: TabInfo } | { ok: false; error: FirefoxBrowserFailure }
  > {
    const deadline = Date.now() + settings.settleTimeoutMs;
    let lastTabs: TabInfo[] = [];
    do {
      if (signal?.aborted)
        return {
          ok: false,
          error: fail("aborted", "The browser operation was cancelled."),
        };
      const listed = await listTabs(binding.windowId, signal);
      if (!listed.ok) return listed;
      lastTabs = listed.value;
      const original = lastTabs.find((tab) => tab.id === binding.tabId);
      if (original) {
        if (
          original.windowId !== binding.windowId ||
          original.private ||
          !original.cookieStoreId
        )
          return {
            ok: false,
            error: fail(
              "tab_verification_failed",
              "Firefox tab ownership metadata is missing or changed.",
            ),
          };
        if (original.cookieStoreId !== binding.cookieStoreId)
          return {
            ok: false,
            error: fail(
              "container_conflict",
              "The owned Firefox tab changed containers.",
            ),
          };
        if (sameUrl(original.url, expectedUrl)) {
          if (
            expectedContainerId &&
            original.cookieStoreId !== expectedContainerId
          )
            return {
              ok: false,
              error: fail(
                "container_conflict",
                "The requested destination container does not match the owned tab.",
              ),
            };
          return { ok: true, tab: original };
        }
      } else {
        const unowned = lastTabs.filter(
          (tab) =>
            !before.has(tab.id) &&
            tab.windowId === binding.windowId &&
            !tab.private &&
            Boolean(tab.cookieStoreId) &&
            sameUrl(tab.url, expectedUrl) &&
            ![...sessions.values()].some(
              (owned) => !owned.closed && owned.tabId === tab.id,
            ),
        );
        if (
          expectedContainerId &&
          unowned.some((tab) => tab.cookieStoreId !== expectedContainerId)
        ) {
          return {
            ok: false,
            error: fail(
              "container_conflict",
              "Firefox opened the replacement tab in a different requested container.",
            ),
          };
        }
        if (unowned.length === 1) {
          const candidate = unowned[0]!;
          const expiresAtMs = Date.now() + CONFIRMATION_TTL_MS;
          const publicValue: FirefoxReplacementConfirmation = {
            id: randomUUID(),
            session,
            previousTabId: binding.tabId,
            candidate: publicTab(candidate),
            container: makeContainer(candidate.cookieStoreId!),
            expiresAt: new Date(expiresAtMs).toISOString(),
          };
          binding.pending = {
            publicValue,
            candidateUrl: candidate.url,
            candidateContainerId: candidate.cookieStoreId!,
            ...(expectedContainerId ? { expectedContainerId } : {}),
            expiresAtMs,
          };
          return {
            ok: false,
            error: {
              ...fail(
                "confirmation_required",
                "Firefox replaced the owned tab. Confirm the candidate before adoption.",
              ),
              confirmation: cloneConfirmation(publicValue),
            },
          };
        }
        if (unowned.length > 1)
          return {
            ok: false,
            error: fail(
              "replacement_ambiguous",
              "Multiple replacement tabs match the requested page.",
            ),
          };
      }
      if (Date.now() < deadline)
        await delay(Math.min(100, Math.max(1, deadline - Date.now())));
    } while (Date.now() < deadline);
    if (!lastTabs.some((tab) => tab.id === binding.tabId)) {
      return {
        ok: false,
        error: fail(
          "owned_tab_missing",
          "The owned tab disappeared and no unique container-safe replacement was found.",
        ),
      };
    }
    return {
      ok: false,
      error: fail(
        "navigation_not_settled",
        "Firefox did not report the requested URL before the settle timeout.",
      ),
    };
  }

  async function performGo(
    session: string,
    binding: BrowserSession,
    url: string,
    expectedContainerId: string | undefined,
    signal?: AbortSignal,
  ): Promise<FirefoxBrowserResult<{ ready: true }>> {
    const checked = await checkedBinding(session, binding, signal);
    if (!checked.ok) return checked.error;
    const beforeResult = await listTabs(binding.windowId, signal);
    if (!beforeResult.ok) return beforeResult.error;
    const before = new Set(beforeResult.value.map((tab) => tab.id));
    const command = await cli(
      [
        "open",
        url,
        "--window",
        `id:${binding.windowId}`,
        "--tab",
        `id:${binding.tabId}`,
        "--json",
      ],
      signal,
    );
    if (!command.ok) {
      binding.uncertain = true;
      return {
        ...command.error,
        code: "mutation_uncertain",
        message:
          "Navigation may have occurred. Do not replay it automatically.",
      };
    }
    if (command.value.exitCode !== 0) {
      binding.uncertain = true;
      return fail(
        "mutation_uncertain",
        "Navigation has an uncertain outcome. Do not replay it automatically.",
      );
    }
    const settled = await pollNavigation(
      session,
      binding,
      before,
      url,
      expectedContainerId,
      signal,
    );
    if (!settled.ok) {
      if (!binding.pending) binding.uncertain = true;
      return settled.error;
    }
    const ready = await jsonCommand(
      [
        "wait",
        "--load",
        "domcontentloaded",
        "--timeout",
        String(settings.settleTimeoutMs),
        "--window",
        `id:${binding.windowId}`,
        "--tab",
        `id:${settled.tab.id}`,
        "--json",
      ],
      signal,
    );
    if (!ready.ok || ready.value.matched !== true) {
      const refreshed = await pollNavigation(
        session,
        binding,
        before,
        url,
        expectedContainerId,
        signal,
      );
      if (!refreshed.ok && binding.pending) return refreshed.error;
      binding.uncertain = true;
      return fail(
        "navigation_not_ready",
        "Firefox did not report the document as ready. Do not replay navigation automatically.",
      );
    }
    const revalidated = await checkedBinding(session, binding, signal);
    if (!revalidated.ok || !sameUrl(revalidated.tab.url, url)) {
      if (!revalidated.ok && revalidated.error.code === "owned_tab_missing") {
        const replacement = await pollNavigation(
          session,
          binding,
          before,
          url,
          expectedContainerId,
          signal,
        );
        if (!replacement.ok && binding.pending) return replacement.error;
      }
      binding.uncertain = true;
      return fail(
        "navigation_not_ready",
        "Firefox changed the owned tab before readiness could be confirmed.",
      );
    }
    binding.expectedUrl = url;
    binding.documentEpoch = (binding.documentEpoch ?? 0) + 1;
    binding.expectedContainerId = revalidated.tab.cookieStoreId!;
    return success(session, revalidated.tab, { ready: true });
  }

  return createBrowserOperations({
    sessions,
    withSession,
    settings,
    cli,
    jsonCommand,
    listWindows,
    listTabs,
    checkedBinding,
    performGo,
    success,
  });
}
