# Exec plan: pi-better-read-edit

## Goal and why

Build one small, local-first Pi package named `@pi-kaush/pi-better-read-edit` that overrides Pi's `read` and `edit` tools as a coordinated pair. It should preserve the useful resource-reading routes from Aikado's `read-plus`, add strict context-efficient hashline editing, and supersede the dormant `unified-edit` implementation without importing Atomic's runtime or maintaining multiple extensions.

The package should stay on Pi's public extension APIs, have no installed runtime dependencies, reject unsafe or stale edits rather than guess, and retain Pi-standard diff details and mutation coordination.

## Work packages

### 1. Establish the package contract

- [x] Record the current repository and external-repository worktree state; preserve unrelated changes.
- [x] Define the tagged-read contract, strict edit grammar, eligibility rules, session restoration metadata, and failure semantics.
- [x] Create the package skeleton and document its internal structure and succinct improvement list in its README.

### 2. Deliver coordinated better read + hashline edit

- [x] Implement rich read routing for ordinary files, ranges, article-like URLs/HTML, PDFs, archives, SQLite, notebooks, and GitHub PR URLs.
- [x] Implement collision-aware SHA-256 hashline snapshots with 16-character visible tags, seen-range authorization, and branch restoration when the live file digest still matches.
- [x] Implement a concise strict edit language (`PUT` and `CUT`) using original-snapshot coordinates, overlap rejection, multi-file preflight, sorted mutation queues, and fresh post-edit tags/windows.
- [x] Return Pi-standard diff details (`diff`, `patch`, `firstChangedLine`) and avoid alternate legacy grammars, fuzzy matching, registers, syntax blocks, or heuristic stale recovery.

### 3. Prove behavior and interoperability

- [x] Add focused tests for tagged reads, selectors, stale/collision rejection, unseen ranges, inserts/replacements/cuts, original-coordinate multi-hunk edits, overlap rejection, CRLF handling, multi-file preflight, session restoration, and ordinary non-text reads.
- [x] Add package checks and run the smallest focused validation while iterating.
- [x] Run the repository-wide `npm run check` before claiming completion.

### 4. Migrate and retire superseded local extensions

- [x] Switch Aikado's configured `read-plus` symlink/configuration to the new local package only after validation.
- [x] Remove the superseded Aikado `read-plus` implementation, anchored-read helper, and migrated tests without touching unrelated Aikado work.
- [x] Remove the dormant `agent-stuff` unified-edit implementation and migrated tests without touching its existing commits.
- [x] Update relevant package/repository documentation and report the required `/reload` step.

### 5. Close validated Atomic parity and resource-safety gaps

- [x] Classify the supplied findings as already addressed, deliberate scope, or genuine gap and record the resulting decisions.
- [x] Add a bounded session-runtime snapshot store plus conservative operation-aware recovery for retained non-overlapping stale/sibling edits; keep duplicate, ambiguous, same-gap, or overlapping drift fail-closed.
- [x] Bound local/resource input work, tighten URL/SQLite/selector/archive handling, and make projection truncation metadata accurate without an unsafe continuation cursor.
- [x] Add focused recovery, concurrency, resource-security, and bounds regression tests; rerun package and repository validation.

## Validation

- `pi-better-read-edit`: 51 focused tests passed, including the reproduced duplicate-context, same-gap sibling, EOL-collision, FIFO, URL, SQLite, TAR-alias, and truncation-metadata regressions.
- Package dry run passed with 20 reviewed files and zero runtime dependencies; the package is linked in the workspace lockfile.
- Full `npm run check` passed in `pi-kaush`: 31 Vitest files / 475 tests, typecheck, formatting, and every workspace package check.
- Aikado's relevant reconciliation suites passed: 17 tests. Its broader config suite had 131 passes and one unrelated pre-existing `poll-olive` failure caused by the live adjacent config.
- `agent-stuff` has no tests after retiring its only tested extension; `npm pack --dry-run` confirmed no unified-edit files remain.
- `pi list` resolves `pi-better-read-edit` from the local checkout, and `git diff --check` passed in all touched repositories.

## Unresolved blockers

- No unresolved implementation blocker. Unrelated modifications remain in `pi-kaush` and Aikado and must be preserved.
- Multi-file filesystem writes cannot be fully transactional through Pi's public APIs. The implementation preflights every target and clearly reports any rare partial I/O failure.
- Search/write snapshot integration would require overriding otherwise independent Pi/FFF tools; this remains outside the clean paired-extension boundary unless those tools later expose a shared public snapshot seam.
- The current Pi process still has its startup tool set; run `/reload` (or restart Pi) before using the newly configured package.

## Decision log

- **2026-08-21 — One package, modular source.** A single install should own both tools, while small internal modules keep the implementation testable and deletable.
- **2026-08-21 — Strict safety over recovery magic.** Use full SHA-256 identity, collision-aware visible tags, seen-range authorization, and hard stale rejection; omit fuzzy or heuristic recovery.
- **2026-08-21 — Concise grammar only.** Support `PUT` and `CUT` in original read coordinates. Do not carry forward row scripts, apply-patch compatibility, registers, tree-sitter blocks, or multiple edit modes.
- **2026-08-21 — Preserve rich reads selectively.** Tag only exact local UTF-8 text reads. Resource reads, directories, binary/image outputs, and truncated/ambiguous reads remain ordinary and cannot authorize edits.
- **2026-08-21 — No Atomic/OMP runtime dependency.** Implement against public Pi APIs with zero runtime dependencies; avoid Bun/native coupling and copied Atomic integration code.
- **2026-08-21 — Adopt Atomic's shared-contract lesson, not its whole engine.** The initial store is shared by this package's `read` and `edit` overrides and keyed by canonical path plus full digest. Search/write integration remains a later extension because overriding unrelated tools would expand the package and interoperability risk.
- **2026-08-21 — Deterministic stale failure instead of drift recovery.** V0.1 does not attempt Atomic's three-way stale recovery or sibling batching. Per-path queues prevent lost updates; the first valid sibling may succeed and later siblings safely fail stale with reread guidance. This is smaller and safer than heuristic recovery, but intentionally less capable for concurrent non-overlapping changes.
- **2026-08-21 — Strict no-op rejection.** Byte-identical plans fail before writing rather than maintaining session state for Atomic's warn-once/escalate behavior.
- **2026-08-21 — Harden projection reads before advertising them.** URL reads must reject private/metadata destinations, pin validated DNS, validate redirects, cap bodies, and reject non-2xx responses. SQLite exposes a bounded read-only subset; archive members are streamed only after lexical traversal checks. Projection reads never mint edit tags.
- **2026-08-21 — Fail closed on hard links.** Multiply linked files remain ordinary untagged reads and cannot be hashline-edited because distinct aliases cannot participate in every path-based Pi mutation queue.
- **2026-08-22 — Reassess strict stale failure after Atomic audit.** The original v0.1 choice was safe but left a validated capability gap. Add bounded in-memory base snapshots and translate only the requested operations through unchanged context that is unique in both tagged and live text. Generic patch relocation, duplicate context, changed targets, and occupied insertion gaps fail closed.
- **2026-08-22 — Keep the extension boundary narrow.** Do not override search/write solely to claim store parity. Preserve FFF and Pi interoperability; document that only this package's read/edit producers share recoverable snapshots.
- **2026-08-22 — Bound work, not only output.** Regular local reads, logical line counts, scripts, selectors, URL/command buffers, and external-adapter inputs all need pre-allocation/input caps. Prefer bounded failure and accurate truncation metadata over maintaining persisted overflow or returning a cursor that cannot preserve the projection mode.
- **2026-08-22 — Pin external-adapter inputs.** PDF, archive, HTML, and SQLite adapters consume owner-private snapshots made from one bounded descriptor read. Active SQLite WAL files are refused, and SQLite is restricted to ordinary rowid tables with engine length/opcode limits.
- **2026-08-22 — Remove misleading recovery and continuation primitives.** Generic zero-fuzz patches can still relocate edits through duplicate context, and a bare line continuation loses raw/resource mode. Replace the patch with unique-context operation mapping and omit cursors until Pi exposes a representation-preserving contract.
- **2026-08-22 — Both supplied findings were valid against the predecessor.** `read-plus` had producer-only tags and weaker resource guards. The paired extension now closes the read/edit contract and prioritized URL, SQLite, archive, adapter, input-work, and metadata gaps; search/write store integration remains a deliberate composability limit rather than an unaddressed safety claim.
