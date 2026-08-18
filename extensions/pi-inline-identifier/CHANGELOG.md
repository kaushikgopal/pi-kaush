# Changelog

## Unreleased

- Cache each inline prompt body after its first use for the current session runtime.

## 0.1.1

- Autocomplete and expand every loaded prompt template inline, including names such as `/publish-pi-ext`, while preserving Pi's native first-line slash handling.

## 0.1.0

- Add selectively loadable inline identifiers for Pi skills, named agents, and `pi-prompt-*` prompt templates.
- Preserve native behavior for prompts whose first line starts with `/`.
- Coordinate input routing so one original request is inserted once and mixed identifiers are not composed implicitly.
