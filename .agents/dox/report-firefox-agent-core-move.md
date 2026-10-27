# Firefox Agent Core package relocation

## Goal

Make the harness-neutral library distinct from Pi extensions without creating a separate repository.

## Changes

- Move `extensions/firefox-core` to `packages/firefox-agent-core`.
- Rename `@pi-kaush/firefox-core` to `@pi-kaush/firefox-agent-core`.
- Keep `extensions/pi-firefox` and `@pi-kaush/pi-firefox` unchanged.
- Update the adapter dependency, imports, build commands, repository metadata, documentation links, and executable validation scripts.
- Add `packages/*` to workspace discovery and `packages/**/*.ts` to strict TypeScript coverage.
- Preserve generated-output exclusions and adjust the cross-package boundary test.
- Add a regression test for library identity, dependency wiring, and absence of Pi extension metadata.

Firefox CLI remains an external executable. Browser behavior, permissions, configuration paths, and session storage do not change.

## Validation

- `npm run check` passed: 1,321 Vitest tests passed, one skipped, and 57 Bun tests passed.
- Both Firefox package allowlists passed: 48 core files and seven adapter files.
- Public Node import resolved the new package and exposed all 16 tool descriptors.
- Real read-only CLI health passed through the new package import.
- The old package name returned `ERR_MODULE_NOT_FOUND`; no compatibility alias remains.
- Public Pi-loader interoperability tests passed during the full check.
- `git diff --check` passed.

The initial check stopped at formatting in the renamed README. Formatting was corrected before the complete check passed.

## Lockfile and installation

Only six lockfile entries changed relative to the migration baseline: root workspace metadata, old/new core workspace records, old/new core links, and the Pi adapter dependency. No unrelated entry changed.

The installed Pi extension still points to the same local directory. It requires no reinstall. Reload Pi to load the renamed dependency. No commit, push, publication, browser mutation, or pairing change occurred.
