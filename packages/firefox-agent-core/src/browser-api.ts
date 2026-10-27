import { summarizeSnapshot } from "./summary.js";
import { createBrowserFeatureOperations } from "./browser-features.js";
import type { FirefoxTransportResult } from "./types.js";
import type {
  BrowserConfig,
  BrowserSession,
  FirefoxBrowserFailure,
  FirefoxBrowserResult,
  TabInfo,
} from "./browser-types.js";
import {
  fail,
  isId,
  record,
  sameUrl,
  validateEnsureInput,
  validateGoInput,
  validateReadInput,
  validSession,
  cloneConfirmation,
} from "./browser-types.js";

type WithSession = <T>(
  session: string,
  signal: AbortSignal | undefined,
  operation: () => Promise<FirefoxBrowserResult<T>>,
) => Promise<FirefoxBrowserResult<T>>;
type Command = (
  args: readonly string[],
  signal?: AbortSignal,
) => Promise<
  | { ok: true; value: FirefoxTransportResult }
  | { ok: false; error: FirefoxBrowserFailure }
>;
type JsonCommand = (
  args: readonly string[],
  signal?: AbortSignal,
) => Promise<
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: FirefoxBrowserFailure }
>;
type CheckedBinding = (
  session: string,
  binding: BrowserSession,
  signal?: AbortSignal,
) => Promise<
  { ok: true; tab: TabInfo } | { ok: false; error: FirefoxBrowserFailure }
>;
type Success = <T>(
  session: string,
  tab: TabInfo,
  result: T,
) => FirefoxBrowserResult<T>;
type SessionOperationsContext = {
  sessions: Map<string, BrowserSession>;
  withSession: WithSession;
  settings: BrowserConfig;
  cli: Command;
  jsonCommand: JsonCommand;
  listWindows: (
    signal?: AbortSignal,
  ) => Promise<
    | { ok: true; value: Array<{ id: number; private: boolean }> }
    | { ok: false; error: FirefoxBrowserFailure }
  >;
  listTabs: (
    windowId: number,
    signal?: AbortSignal,
  ) => Promise<
    { ok: true; value: TabInfo[] } | { ok: false; error: FirefoxBrowserFailure }
  >;
  checkedBinding: CheckedBinding;
  performGo: (
    session: string,
    binding: BrowserSession,
    url: string,
    expectedContainerId: string | undefined,
    signal?: AbortSignal,
  ) => Promise<FirefoxBrowserResult<{ ready: true }>>;
  success: Success;
};

function chooseWindow(
  windows: Array<{ id: number; private: boolean }>,
  requested?: number,
): { id: number; private: boolean } | null {
  const normal = windows.filter((window) => !window.private);
  if (requested !== undefined)
    return normal.find((window) => window.id === requested) ?? null;
  return normal.length === 1 ? normal[0]! : null;
}

export function createBrowserOperations(context: SessionOperationsContext) {
  const {
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
  } = context;
  const features = createBrowserFeatureOperations(context);
  return {
    ...features,
    sessionEnsure(
      input: {
        session: string;
        url?: string;
        containerId?: string;
        windowId?: number;
      },
      callOptions: { signal?: AbortSignal } = {},
    ): Promise<FirefoxBrowserResult<{ ready: true }>> {
      const validation = validateEnsureInput(input);
      if (validation) return Promise.resolve(validation);
      return withSession(input.session, callOptions.signal, async () => {
        const current = sessions.get(input.session);
        if (
          current &&
          !current.closed &&
          input.windowId !== undefined &&
          input.windowId !== current.windowId
        )
          return fail(
            "window_conflict",
            "The requested window differs from the owned session.",
          );
        if (
          current?.pending &&
          input.containerId &&
          input.containerId !== current.pending.candidateContainerId
        )
          return fail(
            "container_conflict",
            "The pending candidate does not match the requested container.",
          );
        if (
          current?.pending &&
          input.url &&
          !sameUrl(input.url, current.pending.candidateUrl)
        )
          return fail(
            "session_url_mismatch",
            "The pending candidate does not match the requested URL.",
          );
        if (current?.pending)
          return {
            ...fail(
              "confirmation_required",
              "Replacement confirmation is pending.",
            ),
            confirmation: cloneConfirmation(current.pending.publicValue),
          };
        if (current && !current.closed) {
          if (current.uncertain)
            return fail(
              "mutation_uncertain",
              "The previous browser mutation has an uncertain outcome.",
            );
          const checked = await checkedBinding(
            input.session,
            current,
            callOptions.signal,
          );
          if (!checked.ok && checked.error.code !== "owned_tab_missing")
            return checked.error;
          if (checked.ok) {
            if (
              input.containerId &&
              input.containerId !==
                (current.expectedContainerId ?? current.cookieStoreId)
            )
              return fail(
                "session_container_mismatch",
                "This session is bound to another destination container. Use go to request a switch.",
              );
            if (input.url && !sameUrl(current.expectedUrl, input.url))
              return fail(
                "session_url_mismatch",
                "This session already owns another URL. Use go to navigate.",
              );
            return success(input.session, checked.tab, { ready: true });
          }
          current.closed = true;
        }
        const windowResult = await listWindows(callOptions.signal);
        if (!windowResult.ok) return windowResult.error;
        const window = chooseWindow(windowResult.value, input.windowId);
        if (!window)
          return fail(
            "window_selection_required",
            "Select one normal Firefox window explicitly.",
            { command: "firefox-cli", args: ["window", "--json"] },
          );
        const before = await listTabs(window.id, callOptions.signal);
        if (!before.ok) return before.error;
        sessions.set(input.session, {
          tabId: -1,
          windowId: window.id,
          cookieStoreId: "",
          expectedUrl: "about:blank",
          closed: false,
          uncertain: true,
        });
        const created = await cli(
          [
            "tab",
            "new",
            "about:blank",
            "--window",
            `id:${window.id}`,
            "--json",
          ],
          callOptions.signal,
        );
        if (!created.ok || created.value.exitCode !== 0) {
          sessions.set(input.session, {
            tabId: -1,
            windowId: window.id,
            cookieStoreId: "",
            expectedUrl: "about:blank",
            closed: false,
            uncertain: true,
          });
          return fail(
            "mutation_uncertain",
            "Firefox may have created a seed tab. Do not retry automatically.",
          );
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(created.value.stdout);
        } catch {
          parsed = null;
        }
        const target =
          record(parsed) && record(parsed.target) ? parsed.target : null;
        const tabId =
          target &&
          (isId(target.tabId)
            ? target.tabId
            : isId(target.id)
              ? target.id
              : null);
        if (tabId === null) {
          sessions.set(input.session, {
            tabId: -1,
            windowId: window.id,
            cookieStoreId: "",
            expectedUrl: "about:blank",
            closed: false,
            uncertain: true,
          });
          return fail(
            "mutation_uncertain",
            "Firefox created a tab without a verifiable tab ID.",
          );
        }
        const listed = await listTabs(window.id, callOptions.signal);
        if (!listed.ok) return listed.error;
        const seed = listed.value.find((tab) => tab.id === tabId);
        if (
          !seed ||
          before.value.some((tab) => tab.id === tabId) ||
          seed.private ||
          !seed.cookieStoreId ||
          seed.windowId !== window.id ||
          !sameUrl(seed.url, "about:blank")
        ) {
          return fail(
            "tab_verification_failed",
            "Firefox did not return a verifiable normal blank tab.",
          );
        }
        const binding: BrowserSession = {
          tabId,
          windowId: window.id,
          cookieStoreId: seed.cookieStoreId,
          expectedUrl: "about:blank",
          ...(input.url
            ? input.containerId
              ? { expectedContainerId: input.containerId }
              : {}
            : { expectedContainerId: input.containerId ?? seed.cookieStoreId }),
          closed: false,
          uncertain: false,
          lastUsedAtMs: Date.now(),
          documentEpoch: current ? (current.documentEpoch ?? 0) + 1 : 0,
        };
        sessions.set(input.session, binding);
        if (!input.url) {
          if (input.containerId && input.containerId !== seed.cookieStoreId)
            return fail(
              "container_conflict",
              "The blank tab does not match the requested destination container. Provide a URL that CTC routes there.",
            );
          return success(input.session, seed, { ready: true });
        }
        return performGo(
          input.session,
          binding,
          input.url,
          input.containerId,
          callOptions.signal,
        );
      });
    },

    go(
      input: { session: string; url: string; containerId?: string },
      callOptions: { signal?: AbortSignal } = {},
    ): Promise<FirefoxBrowserResult<{ ready: true }>> {
      const validation = validateGoInput(input);
      if (validation) return Promise.resolve(validation);
      return withSession(input.session, callOptions.signal, async () => {
        const binding = sessions.get(input.session);
        if (!binding)
          return fail(
            "session_not_found",
            "Create this owned session with ensure first.",
            { command: "ff_session_ensure", args: [input.session] },
          );
        return performGo(
          input.session,
          binding,
          input.url,
          input.containerId ??
            binding.expectedContainerId ??
            binding.cookieStoreId,
          callOptions.signal,
        );
      });
    },

    read(
      input: { session: string; maxBytes?: number },
      callOptions: { signal?: AbortSignal } = {},
    ): Promise<FirefoxBrowserResult<ReturnType<typeof summarizeSnapshot>>> {
      const validation = validateReadInput(input);
      if (validation) return Promise.resolve(validation);
      return withSession(input.session, callOptions.signal, async () => {
        const binding = sessions.get(input.session);
        if (!binding)
          return fail(
            "session_not_found",
            "Create this owned session with ensure first.",
            { command: "ff_session_ensure", args: [input.session] },
          );
        const checked = await checkedBinding(
          input.session,
          binding,
          callOptions.signal,
        );
        if (!checked.ok) return checked.error;
        if (
          binding.expectedContainerId &&
          binding.expectedContainerId !== checked.tab.cookieStoreId
        )
          return fail(
            "container_conflict",
            "The current tab does not match the session's expected destination container.",
          );
        const target = [
          "--window",
          `id:${binding.windowId}`,
          "--tab",
          `id:${binding.tabId}`,
        ];
        const titleResponse = await jsonCommand(
          ["get", "title", ...target, "--json"],
          callOptions.signal,
        );
        if (!titleResponse.ok) return titleResponse.error;
        const titleTargetError = responseTargetError(
          titleResponse.value,
          binding,
        );
        if (titleTargetError) return titleTargetError;
        const title = titleResponse.value.value;
        if (typeof title !== "string")
          return fail(
            "invalid_cli_response",
            "Firefox CLI returned invalid title data.",
          );
        const snapshotResponse = await jsonCommand(
          [
            "snapshot",
            "-c",
            "--max-output",
            String(input.maxBytes ?? 4_000),
            ...target,
            "--json",
          ],
          callOptions.signal,
        );
        if (!snapshotResponse.ok) return snapshotResponse.error;
        const snapshotTargetError = responseTargetError(
          snapshotResponse.value,
          binding,
        );
        if (snapshotTargetError) return snapshotTargetError;
        if (
          typeof snapshotResponse.value.text !== "string" ||
          typeof snapshotResponse.value.truncated !== "boolean"
        )
          return fail(
            "invalid_cli_response",
            "Firefox CLI returned invalid snapshot data.",
          );
        const finalCheck = await checkedBinding(
          input.session,
          binding,
          callOptions.signal,
        );
        if (!finalCheck.ok) return finalCheck.error;
        if (!sameUrl(finalCheck.tab.url, checked.tab.url))
          return fail(
            "page_changed",
            "The page changed during the read. Read the session again.",
          );
        return success(
          input.session,
          finalCheck.tab,
          summarizeSnapshot({
            text: snapshotResponse.value.text,
            title,
            truncated: snapshotResponse.value.truncated,
            maxBytes: input.maxBytes ?? 4_000,
          }),
        );
      });
    },

    sessionClose(
      input: { session: string },
      callOptions: { signal?: AbortSignal } = {},
    ): Promise<FirefoxBrowserResult<{ closed: true }>> {
      if (!input || !validSession(input.session))
        return Promise.resolve(
          fail("invalid_session", "Session name is invalid."),
        );
      return withSession(input.session, callOptions.signal, async () => {
        const binding = sessions.get(input.session);
        if (!binding)
          return fail(
            "session_not_found",
            "This client does not own that session.",
          );
        const checked = await checkedBinding(
          input.session,
          binding,
          callOptions.signal,
        );
        if (!checked.ok) return checked.error;
        const command = await cli(
          [
            "tab",
            "close",
            `id:${binding.tabId}`,
            "--window",
            `id:${binding.windowId}`,
            "--json",
          ],
          callOptions.signal,
        );
        if (!command.ok) {
          binding.uncertain = true;
          return {
            ...command.error,
            code: "mutation_uncertain",
            message:
              "Tab close may have occurred. Do not replay it automatically.",
          };
        }
        let closed: unknown;
        try {
          closed = JSON.parse(command.value.stdout);
        } catch {
          closed = null;
        }
        if (
          command.value.exitCode !== 0 ||
          !record(closed) ||
          closed.closedTabId !== binding.tabId
        ) {
          binding.uncertain = true;
          return fail(
            "mutation_uncertain",
            "Tab close has an uncertain outcome. Do not replay it automatically.",
          );
        }
        binding.closed = true;
        binding.documentEpoch = (binding.documentEpoch ?? 0) + 1;
        return success(input.session, checked.tab, { closed: true });
      });
    },

    confirmReplacement(
      input: { session: string; confirmationId: string },
      callOptions: { signal?: AbortSignal } = {},
    ): Promise<FirefoxBrowserResult<{ ready: true }>> {
      if (
        !input ||
        !validSession(input.session) ||
        typeof input.confirmationId !== "string" ||
        !input.confirmationId
      )
        return Promise.resolve(
          fail("invalid_confirmation", "Replacement confirmation is invalid."),
        );
      return withSession(input.session, callOptions.signal, async () => {
        const binding = sessions.get(input.session);
        const pending = binding?.pending;
        if (
          !binding ||
          !pending ||
          pending.publicValue.id !== input.confirmationId
        )
          return fail(
            "invalid_confirmation",
            "No matching replacement confirmation is pending.",
          );
        if (Date.now() >= pending.expiresAtMs) {
          delete binding.pending;
          return fail(
            "confirmation_expired",
            "Replacement confirmation has expired.",
          );
        }
        const windows = await listWindows(callOptions.signal);
        if (!windows.ok) return windows.error;
        const window = windows.value.find(
          (item) => item.id === binding.windowId,
        );
        if (!window || window.private)
          return fail(
            "window_verification_failed",
            "The candidate window is missing or private.",
          );
        const tabs = await listTabs(binding.windowId, callOptions.signal);
        if (!tabs.ok) return tabs.error;
        const candidate = tabs.value.find(
          (tab) => tab.id === pending.publicValue.candidate.id,
        );
        const ownedByOther = [...sessions.entries()].some(
          ([name, owned]) =>
            name !== input.session &&
            !owned.closed &&
            owned.tabId === candidate?.id,
        );
        if (ownedByOther) {
          delete binding.pending;
          return fail(
            "candidate_owned",
            "Another local session already owns this candidate tab.",
          );
        }
        if (
          !candidate ||
          candidate.private ||
          candidate.windowId !== binding.windowId ||
          candidate.cookieStoreId !== pending.candidateContainerId ||
          (pending.expectedContainerId &&
            candidate.cookieStoreId !== pending.expectedContainerId) ||
          !sameUrl(candidate.url, pending.candidateUrl)
        ) {
          delete binding.pending;
          return fail(
            "candidate_changed",
            "The replacement candidate no longer matches the confirmed tab.",
          );
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
            `id:${candidate.id}`,
            "--json",
          ],
          callOptions.signal,
        );
        if (!ready.ok || ready.value.matched !== true)
          return fail(
            "candidate_not_ready",
            "Firefox did not report the replacement document as ready.",
          );
        const finalWindows = await listWindows(callOptions.signal);
        if (!finalWindows.ok) return finalWindows.error;
        if (
          !finalWindows.value.some(
            (item) => item.id === binding.windowId && !item.private,
          )
        )
          return fail(
            "window_verification_failed",
            "The candidate window changed before adoption.",
          );
        const finalTabs = await listTabs(binding.windowId, callOptions.signal);
        if (!finalTabs.ok) return finalTabs.error;
        const finalCandidate = finalTabs.value.find(
          (tab) => tab.id === candidate.id,
        );
        const claimed = [...sessions.entries()].some(
          ([name, owned]) =>
            name !== input.session &&
            !owned.closed &&
            owned.tabId === finalCandidate?.id,
        );
        if (
          claimed ||
          !finalCandidate ||
          finalCandidate.private ||
          finalCandidate.windowId !== binding.windowId ||
          finalCandidate.cookieStoreId !== pending.candidateContainerId ||
          !sameUrl(finalCandidate.url, pending.candidateUrl)
        ) {
          delete binding.pending;
          return fail(
            "candidate_changed",
            "The replacement candidate changed before adoption.",
          );
        }
        if (Date.now() >= pending.expiresAtMs) {
          delete binding.pending;
          return fail(
            "confirmation_expired",
            "Replacement confirmation expired during revalidation.",
          );
        }
        binding.tabId = finalCandidate.id;
        binding.documentEpoch = (binding.documentEpoch ?? 0) + 1;
        binding.cookieStoreId = finalCandidate.cookieStoreId!;
        binding.expectedContainerId = finalCandidate.cookieStoreId;
        binding.expectedUrl = pending.candidateUrl;
        delete binding.pending;
        return success(input.session, finalCandidate, { ready: true });
      });
    },
  };
}

function responseTargetError(
  response: Record<string, unknown>,
  binding: BrowserSession,
): FirefoxBrowserFailure | null {
  const target = response.target;
  if (
    !record(target) ||
    target.tabId !== binding.tabId ||
    target.windowId !== binding.windowId
  )
    return fail(
      "target_mismatch",
      "Firefox returned data for an unverified browser target.",
    );
  if (
    target.cookieStoreId !== undefined &&
    target.cookieStoreId !== binding.cookieStoreId
  )
    return fail(
      "container_conflict",
      "Firefox returned data for a different container.",
    );
  return null;
}
