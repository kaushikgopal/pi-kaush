# Managed subagents

## Goal

Add addressable, reusable background children to `pi-simple-subagents` without replacing bounded delegation or weakening its limits, model profiles, structured results, or diagnostics.

## Work packages

1. **Managed lifecycle and control.** Persist parent-owned launch configuration and child-owned status separately. Return stable handles; support status/list, steer, follow-up, wait, stop, and resume. Use assignment IDs so collecting a new task cannot return an older result. Preserve transcripts on stop. Survive extension reload; suspend children on parent quit/session replacement and relaunch idle when the parent resumes. Never automatically replay interrupted work.
2. **Execution and hosting.** Share the existing five-process gate between bounded and managed work; idle live workers consume slots. Preserve depth and watchdog ceilings. Launch native Pi children in unfocused Herdr panes split down below the parent; use a portable RPC backend elsewhere. Keep child control independent of terminal keystrokes.
3. **Integration and UI.** Preserve agent/profile/model precedence, emoji labels, catalog resolution, and safe pre-tool fallback. Keep existing single/parallel/chain behavior. Add `/subagent` discovery, inspect, open, message, and stop controls; expose isolation flags without removing the required child bridge or yield tool.
4. **Validation.** Add focused lifecycle, assignment, queue, ownership, concurrency, model-selection, isolation, and UI tests. Run the package tests, typecheck, packaging validation, and `npm run check`. Native Herdr smoke tests must close only extension-owned child panes, preserve the caller's tab and pane, and use offline providers.

## Decisions

- Bounded delegation remains the default; managed work is opt-in.
- In Herdr, each managed child gets an unfocused horizontal split below the parent in the current tab. Subsequent children split below the last live owned child; `/subagent` focuses the exact child agent. Existing worker tabs are not moved on reload.
- Outside Herdr, RPC provides background work and control without a tmux dependency. Native TUI attachment is not available there.
- Idle workers count against the process cap. Stop/suspend releases a slot; yield does not close a reusable worker.
- Stop retains transcripts and results. No implicit destructive cleanup.
- Parent and child must not concurrently rewrite the same metadata file. Persist configuration and status separately, with atomic writes and command acknowledgements.
- Resume restores context but does not repeat interrupted instructions or uncertain message deliveries.
- Terminal managed results report automatically to the parent through custom messages. Busy parents receive follow-ups, not steering; manual `wait` remains available.
- Reporting receipts live in the parent session and suppress duplicate delivery across reloads. An outbox intent alone never counts as delivery.
- Managed status contributes `below-footer:managed-subagents` through `setStatus`; `pi-footer-minimal` appends faint, dim rows after all footer lines. Reported nonlive workers disappear from the footer, while reusable idle workers remain visible.
- Expanded tool output owns spawn IDs and control hints; completion metadata is hidden while collapsed. Parent model guidance requests answer-only prose, with no message filtering or transcript rewriting.
- Outside Herdr, warn that automatic opening is unavailable and supply an exact fish-safe saved-session command. Require stopping a live RPC worker before manual opening to prevent duplicate session writers.

## Validation

- Full repository `npm run check` passed, including formatting, typecheck, tests, and package checks.
- Real offline Pi RPC smoke passed for yield, usage, session reuse, stop, and idle resume without replay.
- Native offline Herdr smoke passed: unfocused lower split, two yielded assignments, preserved caller tab and pane, and cleanup of only the owned child pane.
- Independent review fixes cover delivery confirmation after prompt validation, fallback result masking, RPC dialog cancellation, orphan writer exclusion, startup activation, managed-environment stripping, idle-slot deadlock prevention, and hard watchdog backstops.
- Real offline Pi SDK reporting smoke passed for idle parent turns, busy follow-up queues, persistent receipts, and resumed-session deduplication.
- Footer tests verify ordering after optional stats, dim/faint styling in light and dark themes, narrow-width truncation, control-code sanitization, and retained-history visibility.

## Remaining limits

- Native Herdr workers rely on provider credentials in the Herdr server environment or shared Pi authentication files. Parent-only exported credentials are not forwarded.
- RPC extension dialogs are cancelled rather than forwarded to the parent. Native workers expose dialogs in their own tab.
- A prompt rejected asynchronously before a run begins is detected by the delivery deadline, not an immediate acknowledgement.
- Windows orphan identity checks fail safe when an earlier process may still own the session; native attachment is Herdr-only.
- Real model-provider calls were not exercised; smoke providers are offline and deterministic.
