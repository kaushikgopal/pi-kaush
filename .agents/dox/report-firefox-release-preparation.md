# Firefox release preparation

## Outcome

Both Firefox packages are prepared for their first npm publication. No version was changed. No package was published. No commit, push, GitHub release, npm login, or trusted-publisher change occurred.

Public npm metadata lookups returned E404 for both package names. First publication still requires the owner's npm authentication and browser-based 2FA under the repository's bootstrap policy.

## Changes

- Add `firefox-agent-core-v*` and `pi-firefox-v*` to the release workflow.
- Resolve core from `packages/firefox-agent-core`; keep the adapter under `extensions/pi-firefox`.
- Block adapter releases until npm serves the adapter's declared core dependency range.
- Test release resolution and safety gates through fake Git, npm, GitHub CLI, and jq programs. Tests cannot create real releases or push commits.
- Install both packed artifacts into a private temporary project outside the workspace, offline and without lifecycle scripts or peer installation.
- Verify real installed files, compiled core import, public export/type targets, dependency resolution from inside the installed Pi package, 16 tools, three commands, and the skill file.
- Check dependency compatibility with npm rather than requiring an exact caret range tied to the current core patch version.
- Set the adapter's Node minimum to 22.19.0, matching Pi 1.x.
- Update README installation paths, supported-platform statements, first-release changelog, release guidance, and repository instructions.

The smoke test uses the repository SDK as the Pi host. The installed adapter and core are physical copies from tarballs, not workspace links. No Firefox executable or live browser is needed.

## Validation

`npm run check` passed: 1,368 Vitest tests passed, two existing managed-CLI tests skipped, 57 Bun tests passed, both Firefox package allowlists passed, and the installed-tarball smoke passed. Eleven focused release tests passed. Shell syntax and `git diff --check` passed.

The smoke subprocesses have timeouts. Temporary artifacts and isolated npm configuration/cache are removed after the check. The lockfile changes only the Pi adapter's Node engine requirement.

These changes do not require new browser tests: browser behavior, pairing, and CTC routing remain unchanged. Prior macOS live evidence remains applicable; no new Linux Firefox or Node 20 support claim is made.

## Next release steps

1. Review and commit the preparation changes.
2. Make reviewed source available in the GitHub repository.
3. Follow `.agents/dox/guide-firefox-release.md` to publish core first.
4. Publish the adapter after core is available.
5. Configure each npm trusted publisher for subsequent automated releases.

Do not use `make publish` for first publication: it bumps versions, commits, pushes, and creates a GitHub release. First bootstrap is manual; later releases use the prepared workflow.
