# @pi-kaush/pi-split-session

Fork the current Pi conversation into a right-hand side session, continue working there, and import a clean handoff into the main session.

The extension is intentionally narrow: it supports Herdr and Ghostty, shares the current working directory, and adds no background service or model call of its own.

## Install

After the first npm release:

```bash
pi install npm:@pi-kaush/pi-split-session@0.1.0
```

For local development:

```bash
pi -e ./extensions/pi-split-session/src/index.ts
```

## Workflow

Start side work with a prompt:

```text
/split investigate the failing integration test
```

Or run `/split` without arguments to choose a previous user message. The selected prompt is submitted automatically in the side session.

When the side work is ready, run this inside the side session:

```text
/split-handoff
```

The side agent writes a concise final handoff using its own context. Back in the main session, import only that handoff:

```text
/split-import
```

An optional argument starts a main-agent follow-up after queuing the handoff:

```text
/split-import compare this with the current approach
```

For diagnostics, explicitly import the complete text transcript:

```text
/split-import-full
```

Summary and full-transcript imports are tracked separately, while repeated imports of the same format are ignored.

## Terminal behavior

- Inside Herdr, `/split` opens a right-hand Herdr agent split.
- Outside Herdr on macOS, it opens a right-hand Ghostty split through AppleScript.
- Without either supported host, it fails before copying a session.
- Ambiguous launch failures retain an `[unconfirmed]` session in the import chooser so work can still be recovered.

The main and side sessions share the same working directory and files. This extension isolates conversation state, not filesystem changes.

## Commands

| Command                          | Behavior                                                                                           |
| -------------------------------- | -------------------------------------------------------------------------------------------------- |
| `/split [prompt]`                | Fork the conversation and launch a side session. Without a prompt, choose a previous user message. |
| `/split-handoff`                 | Ask the live side agent to prepare its clean final handoff.                                        |
| `/split-import [follow-up]`      | Import the completed handoff and optionally ask the main agent a follow-up.                        |
| `/split-import-full [follow-up]` | Import the full text transcript and optionally ask a follow-up.                                    |

## Design

- No runtime dependencies.
- No startup I/O, subprocesses, model requests, timers, or event listeners; startup only registers commands.
- Uses Pi's session files and custom entries for branch boundaries and import tracking.
- The side agent creates the summary; the main session never receives the side transcript unless `/split-import-full` is invoked.
- Multiple side sessions remain selectable with a small TUI chooser.
- Removing the package removes the commands; existing custom entries become inert and imported handoffs remain ordinary session context.

Requires Pi 0.80.6 or newer. Ghostty fallback requires macOS and Ghostty AppleScript support.

## Development

From the repository root:

```bash
npm ci --ignore-scripts
npm run check
```

Inspect the publish payload:

```bash
npm pack --workspace @pi-kaush/pi-split-session --dry-run
```

## License

MIT
