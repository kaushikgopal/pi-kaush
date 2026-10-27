# @pi-kaush/pi-btw

Ask a question in a fork of the current Pi conversation with `/btw`.

The extension opens a side session in this order: Herdr, Rex, then Pi's fork fallback. Herdr and Rex open a parallel Pi session in a right-hand pane or block. Without either host, Pi switches to the fork in the current terminal; the original remains saved and can be reopened with Pi's built-in `/resume` command.

The extension has no background service, model call, transcript import, merge protocol, terminal-specific fallback, or Intercom integration.

### Install

```fish
pi install npm:@pi-kaush/pi-btw
```

Restart Pi or run `/reload`.

## Local development

```fish
pi -e ./extensions/pi-btw/src/index.ts
```

## Use

```text
/btw investigate the failing integration test
```

### Inside Herdr

When `HERDR_ENV` is 1, the extension opens an unfocused right-hand pane and submits the question through Herdr. This path takes priority when both Herdr and Rex are available.

If the parent is already responding, `/btw` snapshots the last completed response and starts the side session immediately. It does not wait for the parent to settle.

### Inside Rex

When Herdr is not active, the extension uses Rex if `REX_SESSION` and `REX_BLOCK` are non-empty and an executable `rex` command is available. It opens an unfocused right-hand block and starts Pi with the question as its initial message.

If the parent is already responding, `/btw` uses the same last-completed-response snapshot as the Herdr path.

Run `/btw` again from either host session to create another side fork. Nested or repeated side sessions are allowed.

### Without Herdr or Rex

The extension uses Pi's public fork API to clone the current active branch, switches the current process to that new session, and submits the question. The original session is saved but dormant rather than running in the background.

Use Pi's built-in `/resume` picker to switch back to the original or move among later forks. Repeated `/btw` calls create a chain of independent saved sessions.

## Constraints

- `/btw` requires a non-empty question and an interactive Pi session.
- Herdr and Rex can run while the parent is responding. The side session starts from the checkpoint before the active parent run, so it never includes a partial response or incomplete tool call.
- `/btw` requires at least one completed response. It is rejected in a brand-new session because there is no useful conversation checkpoint to fork.
- Without Herdr or Rex, the current agent must be idle and the conversation must contain an entry to fork.
- Herdr and Rex sessions share the same working directory and files. Simultaneous edits can conflict.
- The question submitted to Herdr or Rex may be briefly visible in local process arguments.
- A Herdr pane or Rex block is retained after startup failure so its terminal can be inspected.
- Rex receives only selected non-secret Pi configuration variables. The extension does not forward credentials.

## Design

The Herdr and Rex paths use Pi's public session APIs:

1. Record the current leaf before each parent agent run.
2. If the parent is busy, create a branched session through that pre-run leaf. Otherwise, let Pi fork the settled session.
3. Open an unfocused right-hand pane or block.
4. Start Pi and submit the question.

The hostless path delegates to `ExtensionCommandContext.fork` with position at, then sends the question through the fresh replacement-session context. It follows Pi's session replacement lifecycle and never reuses stale session objects.

No session JSON is copied or interpreted by the extension. Communication and handoff concerns remain outside it; `pi-intercom` can coordinate concurrently live Herdr or Rex sessions independently.

## Development

From the repository root:

```sh
npm ci --ignore-scripts
npm run check
```

Inspect the publish payload:

```sh
npm pack --workspace @pi-kaush/pi-btw --dry-run
```

## License

MIT
