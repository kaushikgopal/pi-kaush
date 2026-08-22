# @pi-kaush/pi-better-read-edit

One Pi extension that replaces `read` and `edit` with a coordinated, context-efficient pair. Exact local text reads produce a short version tag and numbered lines; edits use that tag plus compact line operations instead of repeating old source text.

## What it improves

- **One read/edit contract:** the same package mints and validates every edit tag, avoiding a tagged reader paired with an incompatible editor.
- **Less edit context:** `PUT` and `CUT` send changed lines and coordinates, not large `oldText` blocks.
- **Strict stale protection with bounded recovery:** a 16-character visible tag resolves to a full SHA-256 digest on the active session branch. Retained runtime snapshots translate an edit only through unchanged line context that is unique in both the tagged and live versions; changed targets, duplicate context, occupied insertion gaps, unknown tags, and evicted snapshots fail closed.
- **Seen-range authorization:** edits can touch only lines the tagged read actually displayed; appends require a read that reached EOF.
- **Original coordinates:** every operation in a call targets the original snapshot, so earlier operations never shift later line numbers.
- **Safe multi-file preflight:** every target, tag, range, permission, live digest, target count, and aggregate plan size is checked before the first write; canonical-path queues prevent cooperating Pi tools from overwriting one another.
- **Compact edit results:** successful edits return a fresh tag and small changed windows, while per-file diffs and unified patches stay in tool details.
- **Exact bounded text handling:** strict UTF-8, LF/CRLF preservation, terminal-newline preservation, BOM rejection, and 4 MiB/100,000-line editable snapshot caps.
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

Pass that header back to `edit` in `script`, followed by one or more operations:

```text
[src/example.ts#4D3C2B1A9F8E7D6C]
PUT 10.=12:
+export function greet(name: string) {
+  return `Hi, ${name}`;
+}
PUT <10:
+// Public greeting helper.
CUT 20.=22
```

Supported operations:

- `PUT N.=M:` replaces inclusive original lines `N..M` with the following `+` rows.
- `PUT <N:` inserts `+` rows before original line `N`.
- `PUT >N:` inserts `+` rows after original line `N`.
- `PUT >$:` appends `+` rows after a tagged read that reached EOF.
- `CUT N.=M` deletes inclusive original lines `N..M`.
- A bare `+` inserts a blank line.

Repeat `[path#TAG]` sections to edit multiple files in one call. All operations use original-snapshot coordinates. Overlapping ranges, duplicate insertion boundaries, inserts beside changed spans, empty `PUT` bodies, no-ops, unseen lines, and unrecoverable stale files are rejected before writing. A successful recovery is explicit in the result warnings and diff.

## Read selectors and projections

`read` keeps Pi's `path`, `offset`, and `limit` for ordinary local text, and adds `selector` plus `ranges`. Projection routes use selectors and reject `offset`/`limit` rather than silently ignoring them.

```text
selector: 20-40
ranges: 5-10,80+12,200-
path: src/example.ts:20-40
```

Selectors support `N`, `N-M`, `N+K`, `N-`, and comma-separated ranges. For ordinary projections, `ranges` takes precedence over a line `selector`. For SQLite, `selector` names the table/row and `ranges` selects lines from the rendered result. Use `selector: raw` for an untagged local or URL response.

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
│  ├─ index.ts                 registers the paired read/edit overrides
│  ├─ read/
│  │  ├─ tool.ts               Pi read tool and built-in fallback
│  │  ├─ local-text.ts         exact tagged local-text snapshots
│  │  ├─ artifacts.ts          bounded projection routing
│  │  ├─ bounded.ts            descriptor-based bounded regular-file reads
│  │  ├─ safe-url.ts           DNS/redirect/body URL safety
│  │  ├─ selectors.ts          line and inline selector parsing
│  │  └─ commands.ts           optional CLI adapters
│  ├─ edit/
│  │  └─ tool.ts               preflight, queues, writes, diffs, fresh tags
│  └─ hashline/
│     ├─ contract.ts           digest, metadata, UTF-8/EOL rules
│     ├─ registry.ts           active-branch snapshot lookup
│     ├─ parser.ts             strict PUT/CUT grammar
│     ├─ apply.ts              original-coordinate planning
│     ├─ recovery.ts           unique-context operation translation
│     ├─ snapshot-store.ts     bounded session-runtime text history
│     └─ render.ts             numbered reads and changed windows
├─ test/
├─ README.md
├─ CHANGELOG.md
└─ package.json
```

## Install locally

From this repository:

```fish
pi install ./extensions/pi-better-read-edit
```

Or load the live source for one run:

```fish
pi -e ./extensions/pi-better-read-edit/src/index.ts
```

Restart Pi or run `/reload` after changing the configured package.

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
- **No fuzzy or legacy modes:** stale recovery maps the requested operations through unique unchanged context; it does not apply a generic patch. There is no apply-patch fallback, exact-text replacement mode, row script, syntax-block selector, register, move operation, or heuristic tag repair.
- **No persisted overflow or cursor subsystem:** projections report structured truncation counts; oversized adapter output fails at its process cap rather than maintaining a second session-storage lifecycle or returning a cursor that cannot preserve representation mode.
- **Strict resource subset:** URL ports are limited to standard HTTP/HTTPS, free-form SQLite queries and non-rowid/virtual/view tables are disabled, SQLite offsets are capped, and archive members must resolve to one canonical literal path in a pinned archive snapshot.
