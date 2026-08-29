# @pi-kaush/pi-better-read-edit

One Pi extension that replaces `read` and `edit` with a coordinated, context-efficient pair. Exact local text reads produce a short version tag and numbered lines; edits use that tag plus compact line operations instead of repeating old source text.

### Install

```fish
pi install npm:@pi-kaush/pi-better-read-edit
```

Restart Pi or run `/reload`.

## Model avoidlist

The better tools are enabled for every model by default. To route models that work better with Pi's native exact-text tools, add `betterReadEdit.avoidModels` to the global `settings.json` in Pi's agent directory (normally `~/.pi/agent/settings.json`):

```json
{
  "betterReadEdit": {
    "avoidModels": ["openai/gpt-4o*", "google/gemini-2-*-flash"]
  }
}
```

Each pattern is matched against both the bare model ID and `provider/model-id`. Matching is anchored and case-insensitive. `*` matches zero or more characters except `/`, `**` also crosses `/`, and `?` matches one character except `/`; every other character is literal. This small glob subset behaves the same on every operating system and requires no glob package. For example, `gpt-4o*` matches that model ID through any provider, `openai/gpt-4o*` can target the provider-qualified name, and `openrouter/**` includes OpenRouter IDs containing `/`.

When a pattern matches, both `read` and `edit` are re-registered from Pi's public built-in tool definitions, including their native schemas and behavior. A nonmatching model receives the coordinated better tools. Routing updates on session start and every model selection; use `/reload` after changing settings when the model does not change.

A trusted project's `.pi/settings.json` may contain the same block. Its `avoidModels` array replaces the global array. Project settings are never read when `ctx.isProjectTrusted()` is false. Invalid blocks are ignored, preserve the valid lower-scope value, and produce a UI warning when a UI is available.

## What it improves

- **One read/edit contract:** the same package mints and validates every edit tag, avoiding a tagged reader paired with an incompatible editor.
- **Less edit context:** structured line splices send changed lines and coordinates, not large `oldText` blocks.
- **Strict stale protection with bounded recovery:** a 16-character visible tag resolves to a full SHA-256 digest on the active session branch. Retained runtime snapshots translate an edit only through unchanged line context that is unique in both the tagged and live versions; changed targets, duplicate context, occupied insertion gaps, unknown tags, and evicted snapshots fail closed.
- **Seen-range authorization:** edits can touch only lines the tagged read actually displayed; appends require a read that reached EOF.
- **Original coordinates:** every operation in a call targets the original snapshot, so earlier operations never shift later line numbers.
- **Safe multi-file preflight:** every target, tag, range, permission, live digest, target count, and aggregate plan size is checked before the first write; canonical-path queues prevent cooperating Pi tools from overwriting one another.
- **Compact edit results:** successful edits return a fresh tag and small changed windows, while per-file diffs and unified patches stay in tool details.
- **Exact bounded text handling:** strict UTF-8, LF/CRLF preservation, explicit terminal-newline control, BOM rejection, and 4 MiB/100,000-line editable snapshot caps.
- **Richer bounded reads:** directories, public URLs, saved HTML, PDFs, notebooks, archives, SQLite, and GitHub PRs are clearly marked, untagged projections with line, byte, truncation, and omission metadata.
- **Resource safety:** adapter inputs are bounded and PDF/archive/HTML/SQLite commands consume private snapshots. URL reads reject private, metadata, cloud-platform, and documentation destinations; validate every redirect; pin validated DNS; forbid HTTPS downgrade; and cap bodies. SQLite allows only bounded ordinary rowid-table views. Archive members reject traversal, duplicate, and noncanonical aliases.
- **Zero runtime dependencies:** it uses public Pi APIs, Pi's `typebox` peer, and Node's standard library.

## Edit format

A local text read returns a header and exact source coordinates:

```text
[src/example.ts#4D3C2B1A9F8E7D6C]
10:export function greet(name: string) {
11:  return `Hello, ${name}`;
12:}
```

Pass the path and tag to `edit` with structured original-coordinate splices:

```json
{
  "files": [
    {
      "path": "src/example.ts",
      "tag": "4D3C2B1A9F8E7D6C",
      "edits": [
        {
          "startLine": 10,
          "deleteCount": 3,
          "newLines": [
            "export function greet(name: string) {",
            "  return `Hi, ${name}`;",
            "}"
          ]
        }
      ],
      "appendLines": [],
      "finalNewline": "preserve"
    }
  ]
}
```

Each splice starts before `startLine`, removes `deleteCount` original lines, then inserts `newLines`:

- Replace lines `N..M` with `startLine: N`, `deleteCount: M - N + 1`, and replacement `newLines`.
- Delete lines with the same coordinates and `newLines: []`.
- Insert before original line `N` with `startLine: N` and `deleteCount: 0`.
- Append `appendLines` at the observed EOF; use `[]` when not appending. A splice at original `lineCount + 1` also appends.
- Put exactly one logical UTF-8 line in each `newLines` or `appendLines` item; embedded CR/LF and invalid surrogate content are rejected.
- Set `finalNewline` to `preserve`, `present`, or `absent`. Changing it requires an exact current snapshot from a read that displayed EOF.

Repeat file entries to edit multiple files. Every splice uses original-snapshot coordinates, so earlier entries never shift later ones. Overlapping ranges, duplicate insertion boundaries, inserts beside changed spans, no-ops, unseen boundaries or lines, and unrecoverable stale files are rejected before writing. Stored calls using the original `script` format are converted before schema validation for session compatibility, but new calls see only the structured schema.

## Read selectors and projections

`read` keeps Pi's `path`, `offset`, and `limit` for ordinary local text, and adds `selector` plus `ranges`. Projection routes use selectors and reject `offset`/`limit` rather than silently ignoring them.

```text
selector: 20-40
ranges: 5-10,80+12,200-
path: src/example.ts:20-40
```

Selectors support `N`, `N-M`, `N+K`, `N-`, and comma-separated ranges. `selector` and `ranges` are mutually exclusive except for SQLite, where `selector` names the table/row and `ranges` selects lines from the rendered result. `offset`/`limit` cannot be combined with either selector form. Use `selector: raw` for an untagged local or URL response.

Projection routes include:

- directories;
- article-like public URLs and local HTML, using Defuddle when installed;
- PDFs through `pdftotext`;
- `.ipynb` notebook cells;
- ZIP and TAR listings or streamed members;
- bounded ordinary SQLite rowid-table and numeric-rowid views through `sqlite3 -safe -readonly`;
- GitHub pull-request URLs through `gh`.

Projection output never authorizes an edit. Optional command-line adapters must already be installed. Their stdout is stopped at a 2 MiB extraction cap before Pi's normal output truncation. Local exact/projection inputs use explicit byte and line caps, directory enumeration stops at 500 entries, SQLite inputs stop at 64 MiB, offsets stop at 10,000, and active SQLite WAL files are refused rather than copied inconsistently.

## Structure

The package is one install with small internal modules:

```text
pi-better-read-edit/
├─ src/
│  ├─ index.ts                 routes and registers the paired read/edit tools
│  ├─ settings.ts              trusted global/project avoidlist loading
│  ├─ model-routing.ts         portable model glob matching
│  ├─ read/
│  │  ├─ tool.ts               Pi read tool and built-in fallback
│  │  ├─ local-text.ts         exact tagged local-text snapshots
│  │  ├─ artifacts.ts          bounded projection routing
│  │  ├─ bounded.ts            descriptor-based bounded regular-file reads
│  │  ├─ safe-url.ts           DNS/redirect/body URL safety
│  │  ├─ selectors.ts          line and inline selector parsing
│  │  └─ commands.ts           optional CLI adapters
│  ├─ edit/
│  │  ├─ input.ts              structured schema and legacy-call normalization
│  │  └─ tool.ts               preflight, queues, writes, diffs, fresh tags
│  └─ hashline/
│     ├─ contract.ts           digest, metadata, UTF-8/EOL rules
│     ├─ registry.ts           active-branch snapshot lookup
│     ├─ parser.ts             legacy PUT/CUT session-call compatibility
│     ├─ apply.ts              original-coordinate planning
│     ├─ recovery.ts           unique-context operation translation
│     ├─ snapshot-store.ts     bounded session-runtime text history
│     └─ render.ts             numbered reads and changed windows
├─ bench/                   extension-local A/B harness (see below)
├─ test/
├─ README.md
├─ CHANGELOG.md
└─ package.json
```

## Local development

From this repository:

```fish
pi install ./extensions/pi-better-read-edit
```

Or load the live source for one run:

```fish
pi -e ./extensions/pi-better-read-edit/src/index.ts
```

Restart Pi or run `/reload` after changing the configured package.

## Bench: better vs builtin

An extension-local A/B harness compares these tools against Pi's built-in `read`/`edit` on exact fixture edits (two-splices, repeated context, two files, large delete). Every arm gets a fresh workspace plus a private 0700 `PI_CODING_AGENT_DIR` in the system temp dir; `auth.json`/`models.json`/`models-store.json` are copied in with 0600 permissions (never symlinked, contents never read), and a forced `settings.json` keeps `betterReadEdit.avoidModels` empty so an avoidlist cannot silently route the better arm to builtin. Tree scoring is byte-exact over the complete workspace.

**This is not an OS sandbox:** models run as your user and can read/write beyond the scratch workspace — benchmark only models you trust, and don't run the bench concurrently with an interactive Pi session on the same agent dir. The harness ships in the npm package too, so installed users can `npm run bench` from the extension directory. See `bench/README.md` for the full contract.

```fish
make bench                    # full default run (4 models x 4 fixtures x 2 arms)
make bench-quick              # one-fixture smoke run
make publish RUN=<runId>      # sanitized, checksummed public bundle
make report RUN=<runId>       # regenerate report.md from raw.json
make verify RUN=<runId>       # independent re-check of run + bundle
```

Equivalently `npm run bench -- <flags>` (`--model`, `--fixture`, `--trials`, `--seed`, `--timeout`, `--max-calls`, `--dry-run`, `--help`). Bench source is Node/Bun MJS with no runtime dependencies, covered by Vitest tests under `bench/tests/`; generated results live under `bench/runs/` (gitignored) and published bundles under `bench/published/`. The npm tarball ships only the bench runtime, fixtures, and READMEs — never the tests or generated runs.

## Migrate from read-plus or unified-edit

1. Remove or disable every other extension that registers `read` or `edit`; tool override order must not decide which contract is active.
2. Install this package and restart Pi or run `/reload`.
3. Reread files before editing. Tags from `unified-edit-anchor/v1`, old `DEL` envelopes, exact-text `edits[]`, and apply-patch payloads are intentionally incompatible.
4. After the paired read/edit smoke test succeeds, delete the superseded extension sources and tests.

## Deliberate limits

- **Recovery needs a retained runtime snapshot:** exact tagged edits still work after resume/reload from active-branch metadata, but stale recovery requires the original full text to remain in this extension instance's bounded memory store. Evicted or pre-reload snapshots fail and require a reread.
- **Conservative sibling handling, not Atomic batching:** concurrent edits sharing one tag serialize and can both succeed only when each target maps through unique unchanged context. Same-boundary insertions, nearby changes, duplicate context, and overlaps fail instead of being reordered or grouped into a custom batch.
- **Preflight, not transactions:** multi-file validation completes before writing, but an operating-system write failure can still cause a partial commit; the error names committed files and treats the failing target as potentially modified.
- **External writers are not locked:** each target is reverified immediately before writing, but processes outside Pi's mutation queue can still race in the final filesystem write window.
- **Hard links stay untagged:** files with multiple hard links are read through Pi's ordinary fallback and rejected by hashline edit, because separate aliases cannot share every cooperating tool's path queue.
- **Read/edit only:** search and write do not mint tags. Overriding those independent Pi/FFF tools solely for store parity would make this package less composable; they can join later if Pi exposes a shared public snapshot seam.
- **No fuzzy modes:** stale recovery maps requested operations through unique unchanged neighboring context; it does not apply a generic patch. There is no apply-patch fallback, exact-text replacement mode, syntax-block selector, register, move operation, or heuristic tag repair.
- **No persisted overflow or cursor subsystem:** projections report structured truncation counts; oversized adapter output fails at its process cap rather than maintaining a second session-storage lifecycle or returning a cursor that cannot preserve representation mode.
- **Strict resource subset:** URL ports are limited to standard HTTP/HTTPS, free-form SQLite queries and non-rowid/virtual/view tables are disabled, SQLite offsets are capped, and archive members must resolve to one canonical literal path in a pinned archive snapshot.
