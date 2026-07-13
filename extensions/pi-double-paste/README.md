# @pi-kaush/pi-double-paste

Paste the same large block twice to expand Pi's compact paste markers into ordinary editable text.

## Why

[Pi](https://pi.dev) keeps its editor readable by collapsing large pastes into markers such as:

```text
[paste #1 +123 lines]
```

That is useful until you need to edit the pasted text. This extension keeps Pi's normal first-paste behavior and treats an identical second paste as a request to expand every current marker.

## Install

After the first npm release:

```bash
pi install npm:@pi-kaush/pi-double-paste@0.1.0
```

For local development:

```bash
pi -e ./extensions/pi-double-paste/src/index.ts
```

## Use

1. Paste a block longer than 10 lines or 1,000 characters.
2. Pi displays its normal compact marker.
3. Paste the same block again within three seconds.
4. The second paste is not duplicated; all current markers become editable text.
5. Pi briefly confirms the expansion with a “Paste expanded.” notification.

Short pastes and non-matching long pastes retain Pi's normal behavior.

## Compatibility

This extension does **not** replace or wrap Pi's input editor. It uses only Pi's public extension APIs:

- `ctx.ui.onTerminalInput()`
- `ctx.ui.getEditorText()`
- `ctx.ui.setEditorText()`

That allows it to compose with custom editors that implement Pi's public editor contract. Extensions that deliberately make every first paste fully expanded have overlapping semantics; double-pasting still means “do not duplicate this content.”

### Minimal impact by design

Adding this extension to an existing Pi setup has negligible runtime impact:

- it does not replace, wrap, or retain the active editor;
- ordinary keystrokes perform only a cheap bracketed-paste check;
- hashing and editor reads happen only for large paste events;
- it stores only short-lived hashes and timestamps, not another copy of pasted content;
- it starts no background tasks, timers, processes, filesystem watchers, or network requests;
- it returns input unchanged except for the confirmed matching second large paste.

The one intentional interaction is that a matching second paste is consumed and the active editor's already-expanded content is written back through Pi's public API. If another extension also consumes that exact paste first, behavior depends on extension load order, but neither extension needs to take ownership of the editor.

Requires Pi 0.80.6 or newer for the initial release.

## Security and performance

The published package contains readable TypeScript and has:

- no runtime dependencies;
- no install scripts;
- no tools or prompt/system-message hooks;
- no filesystem, network, subprocess, environment, clipboard, or model access;
- no telemetry.

Ordinary input takes only a bracketed-paste prefix check. Hashing and editor reads happen only for large paste events.

## Development

From the repository root:

```bash
npm ci --ignore-scripts
npm run check
```

Inspect the exact publish payload:

```bash
npm pack --workspace @pi-kaush/pi-double-paste --dry-run
```

## License

MIT
