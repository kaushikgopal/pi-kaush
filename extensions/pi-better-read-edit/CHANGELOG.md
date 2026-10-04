# Changelog

## Unreleased

- Add an output ceiling for oversized tool results. Results from `bash`, `web_search`, `fetch_content`, and MCP tools above 10k characters keep their head and tail plus a marker naming the recovery path, with the complete text written to a temp file; `structuredContent` is carried through for codemode scripts. `read` and `edit` are exempt, because a read authorizes an edit by the lines it displayed, and nested calls (carrying `parentToolCallId`, such as a codemode script's `tools.bash`) are left untouched so the sandbox keeps its full 1 MiB. Bash results whose stderr was hidden by `2>/dev/null` and that look failed or empty now say so.

- Add exact-text splice fallback: a line edit may anchor by `oldText`/`newText` (unique literal match in the live file) instead of line coordinates, and a splice carrying both `startLine` and `oldText` tries the coordinate path first and falls back to the text match when coordinates are out of bounds, unseen, or unrecoverable. Unique text matches authorize their own target lines; ambiguous or missing anchors fail closed with targeted messages.

- Inherit seen-range display authorization through successful edits: lines outside the changed spans carry their read authorization forward to the edit's anchor, so editing a second unchanged region no longer requires rereading the file first. Stale-recovered edits stay conservative (window-only).
- Make mechanical structured-edit defaults optional and normalize bounded JSON-string array encodings before strict validation.
- Explain full-range read authorization in the tool contract and return exact unread ranges after a rejected edit.
- Preserve private failed-edit diagnostics in benchmark runs while keeping published bundles sanitized.

## 0.1.0

- Add coordinated tagged local-text reads and strict hashline edits.
- Add original-coordinate multi-file `PUT`/`CUT` planning with seen-range validation, bounded runtime snapshots, unique-context non-overlap recovery, and fresh post-edit tags.
- Add bounded, untagged resource projections for directories, public URLs, HTML, PDFs, notebooks, archives, SQLite, and GitHub pull requests, with strict input/work caps, pinned adapter snapshots, safe selectors, SQLite paging, and structured truncation metadata.
