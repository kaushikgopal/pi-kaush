# Changelog

## Unreleased

- Allow Herdr `/btw` commands to start while the parent is responding by snapshotting the last completed conversation point.
- Reject `/btw` only when no response has completed yet; the non-Herdr fallback still waits because it replaces the active session.

## 0.1.0

- Rename the package from `@pi-kaush/pi-btw-with-imports` to `@pi-kaush/pi-btw`.
- Use Pi's native `--fork` command for parallel right-hand sessions inside Herdr.
- Fall back to Pi's public fork-and-switch API when Herdr is unavailable; the original session stays saved and can be reopened with `/resume`.
- Allow repeated and nested `/btw` forks from any resulting session.
- Require a non-empty question and a settled parent session.
- Remove Ghostty, previous-message selection, first-turn snapshots, child markers, private launch commands, merge compatibility, and custom session cleanup.
- Keep communication and handoff concerns outside the extension; pi-intercom can coordinate live Herdr side sessions independently.
