---
description: Publish a pi-kaush extension via GitHub Actions and refresh the local Pi install
argument-hint: "[package-name] [version]"
---

Publish a new version of a pi-kaush extension.

Known publishable packages: `pi-btw-with-imports`, `pi-double-paste`, `pi-inline-skill-identifier`, `pi-openai-compaction`, `pi-openai-text-verbosity`, `pi-tool-call-markers`, `pi-welcome-screen`.

This is only for packages that already exist on npm with a trusted OIDC publisher. For a first-time release, do a manual `npm publish` with 2FA instead.

Run the entire workflow from the pi-kaush repo at `/Users/kg/dev/oss/pi-kaush`.

1. **Determine the package name**.
   - If the first argument `$1` is provided, use it as `PACKAGE`. Validate it against the known list and check that `extensions/$PACKAGE/package.json` exists; if not, stop and ask.
   - If `$1` is empty, infer the package from local changes:
     ```bash
     CHANGED_PACKAGES=$( { git diff --name-only; git diff --cached --name-only; git ls-files --others --exclude-standard; } | grep '^extensions/' | cut -d'/' -f2 | sort -u )
     ```
     If exactly one package name is returned, use that as `PACKAGE`. If zero or multiple packages appear, show the list of changed packages and ask which one to publish.
   - Report the chosen `PACKAGE` before proceeding.

2. **Inspect and commit local changes**. The `make publish` script requires a clean working tree.
   - Run `git status` and show the short output.
   - If there are uncommitted changes, show the diff. Commit only changes related to this release with a message like `chore: prep for @pi-kaush/$PACKAGE release`. If the diff includes unrelated files, ask whether to commit them or stash them first.
   - If the working tree is already clean, proceed.

3. **Publish the package**. If a version was provided as the second argument (`$2`), run `make publish PACKAGE=$PACKAGE VERSION=$2`. Otherwise, run `make publish PACKAGE=$PACKAGE` to bump the patch version. This runs `npm run check`, commits the version bump, pushes to `main`, and creates a GitHub release. The release triggers the OIDC publish workflow.

4. **Wait for the npm publication**.
   - Read the new version from `extensions/$PACKAGE/package.json` (the `make publish` script already bumped it). Store it as `NEW_VERSION`.
   - Watch the GitHub Actions workflow until it succeeds:
     ```bash
     RUN_ID=$(gh run list --workflow=publish.yml --limit 1 --json databaseId --jq '.[0].databaseId')
     gh run watch "$RUN_ID"
     ```
   - Poll npm until the registry shows the new version:
     ```bash
     npm view @pi-kaush/$PACKAGE version
     ```
     Stop polling once the returned version equals `NEW_VERSION`. Report the published version.

5. **Refresh the local Pi install**. Run:
   ```bash
   pi update npm:@pi-kaush/$PACKAGE
   ```
   If that fails, fall back to `pi update --extension npm:@pi-kaush/$PACKAGE`.

6. **Unpin the package in Pi settings**. Check both:
   - `/Users/kg/dev/per/aikado/config/pi/agent/settings.personal.json`
   - `~/.pi/agent/settings.json`

   For each file that contains an entry for `@pi-kaush/$PACKAGE`:
   - If the entry is a string like `npm:@pi-kaush/$PACKAGE@x.y.z`, change it to `npm:@pi-kaush/$PACKAGE`.
   - If the entry is an object with `source: "npm:@pi-kaush/$PACKAGE@x.y.z"`, remove the version suffix from the source string.
   - If the package is missing entirely from the active personal/global settings, add it as a plain `npm:@pi-kaush/$PACKAGE` entry.
   - Do not modify unrelated entries, and do not remove any local extension path entries (e.g. `~/dev/oss/pi-kaush/extensions/$PACKAGE/...`) unless explicitly asked.

7. **Verify**. Run `pi list` and confirm the package `@pi-kaush/$PACKAGE` is installed. Then read the installed version:
   ```bash
   jq -r '.version' ~/.pi/agent/npm/node_modules/@pi-kaush/$PACKAGE/package.json
   ```
   Confirm it equals the published `NEW_VERSION`.

Stop and ask for confirmation before any commit or push if the diff or command output looks unexpected.
