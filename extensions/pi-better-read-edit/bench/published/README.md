# Published bench bundles

`bench/published/<runId>/` holds sanitized A/B benchmark reports for the
`pi-better-read-edit` extension. A bundle is created with
`make publish RUN=<runId>` (or `npm run bench -- publish <runId>`) and
contains exactly four files:

- `manifest.json` — run metadata, model matrix, fixture list, and
  per-fixture descriptor/start/expected tree checksums (sha256 per file).
- `results.json` — per-arm metrics: outcome, wall time, tokens, tool
  calls, edit argument bytes, first-edit status, pi-reported model, and
  byte-exact tree diffs (missing/extra/changed paths with sha256 and byte
  counts, relative to the fixture workspace).
- `report.md` — polished markdown summary derived from `results.json`.
- `checksums.txt` — sha256 of the three files above.

Publishing stages the bundle in a temp dir and atomically renames it into
place, so readers never see a partial bundle and re-publishing the same
run replaces it cleanly.

## What is NOT in a bundle

Public bundles are a strict allowlist projection of the private run
record. They never contain protocol events, assistant prose, provider or
tool error strings, stderr output, absolute paths, extension source paths,
or any credential material. `make verify RUN=<runId>` requires the bundle
directory to contain exactly the four files above (extras are rejected),
byte-compares every file — including the regenerated report — against a
fresh computation from `raw.json`, and fails on any tampering.

Published bundles are intended for review and commit to repository history.
Publish never stages, commits, pushes, or uploads anything; adding a bundle
to Git remains an explicit manual step.
