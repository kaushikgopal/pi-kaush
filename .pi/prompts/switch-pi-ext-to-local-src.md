---
description: Point the global Pi install at a local pi-kaush package for development
argument-hint: "[package-name]"
---

Point the global Pi settings at a local pi-kaush package so edits in the repo are picked up on the next Pi reload.

Known packages: `pi-btw-with-imports`, `pi-double-paste`, `pi-inline-skill-identifier`, `pi-openai-compaction`, `pi-openai-text-verbosity`, `pi-tool-call-markers`, `pi-welcome-screen`.

Run from the pi-kaush repo at `/Users/kg/dev/oss/pi-kaush`.

1. **Determine the package name**.
   - If the first argument `$1` is provided, validate it against the known list and check that `extensions/$1/package.json` exists. Use it as `PACKAGE`.
   - If `$1` is empty, infer the package from the conversation context or recent changes:
     ```bash
     CHANGED=$( { git diff --name-only; git diff --cached --name-only; git ls-files --others --exclude-standard; } | grep '^extensions/' | cut -d'/' -f2 | sort -u )
     ```
     If exactly one package is returned, use it. If none or multiple are returned, ask which package to swap.
   - Report the chosen `PACKAGE` before proceeding.

2. **Ensure dependencies are present**. From the repo root, run `npm install` if `node_modules` is missing or looks stale. This makes sure the package's peer dependencies are resolvable.

3. **Update the global Pi settings** in `~/.pi/agent/settings.json`:
   - Remove any `npm:@pi-kaush/$PACKAGE` entry from the `packages` array.
   - Remove any local path entries in the `extensions` array that point to `~/dev/oss/pi-kaush/extensions/$PACKAGE` or any file inside it (e.g. `src/index.ts`). This avoids double-loading the package.
   - Add the local package directory as a new package source:
     ```json
     "/Users/kg/dev/oss/pi-kaush/extensions/$PACKAGE"
     ```
     Place it in the `packages` array where the npm entry used to be.

4. **Check for overrides**. Look at `/Users/kg/dev/per/aikado/config/pi/agent/settings.personal.json` for any `npm:@pi-kaush/$PACKAGE` or local path entry. If one exists, warn that personal settings may override the global swap and ask whether to remove or unpin it there as well.

5. **Tell the user to reload Pi**. The local package will be loaded on the next Pi start or session reload.

6. **Verify**. After Pi reloads, run `pi list` and confirm the package is loaded from the local path `/Users/kg/dev/oss/pi-kaush/extensions/$PACKAGE`.

When you are done iterating, use `/publish-pi-ext $PACKAGE` to commit the changes, bump the version, publish to npm, and switch the settings back to the npm package.
