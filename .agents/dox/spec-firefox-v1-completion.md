# Firefox v1 completion work

## Goal and authorization

Continue through a usable, locally installed Firefox browser-use system. Do not stop after intermediate chunks. No additional commit, push, publish, CTC change, native helper, or private-window access is authorized. Preserve unrelated lockfile changes. CTC routing and human-confirmed candidate adoption remain mandatory.

Integrate in plan order. Independent pure modules can be prepared in parallel. A phase passes only after integration tests and live checks.

## Completion checklist

- Durable scoped sessions, safe restart checks, cross-process exclusion, list/close/dry-run cleanup.
- Summary/scoped/full/text reads, bounded output, generation-bound refs, deterministic locators, actions, waits, compact diffs.
- File-only screenshots, local resizing when available, bounded network summaries; unsupported backend capabilities remain explicit.
- Bounded deterministic workflows and typed extraction with source evidence, no hidden model calls.
- Core config/env support, safe diagnostic logs, thin Pi integration, local installation, a Firefox skill, tested walkthrough and measured output table.
- Full checks, focused process/concurrency tests, live 20-cycle exercise and restart reuse. Never report a skipped check as a pass.

## Ownership of parallel work

1. Browser worker: current browser session modules and public browser exports, new snapshot/ref/action/read/network/screenshot/wait/lifecycle implementation and tests. Do not implement disk persistence, workflow engine, config loader or extraction conversion.
2. State worker: only `state-store.ts`, `browser-identity.ts`, corresponding tests, and a short module contract. Do not edit current session modules or public index; parent integrates.
3. Workflow worker: only `workflows.ts`, `extraction.ts`, corresponding tests. Pure/injected operations, no browser mutation in tests. Parent integrates these through a facade.
4. Parent: config/diagnostics, durable integration, facade, package checks, Pi extension integration, docs, review and live tests. Delegate adapter work after public client contracts settle.

Use a few cohesive modules, not a framework. New dependencies require evidence and approval; prefer zero runtime dependencies. All browser operations still call firefox-cli public commands. No copied upstream code.

## Browser worker contract

Preserve existing methods and result aliases. `read` remains summary-only for compatibility. Add methods on the same client:

- `snapshot({session,mode:'full'|'scoped'|'text',ref?,depth?,maxBytes?,noText?}, {signal?})`
- `locate({session,role?,name?,text?,label?,exact?}, {signal?})`
- `act({session,action:'click'|'fill'|'key'|'scroll'|'select',ref?,locate?,value?,key?,direction?,amount?,noDiff?}, {signal?})`
- `wait({session,ref?,text?,url?,timeoutMs?}, {signal?})`
- `network({session,origin?,method?,type?,status?,urlsOnly?,maxEntries?,cursor?}, {signal?})`
- `screenshot({session,outputPath?,fullResolution?,focus?}, {signal?})`
- `readText({session,ref?,maxBytes?}, {signal?})` for bounded visible text; no HTML, eval, cookie/attribute/value read.
- `sessionList({session?}, {signal?})`: owned scoped entries only.
- `sessionCleanup({idleAfterMs,dryRun?}, {signal?})`: dry-run by default; closes only revalidated owned tabs.

All return existing `FirefoxBrowserResult<T>` for session operations. Lifecycle list/cleanup may use a new JSON-friendly `{ok:true,result:...}|FirefoxBrowserFailure` alias. Export required types through public index. Document exact shapes for the parent, then add APIs without changing old signatures.

Refs: wrapper refs `eN` map to a backend `@eN` plus generation, tab and URL. Never reuse an old public ref for another target. Invalidate on navigation/document replacement. Old generation refs may remain usable across ordinary DOM changes if backend still resolves them. Do not claim semantic stability the backend cannot prove. Validate actual refs through `ref --generation` before mutations; stale means `stale_ref`, not a fresh full read or guessed target.

Scoping must use a backend-supported selector derived from a verified element (or conservative local tree scoping). Do not invent a scoped-ref flag. Snapshot parser is original code over actual DOM-text grammar. Full/text modes require explicit calls and remain capped. Exclude password/input values. Summary still has no refs. Return cap/truncation metadata and narrow recovery hints. `readText` uses only public text getter and revalidates target.

Locators match locally by exact role/name/label/text semantics. No model calls. Duplicate matches fail before acting. Ref-less actions need a unique locator, except documented key/scroll cases. After an action, requery tab/container, detect loss/replacement, and return a compact diff rather than full snapshot. Never replay mutations on timeout or nonzero exit. Do not act again after unknown outcomes. Preserve explicit destination expectations. Do not silently follow a container-changing link.

Network: start observation before supported operations when needed; source retention is 30 seconds. Summaries only, scrub URL credentials/query/fragment, fixed caps and filters. No fake historical timestamps or response-body support. Report limitations accurately.

Screenshot: public CLI writes a private image file. Never return base64. macOS `sips -Z 1200` is an optional local image-processing operation, not browser control. If resizing unavailable, report the limitation rather than falsely claiming resized output. Full-page remains unsupported. `focus` is explicit; disclose that capture selects the tab.

Add narrow application seams for later persistence: option `sessionState?: Map<string,BrowserSession>` can share bindings inside core, and `runSession?<T>(session,operation):Promise<T>` can wrap the entire existing withSession operation in an external state transaction. These seams are core-internal options if exposing internal types would pollute public API; prefer exporting an explicit internal factory to another core module, not adapter deep imports. Parent will finalize after handoff. Do not build persistence yourself.

## State worker contract

Implement standalone private, atomic, bounded JSON state and cross-process locks with standard Node APIs. Never read/write Firefox internals. Store only wrapper state.

Export:

```ts
type StateJson = null|boolean|number|string|StateJson[]|{[key:string]:StateJson};
createFirefoxStateStore(options:{path:string;lockTimeoutMs?:number}): {
  withEntry<T>(key:string, operation:(entry:StateJson|undefined)=>Promise<{entry:StateJson|undefined;result:T}>, options?:{signal?:AbortSignal}):Promise<T>;
  list(options?:{signal?:AbortSignal}):Promise<Record<string,StateJson>>;
};
class FirefoxStateError extends Error {code:string}
getLocalFirefoxEpoch():Promise<string|null>;
```

`withEntry` holds a per-key lock across the operation. Reads/writes of the shared index use a short global lock; merge updates so different sessions can overlap without losing entries. Atomic temp write/rename, 0600 files, 0700 lock directory, reject symlinks, malformed/oversized state, unsafe ownership. No secrets or page bodies in error strings. Never reclaim locks on elapsed age alone. Reclaim only provably dead process owners; unknown owners fail safely. Do not kill processes to recover locks. Tests must use real child processes for cross-process mutual exclusion, independent entries, crash recovery and malformed-state protection.

Browser identity gap: public `doctor --json` has no browser-instance identifier. The local epoch helper may read only same-user OS process PID/start metadata (`pgrep -x firefox`, `ps`), returning a hash for exactly one Firefox main process or null when ambiguous/unavailable. Do not expose command lines, user data paths, or browser content. This is ownership metadata, not a browser-control bypass. Parent records this helper gap and verifies it locally. Linux/macOS first; unsupported OS must return null, not guess.

## Workflow and extraction worker contract

`workflows.ts` exports JSON-friendly step/result types and `runFirefoxWorkflow(input,port,{signal?})`. Input has `steps`, `args?`, `dryRun?`, `allowWrite?`, `onError?:'stop'|'continue'`. Port is an injected `execute(step, resolvedArgs):Promise<{ok:boolean,result?:WorkflowJson,code?:string,message?:string}>` or similarly narrow typed callable. No core session imports.

Steps include navigate/read/locate/click/fill/key/scroll/wait/extract/assert, `as` capture, `%{arg}` and captured paths, bounded repeat/each. Validate the entire workflow before effects. Data-only substitutions, no eval/code/template execution, no prototype keys. Cap expanded steps, loops, timeout, captures and results. Dry-run performs no effects, including no reads. Navigate/click/fill/key/scroll/select and unknown effects require `allowWrite`; a safety failure stops even with continue. Assertions are deterministic comparisons. Abort between steps. No hidden model/provider calls.

`extraction.ts` exports `extractFirefoxFields(fields,sources)` and types. Sources map field name to candidate `{text:string,ref?:string}` records; another layer selects sources. Fields have `type:'text'|'number'|'integer'|'date'|'time'|'datetime'|'duration'|'list'|'list.number'|'list.date'`, `instructions?`, `unit?`, `decimals?`, plus optional selector metadata the converter can ignore. Return per field explicit extracted/absent/uncertain variants, with bounded source evidence. Exact deterministic conversion only, no guessing of locale/timezone or natural-language instructions. Reject ambiguous numeric/date formats and unsupported instructions. Typed list behavior must be documented. Never return arbitrary input objects or unbounded sources. Original code, surf technique attribution comments with source URL.

## Parent integration invariants

Persisted keys include namespace, stable agent identity and session name. Pi supplies cwd namespace and its public session ID by default; `FFX_AGENT_ID` can select a stable explicit identity. Separate agents must not accidentally share bindings. Persist safe URLs only; retain a flag if a query/fragment was omitted, so a missing tab cannot be reopened at an altered URL silently. Rehydrate transient full URLs from verified live metadata in the same browser epoch. A changed/unknown epoch cannot authorize an old tab ID.

Disk pending confirmations never auto-adopt; prompt again if needed and revalidate. Refs/page text are not persisted. Errors and timeouts after mutations must persist uncertainty. No silent destructive state repair.

Config: documented XDG config/cache defaults and project `.pi-firefox.json`, known `FFX_*` overrides, explicit schema and precedence. Read only known env keys. Logs contain event/session IDs, container IDs, URL domain only, never queries/bodies/values/credentials. Debug off by default.

A facade composes browser operations, extraction source selection and workflow execution. The Pi adapter translates only schemas/UI/results. Install locally through public Pi package commands only after checks pass. Do not remove existing Chromium tooling or publish packages. Add a packaged Firefox usage skill so Pi can prefer the new tools without replacing the editor.
