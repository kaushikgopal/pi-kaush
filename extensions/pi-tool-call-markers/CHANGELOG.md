# Changelog

## Unreleased

- Render in-progress calls as a single header line (elapsed time inline for `bash`) that settles into the final summary at the same height, so the transcript flows downwards without jumping.
- Show the real duration in successful bash summaries (`→ done · 2.3s`) instead of dropping the elapsed time on completion.
- Keep a call's settled shape stable once rendered: batches that settle next to an active sibling stay as individual one-liners instead of regrouping afterwards, which removes the second jump when a parallel batch completes.
- Only invalidate grouped-render caches on real state transitions, so bash's per-second ticks and resize invalidations stop busting them.

- Keep failed calls collapsed by default while retaining their native error background and Ctrl+O expansion.
- Add compact result tails for common successful tools in singleton and grouped summaries.
- Keep grouped bullets to one line and preserve the useful result tail on narrow terminals.
- Merge settled calls across assistant turns when no visible prose separates them, without reopening earlier groups while a later batch is active.
- Move adjacent thinking-block merging to a separate extension entrypoint bundled in this package.

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
