# Changelog

## Unreleased

- Prefer a constrained deletion-plan tool for strict-tool-capable OpenAI Responses models, retain strict text compatibility elsewhere, and recover only complete ranges inside recognized wrappers.
- Add bounded response-shape diagnostics and parse-mode metadata without persisting planner or transcript content.
- Enforce host-side response bounds and an 80% heuristic planner-context quality gate before parsing.
- Start opt-in prefix-safe preparation automatically for high-context session startup and agent-turn lifecycle points.
- Document global dedicated-planner selection while keeping `current` as the provider-neutral default.
- Collapse exact duplicate planner ranges at their first rank instead of discarding an otherwise usable plan, while retaining the raw range-count limit and all other validation.
- Show the bounded planner failure message in an expanded (Ctrl+O) compaction card, with a short ellipsis-trimmed snippet when collapsed and terminal control characters neutralized.

## 0.1.0

- Add provider-neutral verbatim-line compaction with strict planner ranges and deterministic reconstruction.
- Add token-aware retention, digest-bound repeated-compaction provenance, trusted protected context, and reserved-delimiter quoting.
- Add bounded lexical recall, planner usage diagnostics, fail-open deadlines, and conservative opt-in speculative planning.
- Add privacy handling for excluded bash history and SDK persistence/resume coverage.
