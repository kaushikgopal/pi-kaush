# pi-content-layout

A small Pi extension that insets the main conversation, renders the active editor as a full-width dark surface, and gives submitted prompts a compact rail shell.

```text
Assistant output
  Text wraps inside the inset width.

Active prompt
████████████████████████████████████████████████
  prompt text                        darker background
████████████████████████████████████████████████

Submitted prompt
  ▎                                            darker background
  ▎ prompt text                                darker background
  ▎                                            darker background
```

Assistant and submitted-message content keep the two-column outer inset. The active prompt intentionally ignores that inset: its darker background fills the terminal width, with no rail, one extra layout column on each side of Pi's configured editor padding, and one background-colored row above and below the content. Real scroll indicators replace the corresponding padding row when needed. The submitted prompt remains unchanged: it keeps Pi's message padding and the thin rail outside its darker body. Autocomplete stays outside the active surface.

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

## Install

```json
{
  "packages": ["npm:@pi-kaush/pi-content-layout"]
}
```

The package is not published while its version is `0.0.0`; use the repository path for local development.

## Theme ownership

The active editor surface and submitted message body paint with a fixed
near-black `#071312` background (`PROMPT_SURFACE_BG`) so both user-input
surfaces stay identical; the theme's `selectedBg` token continues to serve
selections and dialogs. Active input uses the theme's `userMessageText`
foreground and restores it after embedded ANSI resets without overriding
inline identifier colors. The extension also consumes `accent` for the
submitted-prompt rail and `muted` for editor scroll hints.

Themes control colors, while this extension controls width and component
shape; a theme cannot provide the layout itself.

## Composition and compatibility

The editor factory wraps the currently configured custom editor, or creates Pi's `CustomEditor` when none exists. It decorates `render()` only; text handling, callbacks, autocomplete, history, paste, application keybindings, image paste, and extension shortcuts remain on Pi's editor.

Pi does not currently expose public renderers for native user and assistant messages. Their side inset and submitted prompt shell therefore use guarded prototype adapters around Pi's exported components. The adapters are idempotent, restore the original renderers on shutdown, and fall back to native rendering if the runtime shape changes.

For the complete visual system, combine this package with:

- `@pi-kaush/pi-footer-minimal` for matching footer inset and footer working state; and
- `@pi-kaush/pi-tool-call-markers` for unboxed tool rows, subagent plans, thinking markers, and user-run `!` bash blocks.

## License

MIT
