# Exec plan: pi-response-style

## Goal and why

Build `pi-response-style`, a Pi extension that lets the user switch how the model
_responds in chat_ — prose style only, never thinking traces — by picking a named
"response style" from a `/response-style` picker. The chosen style is injected into
the system prompt each turn, so it is followed reliably (system level) rather than
per-prompt.

Origin: Slack thread C0A0RRPMW1K/p1786637636155439 (Lexile levels, plain-English
prompting, Claude Code output-styles) + KG's note that dynamically swapping styles in
the harness's system instructions is the effective pattern.

Red-teamed before execution (verdict: revise). All material findings are folded in
below; see "Red-team log" at the bottom.

## Key design decisions (with rationale)

1. **Injection point: `before_agent_start` → append to `event.systemPrompt`.**
   System-level placement is the strongest, most reliable lever (beats per-prompt and
   AGENTS.md stuffing, per the thread). Same mechanism Claude Code's output-styles use.
   Rejected alternative: post-hoc LLM rewrite of assistant messages (true thinking/output
   separation, but breaks streaming UX, costs a second model call per reply, mutates the
   stored message). Rejected: `registerMarkdownTransformer` (hard thinking/output split
   but sync string transforms only, no real restyling).

2. **Thinking-trace guardrail is instructional, not enforced.** Text instructions are the
   only channel we have for steering a model; no provider API can style only the chat
   channel, since thinking and visible text come from the same model guided by the same
   prompt. Every injection ends with a scoping line (see WP2). Models honor
   register-switching well in practice; the failure mode is mild style leak into thinking.

3. **Three-layer style resolution, zero writes to style dirs.** Precedence: bundled
   (package `styles/*.md`) < user (`<agentDir>/response-styles/*.md`) < project
   (`<cwd>/.pi/response-styles/*.md`). Filename match overrides. The project layer
   loads only when `ctx.isProjectTrusted()` — an untrusted repo must not shadow a
   named style that `lastUsed`/`default` could resolve to (prompt-injection hole
   otherwise). The picker tags project styles. The extension never writes style
   files — important because KG's user dir is a symlink into his aikado dotfiles repo
   and must stay content-only. Path resolution uses `getAgentDir()`/`CONFIG_DIR_NAME`
   from the peer dep, never hardcoded.

4. **Style file format:** markdown with YAML frontmatter and the body as the prompt.
   Parsing uses `parseFrontmatter` from the pi-coding-agent peer (precedent:
   pi-agent-mode), NOT a hand-rolled parser — multi-line descriptions, quoted values,
   CRLF/BOM all handled. Title is newline-normalized before use in the injection header.

   ```markdown
   ---
   title: Plain English
   description: Smart-friend explanations, no jargon
   ---

   <style prompt body>
   ```

5. **Selection resolution order** (KG: "if no default configured, use the last version").
   Off is an explicit, persistable state, not merely "nothing set":
   1. session pick — newest `pi-response-style/state` entry on the active branch
      (`getBranch()`, `.pop()`); `{ name: null }` = explicit off, **stops the cascade**
   2. `default` from `config.json` in the user styles dir (committable dotfiles config)
   3. `lastUsed` from `<agentDir>/pi-response-style.state.json` (local state, written on
      every style pick — kept out of the symlinked dir so picks don't dirty the repo)
   4. off (no injection)

   At every layer, if the resolved name doesn't exist among loaded styles (file deleted
   from the dotfiles repo), fall through to the next layer and notify once.

6. **Cache behavior accepted, not engineered around.** Appending to the system prompt
   invalidates the prompt-cache prefix once per switch (one re-read of conversation
   history, then re-cached). Style switches are rare, so this is noise. Tail-message
   injection (`message` + `context`-event filtering of stale style messages) is the
   documented escape hatch if switching ever becomes frequent — future option, not built
   now. Open question whether the AI Gateway preserves pi's cache headers; WP7 measures it.

## Work packages

### WP1 — Package scaffold ✅ (done 2026-08-14)

- `extensions/pi-response-style/` mirroring pi-agent-mode: `src/index.ts` (no-op stub),
  `package.json` (`@pi-kaush/pi-response-style`, `pi.extensions` entry, zero runtime
  deps, optional peers pi-coding-agent + pi-tui), `scripts/check-package.mjs`
  (globs `styles/*.md`, count ≥ 1 — so WP6 template swaps can't break `npm run check`),
  `LICENSE`, `CHANGELOG.md`, placeholder `README.md`, placeholder `styles/plain-english.md`.

### WP2 — Core extension ✅ (done 2026-08-14)

- Style loader: read bundled `styles/*.md` + user `<agentDir>/response-styles/*.md`,
  `parseFrontmatter` for `title`/`description` + body. User layer overrides bundled on
  filename match. Malformed files skipped with a notify warning. Scan at factory load;
  rescan on `session_start` reason `"reload"` (README notes live template edits need
  `/reload`).
- `/response-style` command:
  - No arg → `ctx.ui.select` picker showing `title — description` per style plus "Off".
    **Esc/cancel (`undefined`) = no change**, notify and return — never treated as Off.
  - After a real style pick: `ctx.ui.confirm` "Also make this your default?" (yes →
    writes `default` to `config.json` in the user styles dir, creating the dir if
    needed; README notes this dirties the dotfiles worktree deliberately, and documents
    clearing the default by removing the key). Not offered after an Off pick.
  - `/response-style <name>` → direct set, matched by filename (not title), `off`
    accepted as an alias for Off, with `getArgumentCompletions` (pi-tui
    `AutocompleteItem`, peer declared in WP1).
  - Every style pick: in-memory state, `pi.appendEntry("pi-response-style/state",
{ name })`, write `lastUsed` to the state file, footer `setStatus`.
  - Off pick: in-memory off, `pi.appendEntry("pi-response-style/state", { name: null })`
    (cascade stop), footer cleared via `setStatus(key, undefined)`.
- `session_start`: restore per decision 5 (newest entry on `getBranch()`; off marker
  stops cascade; stale names fall through with a notify). On `session_compact`, if the
  pick entry was dropped as a cut point, re-persist from in-memory state.
- `session_shutdown`: clear footer status (pi-agent-mode precedent).
- `before_agent_start`: if a style is active, append (exactly once per turn — WP3
  asserts this):

  ```
  ## Response style: <title>

  <style body>

  Apply this style only when responding to the user in chat. Never apply it to
  internal reasoning, thinking traces, tool calls, or code.
  ```

### WP3 — Tests (vitest) ✅ (done 2026-08-14, 28 tests)

- Frontmatter: happy path, missing description, malformed skipped, multi-line
  description, body containing `---` lines, CRLF/BOM, title newline normalization.
- Layering: user file overrides bundled file of same name.
- Resolution order: session pick > default > lastUsed > off; **off marker stops the
  cascade** (off-overrides-default); two picks in one session → newest wins; forked
  branch without a pick falls through; deleted style name → fallthrough + warning.
- Command flow (mocked ctx): picker pick → state/appendEntry/state-file write;
  **Esc-cancel keeps current state**; no-UI mode (undefined select) → no change,
  direct-arg path still works.
- Injection: contains body + guardrail; absent when off; appears exactly once per turn.

### WP4 — Dev setup in aikado (KG's machine) ✅ (done 2026-08-14)

- Create `~/dev/per/aikado/config/pi/agent/response-styles/` (content starts empty;
  KG's templates arrive in WP6).
- Add the source/target pair to `config/pi/agent/update-pi-config.sh` so
  `make setup-user` links it to `<agentDir>/response-styles`, matching the existing
  prompts/extensions/themes pattern. Run the script and verify the link.
- Dogfood the extension via the settings.json `packages` path entry (already added
  2026-08-14: `/Users/kg/dev/oss/pi-kaush/extensions/pi-response-style`).

### WP5 — README ✅ (done 2026-08-14 via @hemingway, guardrail-dedup fix applied)

Content spec (KG's explicit list — the insights that show the problem was thought
through, not hacked together):

- **System-level instruction vs tail injection**: what each is, why system level was
  chosen (strongest lever, same mechanism as Claude Code output-styles), and when tail
  injection would win (frequent switching, cache sensitivity).
- **KV cache**: changing the system prompt invalidates the cached prefix — a one-time
  spike per switch, then it re-caches and later turns are cheap. Fine for occasional
  switching; the tail-injection escape hatch exists if that changes.
- **Instruction is the only channel**: the only way to steer a model's output is text
  it reads. There is no API that styles "just the chat text" — thinking and replies are
  the same model reading the same prompt. So "style my replies, not your reasoning" is
  itself an instruction, and models are good at honoring that split.
- **Stricter enforcement exists, and was deliberately not used**: display-layer
  transforms (`registerMarkdownTransformer`, provably never touches thinking but no real
  restyling) and post-hoc LLM rewriting (true separation but kills streaming UX and
  doubles cost). Documented as considered-and-rejected, with the trigger that would
  justify revisiting.
- Plus standard docs: install, style file format, `/response-style` usage (incl. `off`
  and Esc-cancel semantics), default vs last-used resolution (incl. how to clear a
  default), bundled styles, adding your own, `/reload` needed after editing templates.

Voice: plain, direct, no hype. README is a deliverable — length as needed, but tight.

### WP6 — Bundled default styles ✅ (done 2026-08-14: simplicity, hemingway, i-have-adhd, pirate; injection now `# Communication` + guardrail + body per KG)

- Replace placeholder bundled styles in `styles/` with KG's specific templates
  (KG to provide; not the Slack-thread ones like lexile-1000).
- Template guidance from the attention-span analysis (write fresh, in KG's voice —
  attention-span is AGPL-3.0, its text can never be vendored into this MIT package;
  ideas are free, sentences are not): answer-vs-deliverable distinction (answers lean,
  deliverables run long), deliverable purity (output only the thing asked for, no
  wrapper), never-trim-a-warning (compress elaboration, never caveats), "the bold alone
  must carry the whole answer", code comments inherit plain-English but never chat
  formatting. KG may keep verbatim attention-span files in his personal aikado
  response-styles dir (private use, no distribution).
- Mirror them into `~/dev/per/aikado/config/pi/agent/response-styles/` if KG wants them
  under his personal dir as well. (Placeholder style ships in the npm package until
  then — acknowledged.)
- Note: "make default" writes `config.json` into KG's live dotfiles worktree — that's
  deliberate and user-controlled; documented in README.

### WP7 — Validation ✅ (done 2026-08-14)

- `npm run check` at repo root (prettier, tsc, vitest, package:check).
- Manual smoke: reload pi, run `/response-style`, pick a style, confirm footer status
  and that the next reply follows the style; restart and confirm default/last-used
  restoration; confirm thinking traces are unstyled; Esc-cancel keeps the current style.
- `/compact` sanity ✅ (2026-08-14, RPC-driven live run): pick pirate → build history
  → compact (compaction_end) → next reply still pirate-styled, pick entry intact.
- Cache-spike claim ✅ (2026-08-14, measured on KG's ~150k live session through the AI
  Gateway): pick at turn 116 → exactly one full re-read (146k, cacheRead 0) → cache
  refilled. cacheRead healthy every other turn (145k–197k), so caching survives the
  gateway. Bonus finding: TTL-driven re-reads every ~5–10 min of wall time anyway, so
  interactive switch cost is usually zero. cacheWrite reported 0 throughout (provider
  accounting), so write premium unmeasurable from this data. Results in README.

### WP8 — Eval harness ✅ (done 2026-08-14, proof run: 38 calls, 0 errors, 196s)

Adapted from attention-span's approach (reimplemented, not copied), so "the work is
unchanged" and "output is shorter/skimmable" are measured, not asserted:

- Work-equivalence: small set of coding tasks with hidden tests, style off vs on, pass
  rates compared. No LLM judge.
- Output shape: time-to-point (words before the first emphasized point),
  answer-in-first-line rate, longest unbroken block, deliverable purity (clean
  deliverable vs wrapped).
- Constraints (KG): runs **locally**, fully **isolated** (own `PI_CODING_AGENT_DIR` in
  a temp dir, `--no-extensions -e` the package source, temp cwd), never touches live pi
  config, sessions, or the aikado styles dir; sequential requests on a cheap/fast
  model, opt-in via an explicit command (e.g. `npm run bench` in the package), so it
  never slows or clobbers normal pi usage.

### WP9 — npm publish bootstrap ✅ (done 2026-08-14: @pi-kaush/pi-response-style@0.1.0 live; settings swapped back to npm package)

Per repo README/AGENTS.md, a package's first release must be bootstrapped
interactively before Trusted Publishing works:

1. Bump `package.json` to 0.1.0 (currently 0.0.0) and run `npm run check`.
2. Interactive first publish (local npm login + browser 2FA):
   `npm publish --workspace @pi-kaush/pi-response-style --access public`.
3. Configure the Trusted Publisher on npmjs.com for `@pi-kaush/pi-response-style`:
   GitHub Actions provider, org `kaushikgopal`, repo `pi-kaush`, workflow
   `publish.yml`, environment `npm`, allowed action `npm publish`.
4. All later releases use `make publish PACKAGE=pi-response-style` (bumps version,
   runs checks, tags `pi-response-style-v<x.y.z>`, GitHub release triggers the OIDC
   publish; verify with `gh run watch` and `npm view @pi-kaush/pi-response-style version`).
5. After the npm release, swap global settings.json back from the local path to
   `npm:@pi-kaush/pi-response-style` (the `/publish-pi-ext` flow's closing step).

## Blockers / open questions

- WP6 blocked on KG providing his style templates. Everything else can proceed.
- Assumption: aikado styles folder lives at `config/pi/agent/response-styles/` (matches
  the existing symlink convention), not at aikado root.
- Assumption: injection via system prompt, not tail message, per the accepted
  recommendation; tail injection documented as a future option.

## Decision log

| Decision              | Choice                                                                            | Rationale                                                                                                                       |
| --------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Injection mechanism   | `before_agent_start` systemPrompt append                                          | strongest lever; same as Claude Code output-styles                                                                              |
| Thinking separation   | guardrail instruction                                                             | instructions are the only steering channel; enforcement alternatives cost too much                                              |
| Style storage         | bundled + user-dir layering, never write user dir                                 | user dir is a symlinked dotfiles folder                                                                                         |
| Paths                 | `getAgentDir()` from peer                                                         | respects `PI_CODING_AGENT_DIR`; hardcoding diverges (red-team)                                                                  |
| Frontmatter           | `parseFrontmatter` from peer                                                      | hand-rolled parser mangles multi-line/CRLF (red-team)                                                                           |
| Off state             | explicit persisted marker, stops cascade                                          | else restart silently re-enables a style the user turned off (red-team)                                                         |
| Session restore       | newest `pi-response-style/state` entry on `getBranch()`; stale names fall through | namespaced customType avoids collisions; branch-aware restore (red-team)                                                        |
| Config vs state       | `default` in styles-dir config.json; `lastUsed` in un-symlinked state file        | picks shouldn't dirty the dotfiles repo                                                                                         |
| No default configured | fall back to last-used                                                            | KG requirement                                                                                                                  |
| Cache impact          | accept one-time spike; document tail-message option; measure in WP7               | switches are rare; claim should be verified, not asserted (red-team)                                                            |
| Bundled style content | KG templates, attention-span-informed, before WP8                                 | KG wants his own; ideas are free, AGPL sentences are not vendored                                                               |
| License               | MIT, never AGPL                                                                   | AGPL kills adoption (corporate no-fly lists) and is only needed for verbatim copying, which original templates make unnecessary |
| Style layers          | bundled < user < project (trust-gated)                                            | matches Claude Code precedence; trust gate closes a shadowing hole                                                              |
| Eval harness          | WP8, last, local + isolated + opt-in                                              | measurement beats assertion; must never clobber or slow pi usage (KG)                                                           |
| README authoring      | @hemingway subagent                                                               | KG request: non-robotic voice                                                                                                   |

## Red-team log (2026-08-14, verdict: revise — all addressed)

1. Off not representable → explicit `{ name: null }` cascade-stop marker + tests (decision 5, WP2, WP3).
2. Hand-rolled frontmatter parser → use peer's `parseFrontmatter`; expanded parse tests (decision 4, WP3).
3. Session restore underspecified → newest-on-branch, namespaced customType, stale-name fallthrough, compaction re-persist (decision 5, WP2, WP7).
4. Esc-cancel indistinguishable from Off → undefined = no change + tests (WP2, WP3).
5. check-package exact file list breaks at WP6 → glob `styles/*.md`, fixed in WP1.
6. Missing pi-tui peer + footer cleanup → peer added in WP1; `session_shutdown` clears status (WP2).

Minor, also adopted: `getAgentDir()` over hardcoded path; loader rescans on `/reload`;
arg matching by filename with `off` alias; WP7 measures the cache claim; WP4 dogfood
route validated (subdirectory `package.json` `pi.extensions` is honored, settings.json
path entry chosen anyway).
