# Changelog

## Unreleased

- Render subagent calls as an unboxed plan — `% subagent` heading with chain/parallel counts and numbered steps as they execute, agent names in accent with emojis scraped from the native plan component (args fallback) — replacing the accent-rail card; failed subagents follow the full-red failure tone.
- Strip display sequences and control bytes (notably `\r` from progress writers like git) from collapsed-row text so command output cannot return the cursor to column 0 and overwrite the row.
- Color the truncation ellipsis to match its row tone (`muted` settled, `error` failed) instead of the terminal default foreground left by pi-tui's truncation reset.
- Render failed tool rows entirely in `error` — marker, call label, and outcome tail including the arrow and truncation ellipsis — so errored calls stand out as full red lines.
- Render settled tool rows in one uniform `muted` tone — group headings, bullets, summaries, and outcomes — while keeping `warning` pending and `error` failure states semantic.
- Compose container-level rendering through the shared
  `kg.pi.chatContainerHooks.v1` registry so grouping no longer shadows (or is
  shadowed by) `pi-content-layout`'s system-message inset in either load order.
- Label self-rendered `edit` rows by path (`edit <path>`), matching Pi's native
  call line instead of dumping the raw `{ path, edits }` JSON payload.
- Redesign collapsed tools as unboxed, background-free transcript lines with a two-column outer inset, `%` tool/group headings, `•` grouped children, and semantic low-contrast foregrounds with clear warning/error states.
- Preserve compact outcomes, right-hand tail reservation, `bash` duration, errors, image output, quiet-turn grouping, grouped-render caching, and MCP/self-rendered tool labels in the new shell.
- Keep expanded rows fully native so `Ctrl+O` restores complete results, custom renderers, and errors without collapsed decoration.
- Label hidden local reasoning with Pi's native braille spinner sequence (`⠋ Thinking…`, `⠙ Thinking…`, …) while streaming and `+ Thought · X.Xs` when finalized; use `+ Thought` for restored messages and older runtimes without streaming metadata.
- Track thinking duration per assistant row in a `WeakMap`, forward optional/future `updateContent` arguments, retain display-only adjacent thinking merging, and add no timer or render loop.
- Feature-detect private tool and thinking component shapes and fail open to Pi's native rendering while retaining Pi `>=0.80.6` support.
- Compact multiline singleton calls into one width-safe summary after settlement, including timeout metadata, while preserving the full native call under `Ctrl+O`.
- Group adjacent calls while they are still running, update pending outcomes in place, and merge sequential calls across quiet assistant turns.
- Add `PI_TOOL_CALL_MARKERS_COLLAPSE_PARALLEL`, enabled by default, to optionally keep same-assistant-message calls individual.
- Only invalidate grouped-render caches on meaningful state transitions.

## 0.1.2

- Keep grouping within one assistant tool batch, so a later pending batch does not reopen completed groups.
- Wait for every tool in a batch to settle, including tools beyond failed or expanded siblings.
- Preserve partial and image-bearing results instead of collapsing them.
- Treat self-rendered tools as owning their full shell and use only their stable header line in grouped summaries.

## 0.1.1

- Wait for every call in a contiguous parallel run to settle before grouping successful calls, which prevents completed prefixes and suffixes from repeatedly collapsing around active calls.

## 0.1.0

- Collapse adjacent successful tool calls into one compact block per tool type, each with a gear header and bulleted call summaries.
- Add vertical spacing between tool types and a hanging indent for wrapped bullet summaries.
- Keep visible thinking/text, active calls, and errors as group boundaries; expand errors in place.
- Combine only directly adjacent thinking blocks, falling back to Pi's renderer exactly once on malformed content.
- Restore individual full blocks when tools are expanded (Ctrl+O).
