# Changelog

## Unreleased

- Move user-run `!` bash block styling to `@pi-kaush/pi-tool-call-markers`,
  which now owns every execution row (tools, grouping, subagents, thinking
  labels, and bash blocks). This package narrows to the transcript surface:
  message insets, system-text and status-rule alignment, the editor surface,
  and the submitted-prompt shell for user messages. One spacing contract with
  markers remains: bash blocks align at this package's message inset.

- Pad submitted message text two columns right of the accent rail (one extra leading space inside the body) for more breathing room in the chat log.
- Paint the active editor surface and submitted message body with a fixed
  `#071312` background (`PROMPT_SURFACE_BG`) instead of the theme's `selectedBg`
  token, keeping both user-input surfaces identical while the theme token
  continues to serve selections and dialogs.
- Inset dim system status rows (for example `showStatus` reload notices) to the
  shared transcript column via instance-level decoration registered on the
  `kg.pi.chatContainerHooks.v1` hook registry, so the inset composes with
  `pi-tool-call-markers`' grouping wrapper in either load order.
- Add a two-column outer inset to assistant and user transcript rows.
- Render the active editor as a rail-free, edge-to-edge dark surface with one extra horizontal layout column on each side and one background-colored padding row above and below; preserve functional scroll indicators in those rows.
- Render submitted user messages with a thin accent rail and the same darker semantic background behind the padded message body.
- Compose with existing custom editors and preserve Pi's native input, autocomplete, cursor, history, paste, and keybinding behavior.
- Keep autocomplete rows outside the prompt block.
- Add guarded, reversible native message render adapters that fail open to Pi's renderer.
