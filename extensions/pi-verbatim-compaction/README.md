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

## Behavior

The extension:

1. intercepts Pi's public `session_before_compact` event;
2. preserves Pi's `firstKeptEntryId`, recent-context tail, trigger thresholds, persistence, and retry behavior;
3. serializes complete textual message content without adding another tool-output truncation layer;
4. calls a configured Pi model through `ctx.modelRegistry.complete`;
5. accepts only strict ranked `start,end` records from the planner;
6. mechanically protects transcript structure and trusted `<keepContext>` spans;
7. applies ranked ranges until the configured estimated-token target is reached;
8. inserts `[verbatim-compaction: N lines removed]` markers and folds their counts across repeated compactions; and
9. returns no custom result on any unsafe or unusable outcome, allowing Pi's native compactor to run.

Diagnostic metadata records counts, ratios, planner identity, latency, line provenance, and whether a foreground or speculative plan was used. `/verbatim-context` also reports planner response tokens and provider-reported cost, including discarded completed plans. The extension does not persist the planner prompt, response, transcript, session ID, or credentials.

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

The default planner is the current active Pi model. Configure another model as `provider/model` only when sending the full compactable transcript to that model and provider is acceptable.

The planner sees an explicit current objective, token target, protected line list, and numbered transcript. It is instructed to preserve continuation-critical coding evidence and return only:

```text
120,180
6,40
300,305
```

Ordinary malformed output is rejected in full. Coordinates must be positive, ascending, and within the current transcript; invalid records are never swapped or clamped into real deletions. If a provider stops at its output limit, only complete newline-terminated records before the truncated fragment are recoverable. Planner output and accepted range counts are hard-bounded; every accepted range is still split around protected lines and constrained by the retention floor. If a pathological plan cannot meet the target within those bounds, the extension fails open. The complete numbered prompt plus output reserve is preflighted against the planner context window, and calls have a configurable hard deadline even if a provider ignores cancellation.

## Speculative background planning

Speculation is implemented but disabled by default until its cost/hit rate is measured on real sessions.

When enabled, a standalone planner call can start after a tool-heavy turn crosses `speculation.triggerRatio`. It operates on an immutable active-context snapshot while the agent continues. At Pi's actual compaction point, the candidate is accepted only when:

- Pi's exact compactable transcript is a complete, digest-identical prefix of the immutable candidate;
- objective, planner model, retention config, and protected-context config still match;
- no custom `/compact` focus changed relevance;
- the candidate is less than 15 minutes old; and
- its ranges still meet all foreground retention and safety checks.

Pending, stale, or incompatible work is aborted/discarded without delaying foreground compaction, which remains the fallback. Speculation never mutates live context.

## Historical recall

The `verbatim_recall_history` tool performs bounded lexical substring search over the current branch's original session entries, including content no longer present in active model context.

It is optimized for exact paths, symbols, commands, errors, versions, and phrases. Query size, scanned entries, scanned characters, result count, and final output are bounded. Assistant thinking, images, and `excludeFromContext` bash history are excluded; the abort signal is checked while scanning.

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
cd /Users/kg/dev/oss/pi-kaush/extensions/pi-verbatim-compaction
npm run typecheck
npm test
npm run package:check
npm run bench
```

The test suite covers exact and reserved-line serialization, Unicode and huge lines, excluded bash privacy, trusted-tag injection boundaries, strict/truncated/out-of-bounds range parsing, protected-range splitting, token floors, repeated provenance and marker folding, planner context/deadline failures, foreground fallback, cancellation, speculative reuse, bounded recall, and two persisted compaction generations across an in-memory Pi SDK resume.

`bench/replay.ts` can also read a JSON array of replay cases containing `source`, ranked `ranges`, retention settings, and exact-string `probes`:

```fish
bun run bench/replay.ts ./my-replay-cases.json
```

## Inspiration

The strategy is inspired by [Atomic's Verbatim Compaction](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/docs/compaction.md): use a model for selection and deterministic software for deletion. This package is an independent implementation for Pi's public extension APIs; no Atomic source code is copied.
