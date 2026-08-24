# Exec plan: Pi verbatim compaction

## Goal and why

Build `@pi-kaush/pi-verbatim-compaction`, a provider-neutral Pi extension that uses a model only to rank deletion ranges, then reconstructs compacted history deterministically from original transcript lines. The package must preserve ordinary surviving evidence exactly and reserved delimiters losslessly, fail open to Pi native compaction, support token-aware retention and trusted protected context, expose useful diagnostics and lexical recall, and add conservative speculative background planning without ever mutating live history before Pi compacts.

## Work packages

### 1. Establish contracts and safety boundaries

- [x] Read the supplied design and repository guidance.
- [x] Verify Pi's public compaction/model/session APIs against installed source and docs.
- [x] Research Atomic's implementation and licensing; independently implement the architecture and credit the inspiration rather than copying code.
- [x] Record package configuration, transcript grammar, range grammar, fidelity guarantees, fallback rules, and speculation invalidation rules in package docs/tests.

Outcome: a narrow public-API-only architecture with explicit invariants.

### 2. Build the pure compaction engine

- [x] Add a deterministic full-content serializer for Pi compactable messages, previous compacted history, split-turn prefixes, roles, tool calls/results, custom messages, Unicode, long lines, and image placeholders.
- [x] Add strict ranked-range parsing, normalization, merging, mechanically protected spans, token-aware range selection, deletion-marker folding, and deterministic reconstruction.
- [x] Add source/snapshot hashing and metadata calculations.
- [x] Cover malformed output, truncation, huge lines, Unicode, repeated generations, prompt-injection-shaped tool output, and retention floors with focused tests.

Outcome: model output cannot directly author compacted history or violate host-enforced protections.

### 3. Integrate foreground planning with Pi

- [x] Call the configured planner through `ctx.modelRegistry.complete`, passing an explicit injection-resistant prompt and current objective.
- [x] Handle manual, threshold, overflow, cancellation, split-turn, prior-summary, model failure, output truncation, and no-op plans.
- [x] Return a valid custom compaction only when reduction and integrity checks pass; otherwise let Pi compact natively.
- [x] Persist bounded observability metadata without transcript or planner-response leakage.

Outcome: a usable, provider-neutral foreground compactor with safe native fallback.

### 4. Add operations, recall, and conservative speculation

- [x] Add namespaced global settings/environment overrides with secure defaults.
- [x] Add `/verbatim-context` diagnostics and a bounded `verbatim_recall_history` lexical search tool over the current session branch.
- [x] Implement disposable background candidates only at safe lifecycle points, with exact compactable-prefix/model/config/objective hashes, abort/invalidation, bounded concurrency, and foreground fallback.
- [x] Measure candidate generated/used/stale/error counts, planner latency, tokens, and provider-reported cost.

Outcome: inspectable memory behavior, recoverable raw evidence, and latency optimization that cannot affect correctness when stale.

### 5. Package, validate, and run locally

- [x] Add README, changelog, license, package metadata, settings defaults, and package-content checks.
- [x] Add pure, hook-harness, and Pi SDK integration tests plus an offline deterministic replay/evaluation harness.
- [x] Run package tests/typecheck/package checks, then repository `npm run check`; resolve task-caused failures and report unrelated failures.
- [x] Point `~/.pi/agent/settings.json` at the local package exactly once, check the shared settings override, and verify after Pi reload with `pi list`.

Outcome: reviewable local package ready for real-session evaluation; publishing remains a separate explicit user action.

## Validation

- Pure invariants: exact survivor fidelity, protected-span enforcement, strict parser behavior, bounded output, cumulative markers, deterministic hashes.
- Hook behavior: all compaction reasons, cancellation, prior summary, split turn, failure fallback, competing extension interoperability.
- SDK smoke: persisted compaction entry, resume/repeat behavior, faux-provider planner completion, lexical recall boundaries.
- Operational: package tarball contents, no runtime dependency requirement where practical, global local-source settings, `pi list` after reload.
- Final gate: `npm run check` from repository root.

## Unresolved blockers

- Real automatic-compaction and multi-generation quality need an interactive Pi reload and representative sessions; automated tests and replay fixtures can validate mechanics but not the research hypothesis alone.
- Pi has no early exact compaction-preparation event. Speculation must use conservative approximate snapshots and will only be accepted on an exact digest match at commit time; low hit rate is acceptable and must be measured.
- Shared Aikado settings still contain `npm:@pi-kaush/pi-openai-compaction`. The active global settings use only the local verbatim package, but a future shared-settings sync could restore the competing compactor and must be reconciled first.

## Decision log

- **2026-08-23 — New package.** Use `pi-verbatim-compaction` rather than modifying `pi-openai-compaction`; the latter replays provider-native OpenAI checkpoints and has a different compatibility and persistence contract.
- **2026-08-23 — Independent implementation.** Credit Atomic as design inspiration but do not copy its source; this keeps the package's existing MIT licensing straightforward.
- **2026-08-23 — Stronger fidelity than Atomic.** Preserve complete textual tool output in the compactable transcript; represent non-text image content with explicit deterministic placeholders because arbitrary binary/image bytes cannot live in Pi's string compaction summary.
- **2026-08-23 — Pi owns boundaries.** Operate only on `event.preparation` and preserve `firstKeptEntryId`; do not recreate Pi's cut-point logic.
- **2026-08-23 — Strict mutation boundary.** Planner output is only ranked inclusive `start,end` records. Host code parses, protects, budgets, reconstructs, and decides whether a result is safe enough to persist.
- **2026-08-23 — Token-aware from the start.** Keep line-oriented semantic ranking but select ranked ranges until an estimated token target is reached, avoiding huge/minified-line pathologies.
- **2026-08-23 — Speculation is optional and fail-disposable.** Ship it disabled by default until measured; an exact commit-time digest is mandatory, and a miss always falls back to the foreground path.
- **2026-08-23 — Reserved delimiters are quoted losslessly.** Pi wraps summaries in a user-role `<summary>` envelope, so raw closing tags and serializer-shaped content would elevate untrusted provenance. Quote only reserved lines as deterministic JSON records; keep ordinary survivors byte-identical.
- **2026-08-23 — Repeated provenance is digest-bound.** Persist protected, marker, and structure line numbers with a summary SHA-256 digest, and trust them only when the active prior summary and latest verbatim compaction entry match.
- **2026-08-23 — Excluded history stays excluded.** Never send or return `excludeFromContext` bash executions through planning, reconstruction, or recall.
- **2026-08-23 — Provider aborts fail open.** Cancel Pi compaction only when Pi's event signal is actually aborted; provider-side aborts, timeouts, context overflow, and malformed plans fall through to native compaction.
- **2026-08-23 — Prefix-safe speculation.** Pi exposes no early preparation event, so a candidate may include the recent tail. Reuse requires Pi's exact prepared compactable transcript to be a complete digest-identical prefix of the immutable candidate; pending or mismatched work is discarded without waiting.
- **2026-08-23 — Hard resource bounds fail open.** Cap planner output, parsed records, selected fragments, recall scans, labels, and serialized metadata. If a pathological transcript cannot reach its retention target within those bounds, return no custom result and let Pi's native compactor run.
