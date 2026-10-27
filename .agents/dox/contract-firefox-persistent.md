# Persistent Firefox browser contract

## API

`createPersistentFirefoxBrowser(options)` accepts the normal Firefox browser options plus `statePath`, `namespace`, `agentId`, and optional `getEpoch`. It returns the normal browser methods, scoped persistent `sessionList` and `sessionCleanup`, and `recoverSession({ session }, { signal? })`.

Storage keys hash the namespace, agent ID, and session name. A record stores verified tab, window, and container IDs; closed and uncertain flags; last-use time; document epoch; safe URL; whether URL data was stripped; and Firefox epoch. It never stores full URLs, refs, or page text.

## Operation and recovery rules

Each `runSession` operation holds its state entry lock through binding hydration, marker creation, browser work, and state commit. A separate in-flight entry is committed before browser work. The binding stores the completed marker ID with the state commit. Cleanup removes only that marker ID. A later operation reconciles a matching leftover marker under the entry lock. An unmatched marker blocks replay and marks the binding uncertain.

The wrapper gets an epoch for each operation. A missing or invalid epoch blocks use. After restart, same-epoch records are revalidated by read-only window and tab listings. The current client trusts a locally proved binding for the same epoch. This preserves in-memory replacement confirmation during `sessionList` and later calls. The wrapper keeps a verified full URL in memory only. A changed epoch closes the saved binding without using its tab ID. A later explicit ensure can create a new binding. Ensure requires the full URL when storage omitted a query or fragment.

Replacement confirmations stay in memory and are not persisted. After a restart, the wrapper never adopts a candidate automatically. If the old seed is gone, the wrapper blocks use and reports an uncertain session for recovery.

`recoverSession` performs only read-only verification. It requires the same epoch and exact tab, window, and container IDs. It refreshes the in-memory URL and clears uncertainty only after verification. It does not adopt another tab or replay a browser action. A missing or orphaned binding cannot be recovered.

Malformed records fail closed and remain untouched. Independent sessions merge through the state store. Lifecycle hydration skips session maps that are active in this client. Firefox control remains limited to the public CLI.

## Tests

`test/persistent.test.ts` uses a temporary state path, an injected epoch, and a fake CLI transport. It checks same-epoch reuse, epoch-change isolation, URL scrubbing, agent scoping, independent-entry merging, pending replacement rejection, marker reconciliation, unknown-epoch failure, and aborted-mutation recovery. It does not use a real browser.
