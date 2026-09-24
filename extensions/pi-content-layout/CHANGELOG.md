# Changelog

## Unreleased

- Restyle the `intercom_message` box even when `pi-intercom` wins Pi's first-registration-wins renderer lookup: a chat-container hook replaces the box Pi built with this package's frame, so the surface no longer depends on `packages` order. The renderer registration stays as the cheaper path when this package loads first.

- Restore Pi's native active editor border and terminal background, so its embedded status interrupts the top rule as in native Pi. Submitted user messages keep their darker railed shell. Older Pi versions keep the aligned transcript-row status fallback.

- Roll back a chat-container hook that mutates the child list and then throws.
  Its edit used to stick, dropping those rows from every later render. The
  contract is shared by copy with pi-tool-call-markers, so both copies changed
  together.

- Pad the submitted-prompt box with two columns on the right of the text so
  it matches the two-column visual gap the quarter-block rail leaves on the
  left; previously wrapped content sat one column off the right edge.

- Reference semantic tokens for the remaining extension-colored elements:
  the intercom sender name rides `customMessageLabel`, the submitted-prompt
  rail rides `borderAccent`, and prompt surfaces paint with `userMessageBg`.
- Paint the prompt surfaces (active editor, submitted prompt) with the
  theme's `customMessageBg` token instead of a hardcoded hex, retiring the
  last fixed color in this package. Falls back to the legacy #071312 only
  for theme lookalikes that cannot resolve the token.
- Paint the `intercom_message` frame in the bash-mode green used for `!`
  shell-block rules, keep all text inside it muted, and render the sender
  name in the `mdHeading` orange. All colors come from theme tokens.

- Restyle pi-intercom's inbound `intercom_message` box onto the shared
  transcript columns (frame border on the marker column, title and body text
  on the text column) and drop the redundant `Ctrl+O expands` title hint.
  Requires this package to load before `pi-intercom`; falls back to Pi's
  default custom-message box for malformed payloads.

- Render active input with the theme's `userMessageText` foreground, restoring
  that base color after embedded ANSI resets while preserving inline identifier
  highlighting.
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
