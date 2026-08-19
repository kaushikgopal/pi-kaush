# Exec plan: Pi visual redesign

Status: code complete and all four redesigned extensions published to npm
(content-layout 0.1.1, footer-minimal 0.1.1, markers 0.2.6, inline-identifier
0.1.4) and loading from npm in both settings files. Open: live visual review by
the user (WP8, WP11-WP13, F28, F30-F32) and the pi-intercom upstream padding
note (F29).

## Execution tracker

- [x] Architecture and exec plan confirmed.
- [x] WP1 — Lock the render contract and regression baseline.
- [x] WP2 — Build `pi-content-layout`.
- [x] WP3 — Move working state into `pi-footer-minimal`.
- [x] WP4 — Redesign collapsed tools and subagents.
- [x] WP5 — Add streaming/final thinking markers.
- [x] WP6 — Integration, documentation, and package wiring.
- [ ] WP7 — Validation and visual review.
- [ ] WP8 — Align transcript text columns to the rail (F15, F16).
- [x] WP9 — Publish `pi-welcome-screen` and restore Pi to the npm source.
- [x] WP10 — Reconcile local `main` with the published release history.
- [ ] WP11 — Restore tool grouping via container hook composition (F19, F20).
- [ ] WP12 — Uniform tool colors and prompt surface background (F21, F22).
- [ ] WP13 — Footer top row, full-red errors, wider submitted pad, uniform ellipsis (F23, F24, F26, F27).
- [x] WP14 — Control-byte sanitization, commit train, review loop, publishes (F28, F29).
      Two first releases remain blocked on manual npm bootstrap; see WP14 step 5.

Implementation note: integration testing found that Pi's host `CustomEditor` and an
extension's `Editor` can resolve from distinct `pi-tui` module instances. The
`pi-inline-identifier` render adapter now covers both prototypes, preserving identifier
coloring with `pi-content-layout` in either load order.

Latest refinements (2026-08-18): use Pi's native braille spinner sequence for live work
and thinking; working shows only the indicator immediately left of the stable right-aligned
model, while
thinking switches to `+ Thought · <duration>` after it settles. The latest prompt
feedback replaces the active rail with an edge-to-edge `selectedBg` surface while retaining
one row of vertical padding; submitted messages keep their compact rail shell.

Live-test setup (2026-08-18): global and shared settings load `pi-content-layout`,
`pi-footer-minimal`, and `pi-tool-call-markers` from this checkout. `pi-welcome-screen`
returned to the unpinned npm source after publishing 0.1.6; `pi list` and the installed
package manifest verify 0.1.6. Visual review remains open pending user feedback.

## Live feedback log

- [x] **F1 — Separate prompt from footer (2026-08-18; superseded by F2).** User asked
      for more vertical space between the active input block and footer. Implemented one
      full-width blank row in `pi-footer-minimal`; live feedback says that is too tall.
- [x] **F2 — Rebalance prompt/footer height (superseded by F5).** Terminal layout has
      integer-height rows, so an exact half-row is unavailable. The intermediate decision
      was to keep the full footer separator and consider removing active prompt padding.
- [x] **F3 — Refine prompt rail (active side superseded by F11).** Use a thin `▎` accent
      rail and its unpainted terminal cell for breathing room. F11 later removes it from the
      active editor while retaining it for submitted messages.
- [x] **F4 — Darker submitted-prompt background.** User confirmed the darker surface is
      the submitted user block, not the whole transcript. Decision: keep the existing
      semantic `selectedBg` token; no hard-coded color or theme edit is needed.
- [x] **F5 — Sharp active prompt (superseded by F11).** This intermediate prototype used a
      rail-only active editor and reserved `selectedBg` for submitted messages.
- [x] **F6 — Reduce the prompt/footer gap (resolved by F8 and F9).** The screenshot showed
      the rail content followed by three visually empty rows. F8 restored two as visible
      rail padding; F9 removes the remaining footer-owned separator.
- [x] **F7 — Prioritize the footer work indicator (ordering refined by F10).** Remove
      `Working…` entirely and keep only the animated braille cell in the mandatory
      right-side core. Provider, path, cost, and optional active-agent status degrade before
      it; at the narrowest width the spinner remains the final visible cell.
- [x] **F8 — Add one-cell active prompt padding (shape retained by F11).** Keep one row
      above and below active content and replace either with the native scroll indicator
      when needed. F11 changes those rows from rail-only to full-width background.
- [x] **F9 — Remove the prompt/footer separator.** User confirmed the footer should begin
      immediately after the active surface. The bottom active-padding row is the only visual
      breathing room; the footer emits no leading blank row.
- [x] **F10 — Move the work indicator before the gateway provider (superseded by F12).**
      This intermediate order was `⠋ (provider) model`, with provider degradation to
      `⠋ model`.
- [x] **F11 — Replace the active rail with a full-width dark input surface.** User confirmed
      all material choices: the active background runs to both terminal edges, uses the same
      `selectedBg` token as the submitted body, retains one padded row above/below, and has
      no rail. Submitted messages keep their existing inset, accent rail, and dark body.
- [x] **F12 — Stabilize the work indicator beside the model.** Remove the gateway provider
      from footer line 1 entirely and render the active spinner immediately left of the
      right-aligned model. Show `(provider)` only on line 2 when `/footer-more-stats` is
      enabled and multiple providers are available. Line 1 therefore never changes shape
      because provider text appears or disappears.
- [x] **F13 — Add one horizontal input-padding column per side.** Keep the active background
      edge-to-edge, but render its editor at two fewer columns and add one background-colored
      layout column on both sides. With the user's existing `editorPaddingX: 1`, input text
      now begins at column 2 and aligns with the footer text.
- [x] **F19 — Restore tool grouping/collapse (2026-08-18; code-side complete).** Live regression: adjacent
      tool rows stopped collapsing under `%`/`•` groups. Root cause: `pi-content-layout`'s
      system-message patch and `pi-tool-call-markers`' grouping patch both replace
      `Container.prototype.render` with non-composing whole-container wrappers. Load order
      is deterministic (markers installs at factory load, content-layout on
      `session_start`), so content-layout is always outermost and
      `renderContainerWithToolGroups` never runs. Per-row `%` markers survive because row
      presentation patches `ToolExecutionComponent.prototype` separately. Fix: compose via
      a `Symbol.for("kg.pi.chatContainerHooks.v1")` globalThis registry — content-layout
      moves the system-text inset to instance-level decoration driven by a registered hook;
      both wrappers run all hooks before rendering and restore after. Order-independent,
      fail-open, and removable per package. Existing mocked-container tests could not see
      this conflict; add real-`Container` composition coverage.
- [x] **F20 — Replace raw-JSON `edit` summaries (2026-08-18; code-side complete).** `edit` is a
      self-rendered tool in Pi, so markers currently expose raw arguments instead of Pi's
      compact native label. Add an `edit` case to `selfRenderedCallLabel` producing
      `edit <path>`, matching Pi's native call format; the generic JSON fallback stays for
      unknown shapes. Exposed by F19 (grouping hid singleton edit rows less often);
      existing tests encode the JSON fallback.
- [x] **F23 — Restore one blank row above the footer (2026-08-19; supersedes F9).**
      User wants one blank row between the active input surface and footer line 1.
      `pi-footer-minimal` prepends a single blank row to its render; the zero-separator
      footer contract test flipped to a one-row contract. Decision 15 is superseded — the
      active editor's bottom padding row no longer suffices as the only separation.
      Code-side complete; live visual confirmation pending.
- [x] **F24 — Render failed tool rows fully red (2026-08-19).** Only the outcome tail
      of an errored row was error-colored; the marker and call label stayed muted.
      Singleton headlines and group bullets for failed rows now render entirely in
      `error` — marker, label, outcome, arrow, and truncation ellipsis — so the row
      reads as the one that failed. Pending `warning` state and subagent cards
      unchanged. Code-side complete; live visual confirmation pending.
- [x] **F25 — Keep the blank between tool blocks (2026-08-19; prototype reverted).**
      A compact-spacing prototype removed the single blank between consecutive tool
      rows/groups and between mixed-name sub-headings. Live review: too congested — the
      user prefers the existing spacing, so the change was reverted in the same session
      before gating. Tool-block spacing stays exactly as before.
- [x] **F26 — Two-space inner padding for submitted prompts (2026-08-19).** The
      submitted message body padded text one column right of the accent rail; a second
      space moves text to rail+3 (shared-column contract now `OUTER_INSET + 3`). Applies
      only to submitted messages in the chat log, not the active editor. Code-side
      complete; live visual confirmation pending.
- [x] **F28 — Sanitize control bytes in collapsed rows (2026-08-19).** A phantom
      red line at column 0 ("Auto-merging extensions/pi-footer-min…") turned out not to
      be a padding bug: git's rebase progress output uses `\r`, and the failed row's
      error outcome carried it into the collapsed row, so the terminal returned to
      column 0 and overwrote the marker/label. `sanitizeInline` now strips display
      sequences and control bytes from error outcomes (split on `\r` too), scraped call
      summaries, and image-adjacent output. This also explains the apparent
      "Reloaded…" misalignment: the status row itself was correctly inset; the phantom
      col-0 line was the outlier. Code-side complete; live visual confirmation pending.
- [x] **F31 — Revert the footer working indicator (2026-08-19; supersedes F7, F10,
      F12 and decisions 6/14/17).** User prefers Pi's native working row in the chat
      output. `pi-footer-minimal` no longer hides native working state and carries no
      spinner cell or interval; line 1's stable right side is the model alone.
      Disposal/shutdown no longer need visibility restoration because nothing is
      hidden. Code-side complete (9/9 footer tests).
- [x] **F33 — Per-call `% tool:` lines (2026-08-19; supersedes F32's nested layout).**
      User redirect: grouped calls should each render like a singleton — `% tool: call →
  outcome` per line at the shared inset, tool name bolded, no bullets, no blank lines
      between sections. Grouping behavior (adjacency, live-batch settling, cache) is
      unchanged; the presentation collapsed to one line per call everywhere, singleton or
      grouped. Code-side complete (142/142 markers tests).
- [x] **F32 — Nest grouped tool calls under one marker (2026-08-19; fulfills F25's
      compact goal with hierarchy).** The earlier compact attempt only removed blank
      lines and read as congested. Consecutive tool blocks now share one `%` heading,
      each tool run gets a sub-heading (`$` or the tool name), and calls nest one
      level deeper as sub-bullets with no blank lines between sections. Code-side
      complete (142/142 markers tests).
- [x] **F30 — Restore the numbered-step subagent display (2026-08-19).** User
      preferred the pre-redesign native subagent plan (emoji + numbered steps with agent
      names) over the WP4 accent-rail card, restyled to the new tool aesthetic: `% subagent`
      heading with chain/parallel counts and scope, numbered steps while the chain
      executes, agent names in accent (emoji scraped from the native plan component, args
      fallback without it), everything else muted; failed subagents follow the F24 full-red
      rule. The rail card, hint line, and `Ctrl+O view subagents` line are removed;
      expansion still restores native details. Code-side complete (139/139 markers tests);
      live visual confirmation pending.
- [ ] **F29 — pi-intercom card inner padding (2026-08-19; extension-level).** The
      intercom message card's body lines render flush against the `│` border while the
      header/meta lines carry one leading space. That inconsistency lives in
      `pi-intercom`'s own `InlineMessageComponent.render` (its `frameLine` adds no
      leading pad to body content), not in this repo's layout extensions; the upstream
      fix is a one-space pad inside `frameLine`. Not patched locally (installed npm
      package; edits would not survive reinstall). Recorded as answered, no repo change.
- [x] **F27 — Uniform truncation-ellipsis color (2026-08-19).** Some truncated tool
      rows showed the `…` in the terminal default foreground (bright lavender) while
      others matched the row tone. Root cause: pi-tui's `truncateToWidth` wraps a plain
      suffix in `\x1b[0m` resets, discarding the row color; whether it fired depended on
      whether Pi's own component had pre-truncated the summary. `fitSummary`/
      `fitSummaryTail` now accept a suffix, and collapsed headlines, group bullets, and
      subagent cards pass `theme.fg(color, "…")` so the ellipsis always matches the row
      tone (muted settled, error failed). Code-side complete; live visual confirmation
      pending.
- [x] **F21 — Uniform tool-call colors (2026-08-19).** Grouped/singleton tool blocks
      mixed three tones: `toolTitle` white headings, `muted` summaries, `dim` bullets and
      outcomes (plus an `accent` raw-args fallback). User chose one tone for the whole
      block: settled rows now render entirely in `muted` (bold retained on
      marker/headings), while `warning` pending and `error` failure states stay semantic.
      Subagent cards keep their accent-rail identity. Code-side complete; live visual
      confirmation pending.
- [x] **F22 — Darker prompt surface `#071312` (2026-08-19).** The active editor block and
      the submitted message body now paint with a fixed `PROMPT_SURFACE_BG` truecolor
      (`#071312`) inside `pi-content-layout` instead of the theme's `selectedBg` token.
      Theme untouched: `selectedBg` still serves selections, autocomplete, and dialogs.
      Code-side complete; live visual confirmation pending.
- [x] **F15 — Align system status messages to the rail column (2026-08-18).** The live
      screenshot showed `showStatus` rows (for example "Reloaded keybindings…") one column
      left of the submitted-message rail. Root cause: the screenshot (16:53) predated the
      `index.ts` edit (16:59) that added `systemContainerDecorator`; current source already
      targets the rail column. Column pinned by the shared-column contract test; live visual
      confirmation tracked under WP8.
- [x] **F16 — Align assistant chat text to the rail column (2026-08-18).** The same
      screenshot showed assistant text one column right of the rail (native `outputPad: 1`
      stacking on the full outer inset). Root cause is the same stale build: current
      `assistantDecorator` subtracts the native pad. Column pinned by the shared-column
      contract test. End state: system status text, assistant text, active input text, and
      the submitted rail all share one column; submitted message text stays inside its rail
      block.
- [x] **F14 — Add minimum welcome-screen side padding (expanded by F17).** The initial
      implementation reserved one terminal column on both viewport edges and moved
      responsive breakpoints by two columns. Combined validation also corrected a test
      fixture to instantiate Pi's host `Container` rather than a separately resolved
      `pi-tui` class; runtime behavior did not change.
- [x] **F17 — Expand welcome-screen padding to two columns per side.** Compute responsive
      layout against `width - 4` at normal widths so neither grid reaches the outer two
      columns. Padding degrades progressively to one or zero columns only when needed to
      preserve at least one content column on tiny terminals.

## Goal and why

Make Pi's main conversation surface feel closer to the supplied OpenCode references
without replacing Pi's interaction model:

- inset transcript text and the footer from both terminal edges;
- render the active editor as an edge-to-edge dark surface while keeping submitted user
  messages as compact inset rail blocks;
- reduce tool calls to quiet, unboxed markers while preserving useful grouping,
  outcomes, errors, and expansion;
- move the animated working state out of the transcript and into the footer;
- give subagent calls a distinct compact card; and
- label hidden reasoning with Pi's braille spinner while streaming and
  `+ Thought · <duration>` when complete; and
- keep the responsive welcome screen two columns away from both viewport edges at normal
  widths.

The redesign should remain theme-aware, preserve editor and tool behavior, add no model
or network work, and fail open to Pi's native rendering if a private rendering adapter no
longer matches a future Pi version.

## Acceptance criteria

1. **Transcript and footer inset.** Assistant text, user messages, thinking labels, tool
   rows, and both footer lines share a visible side inset. Headers, dialogs, selectors,
   overlays, and autocomplete popups do not receive the global inset. The custom welcome
   header owns a separate two-column side pad at normal widths.
2. **Prompt state change.** The active editor has no rail or outer background inset:
   `selectedBg` fills the terminal width across content plus one padded row above/below.
   One layout-padding column per side wraps Pi's configured editor padding, aligning text
   at column 2 under the current `editorPaddingX: 1`. Submitted
   messages retain the two-column inset and accent rail, use the same darker semantic
   background behind their padded body, and keep their native blank message rows. Footer
   metadata begins immediately after the active editor's bottom padding row.
3. **Minimal tools.** Collapsed tools have no background box or gear badge. Adjacent
   calls still group by tool type, long summaries still reserve room for the outcome on
   the right, failures remain obvious, images still render, and `Ctrl+O` still exposes
   native details.
4. **Special activity.** Subagent calls use a compact two-line rail card. Working state
   appears only as a braille indicator immediately left of the stable right-aligned model
   and survives every optional-field degradation. Gateway provider moves to the optional
   second footer line. Hidden thinking uses Pi's native braille spinner
   while live, then changes to `+ Thought · <duration>` without adding a render timer.
5. **Safe composition.** Input editing, history, autocomplete, keybindings, inline
   identifiers, footer statuses, tool expansion, reload, and shutdown continue to work.
   Unsupported Pi component shapes fall back to native output instead of crashing.
6. **No avoidable render cost.** The footer spinner replaces Pi's native 80 ms working
   timer rather than running beside it. Thinking duration is updated only when Pi already
   delivers streaming/final content updates.
7. **Welcome-screen breathing room.** Every non-empty welcome line begins two columns from
   the left edge and cannot enter the two rightmost columns at normal widths. Tiny widths
   reduce padding before content, and responsive grid breakpoints account for all four
   reserved columns.

## Target visual structure

Assistant and submitted-message content use a two-column outer inset. Submitted prompts
retain a thin `▎` accent glyph; the active editor instead fills the entire terminal width
with `selectedBg`.

```text
Assistant output
  Text wraps inside the inset width; no background block.

Active prompt (edge-to-edge selectedBg)
████████████████████████████████████████████████
  prompt text
████████████████████████████████████████████████

Submitted prompt
  ▎                                            darker body background
  ▎ prompt text                                darker body background
  ▎                                            darker body background

Grouped tools
  % Read
    • src/a.ts                         42 lines · 8ms
    • src/b.ts                         18 lines · 5ms

Subagent
  ▌ Red-Team Task — Challenge compatibility conclusion
  ▌ ctrl+o down view subagents

Thinking
  ⠋ Thinking… → ⠙ Thinking… → …
  + Thought · 2.5s

Prompt/footer boundary
 prompt text                                    selectedBg
████████████████████████████████████████████████
  ~/dev/oss/pi-kaush …                         ⠇ model · high
  ↑228k ↓72k ¢99.6% · (gateway)                  optional stats
```

Marker mapping for the first prototype:

- `%` identifies a tool or tool group;
- `•` identifies a member of a multi-call group;
- Pi's braille spinner identifies live thinking; `+` identifies settled thought state;
- the accent rail alone identifies a subagent call.

Singleton tools should stay on one line when the summary and outcome fit. Group headings
should not repeat decorative status text that already appears on their child rows.

## What belongs where

| Concern                           | Owner                             | Reason                                                            |
| --------------------------------- | --------------------------------- | ----------------------------------------------------------------- |
| Colors                            | Existing `cobalt2` theme          | Pi themes own semantic colors, not layout                         |
| Transcript and prompt shape       | New `pi-content-layout` extension | Requires width-aware rendering and a custom editor component      |
| Footer inset and working state    | Existing `pi-footer-minimal`      | It already owns the complete footer renderer                      |
| Tools, subagents, thinking labels | Existing `pi-tool-call-markers`   | It already owns collapsed tool rendering and the thinking adapter |
| Startup header side padding       | Existing `pi-welcome-screen`      | It already owns the responsive welcome renderer                   |

Pi's current settings are not sufficient on their own: `outputPad` only supports 0–1,
`editorPaddingX` only changes editor text padding, and themes cannot change component
shape, width, rails, timers, or placement. The initial implementation should not modify
the external `cobalt2` theme. It should consume its existing semantic tokens so later
color tuning remains a theme-only change.

## Design constraints

- Prefer public Pi APIs: `ctx.ui.setEditorComponent`, `ctx.ui.setFooter`,
  `ctx.ui.setWorkingVisible`, event hooks, theme functions, and `pi-tui` width helpers.
- Isolate unavoidable native component patches behind small compatibility adapters.
  Each patch must feature-detect its target, carry an idempotence symbol, preserve the
  original function, restore it on shutdown when still owned, and catch cosmetic errors.
- Never use raw string length for layout. Use `visibleWidth` and `truncateToWidth`, and
  test ANSI color, zero-width control sequences, emoji, and wide characters.
- Preserve leading zero-width terminal control sequences before inserting visual spaces,
  so shell/code-block terminal semantics are not moved into visible content.
- Keep package coupling low. The three extensions share a visual contract and regression
  tests, not a new runtime dependency. A duplicated two-column constant is preferable to
  a global mutable layout service.
- Do not change model messages, session data, tool arguments/results, or provider
  content. Every transformation is display-only.
- Do not change global Pi settings, the external theme symlink, package versions, or npm
  releases as part of implementation without a separate explicit request.

## Work packages

### WP1 — Lock the render contract and regression baseline

**Outcome:** tests describe the current behavior that must survive and the target shape
that later work implements.

- Add focused render fixtures at representative widths (narrow, 80-column, wide) rather
  than relying only on full-line snapshots.
- Extract or add test helpers for visible-width assertions, ANSI stripping, line inset,
  and right-aligned outcome tails.
- Extend existing `pi-tool-call-markers` tests before refactoring to cover:
  - singleton and grouped tools;
  - pending, success, and failure states;
  - long summary truncation with the right outcome preserved;
  - expanded `Ctrl+O` output;
  - self-rendered/MCP tools, image output, and no-result cases; and
  - adjacent thinking-block merging.
- Add footer baseline tests for one/two-line rendering, narrow widths, extension statuses,
  provider/model display, and disposal.
- Record the initial visual constants in one module per owning extension: two-column
  outer inset, one-column rail, and one-column prompt inner padding.

**Exit:** existing tests pass before behavior changes, and every acceptance criterion has
an automated assertion or an explicit manual check in WP7.

### WP2 — Build `pi-content-layout`

**Outcome:** transcript text and the prompt editor form the new content surface while all
input behavior remains Pi-native.

Create `extensions/pi-content-layout/` with the standard package files, zero runtime
dependencies, optional Pi peer dependencies, focused tests, README, changelog, license,
and package validation script.

#### WP2.1 — Width-safe inset primitives

- Render children at `width - leftInset - rightInset`, then restore each output line to
  the parent width without changing its visible content.
- Handle widths too small for the preferred inset by reducing decoration before reducing
  content to zero.
- Keep ANSI and leading OSC/control sequences intact.
- Provide width-safe helpers for an edge-to-edge dark active editor and a submitted prompt
  whose inset padded body fills the same darker background.

#### WP2.2 — Active editor block

- Register a custom editor factory with `ctx.ui.setEditorComponent`.
- Compose with the previously registered factory when one exists; otherwise create Pi's
  standard `Editor`.
- Decorate only its rendering. Do not replace input handling, history, autocomplete,
  keybindings, submission, queued-input behavior, or escape handling.
- Convert editor border rows into one `selectedBg` padding row above and below the content,
  paint every visible editor content row to the full terminal width, and leave
  autocomplete/suggestion rows outside the surface.
- Add no active rail or background inset. Add one background-colored layout column on each
  side outside Pi's configured editor padding; reduce the editor render width accordingly so
  wrapping and cursor geometry remain correct. When a boundary carries a real editor scroll
  indicator, render it inside the corresponding vertical padding row.
- Restore the prior editor factory on shutdown only if the extension still owns the
  registration.

#### WP2.3 — Submitted user and assistant transcript

- Add a guarded adapter around exported assistant/user message components because Pi has
  no public renderer hook for these native rows.
- Assistant output: reduce the render width and add the outer inset, with no new
  background.
- Submitted user output: retain Pi's message content, padding, and blank rows; switch its
  body to the darker semantic background and retain the thin accent rail outside it.
- If the background setter is unavailable, keep the native submitted background but
  still apply the safe outer shape; warn at most once in debug/test paths, never per row.
- Let assistant-level inset naturally carry the hidden thinking label. Tool rows remain
  owned by `pi-tool-call-markers` in the intended installation, avoiding two extensions
  rewriting the same collapsed tool shell.

#### WP2.4 — Composition tests

- Load with `pi-inline-identifier` in both orders and verify identifiers, cursor movement,
  history, multiline input, autocomplete, submission, and paste handling remain intact.
- Exercise empty input, wrapped input, narrow terminals, reload, and shutdown.
- Verify headers/dialogs/overlays are unchanged.
- Verify patches are idempotent and unsupported component shapes use native rendering.

**Exit:** the active/submitted blocks have the same geometry, assistant wrapping respects
both insets, and editor interoperability tests pass.

### WP3 — Move working state into `pi-footer-minimal`

**Outcome:** no working row appears in the transcript; the footer carries the same live
state as a single braille cell immediately before the right-aligned model.

- Start footer metadata immediately after the active prompt; its bottom background-padding
  row provides the visual separation without a footer-owned blank row.
- Change footer layout from its current one-column edge pad to the two-column outer inset
  used by the conversation surface. Apply it to both the main and optional stats line.
- On TUI `session_start`, call `ctx.ui.setWorkingVisible(false)` so Pi disposes/avoids its
  native working component and timer.
- Track working state from `agent_start`; clear it on `agent_end`, `agent_settled`, abort
  cleanup, footer disposal, and `session_shutdown`.
- Render only the animated spinner immediately before the right-aligned model while active.
  Use an 80 ms interval only during active work, matching/replacing Pi's native cadence.
- Omit provider from line 1. Add it to the optional stats line only when multiple providers
  are available.
- Request only a footer render per frame. Keep usage aggregation and other footer data on
  the existing render path unless profiling shows it is material; if it is, cache usage
  totals by session entry count rather than adding another timer.
- Clear every interval on settle/dispose/shutdown. Restore native working visibility on
  shutdown so removing/reloading the extension does not leave Pi's status hidden.
- Preserve narrow-width degradation: drop provider, path, cost, and optional active-agent
  detail before the mandatory spinner/model core. If even the model must clip, retain the
  spinner as the final visible cell.

Tests:

- fake-timer coverage proves one interval while active, none while idle, and no leak after
  repeated starts/settles or disposal;
- native working visibility is disabled/enabled at the correct lifecycle points;
- spinner frames update only the footer; and
- one/two-line footer content stays inside the inset at narrow widths.

**Exit:** one working animation exists, it is footer-only, and lifecycle tests show no
orphan timers.

### WP4 — Redesign collapsed tools and subagents

**Outcome:** tools become quiet, unboxed transcript lines without losing operational
information.

Refactor `extensions/pi-tool-call-markers/src/index.ts` in place; preserve its argument
formatters, grouping cache, duration/outcome calculation, image handling, native
expansion, and compatibility guards.

#### WP4.1 — Minimal shell

- Remove the gear badge, background color, box padding, and filled blank rows from the
  collapsed renderer.
- Apply the shared two-column outer inset directly in this extension so collapsed tools
  align with assistant/user text without introducing a runtime dependency on the layout
  package.
- Use `%` for a tool/group heading and `•` only for children of a multi-call group.
- Keep text hierarchy semantic and low contrast: marker/tool name emphasized, summaries
  normal or muted, success metadata dim, pending state warning-colored, errors
  error-colored. Do not use a background for any ordinary tool state.
- Keep `fitSummaryTail` behavior: truncate the middle/summary first and reserve the
  right-hand outcome/duration.
- Keep images below the corresponding marker with the same inset.

#### WP4.2 — Subagent card

- Detect the `subagent` tool by tool name and inspect its public argument shape without
  mutating it.
- Render it outside ordinary tool grouping as a two-line accent-rail card with no
  background:
  - title: humanized task kind/profile plus the first useful task sentence;
  - hint: Pi's themed key hint for `Ctrl+O` followed by `view subagents`.
- Provide deterministic fallbacks for single, parallel, and chain calls and malformed or
  future argument shapes. Unknown shapes use the normal generic tool renderer.
- Truncate the title before the key hint/outcome becomes unreadable.
- Preserve native expanded details and errors through `Ctrl+O`.

#### WP4.3 — Tool compatibility

- Test marker rendering with and without `pi-content-layout` loaded and in both load
  orders. The collapsed shell must receive exactly one inset.
- Test shutdown/reload restoration for both prototype adapters.
- Retain the existing package's behavior for MCP/self-rendered tools unless their own
  renderer explicitly opts out; remove their background only when it can be done without
  discarding content.

**Exit:** ordinary and special tools match the target text structures, all existing
information-bearing behaviors remain, and no load order causes double padding.

### WP5 — Add streaming/final thinking markers

**Outcome:** hidden reasoning has a lightweight lifecycle label and no independent
animation/render loop.

Extend the existing `thinking-block-merger.ts` adapter instead of adding another patch to
the same `AssistantMessageComponent.updateContent` method.

- Continue merging adjacent thinking blocks only in a display copy; never alter provider
  blocks, signatures, or stored session messages.
- Forward the runtime's optional streaming argument and any future trailing arguments to
  the original method.
- Store the first streaming timestamp per assistant component in a `WeakMap`.
- Before native rendering, set the per-component hidden label to:
  - Pi's native braille sequence (`⠋ Thinking…`, `⠙ Thinking…`, …) while streaming,
    sampled from Pi's existing content updates without adding a timer;
  - `+ Thought · X.Xs` on the final update when a local start timestamp exists; or
  - `+ Thought` for restored messages/older runtimes with no streaming timestamp.
- Use the theme's thinking/warning foreground rather than hard-coded ANSI colors.
- Do not call the public global hidden-label setter for live/final transitions: it would
  relabel older messages every turn.
- If Pi's per-component hidden-label shape is unavailable, preserve adjacent merging and
  native labels rather than failing.
- Preserve visible-thinking mode: the full reasoning block stays native; only hidden mode
  receives the compact lifecycle label.

Tests:

- streaming → final transition and duration formatting;
- restored/final-only message;
- multiple assistant rows do not share timers;
- adjacent thinking merging remains display-only;
- optional-argument compatibility with the package's declared Pi version floor; and
- no `setInterval`, timeout, or extra `requestRender` is introduced.

**Exit:** current `hideThinkingBlock: true` behavior shows the requested labels and the
render-count test is unchanged apart from Pi's native updates.

### WP6 — Integration, documentation, and package wiring

**Outcome:** the three owning extensions work as one visual system and remain usable
independently.

- Add `pi-content-layout` to the root package/workspace documentation and checks.
- Update `pi-tool-call-markers` README/changelog for `%`/`•`, subagent cards, thinking
  labels, no-background rendering, and the retained `Ctrl+O` path.
- Update `pi-footer-minimal` README/changelog for footer inset and working ownership.
- Document the recommended combination and current theme settings:
  - `cobalt2` supplies colors;
  - `pi-content-layout` supplies transcript/editor shape;
  - `pi-footer-minimal` supplies footer shape/status; and
  - `pi-tool-call-markers` supplies tool/thinking shape.
- Document the private-adapter compatibility policy and the native fallback behavior.
- Add an integration fixture that loads all three plus `pi-inline-identifier`, then
  exercises both registration orders, reload, and shutdown.
- Do not bump versions, publish packages, edit the external theme, or change live global
  settings in this work package.

**Exit:** package checks include all changed/new files, docs describe ownership clearly,
and the combined fixture has no duplicate decoration or leaked global patch.

### WP7 — Validation and visual review

**Outcome:** automated checks are green and the live TUI matches the intended hierarchy
at realistic terminal widths.

Run the smallest checks while working, then the repository gate:

**Latest check (2026-08-18, after F19/F20 and WP10):** the reconciled tree passes 202
focused redesign tests and the complete root gate: formatting, TypeScript, 25 Vitest files
with 342 tests, and every package payload. `pi-tool-call-markers` now explicitly reviews its
new `src/container-hooks.ts` file in the npm payload. The final live `/reload` visual review
remains open.

1. Focused Vitest files for `pi-content-layout`, `pi-footer-minimal`, and
   `pi-tool-call-markers`.
2. Type-check and package-check each changed workspace.
3. Root `npm run check` (format, TypeScript, Vitest, and package validation).
4. Optional render micro-benchmark if the footer usage calculation or wrappers show a
   measurable regression; do not add speculative caching.

With explicit approval before touching live config, point Pi at the local package paths,
reload, and capture the same states as the supplied references:

- long assistant prose/code at normal and narrow widths;
- empty, one-line, wrapped, and multiline active prompt;
- submitted prompt directly beside its active-state screenshot;
- singleton/grouped tools in pending, success, failure, image, and expanded states;
- single/parallel/chain subagents collapsed and expanded;
- thinking while streaming, immediately settled, and restored after resume;
- footer working/idle with stats off/on and long cwd/session/model labels; and
- selectors/dialogs/overlays to confirm they remain edge-to-edge/native.

The first live review is a tuning gate, not an architecture rewrite. Adjust only the
small visual constants unless a behavior or compatibility issue is exposed.

**Exit:** `npm run check` passes, manual states are verified, and any skipped live check
is recorded with the exact next step.

### WP8 — Align transcript text columns to the rail

**Outcome:** every left edge the eye tracks shares one column: system status text,
assistant chat text, active input text, and the submitted-message rail all start at
`OUTER_INSET` (column 2). Submitted message text stays inside its rail block.

Measured baseline (CleanShot 2026-08-18, ~26-column window, 16 px character pitch):

| Element                           | Live column | Target column         |
| --------------------------------- | ----------- | --------------------- |
| System status text (`showStatus`) | 1           | 2                     |
| Submitted rail `▎`                | 2           | 2                     |
| Active input text (cursor)        | 2           | 2                     |
| Assistant chat text               | 3           | 2                     |
| Submitted message text            | 4           | 4 (inside rail block) |

Status (2026-08-18): code-side complete; awaiting live visual confirmation.

1. ~~Reload Pi with the current checkout and re-measure.~~ Verified headlessly instead:
   the render stack is deterministic, and the new contract test drives the real
   components through the patches. File mtimes confirmed the screenshot (16:53) predates
   the `index.ts` edit (16:59) that added the system-container patch and the native-pad
   subtraction, and Pi's extension loader creates a fresh jiti per load with
   `moduleCache: false`, so `/reload` always picks up current source.
2. System rows: no matcher miss found; `isSystemTextChild` matches the `showStatus`
   shape (`Text` with `paddingX: 1, paddingY: 0, customBgFn: undefined`).
3. Assistant rows: no `nativeInset` miss found; `outputPad` reads 1 and the decorator
   reduces the inset accordingly.
4. ~~Add focused tests~~ Done: one shared-column contract test pins the exact left
   column of system status rows, assistant markdown, the submitted rail, submitted text
   (`OUTER_INSET + 2`), and active editor text with `editorPaddingX: 1` composed with
   `ACTIVE_SIDE_PADDING`.
5. ~~Re-run the focused suites and the root gate~~ Done: 16/16 `pi-content-layout`
   tests pass; root `npm run check` exits 0.
6. Remaining: user `/reload` in the live session and a fresh screenshot confirming all
   four anchors at column 2.

**Exit:** a fresh screenshot shows all four anchors at column 2 and the column-pinning
tests pass.

### WP11 — Restore tool grouping via container hook composition

**Outcome:** tool grouping/collapse and the system-message inset work together in both
extension load orders, and `edit` rows show `edit <path>` instead of raw JSON.

Status (2026-08-18): code-side complete. Content-layout and tool-marker composition tests
pass in both load orders; the root gate passes. Awaiting the user's live `/reload` visual
confirmation before closing WP11.

1. Add a duplicated ~20-line hook-runner helper in both packages:
   `Symbol.for("kg.pi.chatContainerHooks.v1")` on globalThis holds a `Set` of
   `(container, children, width) => restore | undefined` hooks; the runner executes all
   hooks with per-hook error isolation and returns a combined restore. Duplication
   follows decision 9 (no runtime coupling; the Symbol key is the shared contract).
2. `pi-content-layout`: move the system-text inset from whole-container child
   interception to instance-level `Text.render` decoration inside a registered hook
   (reentrancy-guarded for the nested-wrapper case). Its container wrapper shrinks to
   run-hooks + delegate + restore. Unregister the hook on `session_shutdown`.
3. `pi-tool-call-markers`: run the registry hooks inside `renderWithCollapsedToolGroups`
   before grouping and restore in `finally`. No other grouping change.
4. `pi-tool-call-markers`: add the `edit` case to `selfRenderedCallLabel`
   (`edit <path>` when `args.path` is a non-empty string).
5. Tests: real-`Container` composition test in markers (registry hook runs during grouped
   render; restore runs after); content-layout test simulating a non-delegating outer
   wrapper that runs hooks (system text still inset); hook unregistration on shutdown;
   `edit <path>` label for real-shaped edit args; keep the generic JSON fallback tests.
6. Run focused suites, then the root gate; ask the user to `/reload` and visually confirm
   grouping plus alignment together (WP8's open live check).

**Exit:** grouped tools and system/assistant alignment are simultaneously visible in a
fresh screenshot; both packages' focused tests and the root gate pass.

### WP10 — Reconcile local main after the isolated release

**Outcome:** local `main` contains the published four-commit history plus the existing local
footer degradation commit, with all uncommitted redesign files restored and no duplicate
welcome or stale lockfile changes.

Read-only overlap analysis found one committed conflict: upstream formatted
`pi-footer-minimal/src/index.ts`, while local commit `1254aeb` changes its narrow-width cost
degradation. The current working copy already contains both behaviors. Published welcome
source changes duplicate the working changes; the release version exists only upstream.
The working lock mixes the new `pi-content-layout` workspace with stale package versions and
must be regenerated on the reconciled tree.

Completed protected sequence:

1. Created backup branch `backup/pi-redesign-pre-reconcile-20260818-2343`, a binary tracked
   patch, an untracked archive, and a status manifest before stashing.
2. Rebasing the single footer commit produced the expected formatting conflict; resolution
   kept upstream formatting and reapplied only the cost-degradation behavior. Rebased commit
   is `e80fd0f`.
3. Applied—not popped—the stash. Every tracked and untracked file byte-matched the saved
   stash except the intentionally regenerated lockfile. Duplicate welcome diffs disappeared,
   while package version 0.1.6 remained.
4. Regenerated `package-lock.json`; its only working diff is the new `pi-content-layout`
   workspace. Local `main` is ahead 1 and behind 0.
5. Focused tests pass (202/202), and the complete root gate passes (342/342 Vitest tests plus
   formatting, type-check, and package checks). The temporary stash was dropped only after
   validation; the backup branch and external artifacts remain.

**Gate:** complete.

### WP12 — Uniform tool colors and prompt surface background

**Outcome:** settled tool rows render in one muted tone, and both user-input surfaces
(active editor block, submitted message body) share a fixed `#071312` background.

Status (2026-08-19): code-side complete; awaiting live visual confirmation alongside
WP8/WP11.

1. `pi-tool-call-markers`: group headings, bullets, summaries, outcomes, and the raw-args
   fallback moved from `toolTitle`/`dim`/`accent` to `muted`; bold retained on
   marker/headings. `warning`/`error` stay semantic; subagent cards unchanged.
2. `pi-content-layout`: `paintBackground` now takes a literal background ANSI; the two
   prompt surfaces pass the exported `PROMPT_SURFACE_BG` (`#071312`) instead of the
   theme's `selectedBg`. No theme edit.
3. Tests: a color-tagging theme asserts settled group/singleton output contains only
   `muted` spans; the semantic-foreground test now expects muted settled outcomes with
   warning/error unchanged; background assertions across three content-layout suites
   pin `PROMPT_SURFACE_BG`.
4. Focused suites pass (133 markers, 18 content-layout). Root `npm run check` passes
   (343/343 Vitest, formatting, type-check, package checks); one transient
   welcome-screen retry-test flake on the first attempt passed on the immediate re-run
   and is unrelated to these files.
5. Remaining: user `/reload` + fresh screenshot for uniform tone and darker surface.

**Exit:** settled tool rows show one tone and both prompt surfaces show `#071312` in a
fresh screenshot; root gate passes.

### WP13 — Footer top row, full-red errors, wider submitted pad

**Outcome:** one blank row separates the active input surface from the footer; failed
tool rows read as fully red; submitted messages get a two-space pad after the rail.
Tool-block spacing is unchanged after the F25 live-review revert.

1. `pi-footer-minimal`: prepend one blank row to the footer render; flip the
   zero-separator contract test to a one-row contract (F23, supersedes F9).
2. `pi-tool-call-markers`: failed singleton headlines and failed group bullets render
   entirely in `error` — marker, label, outcome, arrow, and truncation ellipsis — via a
   color parameter on `styledCallLabel`/`compactBulletLine` driven by `rowHasFailed`
   (F24).
3. `pi-content-layout`: prepend one extra space inside the submitted-message body so
   text sits two columns right of the rail; update the shared-column contract
   (`OUTER_INSET + 3`) and rail assertions (F26).
4. `pi-tool-call-markers`: thread a color-matched suffix through
   `fitSummary`/`fitSummaryTail` at the collapsed headline, group bullet, and subagent
   card call sites so pi-tui's truncation reset cannot leave a default-foreground
   ellipsis (F27).
5. Tests: one-row footer separator; tagging-theme assertion that failed rows emit only
   `error` spans; real-renderer assertion that truncated settled rows end in a
   muted-coded ellipsis and failed rows in an error-coded one; submitted-pad column
   pins; F25 revert verified by the pre-existing spacing assertions.
6. Focused suites, then the root gate; user `/reload` visual confirmation.

Status (2026-08-19): code-side complete. Root `npm run check` passes (345/345 Vitest,
formatting, type-check, package checks) before F27; F27 adds focused markers tests
(135/135) with the full gate below. Awaiting live visual confirmation.

**Exit:** the three landed changes visible in a fresh screenshot; focused tests and the
root gate pass.

### WP14 — Control-byte sanitization, commit train, review loop, publishes

**Outcome:** the F28 sanitization fix lands, all redesign work is committed in logical
sequence, passes a two-cycle review loop, and each changed extension publishes
independently.

1. F28: `sanitizeInline` in `pi-tool-call-markers` strips display ANSI and control
   bytes (`\r` included) from collapsed-row text; error outcomes split on `\r` as a
   line separator. Focused test proves no control bytes survive a failed row whose
   output carries git progress text. Done: 136/136 markers tests pass.
2. F29: answered — pi-intercom's own renderer owns the card's inner padding; no repo
   change.
3. Commit the uncommitted redesign work in logical order: `pi-content-layout` (new
   package), `pi-tool-call-markers`, `pi-footer-minimal`, `pi-inline-identifier`, then
   root docs/plan. Commit messages follow `/write-pr-desc` conventions.
4. `/review-my --loop 2 --fix` on the committed diff; apply judged fixes and re-gate.
   Cycle 1 (assessment → judgment → execution chain) landed four fixes: scrape
   sanitization applied to content not just measurement, failed subagent-card ellipsis
   tone, F21/F22 doc drift in READMEs/CHANGELOGs, and a dual-instance editor-decoration
   pin for `pi-inline-identifier`. F30 (subagent plan display) replaced the card those
   fixes touched; cycle 2 covered the cycle-1 fixes plus F30. Cycle 2 landed five
   more (subagent-plan docs, superseded changelog bullets, dead mock, self-rendered
   label sanitization, container-hooks package pin). The terminal review requested
   changes; all six findings were reconciled in-session: grouping now goes inert
   when its shutdown is shadowed (Q1 High), subagent fields and OSC payloads are
   sanitized (Q2 High), footer disposal releases working-state ownership (Q3
   Medium), tiny-width footer budgets the full width (Q4 Low), README drift (S1),
   and real editor input behavior is pinned through the decorated proxy (S2).
   Root gate after reconciliation: 356/356.
5. `/publish-pi-ext` for each changed package. Completed: `pi-tool-call-markers`
   0.2.5 and `pi-inline-identifier` 0.1.4 published via OIDC, verified on npm,
   installed locally (`pi update`), and the markers entries in both settings files
   were restored from the local checkout path to `npm:@pi-kaush/pi-tool-call-markers`
   (matching the WP9 welcome-screen precedent). Standalone loadability held: the
   hook registry is a no-op when the other package is absent, and each suite passes
   alone.

   Resolved (2026-08-19): the user completed the npm web login + security-key
   step and configured trusted publishers for both new packages. pi-content-layout
   published manually at 0.1.0 and via OIDC at 0.1.1 after the publish workflow's
   tag allowlist and resolver learned both package names (release events run the
   workflow from the release tag, so the fix tag had to move). Final published
   state: `pi-content-layout` 0.1.1, `pi-footer-minimal` 0.1.1 (F31 included),
   `pi-tool-call-markers` 0.2.6 (F32 included), `pi-inline-identifier` 0.1.4;
   all three redesigned packages now load from npm in both settings files, and
   the README lists every package in the published table.

**Exit:** every changed extension published (or an exact blocker recorded), main
pushed, review-loop findings resolved or deferred with reasons.

## Risks and mitigations

1. **Native message rendering has no public override.** User/assistant/thinking changes
   need guarded adapters around exported Pi classes. Keep them small, reversible, tested
   against the installed runtime, and fail open to native rendering.
2. **Editor decoration can accidentally swallow autocomplete or another extension.**
   Compose the existing factory, decorate rendering only, and test `pi-inline-identifier`
   in both orders before accepting the active prompt block.
3. **Multiple extensions can stack layout twice.** Give each component one owner,
   explicitly test both load orders, and assert visible inset rather than raw spaces.
4. **Hiding native working state can leave no status after reload.** Restore visibility on
   shutdown/disposal and use settled/abort cleanup in addition to the happy path.
5. **Subagent argument shape can evolve.** Detect conservatively and fall back to the
   generic marker; never assume task/profile fields exist.
6. **Current package types and live runtime differ.** Preserve the existing `>=0.80.6`
   floor where feature detection can bridge it; raise the floor only if a required public
   API has no safe fallback, and make that a review decision before editing metadata.

## Non-goals

- Recreate OpenCode's entire header, dialogs, command palette, or footer information
  architecture.
- Move the model/mode row into the active prompt block.
- Change markdown typography, syntax highlighting, terminal font, or model output.
- Replace Pi's editor input/key handling.
- Expand all tools by default or discard errors/outcomes for visual minimalism.
- Add configuration UI before the fixed visual prototype is accepted.
- Publish or release any package.

## Blockers and review gates

**Release complete (2026-08-18):** the isolated release pushed the approved footer
format commit, welcome feature commit, `release: @pi-kaush/pi-welcome-screen@0.1.6`, and a
workspace lock sync. The first OIDC run (`32223868307`) exposed the stale lock and failed
before npm publish; after approval, the failed release/tag was recreated at the fixed commit.
Run `32224014778` succeeded, npm reports 0.1.6, both Pi settings owners use the unpinned
`npm:@pi-kaush/pi-welcome-screen` source, `pi update` succeeded, and `pi list` plus the
installed manifest verify 0.1.6. Clean `npm ci`, the full gate (21 files, 288 tests), and all
package checks pass. The original checkout is reconciled: local `main` is ahead 1 and behind
0, all redesign work is restored, and the release version and lockfile updates are retained.

Four reversible visual choices also remain for the first live screenshot review:

- outer inset starts at two columns;
- working state is a single mandatory braille cell immediately before the model;
- marker mapping starts as `%` tool, `•` grouped child, native spinner for live
  thinking, and `+` for settled thought;
- subagent titles start from humanized profile/kind plus the first task sentence.

If any of these feel wrong in the TUI, change the constants/formatter before hardening
snapshots. A package rename from the working name `pi-content-layout` should also happen
before any publish request, not afterward.

## Decision log

1. **Theme for color, extensions for shape.** Pi themes cannot add margins, rails,
   component backgrounds by state, or relocate activity indicators.
2. **New focused layout package.** Transcript/editor layout is separate from footer and
   tool ownership, making each part removable without collateral behavior changes.
3. **Compose the editor, do not replace its behavior.** The render-only wrapper gives the
   requested block while preserving Pi and extension input handling.
4. **Keep tool grouping.** Minimal means removing the box/badge, not throwing away the
   scan benefit of adjacent grouped calls or right-side outcomes.
5. **Subagent is a special collapsed shell.** It has materially different semantics and a
   useful expansion affordance, so it should not disappear into an ordinary tool group.
6. **Footer owns working animation.** This lets the native working row and timer be
   disabled instead of duplicated.
7. **Live thinking reuses Pi's spinner.** Native content updates select a frame from
   Pi's braille sequence and provide the duration timestamps; a second animation loop
   would add load without improving the label.
8. **Private adapters fail open.** Visual fidelity is less important than keeping Pi
   usable after an upstream component change.
9. **Duplicate tiny layout constants over runtime coupling.** Independent extensions stay
   easier to remove, publish, and debug; integration tests prevent drift.
10. **No initial theme edit.** Existing `cobalt2` tokens already provide the submitted,
    accent, muted, warning, and error colors needed by the current prototype; tune the
    theme only after the structure is accepted.
11. **Patch both resolved editor prototypes when distinct.** npm can give Pi's
    `CustomEditor` and an extension separate `pi-tui` class instances; covering both in
    `pi-inline-identifier` preserves decoration without coupling the layout package to
    identifier internals.
12. **Footer-owned separation was an intermediate prototype.** The initial leading blank
    row isolated footer spacing from editor behavior, but live feedback superseded it in
    decision 15.
13. **Active and submitted prompts intentionally diverge (superseded by decision 16).**
    The intermediate version shared a rail but changed background after submission.
14. **Working is a mandatory right-side indicator, not a label.** A single animated cell
    communicates activity without spending width on `Working…`. It stays immediately left
    of the right-aligned model in the smallest `spinner + model` core, so optional fields
    disappear first and its position remains stable.
15. **The bottom active-padding row owns the final breathing room.** A separate footer
    blank row is redundant, regardless of whether the active surface uses a rail or a full
    background. Footer metadata begins on the next row.
16. **Active is full-width; submitted stays compact.** The active editor prioritizes a
    strong edge-to-edge input surface using `selectedBg`, while submitted messages retain
    their inset rail shell. This is intentional state-specific geometry, not a shared shell.
17. **Provider is optional detail, not line-1 identity.** Moving it to
    `/footer-more-stats` prevents provider length or degradation from shifting the work
    indicator. Model plus active spinner remains the stable line-1 identity.
18. **Background width and text inset are independent.** The active background remains
    edge-to-edge, while one extension-owned column wraps each side of Pi's editor. This
    aligns text with the two-column footer without changing global `editorPaddingX`.
19. **One shared text column anchored at the rail.** System status text, assistant text,
    active input text, and the submitted rail all start at the two-column outer inset;
    submitted text remains inside its rail block. The fix lives in `pi-content-layout`
    rather than Pi settings because `showStatus` rows and native `outputPad` stacking are
    not reachable through settings.
20. **Container-level concerns compose through hooks, not wrapper stacking.** Two
    whole-container `render` replacements cannot both run; the outer always shadows the
    inner. A tiny globalThis hook registry (keyed by `Symbol.for`, duplicated runner per
    package) lets each extension contribute child decoration without module coupling,
    and fails open when either package is absent.
21. **Welcome padding participates in responsive width.** Reserve four edge columns—two
    per side—before selecting grid count and column widths. This guarantees breathing room
    instead of painting a nominal margin that wide layouts can overflow.
22. **Isolate the welcome release with Graft.** The user chose a clean checkout from
    `origin/main`, so the existing local footer feature commit and all uncommitted redesign
    packages remain untouched. The release carries only the welcome diff plus separately
    approved prerequisites needed to restore the base branch's release gate.
23. **Treat CI installability as part of the release gate.** Local `npm run check` can pass
    with an existing `node_modules` even when the lock omits a workspace. Release recovery
    must verify `npm ci --ignore-scripts` from the committed lock before recreating a failed
    release event.
24. **One tone carries no hierarchy; semantics do.** Settled tool rows use a single
    `muted` tone — color stops distinguishing heading from summary from outcome — while
    `warning` and `error` remain reserved for pending and failure states that must stay
    obvious. Subagent cards keep the accent rail because they are a distinct element,
    not an ordinary tool row.
25. **Surface-specific colors can override the theme locally.** The two user-input
    surfaces needed a fixed hex the theme's `selectedBg` does not provide; a
    `PROMPT_SURFACE_BG` constant in `pi-content-layout` scopes the override to exactly
    those surfaces, leaving the theme token for selections and dialogs and keeping the
    external theme file untouched.
26. **Rebase the one local commit; do not merge release history back into `main`.** A backup
    branch, binary patch, untracked archive, and retained stash make the rewrite reversible.
    Resolve the only semantic overlap explicitly, discard duplicate welcome patches, and
    regenerate the lock from the final workspace set.
