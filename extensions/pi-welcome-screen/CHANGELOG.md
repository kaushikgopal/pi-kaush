# Changelog

## Unreleased

- Reserve two internal padding columns on both sides of the welcome layout at normal widths, degrading only when a tiny terminal needs the content space.
- Tint project-scope skills one step brighter on the welcome screen (`muted` instead of `dim`); global, path, and package skills keep the dim default. Scope comes from Pi's expanded Skills listing, degrading to the dim default when it is unavailable.
- Extend the project-scope tint to prompts and context files. Prompt scope comes from Pi's expanded Prompts listing; context files are classified by their display shape, since Pi renders working-directory files as relative paths and everything else as home-abbreviated or absolute paths.
- Show the active theme name next to the Pi version in the brand header, e.g. `v0.84.0 [cobalt2]`.
- Fix resource capture on Pi 0.84, where the loaded-resources panel moved inside a document container; both the nested 0.84 and flat 0.80–0.83 layouts are detected.
- Keep Pi's resource panel mounted for fullscreen scrolling, wait for a complete snapshot, preserve diagnostic and third-party rows, and reconcile native rows rebuilt during `/reload`.
- Warn in the header when Pi's startup layout is unrecognized (`unrecognized Pi layout — using native panel`) instead of degrading silently. Incomplete resource snapshots stay native without being mislabeled as layout failures.
- Check installed package extensions against the npm registry after load: packages pinned behind the latest major (e.g. `^1.20.0` excluding 2.x) turn red, packages behind within range turn yellow, and unresolved or undeclared imports and missing store dependencies are flagged. Rows get a compact `↻ installed→latest` suffix and a notification summarizes the findings once the check settles. Lookups are async, timeout-guarded, and degrade silently offline.
- Stop reading `from "…"` inside string literals as an import in that check, which flagged `@tintinweb/pi-tasks` as having one undeclared import. Multi-line named imports still match.

## 0.1.4

- Show extension filenames for package-backed sources on the welcome screen.
- Shorten pinned Git revisions to six characters.

## 0.1.3

- Add responsive one-, two-, and three-column welcome layouts.
- Center the Pi logo above two-column resources and in a dedicated column on wider terminals.
- Consolidate section rendering and cover uneven grid content with regression tests.
- Update the preview to show every responsive layout.

## 0.1.2

- Summarize the extension's main benefits at the top of the package README.

## 0.1.1

- Add the welcome-screen screenshot to the GitHub and npm package pages.

## 0.1.0

- Add a responsive custom Pi startup header.
- Summarize loaded context, skills, prompts, and extensions.
- Split extensions into local, package, and linked source-path groups.
- Show the full linked source path instead of ambiguous labels such as `src`.
- Restore Pi's native resource panel when startup data cannot be reproduced safely.
