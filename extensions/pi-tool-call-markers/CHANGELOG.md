# Changelog

## Unreleased

- Compact multiline singleton calls into one width-safe summary after settlement, including timeout metadata, while preserving the full native call under Ctrl+O.
- Compose capped in-progress rows before the Box paints its background, fixing elapsed tails leaking outside the tool background and restoring the block's bottom padding.

- Render in-progress calls as a single header line (elapsed time inline for `bash`) that settles into the final summary at the same height, so the transcript flows downwards without jumping.
- Show the real duration in successful bash summaries (`→ done · 2.3s`) instead of dropping the elapsed time on completion.
- Group adjacent calls while they are still running, so new bullets grow downward and successful settlement updates outcomes in place without upward reflow.
- Add `PI_TOOL_CALL_MARKERS_COLLAPSE_PARALLEL`, enabled by default, to keep same-assistant-message calls individual while still grouping sequential calls across quiet turns.
- Only invalidate grouped-render caches on real state transitions, so bash's per-second ticks and resize invalidations stop busting them.

- Keep failed calls collapsed by default while retaining their native error background and Ctrl+O expansion.
- Add compact result tails for common successful tools in singleton and grouped summaries.
- Keep grouped bullets to one line and preserve the useful result tail on narrow terminals.
- Merge calls across assistant turns as soon as they appear when no visible prose or thinking separates them.
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
