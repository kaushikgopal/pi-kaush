# Changelog

## 0.1.2

- Support Herdr 0.7.5 by creating the pane with `herdr pane split` before starting the Pi agent with `herdr agent start --kind pi --pane <id>`.
- Replace obsolete `--workspace`, `--tab`, and `--split` options that Herdr 0.7.5 removed.
- Retain the copied session as an unconfirmed record when a pane exists but the agent start fails or cannot be parsed.

## 0.1.0

- Fork Pi conversations into Herdr or Ghostty side sessions.
- Generate clean handoffs in the side agent and import them into the main session.
- Support explicit full-transcript imports and lightweight selection across multiple splits.
- Preserve recoverability for ambiguous terminal launches.
