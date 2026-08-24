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

### 6. Harden automatic planning after the first real overflow

- [x] Keep planner selection global and configurable: `current` remains the portable default, while an explicit `provider/model` under `verbatimCompaction.planner.model` selects a dedicated planner without changing the active chat model.
- [x] Prefer one constrained `submit_deletion_plan` tool for strict-tool-capable OpenAI Responses models; use strict text elsewhere and recover only complete records inside one recognized, structurally valid wrapper envelope.
- [x] Strengthen capability-specific post-transcript output contracts, classify malformed responses without persisting their content, and surface bounded response-shape diagnostics in fallback cards/status.
- [x] Preserve automatic behavior: Pi's threshold and overflow events remain authoritative, optional background preparation starts automatically when enabled, and installing the extension never requires a manual checkpoint.
- [x] Make speculative preparation catch up automatically at safe lifecycle points and remain prefix-safe; pending, stale, objective-mismatched, or unusable candidates never delay foreground planning.
- [x] Add regression coverage for constrained-tool plans, strict/recovered text, adversarial wrappers, response bounds, malformed diagnostic privacy, explicit/current model resolution, startup/turn refresh, threshold/overflow events, native fallback, and persisted-metadata privacy.
- [x] Update the README/configuration guidance, replay benchmark cases, changelog, and package validation results.

Outcome: large first-use sessions get a format-reliable automatic planning path, while provider portability, deterministic mutation, privacy, and Pi-native fallback remain intact.

## Validation

- Pure invariants: exact survivor fidelity, protected-span enforcement, strict parser behavior, bounded output, cumulative markers, deterministic hashes.
- Hook behavior: all compaction reasons, cancellation, prior summary, split turn, failure fallback, competing extension interoperability.
- SDK smoke: persisted compaction entry, resume/repeat behavior, faux-provider planner completion, lexical recall boundaries.
- Operational: package tarball contents, no runtime dependency requirement where practical, global local-source settings, `pi list` after reload.
- Final gate: `npm run check` from repository root.

- Hardening regressions: constrained-tool output, bounded text recovery, diagnostic privacy, explicit/current model selection, automatic threshold/overflow behavior, and prefix-safe prepared-plan reuse.
- Completed 2026-08-24: `npm run check` passed (33 Vitest files / 493 tests; verbatim package 52 tests), package tarball validation passed, and the replay benchmark retained the protected/API probes while removing the synthetic noise probe at ~50% retention.

## Unresolved blockers

- Real automatic-compaction and multi-generation quality need an interactive Pi reload and representative sessions; automated tests and replay fixtures can validate mechanics but not the research hypothesis alone.
- Pi has no early exact compaction-preparation event. Speculation must use conservative approximate snapshots and will only be accepted on an exact digest match at commit time; low hit rate is acceptable and must be measured.
- Shared Aikado settings still contain `npm:@pi-kaush/pi-openai-compaction`. The active global settings use only the local verbatim package, but a future shared-settings sync could restore the competing compactor and must be reconciled first.

- The observed overflow proves the foreground fallback boundary but not the planner's exact malformed text because planner output is intentionally not persisted. Replay fixtures must cover plausible wrapper, whitespace, duplicate, reversed, truncated, and out-of-bounds shapes without adding private session content to the repository.

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
- **2026-08-24 — Chat log via custom entries.** Compaction cards use `appendEntry` + `registerEntryRenderer` (Pi ≥ 0.84.3) rather than `sendMessage`, so cards render in the transcript without entering LLM context. Styling borrows tool-row geometry (2-column inset, bullet, `toolTitle` header, muted body) instead of patching Pi's built-in compaction component, keeping the feature in one extension. The peer floor rises to 0.84.3 for `session_compact_failed`.
- **2026-08-24 — Dedicated planner is an explicit global choice.** Keep `current` as the provider-neutral package default. Resolve an explicit `provider/model` only from trusted global settings or environment overrides; do not encode private provider identities in repository plans, defaults, fixtures, or README examples.
- **2026-08-24 — Automatic means no bootstrap command.** Normal threshold and overflow compaction continue through Pi's public hook automatically. Background preparation may warm a plan but must not require `/verbatim-compact`; the command remains an optional manual control only.
- **2026-08-24 — Structured first, compatible fallback.** Prefer a constrained deletion-plan tool when the model/provider can emit it, then strict text, then bounded extraction of complete range-shaped records. Every path converges on the same host validation, protected-line splitting, retention floors, and native fail-open behavior.
- **2026-08-24 — Diagnose shape, never content.** Persist only bounded planner identity, stop reason, response size/counts, parse mode/failure category, latency, usage, and cost. Never persist planner prompt/output, transcript content, credentials, or session-affinity identifiers.
- **2026-08-24 — Preserve Pi's trigger authority.** Do not invent a parallel cut-point algorithm or compact mid-turn. Pi owns threshold/overflow timing and safe preparation; optional speculation can start automatically at safe lifecycle points and is accepted only through exact prefix validation.
- **2026-08-24 — Capability-specific contracts.** Send the constrained plan tool only to OpenAI Responses models whose compatibility profile permits strict schemas; send an unconditional text-only contract everywhere else. Do not advertise or require a tool that was omitted from the request.
- **2026-08-24 — Recovery needs one valid envelope.** Text recovery permits comma whitespace plus one optional recognized heading and one optional paired fence. Repeated, misplaced, arbitrary, or unclosed wrappers reject the entire plan so echoed examples and prose cannot become deletions.
- **2026-08-24 — Bound the whole response locally.** Cap content parts, text/thinking/metadata characters, serialized validated tool arguments, output lines, and range counts before parsing. Provider `maxTokens` remains a hint, not host enforcement.
- **2026-08-24 — Context headroom is heuristic.** Apply an 80% byte-estimated quality gate without claiming tokenizer accuracy. The provider owns the hard context check; any undercounted overflow remains a model error that fails open to native compaction.
- **2026-08-24 — Refresh speculation after completed turns.** A startup candidate may survive interactive input for Pi's pre-turn threshold check; `before_agent_start` refreshes for a changed objective, and `turn_end` always replaces the pre-turn snapshot with the completed-turn snapshot.
- **2026-08-24 — Each card reports only its own strategy.** Header color encodes that strategy's own outcome (tool-title = success, error = failed, warning = cancelled); a verbatim fail-open renders a red verbatim card with the reason, and Pi's fallback then renders a separate normal native card. No cross-card status (no "degraded" native header), and no separate generic "compaction failed" card — the strategy title plus color carries it.
