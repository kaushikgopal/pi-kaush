# pi-content-layout

A small Pi extension that insets the main conversation, leaves the active editor in Pi's native style, and gives submitted prompts a compact rail shell.

### Install

```fish
pi install npm:@pi-kaush/pi-content-layout
```

Restart Pi or run `/reload`.

```text
Assistant output
  Text wraps inside the inset width.

Active prompt (native Pi border and terminal background)
── ⠋ Working ───────────────────────────────────
 prompt text
────────────────────────────────────────────────

Submitted prompt
  ▎                                            darker background
  ▎ prompt text                                darker background
  ▎                                            darker background
```

Assistant and submitted-message content keep the two-column outer inset. The active prompt uses its editor's native border, terminal background, and padding. Pi embeds its status indicator in the top border when supported. The submitted prompt keeps Pi's message padding, with the thin rail outside its darker body.

## Scope boundary

This package owns the transcript **surface**: the message inset, system-text
and status-rule alignment, the editor surface, and the submitted-prompt
shell for user messages. It deliberately never renders tool execution rows
today: collapsed tool calls, grouping, subagent plans, thinking labels, and
user-run `!` bash blocks all live in `@pi-kaush/pi-tool-call-markers` (which
also owns the rail shell those blocks use).

The one cross-package contract is spacing: `!` blocks align with message
text at this package's message inset, so `pi-tool-call-markers` mirrors
`contentInset` for its bash blocks (see its `src/bash-block.ts`). Change
indentation in both packages together.

## Queued steering previews

Pi renders queued `Steering:` messages in the native `dim` color. This package
uses the optional `steeringMessage` foreground token when the active theme
defines it; otherwise, it preserves Pi's native `dim` color. Other queued
rows and the dequeue hint stay native.

Add the token to a theme's `colors` map to choose the preview color:

```json
{
  "colors": {
    "steeringMessage": "mauve"
  }
}
```

## pi-intercom message surface

When [`pi-intercom`](https://www.npmjs.com/package/pi-intercom) is installed,
this package restyles its inbound `intercom_message` box onto the shared
transcript columns: the frame's left border sits on the tool-marker column
(the outer inset), and the `From:` title and body text share the text column
used by tool rows and Thought labels. The frame borrows the bash-mode green
of `!` shell-block rules, all text inside stays muted, and the sender name
uses the `mdHeading` orange (the Thought-label hue in cobalt2 and Pi's stock
themes). The redundant
`Ctrl+O expands` title hint is dropped (the meta line inside the box keeps
`Ctrl+O to expand`). Content is unchanged, and expanded view keeps
pi-intercom's full body, attachment, and reply sections.

Pi resolves custom message renderers in extension load order (first
registration wins), so list this package before `pi-intercom` in `packages`
for the restyle to take effect. Without pi-intercom installed the
registration is inert; malformed message payloads fall back to Pi's default
custom-message box.

## Manual configuration

If you manage Pi package sources directly, add the package to `settings.json`:

```json
{
  "packages": ["npm:@pi-kaush/pi-content-layout"]
}
```

## Theme ownership

The active editor uses Pi's native terminal background (light with a light theme, dark with a dark theme). Submitted message bodies paint with the theme's `userMessageBg` token, and their rails use `borderAccent`.

Themes control colors; this extension controls transcript spacing and the submitted-prompt shape.

## Composition and compatibility

The editor factory wraps the currently configured custom editor, or creates Pi's `CustomEditor` when none exists. It preserves the editor's native rendering and input behavior. The wrapper only prevents transcript-specific status indentation from affecting a status embedded in the editor border.

The default editor opts into Pi's `embedWorkingStatus` behavior when the host supports it, so status indicators interrupt the active prompt's top border. Older Pi versions keep the separate status row, which this package still aligns with the transcript.

Pi does not currently expose public renderers for native user and assistant messages or queued steering previews. Their layout and styling use guarded adapters around Pi's exported components. The adapters restore the original renderers on shutdown and fall back to native rendering when the expected component shape changes.

For the complete visual system, combine this package with:

- `@pi-kaush/pi-footer-minimal` for matching footer inset and footer working state; and
- `@pi-kaush/pi-tool-call-markers` for unboxed tool rows, subagent plans, thinking markers, and user-run `!` bash blocks.

## License

MIT
