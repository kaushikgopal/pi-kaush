# Changelog

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
