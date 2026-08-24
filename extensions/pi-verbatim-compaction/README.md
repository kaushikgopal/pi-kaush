# @pi-kaush/pi-verbatim-compaction

Provider-neutral verbatim compaction for Pi coding sessions.

Instead of asking a model to rewrite old history as a summary, the extension asks a planner model which numbered transcript ranges are safest to delete. Host code validates those ranges, enforces protected context and token floors, and reconstructs the surviving history from the original serialized lines.

```text
Pi chooses its normal safe cut point
  → extension serializes the compactable region
  → planner ranks deletion ranges (`start,end`)
  → deterministic code protects, budgets, and deletes
  → Pi persists verbatim survivors + recent untouched messages
```

The core invariant is: **the model selects; deterministic code mutates**.

## Why use it

Ordinary summary compaction asks a model to author a shorter version of the conversation. That can paraphrase an exact error, omit a constraint, merge two attempts, or invent connective details. Verbatim compaction gives the model a narrower job:

```text
summary compaction                    verbatim compaction
model rewrites history                model ranks deletions
        ↓                                      ↓
new prose becomes durable context     host code copies surviving source lines
```

The result is still lossy—deleted lines are gone from active context—but every ordinary line that survives is the line Pi originally stored. This is especially useful in coding sessions where exact paths, commands, diagnostics, identifiers, decisions, and tool evidence matter more than a fluent narrative.

Key advantages:

- **Lower synthesis risk.** The planner cannot rewrite, reorder, or add durable conversation text; it can only propose deletions.
- **Exact surviving ordinary evidence.** Ordinary textual lines preserve whitespace, Unicode, long content, paths, command output, and other stored text byte-for-byte unless selected for deletion; reserved delimiters and non-text content follow the explicit [fidelity contract](#fidelity-contract).
- **Mechanical safety boundaries.** Host code—not planner obedience—enforces protected spans, transcript structure, token floors, range grammar, and output integrity.
- **Token-aware retention.** Selection targets estimated tokens rather than assuming every line costs the same, avoiding large minified lines or tool payloads overwhelming the budget.
- **Provider-neutral operation.** Planning uses Pi's configured model API; deterministic reconstruction happens locally and requires no separate compaction service.
- **Safe failure.** A timeout, malformed plan, stale speculative result, insufficient reduction, or failed integrity check returns control to Pi's native compactor instead of persisting a questionable boundary.
- **Inspectable and recoverable behavior.** Compaction cards and `/verbatim-context` expose what happened, while `verbatim_recall_history` can search bounded original branch history for evidence no longer in active context.

## Install

```fish
pi install npm:@pi-kaush/pi-verbatim-compaction
```

Requires Pi `>=0.84.3 <0.85` and Node.js `>=22.19.0`.

Restart Pi or run `/reload`, then verify the active configuration with:

```text
/verbatim-context
```

When enabled—and when no later custom compactor replaces its hook result—Pi's built-in `/compact`, automatic threshold compaction, overflow recovery, and `/verbatim-compact` all pass through this extension. Enable only one extension that returns a custom compaction result; see [Compaction-extension interoperability](#compaction-extension-interoperability).

## Behavior

The extension:

1. intercepts Pi's public `session_before_compact` event;
2. preserves Pi's `firstKeptEntryId`, recent-context tail, trigger thresholds, persistence, and retry behavior;
3. serializes complete textual message content without adding another tool-output truncation layer;
4. calls a globally configured Pi model through `ctx.modelRegistry.complete`;
5. prefers one constrained `submit_deletion_plan` tool response, with strict and conservatively recovered `start,end` text as compatibility fallbacks;
6. mechanically protects transcript structure and trusted `<keepContext>` spans;
7. applies ranked ranges until the configured estimated-token target is reached;
8. inserts `[verbatim-compaction: N lines removed]` markers and folds their counts across repeated compactions; and
9. returns no custom result on any unsafe or unusable outcome, allowing Pi's native compactor to run.

Diagnostic metadata records counts, ratios, planner identity, latency, response stop/shape, parse mode, line provenance, and whether a foreground or speculative plan was used. `/verbatim-context` also reports planner response tokens and provider-reported cost, including discarded completed plans. The extension does not persist the planner prompt, planner response content, transcript, session ID, or credentials.

## Fidelity contract

Ordinary surviving textual content lines are copied exactly from Pi's stored messages, including whitespace and Unicode. The serializer adds protected role/field boundaries so surviving evidence remains attributable. It persists digest-bound line provenance with each compaction so those boundaries, protected spans, and deletion markers retain their meaning after restart and repeated compaction.

Reserved text that could break Pi's `<summary>` envelope or impersonate the serializer grammar is represented by a deterministic `[verbatim:escaped-line {"text":...}]` JSON record. This is lossless and host-authored, but the active summary contains the reversible quoted form instead of the raw dangerous delimiter.

Other content without a direct byte-for-byte representation:

- Images become deterministic placeholders containing MIME type, encoded character count, and a SHA-256 digest. Pixel/base64 data is not copied into the compaction summary.
- Tool-call arguments become stable key-sorted JSON, with angle brackets represented as JSON Unicode escapes. The JSON line can be deleted, while its small tool name/ID boundary remains protected.
- `!!` bash executions marked `excludeFromContext` remain excluded from planner input, compacted output, and historical recall.
- Pi tools may already have truncated output before storing it. This extension preserves the complete text Pi stored; it cannot recover output that never entered the session.
- History summarized by an earlier abstractive compactor is already lossy. A later verbatim compaction can preserve that prior summary, but cannot reconstruct the original facts.

## Protected context

Whole-line tags in **user text** are mechanically protected. A cooperating extension may also opt in explicitly by using Pi custom-message type `verbatim-compaction-context`; other custom-message types remain untrusted.

```text
<keepContext>
Do not change the public API.
Generated cache.ts must not be edited directly.
</keepContext>
```

Inline whole-line form is also protected:

```text
<keepContext>HTTP 409 is expected here.</keepContext>
```

Identical tags in assistant text, tool results, previous summaries, repository files, terminal output, or web content are treated as ordinary untrusted transcript data. This prevents tool-output prompt injection from pinning itself indefinitely.

## Planner

The default planner is the current active Pi model. Set `verbatimCompaction.planner.model` to an explicit `provider/model` in trusted global settings to use a dedicated planner without changing the active chat model. If no override exists, `current` is inherited. Configuring another model may send the complete compactable transcript to that model and provider.

The planner sees an explicit current objective, token target, protected line list, and numbered transcript. OpenAI Responses models with strict tool-schema support also receive one constrained `submit_deletion_plan` tool; a valid call contains ranked positive integer `{ start, end }` objects. Models or compatibility profiles without that capability receive only the text contract:

```text
120,180
6,40
300,305
```

Tool arguments are validated as strictly as text records. The text path first accepts the canonical grammar. Recovery allows only complete range-shaped lines inside one optional recognized heading and one optional, properly paired Markdown fence; repeated, misplaced, unclosed, or arbitrary wrappers reject the plan. A duplicate, reversed, unsafe integer, excessive, malformed, or out-of-bounds range also rejects the plan rather than being swapped or clamped.

If a provider stops at its output limit, only complete newline-terminated records before the truncated fragment are eligible. Content-part counts, text/thinking/metadata characters, tool range-array shape, output lines, and accepted range counts are host-bounded; provider token limits are not treated as sufficient enforcement. Every accepted range is split around protected lines and constrained by the retention floor. A byte-based token estimate applies an 80% context quality gate, but it is not a tokenizer or a proof that the request fits; the provider's context check remains authoritative and any overflow fails open to Pi's native compactor.

No bootstrap command is required. Pi's automatic threshold and overflow compaction invoke this planner through the same hook; `/verbatim-compact` remains an optional manual control.

## Speculative background planning

Speculation is implemented but disabled by default until its cost/hit rate is measured on real sessions.

When enabled, standalone planning can start automatically when a high-context session loads, before an agent turn, and after a completed turn once context usage crosses `speculation.triggerRatio`. An idle candidate may survive the next interactive input long enough for Pi's pre-turn threshold check; `before_agent_start` then refreshes it against the new objective if compaction was unnecessary. Planning operates on an immutable active-context snapshot while the agent continues. At Pi's actual compaction point, the candidate is accepted only when:

- Pi's exact compactable transcript is a complete, digest-identical prefix of the immutable candidate;
- objective, planner model, retention config, and protected-context config still match;
- no custom `/compact` focus changed relevance;
- the candidate is less than 15 minutes old; and
- its ranges still meet all foreground retention and safety checks.

Pending, stale, or incompatible work is aborted/discarded without delaying foreground compaction, which remains the fallback. Speculation never triggers a separate cut-point algorithm or mutates live context; Pi remains responsible for automatic threshold/overflow timing and safe boundaries.

## Historical recall

The `verbatim_recall_history` tool performs bounded lexical substring search over the current branch's original session entries, including content no longer present in active model context.

It is optimized for exact paths, symbols, commands, errors, versions, and phrases. Query size, scanned entries, scanned characters, result count, and final output are bounded. Assistant thinking, images, and `excludeFromContext` bash history are excluded; the abort signal is checked while scanning.

## Scope and trade-offs

Verbatim means **surviving lines are verbatim**, not that the complete conversation is retained. Deletion is intentionally lossy, and history already rewritten by an earlier summarizer cannot be reconstructed. The recall tool can search original entries still present in the session branch, but it is not a substitute for active context or an external archive.

The planner receives the complete compactable transcript and current objective. By default that is sent to the active model's provider; configuring another planner may send it to that provider instead. This package does not automatically borrow fallback models from other providers.

The extension also does not implement a destructive "fresh context" rung when planning fails. It fails open to Pi, which retains ownership of cut points, recent-message boundaries, retries, persistence, and native fallback behavior. Speculative planning is an optional latency optimization, not a different retention policy, and remains disabled by default.

## Chat log

Every compaction appends a compact card to the transcript, aligned with tool-call rows. Cards are Pi custom entries: they render in the chat but never enter LLM context, so they cannot pollute the history they describe.

```text
  ≡ verbatim compaction ───────────────────────────────
    41,203 → 20,611 tokens (50% kept) · 258 lines removed
    3 pinned lines · gpt-5.4 · 2.1s · foreground

  ≡ native compaction ─────────────────────────────────
    61,200 → ~3,400 tokens · auto (context full)
```

The header line uses the theme's tool-title color; everything else is muted. Tokens are estimates: the verbatim card shows the compactable region before → after deletion, and the native card shows the session size → summary size. `pinned lines` are the lines the planner can never delete (`<keepContext>` blocks plus structural boundaries); `foreground` means the plan was computed on the spot, `speculative` that it was reused from background planning.

Each card reports only its own strategy's outcome, via header color:

- **tool-title color** — that strategy succeeded.
- **error color** — that strategy failed. A verbatim fail-open (planner timeout, unusable ranges, …) renders a red `verbatim compaction` card with the reason, followed by a separate normal `native compaction` card when Pi's fallback succeeds.
- **warning color** — the compaction was cancelled.

Ctrl+O expands a successful card for retention-target and digest detail. Chat-log cards require Pi ≥ 0.84.3 (`registerEntryRenderer` and the `session_compact_failed` event).

## Commands

- `/verbatim-compact [focus]` — wait for idle, then trigger Pi compaction through the hook.
- `/verbatim-context` — show current config, compaction counts, native fallbacks, speculation counters, and last-run metrics.
- `/compact [focus]` — Pi's built-in command also uses this extension normally.

## Configuration

Package defaults are in `settings.json`. Global overrides belong under `verbatimCompaction` in `~/.pi/agent/settings.json`:

```json
{
  "verbatimCompaction": {
    "enabled": true,
    "retention": {
      "ratio": 0.5,
      "minimumTokens": 8000,
      "minimumReductionTokens": 2048
    },
    "planner": {
      "model": "current",
      "maxOutputTokens": 4096,
      "timeoutMs": 120000
    },
    "protectedContext": {
      "enabled": true
    },
    "recall": {
      "enabled": true,
      "maxResults": 8,
      "maxCharacters": 12000
    },
    "speculation": {
      "enabled": false,
      "triggerRatio": 0.7
    },
    "debug": false
  }
}
```

To select a dedicated planner, override only the model field:

```json
{
  "verbatimCompaction": {
    "planner": {
      "model": "provider/model-id"
    }
  }
}
```

Omit the override or set it to `current` to inherit the active Pi model. Model selection is global-only so an untrusted project cannot redirect the compactable transcript to another provider.

Project-local settings are intentionally ignored. An untrusted repository must not be able to choose a different planner provider or weaken retention/protection rules.

Environment variables override files:

- `PI_VERBATIM_COMPACTION_ENABLED`
- `PI_VERBATIM_COMPACTION_RETENTION_RATIO`
- `PI_VERBATIM_COMPACTION_MINIMUM_TOKENS`
- `PI_VERBATIM_COMPACTION_MINIMUM_REDUCTION_TOKENS`
- `PI_VERBATIM_COMPACTION_PLANNER_MODEL`
- `PI_VERBATIM_COMPACTION_PLANNER_MAX_OUTPUT_TOKENS`
- `PI_VERBATIM_COMPACTION_PLANNER_TIMEOUT_MS`
- `PI_VERBATIM_COMPACTION_PROTECTED_CONTEXT_ENABLED`
- `PI_VERBATIM_COMPACTION_RECALL_ENABLED`
- `PI_VERBATIM_COMPACTION_RECALL_MAX_RESULTS`
- `PI_VERBATIM_COMPACTION_RECALL_MAX_CHARACTERS`
- `PI_VERBATIM_COMPACTION_SPECULATION_ENABLED`
- `PI_VERBATIM_COMPACTION_SPECULATION_TRIGGER_RATIO`
- `PI_VERBATIM_COMPACTION_DEBUG`

## Compaction-extension interoperability

Enable only one extension that returns a custom `session_before_compact` result. Pi runs compaction handlers in load order, and a later truthy result replaces an earlier one; it does not merge strategies. Running this package alongside `pi-openai-compaction`, observational-memory compaction, VCC, or another custom compactor can waste a model call or replace the intended result.

The `verbatim_recall_history` tool and commands are otherwise ordinary public Pi APIs and do not replace the editor or patch Pi internals.

## Use from this checkout

```fish
npm install
cd extensions/pi-verbatim-compaction
npm run package:check
pi -e /Users/kg/dev/oss/pi-kaush/extensions/pi-verbatim-compaction/index.ts
```

For normal local development, add the package directory to the global `packages` array, reload Pi, and confirm it with `pi list`.

## Validation

```fish
cd extensions/pi-verbatim-compaction
npm run typecheck
npm test
npm run package:check
npm run bench
```

The test suite covers exact and reserved-line serialization, Unicode and huge lines, excluded bash privacy, trusted-tag injection boundaries, constrained-tool/strict-text/recovered-text plans, adversarial wrappers, malformed diagnostic privacy, local output bounds, explicit/current planner selection, truncated/out-of-bounds range parsing, protected-range splitting, token floors, repeated provenance and marker folding, planner context/deadline failures, threshold/overflow event handling, foreground fallback, cancellation, automatic startup preparation, speculative reuse, bounded recall, and two persisted compaction generations across an in-memory Pi SDK resume.

`bench/replay.ts` can also read a JSON array of replay cases containing `source`, either ranked `ranges` or raw `plannerOutput`, retention settings, and exact-string `probes`:

```fish
bun run bench/replay.ts ./my-replay-cases.json
```

## Inspiration

The strategy is inspired by [Atomic's Verbatim Compaction](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/docs/compaction.md): use a model for selection and deterministic software for deletion. This package is an independent implementation for Pi's public extension APIs; no Atomic source code is copied.
