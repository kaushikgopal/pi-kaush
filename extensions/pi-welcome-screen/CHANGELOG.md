# Changelog

## Unreleased

- Add namespaced `welcomeScreen` options in Pi's canonical global and trusted project settings files.
- Show resource counts and split long package lists on very wide terminals, with optional workspace and settings-health details.
- Add a lightweight `[Estimate]` section for model, context window, system-prompt size, and active tools without pretending raw tool schemas equal provider tokens.
- Preserve unrelated startup status and diagnostics while replacing Pi's compact comma-separated resource panel.
- Use asymmetric wide-screen columns so the brand stays compact while extension paths receive more room.
- Support Pi 0.84's regular and fullscreen TUI layouts without recursively traversing Pi's component tree.
- Preserve fullscreen scrolling by keeping Pi's resource-panel container mounted in the scroll document.
- Leave Pi's native panel untouched until a complete replacement snapshot is ready.

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
