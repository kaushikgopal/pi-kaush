# Changelog

## Unreleased

- Teach the Simplicity style to choose the smallest useful visual for a reader question, including compact trees, structural diffs, state and sequence diagrams, data flows, and text fallbacks.

## 0.1.0

- Add the `/response-style` command: a themed SelectList picker (active ●, default ★, project-tagged) over markdown-defined response styles, with direct-arg and `off` forms and a plain-select fallback outside the TUI.
- Inject the active style at the system-prompt level via `before_agent_start` under a `# Communication` header, with a guardrail that keeps thinking traces, tool calls, and code unstyled. Off and never-picked are strict no-ops.
- Resolve the active style as session pick > configured default > last-used > off; off is an explicit persisted state that stops the cascade, and Esc-cancel changes nothing. Picks persist across resume and compaction.
- Layer styles bundled < user (`~/.pi/agent/response-styles`) < project (`.pi/response-styles`, trusted projects only). Seven bundled styles: simplicity, hemingway, i-have-adhd, pirate, asd-ste100, us-plain-writing-act, strunk-white-1918.
- Show a footer marker only when the active style differs from the default, and emit `pi-response-style:changed` on `pi.events` for custom footers.
- Ship an opt-in, fully isolated eval harness (`npm run bench`): 33% shorter output, answer-in-first-line 50% → 100%, deliverable purity 0% → 100%, hidden coding tests 5/5 both arms.
- Zero runtime dependencies.
