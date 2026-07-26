# Changelog

## Unreleased

- Unified parent `/btw merge` behavior. When no completed merge request is pending, recorded side sessions with a settled terminal assistant answer after their child marker and latest merge request are treated as merge candidates. A single candidate dispatches automatically; multiple candidates open the chooser. The parent never imports the raw latest answer.
- Under Herdr, the parent resolves the live child agent by exact session file and submits the constant `/btw merge` command with `herdr agent prompt <target> '/btw merge'`. The child authors the handoff, finalizes, refocuses/closes, and the live poll imports the result. It prefers a Herdr target stored on the split record at launch, otherwise queries `herdr agent list` and matches `agent_session.value` to the child session file. If no live child is found, it tells the user to run `/btw merge` inside that side session. Ghostty stays manual.
- `SplitRecord` gained an optional `herdrTarget`; new successful Herdr splits store their agent name so later merges dispatch without an `agent list` query. Legacy records without it fall back to the session-file match.
- Already-requested children (a merge intent awaiting finalization, or a recorded merge request) and already-imported children are not offered again as candidates unless new side work settled after the latest request.
- The live poll remains import-only; it never dispatches to a child.

## 0.2.0

- Redesign around a single `/btw` command. Removes `/split`, `/split-handoff`, `/split-import`, and `/split-import-full`.
- `/btw <goal>` launches a persisted side session; `/btw` without args keeps the historical user-message selector.
- `/btw merge [guidance]` writes a durable intent before sending the exact handoff prompt. Child `agent_settled` (or recovery on `session_start`) verifies the subsequent prompt and completed terminal assistant answer before recording a merge request. Parent import revalidates that association. Under Herdr, finalization uses `herdr agent focus` before closing the child and leaves the child open if refocus fails.
- In the main session, pending completed merges are detected live under Herdr. A factory-local, generation-guarded poll loop (started from `session_start`, stopped idempotently on `session_shutdown`, ~2.5s) skips child sessions, busy parents, and sessions without split records. Exactly one pending merge auto-imports; multiple pending merges show the chooser. An unchanged remainder stays deferred, while a new completion reopens the chooser with all pending items. Ghostty uses manual `/btw merge`. Pending and processed merges are durable and deduped by request id. Raw transcript import is removed.
- First-turn snapshot no longer records a nonexistent source session file as `parentSession`; the lineage link is only set when the source file exists on disk.
- Herdr prompt transport no longer exposes the user prompt in process argv: the prompt is embedded in a child session marker and the child is launched with a constant internal `/btw --launch` command that dispatches it. Ghostty keeps existing initial-input behavior.
- Supports first-turn splits when the source session is not persisted by snapshotting the public in-memory context (`buildSessionContext`) into a normal persisted child. Null boundaries stay null, unresolved turns are excluded, messages precede final model/thinking changes, and resolved compaction/branch summaries are rejected.
- Rejects nested `/btw` launches, uses the newest child marker, propagates a matching local `-e` extension path to children, and gives Herdr commands a 15-second outer timeout around the internal 10-second startup timeout.
- On a definite Herdr `agent start` failure after a pane was created, best-effort closes the new pane and deletes the child session only when cleanup is definite; retains the child on ambiguous timeout or throw.
- No runtime dependencies; only public Pi APIs.

## 0.1.3

- Submit Herdr split prompts through `herdr agent prompt` after startup so multiline prompts and tabs do not fail Herdr's shell-argument safety check.

## 0.1.2

- Support Herdr 0.7.5 by creating the pane with `herdr pane split` before starting the Pi agent with `herdr agent start --kind pi --pane <id>`.
- Replace obsolete `--workspace`, `--tab`, and `--split` options that Herdr 0.7.5 removed.
- Retain the copied session as an unconfirmed record when a pane exists but the agent start fails or cannot be parsed.

## 0.1.0

- Fork Pi conversations into Herdr or Ghostty side sessions.
- Generate clean handoffs in the side agent and import them into the main session.
- Support explicit full-transcript imports and lightweight selection across multiple splits.
- Preserve recoverability for ambiguous terminal launches.
