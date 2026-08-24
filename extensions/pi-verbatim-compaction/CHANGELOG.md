# Changelog

## Unreleased

- Prefer a constrained deletion-plan tool for strict-tool-capable OpenAI Responses models, retain strict text compatibility elsewhere, and recover only complete ranges inside recognized wrappers.
- Add bounded response-shape diagnostics and parse-mode metadata without persisting planner or transcript content.
- Enforce host-side response bounds and an 80% heuristic planner-context quality gate before parsing.
- Start opt-in prefix-safe preparation automatically for high-context session startup and agent-turn lifecycle points.
- Document global dedicated-planner selection while keeping `current` as the provider-neutral default.

## 0.1.0

- Add provider-neutral verbatim-line compaction with strict planner ranges and deterministic reconstruction.
- Add token-aware retention, digest-bound repeated-compaction provenance, trusted protected context, and reserved-delimiter quoting.
- Add bounded lexical recall, planner usage diagnostics, fail-open deadlines, and conservative opt-in speculative planning.
- Add privacy handling for excluded bash history and SDK persistence/resume coverage.
