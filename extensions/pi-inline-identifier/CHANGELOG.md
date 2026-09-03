# Changelog

- Match autocomplete queries anywhere in skill, agent, and prompt names,
  ranking exact-prefix matches first, so `/pi-ext` finds `/publish-pi-ext`
  and `&view` finds `&reviewer`.

## Unreleased

- Source `$skill`/`/prompt`/`&agent` identifier colors from theme tokens
  (mdLink, accent, borderAccent) resolved per session, replacing the
  hardcoded pastel hexes. Identifiers render uncolored without a TUI
  theme; every pi theme provides these tokens.
- Reuse prompt templates already present in active model context through a compact reference, while reinserting the full body after compaction, branch changes, or template revisions.
- Preserve identifier coloring when Pi's host `CustomEditor` and the extension-resolved `Editor` come from separate `pi-tui` module instances, including either load order with render-only custom editor factories.

## 0.1.2

- Cache each inline prompt body after its first use for the current session runtime.

## 0.1.1

- Autocomplete and expand every loaded prompt template inline, including names such as `/publish-pi-ext`, while preserving Pi's native first-line slash handling.

## 0.1.0

- Add selectively loadable inline identifiers for Pi skills, named agents, and `pi-prompt-*` prompt templates.
- Preserve native behavior for prompts whose first line starts with `/`.
- Coordinate input routing so one original request is inserted once and mixed identifiers are not composed implicitly.
