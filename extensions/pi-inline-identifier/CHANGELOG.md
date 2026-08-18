# Changelog

## 0.1.0

- Add selectively loadable inline identifiers for Pi skills, named agents, and `pi-prompt-*` prompt templates.
- Preserve native behavior for prompts whose first line starts with `/`.
- Coordinate input routing so one original request is inserted once and mixed identifiers are not composed implicitly.
