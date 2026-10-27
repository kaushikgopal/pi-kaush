# Phase 1B review and resolution

## Reviewed boundary

Review covered the new session controller, public CLI parsers, bounded summary helper, and Pi confirmation adapter. It did not exercise private windows or change browser permissions.

## Material findings resolved

1. **Snapshot target was unchecked.** The original fixture returned a snapshot for tab/window 999 while tests expected a successful owned-page read. The reader now validates title and snapshot target identities before returning content. It revalidates current tab state after the reads. A mismatched target fails without returning page data.
2. **Pending confirmation ignored new expectations.** Ensure returned a pending candidate before checking explicit window/container requests. It now rejects a conflicting window, container, or URL before any prompt. Regression tests verify the requests cannot adopt a different destination.
3. **Nonzero mutation exits did not poison the binding.** Navigation and close could return failure while leaving further operations available. The controller now marks ambiguous outcomes uncertain and never retries the mutation. Close also checks its returned tab ID. A failed-navigation fixture proves a later go cannot repeat the action.

## Additional integration fixes

- Separate the blank seed's actual cookie store from the requested destination. Initial routing without a requested container can produce a different verified candidate, but still needs human approval. Explicit destination conflicts fail closed.
- Copy pending approval evidence before returning it. Mutation of a public confirmation cannot change private evidence.
- Recheck confirmation expiry after asynchronous readiness checks.
- Recreate externally closed bindings only through an explicit ensure.
- Prevent reads from treating a default blank seed as an unfulfilled nondefault destination.
- Remove raw requested URLs from mismatch recovery data. Query strings must not leak through error results.
- Use unknown JSON records and own-property checks at parser boundaries.

## Validation and remaining limits

Focused core/adapter tests and the live default-container smoke pass. The live smoke invokes tools through the public Pi loader and checks independent session overlap and exact cleanup. CTC routing/cookie metadata was tested earlier with owner-confirmed candidate tabs; the final Pi dialog path is covered by adapter tests, not a live terminal UI test.

Sessions remain in memory. Restart recovery, durable ownership, cross-process scheduling, full read modes, and action tools are not implemented. Private-window access remains disabled by owner decision. Node 20 execution remains untested locally.
