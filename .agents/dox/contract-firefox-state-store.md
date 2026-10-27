# Firefox state-store contract

## API

`createFirefoxStateStore({ path, lockTimeoutMs? })` uses `path` as a private JSON file. `withEntry(key, operation, { signal? })` holds a process lock for that key across the callback and merged write. The callback receives a cloned entry or `undefined`, then returns `{ entry, result }`. Set `entry` to `undefined` to remove the key. `list({ signal? })` returns a cloned map of all entries.

State supports JSON values only. Each entry is capped at 256 KiB. The index is capped at 1 MiB. Lock waits default to five seconds and accept values through 120 seconds. Errors use `FirefoxStateError` with stable codes, including `aborted`, `invalid_key`, `invalid_state`, `malformed_state`, `state_too_large`, `unsafe_path`, `lock_timeout`, and `lock_owner_unknown`. Error messages do not include state values or paths.

## Safety and caveats

The store uses standard Node APIs, 0600 state files, a 0700 lock directory, per-key locks, short global merge locks, and atomic temp-file renames. It rejects symlinks, unsafe ownership, malformed JSON, oversized files, and invalid state. It never replaces malformed state.

A lock is reclaimed only when OS metadata proves its PID is gone or its start identity changed. Unknown owners fail safely. A process killed during stale-lock reclamation can leave an unverifiable marker; do not remove it by age alone. Callbacks are not forcibly interrupted. The store checks abort signals before reading, before writing, and while waiting for locks.

`getLocalFirefoxEpoch()` returns a SHA-256 hash of one same-user Firefox PID and process start identity, or `null` when the process is missing, ambiguous, unavailable, or the OS is unsupported. It reads process metadata only. The epoch does not grant browser-control access. Firefox `doctor --json` does not provide a browser-instance identifier.

## Tests

`test/state-store.test.ts` uses real child processes to check same-key exclusion, overlapping independent keys without lost updates, and dead-owner recovery. It also checks that malformed state and symlink targets are not overwritten. `test/browser-identity.test.ts` checks the bounded hash-or-null result.
