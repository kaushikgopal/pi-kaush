# Changelog

## Unreleased

- Add a content-ambiguity guard: a coordinate splice whose target lines' exact content appears more than once in the file is rejected (a line number cannot prove which occurrence was meant), with the error directing the model to widen the span or anchor by oldText. Dual splices fall back to their text match instead. Fixtures showed models silently editing the wrong twin among repeated lines.

- Add exact-text splice fallback: a line edit may anchor by `oldText`/`newText` (unique literal match in the live file) instead of line coordinates, and a splice carrying both `startLine` and `oldText` tries the coordinate path first and falls back to the text match when coordinates are out of bounds, unseen, or unrecoverable. Unique text matches authorize their own target lines; ambiguous or missing anchors fail closed with targeted messages.

- Inherit seen-range display authorization through successful edits: lines outside the changed spans carry their read authorization forward to the edit's anchor, so editing a second unchanged region no longer requires rereading the file first. Stale-recovered edits stay conservative (window-only).
- Make mechanical structured-edit defaults optional and normalize bounded JSON-string array encodings before strict validation.
- Explain full-range read authorization in the tool contract and return exact unread ranges after a rejected edit.
- Preserve private failed-edit diagnostics in benchmark runs while keeping published bundles sanitized.

## 0.1.0

- Add coordinated tagged local-text reads and strict hashline edits.
- Add original-coordinate multi-file `PUT`/`CUT` planning with seen-range validation, bounded runtime snapshots, unique-context non-overlap recovery, and fresh post-edit tags.
- Add bounded, untagged resource projections for directories, public URLs, HTML, PDFs, notebooks, archives, SQLite, and GitHub pull requests, with strict input/work caps, pinned adapter snapshots, safe selectors, SQLite paging, and structured truncation metadata.
