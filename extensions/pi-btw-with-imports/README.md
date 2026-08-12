# @pi-kaush/pi-btw-with-imports

Fork the current Pi conversation into a right-hand side session and continue working there in parallel.

The extension is intentionally narrow: it supports Herdr and Ghostty, shares the current working directory, and adds no background service or model call of its own. It registers a single `/btw` command.

## Why another side-session workflow?

Pi already has useful primitives for branching and side questions. This extension combines their useful parts for longer parallel work without trying to replace them:

- `/fork` and `/clone` create another conversation path, but you continue by moving the active Pi session to that path.
- BTW-style extensions are excellent for quick questions while the main agent runs, usually through a custom panel or an in-memory side thread.
- `pi-btw-with-imports` creates a normal persisted Pi session in another terminal pane. The main session stays visible and keeps running, while the side gets Pi's normal editor, tools, commands, model, and session history.

That makes it a good fit when the side task is more than a quick question: investigating code, trying an approach, reviewing a change, or iterating through several follow-ups. The side session is a full, independent Pi session; the main session never receives its transcript.

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

The side session is a normal persisted Pi session in a right-hand pane. Work in it as usual; close it manually when finished. There is no merge or import step: the main session never pulls the side transcript back in.

## First-turn splits

`/btw` also works before the main session has been persisted to disk. Instead of refusing, it snapshots the public in-memory session context (`buildSessionContext`) into a normal persisted child, preserving the exact settled boundary and messages before appending the final model and thinking state. Snapshot contexts with compaction or branch summaries are rejected because those resolved messages cannot be appended as ordinary session messages. No pi-vcc, snapshot file, or lossy summary is involved. When the main session is already persisted, the existing exact branch logic is unchanged.

## Requirements and constraints

- **Herdr is the preferred host.** When Pi is running inside the cross-platform [Herdr](https://herdr.dev) multiplexer, `/btw` opens a right-hand Herdr agent split and submits the prompt through a private transport.
- **Ghostty is the fallback.** Outside Herdr, macOS users can open a right-hand [Ghostty](https://ghostty.org) split through its AppleScript API. Ghostty keeps the prompt as initial terminal input. The side pane does not auto-close; close it manually when finished.
- **Other terminals are not supported automatically.** Without an active Herdr session or Ghostty on macOS, `/btw` fails before copying a session. Supporting another terminal requires adapting the small launch boundary in the extension.
- **Conversation isolation is not filesystem isolation.** Main and side sessions share the same working directory and files, so simultaneous edits can affect each other.
- **The side remains a normal Pi session.** Under Ghostty, close it manually when finished. Under Herdr, close the pane or leave it for later; nothing in this extension closes it.
- **Ambiguous launches remain recoverable.** If a host may have opened despite a timeout, the retained child session file is reported in the error notification so it can be opened manually.

Requires Pi 0.80.6 or newer. Ghostty fallback requires macOS, Ghostty AppleScript support, and macOS Automation permission.

## Commands

- `/btw <goal>` forks the conversation and launches a side session with the goal.
- `/btw` lets you choose a previous user message and launches a side session with it.
- `/btw --launch` is internal: the child uses it to dispatch its embedded prompt; it refuses to run outside a side split.

## Private prompt transport

Under Herdr the user prompt never appears in process argv. `/btw` embeds the prompt in a child session marker, starts the child with `pi --session <child-file>`, then submits a constant `/btw --launch` command as the child's first input. The child's `/btw --launch` handler reads the newest marker and submits the embedded prompt as the first user message. When the parent was started with a matching local `-e path/to/index.ts`, that explicit extension path is also passed to the child. Installed-package launches do not add it. Ghostty is permitted to keep the prompt as initial terminal input.

## Design

- No runtime dependencies; only public Pi APIs.
- Startup registers the single `/btw` command. No background loops, listeners that need a session lifecycle, or polling of any kind.
- `/btw` refuses to run inside a side split (no nested side sessions) and waits for the first response to settle before branching a persisted session.
- A split is a normal persisted Pi session: a branch from a settled leaf when the source is persisted, or a snapshot of the in-memory context before the first turn settles. A child marker embeds the side goal so the child can dispatch it without argv exposure.
- On a definite Herdr `agent start` failure after a pane was created, the new pane is best-effort closed and the copied child session is deleted only when that close is definite; ambiguous timeouts or throws retain the child and report its session file.
- Removing the package removes the command; existing side sessions remain ordinary Pi sessions and old custom entries become inert.

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
