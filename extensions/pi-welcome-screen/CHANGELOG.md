# Changelog

## Unreleased

- Show the active theme name next to the Pi version in the brand header, e.g. `v0.84.0 [cobalt2]`.
- Fix resource capture on Pi 0.84, where the loaded-resources panel moved inside a document container; both the nested 0.84 and flat 0.80–0.83 layouts are detected.
- Warn in the header when Pi's startup layout is unrecognized (`unrecognized Pi layout — using native panel`) instead of degrading silently, so future Pi layout changes get noticed. Expected fallbacks like startup diagnostics stay silent.

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
