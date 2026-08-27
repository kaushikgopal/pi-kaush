# @pi-kaush/pi-verbatim-compaction

Native compaction rewrites old history into a short prose summary. Verbatim compaction instead removes low-value lines and keeps every surviving line unchanged.

The core rule is: **the model selects; deterministic host code mutates**.

### Install

```fish
pi install npm:@pi-kaush/pi-verbatim-compaction
```

Restart Pi or run `/reload`.

## Requirements

Requires Pi `>=0.84.3 <0.85` and Node.js `>=22.19.0`.

Inspect the active configuration with:

```text
/verbatim-context
```

When enabled, automatic threshold compaction, overflow recovery, Pi's built-in `/compact`, and `/verbatim-compact` all pass through this strategy.

Enable only one extension that provides custom compaction. See [Interoperability](#interoperability).

## Why compaction exists

LLMs have limited context windows. Eventually a coding session becomes too large to send with every request.

Compaction reduces the **active history the model sees**:

```text
Before:
  lots of old history + recent conversation

After:
  compacted old history + recent conversation
```

Pi decides where the old region ends. Recent messages stay outside compaction and remain unchanged. Original messages remain in the session file, even though the compacted version replaces them in active model context.

## How native Pi compaction works

Native compaction gives the old history to an LLM and asks it to write a prose summary:

```text
Old history
  ↓
summarizer LLM
  ↓
"Goal: Fix login timeout
 Changes: Updated auth.ts
 Tests: 42 passed
 Next: Review retry behavior"
```

The model's next request contains:

```text
system prompt
native prose summary
recent messages kept by Pi
```

This gives strong compression, but the history is rewritten by an LLM. Exact errors, code, numbers, constraints, or subtle decisions can be omitted or paraphrased.

## How verbatim compaction changes this

Verbatim compaction does **not** ask an LLM to rewrite the conversation.

Instead:

```text
old history
  ↓
convert it to numbered lines
  ↓
planner LLM ranks lines that are safe to delete
  ↓
host code validates and applies the deletion plan
  ↓
surviving lines remain word-for-word unchanged
```

Deleted sections become markers such as:

```text
[verbatim-compaction: 318 lines removed]
```

The model's next request contains:

```text
system prompt
surviving verbatim lines + deletion markers
recent messages kept by Pi
```

Verbatim compaction is still lossy: deleted lines leave active context. Its promise is narrower—ordinary textual lines that survive are copied exactly from Pi's stored messages.

## What is the planner?

The planner is an LLM used only to answer:

> Which parts of this old transcript are safest to remove?

It receives:

- the current task or objective;
- a numbered version of the compactable transcript;
- the desired size after compaction;
- a list of mechanically protected lines; and
- optional instructions supplied to `/compact` or `/verbatim-compact`.

It returns ranked deletion ranges. On models with strict tool support, this is a constrained `submit_deletion_plan` tool call. Other models use the equivalent text form:

```text
120,180
6,40
300,305
```

This means:

1. lines 120–180 are safest to delete;
2. lines 6–40 are the next safest; and
3. lines 300–305 are lower-priority candidates.

The planner does not modify the transcript. The extension then:

1. validates the response;
2. collapses exact duplicate ranges at their first rank;
3. splits ranges around mechanically protected lines;
4. applies ranges in ranked order;
5. stops when it reaches the retention target; and
6. refuses to go below the minimum retained context.

With the package defaults, it aims to keep about **50% of the compactable old region**, never fewer than 8,000 estimated tokens, and only compacts when it can save at least 2,048 estimated tokens.

The current active Pi model is the planner by default. A dedicated `provider/model` can be selected in trusted global settings. Because the planner receives the complete compactable transcript, choosing another model may send that transcript to another provider.

## Is there a final summary?

**Technically yes, conceptually no.**

Pi's compaction API requires a field named `summary`. Native compaction fills it with LLM-written prose. Verbatim compaction fills the same field with surviving original lines and deletion markers:

```text
Native summary:
  LLM-written description of what happened

Verbatim summary:
  original transcript with selected sections removed
```

There is no second summarization call after planning. The planner's range selection is the only LLM-generated part; reconstruction is deterministic local code.

On repeated verbatim compactions, deletion-marker counts are folded forward and digest-bound provenance preserves which surviving lines are structure, protected context, and prior deletion markers.

## What is mechanically protected?

Some lines cannot be deleted, even if the planner requests them:

- serializer structure needed to keep messages and fields attributable;
- trusted `<keepContext>` spans in user text;
- protected structure carried through repeated verbatim compactions; and
- the configured minimum retained-token floor.

Use whole-line tags in user text when something must survive mechanically:

```text
<keepContext>
Do not change the public API.
Generated cache.ts must not be edited directly.
</keepContext>
```

The inline whole-line form is also protected:

```text
<keepContext>HTTP 409 is expected here.</keepContext>
```

Identical tags in assistant text, tool results, previous summaries, repository files, terminal output, or web content are treated as ordinary untrusted data. Tool output therefore cannot pin itself indefinitely.

Important goals, decisions, and errors outside `<keepContext>` are preserved through the planner's judgment rather than mechanical protection.

## Small example

Suppose this is the old region being compacted. Serializer structure is hidden here for clarity.

```text
1  User: Fix the login timeout without changing the public API.
2  Assistant: I'll inspect the repository.
3  Tool: 500 lines of directory listing.
4  Tool: The same directory listing repeated.
5  Assistant: Maybe Redis is broken.
6  Tool: auth.ts contains TIMEOUT_MS = 5000.
7  Assistant: Root cause: TIMEOUT_MS is too low.
8  <keepContext>
9  The public API must not change.
10 </keepContext>
```

The planner might return these three records, in priority order:

```text
3,4
5,5
2,2
```

Lines 3–4 are repeated tool output, line 5 is an obsolete hypothesis, and line 2 is lower-priority generic narration. Suppose deleting lines 3–5 is enough to reach the target. The host stops there and does not apply the lower-priority `2,2` range.

The result becomes:

```text
1  User: Fix the login timeout without changing the public API.
2  Assistant: I'll inspect the repository.
3  [verbatim-compaction: 3 lines removed]
4  Tool: auth.ts contains TIMEOUT_MS = 5000.
5  Assistant: Root cause: TIMEOUT_MS is too low.
6  <keepContext>
7  The public API must not change.
8  </keepContext>
```

What happened:

- the original directory listings and obsolete hypothesis were removed;
- their place became one deletion marker;
- the goal, evidence, and root cause survived exactly;
- the planner proposed deleting the generic narration, but the host stopped before needing it;
- the `<keepContext>` section was mechanically protected; and
- recent messages outside this old region remain appended normally.

## Failure behavior

If planning times out, returns an unsafe or unusable plan, cannot achieve the requested reduction, or fails an integrity check, the extension returns control to Pi. Pi's native compactor then runs instead of persisting a questionable verbatim result.

```text
verbatim planning fails
  ↓
no custom result is returned
  ↓
Pi performs native compaction
```

A failed verbatim card and the succeeding native card are separate outcomes. Press Ctrl+O to expand a card and inspect bounded diagnostics.

```text
  ≡ verbatim compaction ───────────────────────────────
    41,203 → 20,611 tokens (50% kept) · 258 lines removed
    3 pinned lines · gpt-5.6 · 2.1s · foreground

  ≡ native compaction ─────────────────────────────────
    61,200 → ~3,400 tokens · auto (context full)
```

## Historical recall

`verbatim_recall_history` performs bounded exact-text search over original entries in the current session branch, including material no longer present in active context. It is useful for paths, symbols, commands, errors, versions, and exact phrases.

Assistant thinking, images, and bash history marked `excludeFromContext` are excluded. Recall is a recovery aid, not a substitute for active context or an external archive.

## Commands

- `/verbatim-compact [focus]` — trigger Pi compaction; it uses the verbatim strategy when enabled and otherwise falls back to native behavior.
- `/verbatim-context` — show configuration, planner usage, fallback counts, and last-run metrics.
- `/compact [focus]` — Pi's built-in command; it also uses this extension when enabled.
- `Ctrl+O` — expand compaction cards for retention or failure details.

## Configuration

Defaults live in `settings.json`. Trusted global overrides belong under `verbatimCompaction` in `~/.pi/agent/settings.json`:

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

To use a dedicated planner without changing the active chat model:

```json
{
  "verbatimCompaction": {
    "planner": {
      "model": "provider/model-id"
    }
  }
}
```

Project-local settings are intentionally ignored. An untrusted repository cannot redirect the compactable transcript to another provider or weaken retention and protection rules.

Environment variables override file settings:

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

Speculative planning is implemented but disabled by default. When enabled, the extension may prepare an immutable candidate before Pi reaches the compaction boundary; it is reused only if the transcript prefix and all relevant settings still match exactly.

## Fidelity limits

- Ordinary surviving textual lines preserve the text Pi stored, including whitespace and Unicode.
- Reserved delimiters are represented by deterministic, reversible escaped-line records so they cannot break the summary envelope or impersonate serializer structure.
- Images become deterministic metadata placeholders; image bytes are not copied into the compacted text.
- Tool-call arguments become stable key-sorted JSON.
- Bash executions marked `excludeFromContext` remain excluded from planning, compacted output, and recall.
- Pi tools may already have truncated output before storing it; this extension cannot recover text that never entered the session.
- History rewritten by an earlier summarizer is already lossy. Later verbatim compaction cannot reconstruct the original conversation.

## Interoperability

Enable only one extension that returns a custom `session_before_compact` result. Pi runs compaction handlers in load order, and a later result replaces an earlier one rather than merging strategies.

Running this package alongside observational-memory compaction, VCC, or another custom compactor can waste a planner call or replace the intended result. The recall tool, commands, and chat cards otherwise use public Pi APIs and do not replace the editor.

## Development

```fish
npm install
cd extensions/pi-verbatim-compaction
npm run package:check
npm run bench
```

## Inspiration

The strategy is inspired by [Atomic's Verbatim Compaction](https://github.com/bastani-inc/atomic/blob/main/packages/coding-agent/docs/compaction.md): use a model for selection and deterministic software for deletion. This package is an independent implementation for Pi's public extension APIs; no Atomic source code is copied.
