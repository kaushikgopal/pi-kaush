# Changelog

## 0.1.0

- Add the `/btw` command for launching normal persisted Pi side sessions in Herdr or Ghostty.
- Add `/btw merge` for child-authored handoffs, parent-side selection, live Herdr import, and durable deduplication.
- Keep Herdr launch prompts out of process arguments and propagate matching local extension paths during development.
- Support first-turn side sessions from Pi's in-memory context without adding a compaction model call.
- Close newly created Herdr panes after definite startup failures and retain ambiguous launches for recovery.
- Keep Ghostty merge import manual and reject nested side sessions.
