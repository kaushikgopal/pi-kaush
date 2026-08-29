# Changelog

## Unreleased

- Make mechanical structured-edit defaults optional and normalize bounded JSON-string array encodings before strict validation.
- Explain full-range read authorization in the tool contract and return exact unread ranges after a rejected edit.
- Preserve private failed-edit diagnostics in benchmark runs while keeping published bundles sanitized.

## 0.1.0

- Add coordinated tagged local-text reads and strict hashline edits.
- Add original-coordinate multi-file `PUT`/`CUT` planning with seen-range validation, bounded runtime snapshots, unique-context non-overlap recovery, and fresh post-edit tags.
- Add bounded, untagged resource projections for directories, public URLs, HTML, PDFs, notebooks, archives, SQLite, and GitHub pull requests, with strict input/work caps, pinned adapter snapshots, safe selectors, SQLite paging, and structured truncation metadata.
