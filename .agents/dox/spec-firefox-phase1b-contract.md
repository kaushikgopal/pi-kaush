# Phase 1B implementation contract

## Scope

Add an in-memory owned-session client, targeted navigation, summary-only reads, and explicit replacement confirmation. Keep existing status APIs unchanged. Do not implement persistence, cross-process scheduling, workflows, arbitrary eval, screenshots, or CTC rule evaluation here. Do not claim v1 complete.

The previous chunk is committed as `4a59a59`. Only the earlier unrelated lockfile changes remain in the working tree. Do not stage, commit, install, publish, or change those entries during this chunk.

## Ownership and modules

- Core/session worker owns new browser session modules, public exports from `src/index.ts`, core package checks and focused session tests.
- Summary worker owns `src/summary.ts` and `test/summary.test.ts` only.
- Pi worker owns adapter `src/`, adapter tests, adapter package check and README/CHANGELOG only.
- Parent owns root integration, core README/support notes, plan, final review and live smoke.

Do not edit another worker's files. All imports in the adapter use `@pi-kaush/firefox-core` public exports only.

## Summary module contract

`summary.ts` exports:

```ts
type FirefoxPageSummary = {
  title: string;
  headings: string[];
  controls: Record<string, number>;
  dialogs: string[];
  truncated: boolean;
};
function summarizeSnapshot(input: {
  text: string;
  title: string;
  truncated: boolean;
  maxBytes?: number;
}): FirefoxPageSummary;
```

Implement the function as pure, original wrapper-side parsing of firefox-cli's actual DOM-text snapshot format. Inspect the pinned renderer/tests. Do not claim a real accessibility tree. Never return refs, input values, full body text, HTML, or backend text. Count controls by role. Bound title, headings/dialogs, node scanning and the complete serialized summary to `maxBytes` (default 4000). Invalid tiny budgets must produce explicit validation failure rather than silently exceeding the cap; the browser client validates budgets to >=256 before invoking this trusted helper. Preserve valid UTF-8. Mark truncation for backend or wrapper truncation. Attribute the summary-first technique to surf-cli in a short source comment with its repository URL. No new dependency or in-page script.

## Public core API contract

Add `createFirefoxBrowser(options?: FirefoxBrowserOptions)` as a separate factory. Do not rewrite the existing status factory. Export the factory and all types needed by the adapter from `core/index.ts`.

Options include existing `binaryPath`, `timeoutMs`, `maxOutputBytes`, and transport seam; `settleTimeoutMs?:number` (default 2000); `containerNames?:Record<string,string>` mapping cookieStoreId to an owner-supplied label. No config-file or Pi state reads.

The client methods are:

```ts
sessionEnsure(input: {
  session: string; url?: string; containerId?: string; windowId?: number;
}, options?: {signal?: AbortSignal}): Promise<FirefoxBrowserResult<{ready:true}>>;
go(input: {
  session: string; url: string; containerId?: string;
}, options?: {signal?: AbortSignal}): Promise<FirefoxBrowserResult<{ready:true}>>;
read(input: {
  session: string; maxBytes?: number;
}, options?: {signal?: AbortSignal}): Promise<FirefoxBrowserResult<FirefoxPageSummary>>;
sessionClose(input: {
  session: string;
}, options?: {signal?: AbortSignal}): Promise<FirefoxBrowserResult<{closed:true}>>;
confirmReplacement(input: {
  session: string; confirmationId: string;
}, options?: {signal?: AbortSignal}): Promise<FirefoxBrowserResult<{ready:true}>>;
```

Additional public types:

```ts
type FirefoxBrowserTab = {id:number; windowId:number; url:string};
type FirefoxVerifiedContainer = {
  cookieStoreId:string; name:string|null; evidence:'verified';
};
type FirefoxReplacementConfirmation = {
  id:string; session:string; previousTabId:number;
  candidate:FirefoxBrowserTab; container:FirefoxVerifiedContainer;
  expiresAt:string;
};
type FirefoxBrowserFailure = {
  ok:false; code:string; message:string;
  recovery:{command:string;args:string[]}|null;
  confirmation?:FirefoxReplacementConfirmation;
};
type FirefoxBrowserResult<T> = {
  ok:true; session:string; tab:FirefoxBrowserTab;
  container:FirefoxVerifiedContainer; result:T; warnings:string[];
} | FirefoxBrowserFailure;
```

Use type aliases for serializable result objects, not interfaces that fail Pi's JsonValue assignability. Preserve `FirefoxStatusResult` unchanged. Avoid exposing transport internals unnecessarily.

## Core behavior

1. Validate all public inputs. Session names must be nonempty and bounded. Accept only HTTP/HTTPS navigation and `about:blank`; reject credential-bearing URLs and privileged/file/script schemes.
2. Select only an explicit normal window or the unique normal window. Never use the current active tab/window implicitly. Multiple normal windows need an explicit window ID.
3. Check CLI version/health on first use. Mismatches warn, unknown surfaces fail. No auto-install, pair, repair or mutation retries.
4. Serialize each session's complete operation FIFO. Keep independent sessions separate. Do not deadlock when ensure calls navigation internally.
5. New sessions first create `about:blank` and record the actual returned ID. Revalidate it through tab metadata. A preexisting ID can never become owned.
6. `sessionEnsure` is idempotent for a live binding. An existing session with a different requested URL must not silently navigate; return a clear mismatch/recovery to `go`. Recreate a closed own binding only through explicit ensure.
7. Before every read/navigation/close, revalidate exact tab ID, window, actual cookieStoreId and non-private state. Missing container metadata means unknown, not default. An unexpected container change blocks the operation.
8. Snapshot existing tab IDs before navigation. Use only explicit `--tab id:N` and documented public commands. After navigation, poll metadata within the settle budget. Do not decide readiness from a fixed sleep alone.
9. If the original disappears, inspect only newly observed tabs with the expected URL and a present container ID. Exclude tabs already owned by another local session. Multiple/no matches stop. A unique match produces `confirmation_required` with a short-lived, session-bound confirmation object, not adoption.
10. An explicit expected container mismatch produces `container_conflict`, never a confirmation that overrides the expected account. A subsequent navigation without an explicit new expectation preserves the bound container expectation.
11. `confirmReplacement` revalidates pending session/token, expiry, exact candidate, URL, window and container. It adopts only after the harness's human-confirmation step. Never expose this as an ungated model-callable tool.
12. While confirmation is pending, repeated ensure returns the pending result without creating more seed tabs. Reads and close fail safely. Keep uncertain mutation outcomes explicit; never replay clicks/navigation/creation on timeout.
13. Return safe URL projections with userinfo, query and fragment removed. Keep full URLs only transiently for exact internal matching. Never log raw stdout/stderr or unrelated tabs.
14. Read summaries through the backend's bounded compact snapshot; pass title and text to `summarizeSnapshot`. Container appears in every tab result. No full snapshots or refs reach the summary output.
15. Close only revalidated owned/adopted tabs. State is intentionally local to this client instance; no restart-survival claims.

## Pi adapter behavior

Keep the status tool/command unchanged. Lazily create one browser client alongside the status client.

Add direct native tools `ff_session_ensure`, `ff_go`, `ff_read`, `ff_session_close` with the matching core inputs. Keep session explicit. Closed input/output schemas, bounded model-facing content, structuredContent, details and `isError` preserve core semantics. No sessions/container/summary policy in the adapter.

When ensure or go returns `confirmation_required`, show the exact candidate metadata through `ctx.ui.confirm` only if `ctx.hasUI`. On approval call core `confirmReplacement` once. On decline or noninteractive execution return the original failure. No model-callable confirmation tool, auto-approval, injected scripts, or UI calls in headless mode. Propagate cancellation. Add no colliding `/browser-*` commands.

Use structural factory injection for tests; do not tie the adapter to inferred extra methods in a growing client factory return type. Test tools through fake public clients and one real public Pi loader. Do not make actual browser calls in ordinary CI.

## Validation

Add tests for input and CLI parse failures, exact explicit targets, idempotence, unknown/changed containers, missing/private/unowned tabs, before/after candidate ambiguity, confirmation expiry/revalidation, declined/headless confirmation, FIFO/cancel, no mutation retry, and summary caps/no refs/no values. Update package allowlists for added production files only.

Parent runs the full repository check and a real default-container fixture smoke. Do not launch real browser tests in worker tasks. Keep temporary CTC settings intact for later integration checks. Private-window access stays disabled.
