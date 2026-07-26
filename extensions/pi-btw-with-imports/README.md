# @pi-kaush/pi-btw-with-imports

Fork the current Pi conversation into a right-hand side session, continue working there, and import a clean handoff back into the main session.

The extension is intentionally narrow: it supports Herdr and Ghostty, shares the current working directory, and adds no background service or model call of its own. It registers a single `/btw` command.

## Why another side-session workflow?

Pi already has useful primitives for branching and side questions. This extension combines their useful parts for longer parallel work without trying to replace them:

- `/fork` and `/clone` create another conversation path, but you continue by moving the active Pi session to that path.
- BTW-style extensions are excellent for quick questions while the main agent runs, usually through a custom panel or an in-memory side thread.
- `pi-btw-with-imports` creates a normal persisted Pi session in another terminal pane. The main session stays visible and keeps running, while the side gets Pi's normal editor, tools, commands, model, and session history.

That makes it a good fit when the side task is more than a quick question: investigating code, trying an approach, reviewing a change, or iterating through several follow-ups. When the side work is ready, its own agent writes a clean handoff and the main session imports only that handoff. The main context never receives the raw side transcript.

The trade-off is deliberate: a real side terminal is heavier than a one-off BTW request, but it avoids building another conversation UI, hidden agent runtime, transcript model, or summarizer inside the extension.

## Install

After the first npm release:

```bash
pi install npm:@pi-kaush/pi-btw-with-imports@0.1.0
```

For local development:

```bash
pi -e ./extensions/pi-btw-with-imports/src/index.ts
```

## Workflow

Start side work with a goal:

```text
/btw investigate the failing integration test
```

Run `/btw` without arguments to choose a previous user message. The selected prompt is submitted automatically in the side session.

When the side work is ready, run this inside the side session:

```text
/btw merge
```

The extension records a durable merge intent before it asks the side agent for a concise final handoff. After the agent fully settles, it verifies the exact intent prompt and terminal answer, records the merge request, and (under Herdr) refocuses the main pane and closes the side pane. An optional argument adds guidance for the handoff:

```text
/btw merge focus on the test results
```

Back in the main session under Herdr, pending handoffs are detected live. A session-scoped poll loop (started on `session_start`, stopped on `session_shutdown`, roughly every 2.5 seconds) watches recorded side sessions for completed handoffs. It skips child sessions, skips while the main agent is busy, and scans only when side sessions are recorded. When exactly one handoff is pending, it imports automatically; when multiple handoffs are pending, it automatically opens the chooser. An immediate check also runs on `session_start`, so Herdr resumes import right away. Outside Herdr, switch back and run `/btw merge` manually. The poll only imports already-authored handoffs; it never dispatches to a child on its own.

After a chooser is cancelled or one item is chosen, the unchanged remaining handoffs are deferred to manual `/btw merge` rather than auto-imported without another user choice. If another handoff completes, the chooser opens again with all pending handoffs. Run `/btw merge` to revisit deferred items:

```text
/btw merge
/btw merge compare this with the current approach
```

Imports are deduped by merge request id, so resuming or re-running `/btw merge` never re-imports the same handoff.
Imports are deduped by merge request id, so resuming or re-running `/btw merge` never re-imports the same handoff.

## Unified parent merge

`/btw merge` in the main session now does one of two things:

1. **Completed handoffs exist** — imports the single pending handoff, or opens the chooser when multiple are pending (the existing behavior).
2. **No completed handoffs, but a recorded side session has finished new side work** — treats that side session as a merge candidate. A single candidate dispatches automatically; multiple candidates open the chooser.

A "merge candidate" is a recorded side session whose latest terminal assistant answer settled after its child marker and after its latest merge request, with no merge intent still awaiting finalization. Children that were already requested or already imported and have no later side work are not offered again. New side work after an earlier merge makes a child a candidate again.

Under Herdr, the parent resolves the live child agent by exact session file — preferring a target stored on the split record at launch, otherwise querying `herdr agent list` and matching `agent_session.value` to the child session file — then submits the constant `/btw merge` command to that child with `herdr agent prompt <target> '/btw merge'`. The child authors the handoff, finalizes, refocuses/closes, and the live poll imports the result. The parent never imports the child's raw latest answer. If no live Herdr child can be found, the parent tells you to run `/btw merge` inside that side session. Outside Herdr (Ghostty), the parent keeps the workflow manual and instructs you to run `/btw merge` in the side session yourself.

## First-turn splits

`/btw` also works before the main session has been persisted to disk. Instead of refusing, it snapshots the public in-memory session context (`buildSessionContext`) into a normal persisted child, preserving the exact settled boundary and messages before appending the final model and thinking state. Snapshot contexts with compaction or branch summaries are rejected because those resolved messages cannot be appended as ordinary session messages. No pi-vcc, snapshot file, or lossy summary is involved. When the main session is already persisted, the existing exact branch logic is unchanged.

## Requirements and constraints

- **Herdr is the preferred host.** When Pi is running inside the cross-platform [Herdr](https://herdr.dev) multiplexer, `/btw` opens a right-hand Herdr agent split, submits the prompt through a private transport, and can refocus/close panes on merge.
- **Ghostty is the fallback.** Outside Herdr, macOS users can open a right-hand [Ghostty](https://ghostty.org) split through its AppleScript API. Ghostty keeps the prompt as initial terminal input. The side pane does not auto-close or refocus, and live polling is disabled. Switch back to the main session and run `/btw merge` to import the handoff.
- **Other terminals are not supported automatically.** Without an active Herdr session or Ghostty on macOS, `/btw` fails before copying a session. Supporting another terminal requires adapting the small launch boundary in the extension.
- **Conversation isolation is not filesystem isolation.** Main and side sessions share the same working directory and files, so simultaneous edits can affect each other.
- **The side remains a normal Pi session.** Under Ghostty, close it manually when finished. Under Herdr, `/btw merge` closes it after a successful refocus; refocus or close failures leave it open and show an error.
- **Ambiguous launches remain recoverable.** If a host may have opened despite a timeout, the retained child appears as `[unconfirmed]` in the merge chooser.

Requires Pi 0.80.6 or newer. Ghostty fallback requires macOS, Ghostty AppleScript support, and macOS Automation permission.

## Commands

- `/btw <goal>` forks the conversation and launches a side session with the goal.
- `/btw` lets you choose a previous user message and launches a side session with it.
- `/btw merge [guidance]` persists and finalizes a side handoff. In the main session, it imports or selects pending handoffs, and when none are pending but side work is complete, dispatches `/btw merge` to the live child (or tells you to run it manually when no live child is found). Herdr also detects pending handoffs live.

## Private prompt transport

Under Herdr the user prompt never appears in process argv. `/btw` embeds the prompt in a child session marker, starts the child with `pi --session <child-file>`, then submits a constant `/btw --launch` command as the child's first input. The child's `/btw --launch` handler reads the newest marker and submits the embedded prompt as the first user message. When the parent was started with a matching local `-e path/to/index.ts`, that explicit extension path is also passed to the child. Installed-package launches do not add it. Ghostty is permitted to keep the prompt as initial terminal input.

## Design

- No runtime dependencies; only public Pi APIs.
- Startup registers the `/btw` command plus session and agent-settled listeners. Under Herdr, `session_start` starts a factory-local, generation-guarded merge poll loop; `session_shutdown` stops it idempotently. The loop skips child sessions, skips while the parent is busy, and only reads child session files when the main session already has split records, so sessions without splits pay no I/O. Child `agent_settled` and `session_start` events finalize durable merge intents.
- Exactly one pending merge auto-imports; multiple pending merges auto-open the chooser. An unchanged remainder is deferred to manual `/btw merge`, but a newly completed handoff reopens the chooser with all pending items.
- Parent `/btw merge` falls back to merge candidates when no completed handoff is pending. A candidate is a recorded side session with a settled terminal answer after its child marker and latest merge request and no pending intent; already-requested or already-imported children without later side work are skipped. Under Herdr the parent resolves the live child by exact session file (a target stored on the split record at launch, else `herdr agent list` matched on `agent_session.value`) and submits the constant `/btw merge` command. The child authors the handoff and the poll imports it; the raw latest answer is never imported. New split records store their Herdr agent target for later dispatch.
- Uses Pi's session files and custom entries for branch boundaries, child markers, pending merge requests, and processed merge results.
- The side agent authors the handoff; the main session never receives the raw side transcript.
- Merge intents, pending requests, and processed merges are durable in session entries/messages and deduped by request id. Parent import revalidates that the recorded terminal answer follows the intent's exact handoff prompt.
- Multiple pending merges remain selectable with a small TUI chooser.
- On a definite Herdr `agent start` failure after a pane was created, the new pane is best-effort closed and the copied child session is deleted only when that close is definite; ambiguous timeouts or throws retain the child for recovery.
- Removing the package removes the command; existing custom entries become inert and imported handoffs remain ordinary session context.

## Development

From the repository root:

```bash
npm ci --ignore-scripts
npm run check
```

Inspect the publish payload:

```bash
npm pack --workspace @pi-kaush/pi-btw-with-imports --dry-run
```

## License

MIT
