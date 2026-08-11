# Changelog

## 0.2.0

- Add optional Intercom awareness: `/btw` splits generate a persisted split identity (generated `btw-*` child name, split id, and exact parent/child targets in proven default identity mode), name the child session before either backend starts, and reassert the name idempotently on startup.
- Project ephemeral, audience-specific Intercom routing guidance (`send` for updates, `ask` only when blocked, `reply` for questions) into `before_agent_start` only when the Intercom runtime initialized and the `intercom` tool is active; agent tool allowlists are never widened and no extra turn is triggered.
- Register an observational `pi-btw-presence/v1` extension channel for advisory connection/presence liveness labels only; no control payloads, shared state, or merge authority flows through it.
- Keep `/btw` fully functional without Intercom: absence, disconnection, or a missed registration degrades to the exact existing launch, merge, polling, and manual-import behavior.

## 0.1.0

## 0.1.0

- Add the `/btw` command for launching normal persisted Pi side sessions in Herdr or Ghostty.
- Add `/btw merge` for child-authored handoffs, parent-side selection, live Herdr import, and durable deduplication.
- Keep Herdr launch prompts out of process arguments and propagate matching local extension paths during development.
- Support first-turn side sessions from Pi's in-memory context without adding a compaction model call.
- Close newly created Herdr panes after definite startup failures and retain ambiguous launches for recovery.
- Keep Ghostty merge import manual and reject nested side sessions.
