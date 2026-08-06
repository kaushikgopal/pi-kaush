# Changelog

## Unreleased

- Support Pi 0.84's regular and fullscreen TUI layouts.
- Discover the native startup-resource panel recursively instead of assuming a fixed root child index.
- Leave Pi's native panel in place until a complete replacement snapshot is ready.

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
