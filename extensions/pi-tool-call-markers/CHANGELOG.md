# Changelog

## Unreleased

- Render an asked question as a user-input moment instead of a raw tool row.
  `ask_user_question` used to collapse to `│ * {"questions":…`, which is a tool
  call marker doing the work of a prompt. An asked question now takes the
  submitted-prompt shell: `▎ > <question>` followed by `▎ User: <answer>`, one
  pair per question, with multi-select labels joined, a decline reading
  `User declined to answer questions`, and a live row showing
  `awaiting your answer…`. Recognition is shape-first off
  `details.answers`, so another author's question tool renders the same without
  a change here; the tool name is the fallback for calls that never answered.
  The block reuses pi-content-layout's submitted-prompt geometry — rail,
  surface, inset, one-column left and two-column right body padding, and
  background padding rows — and italicizes the question while the answer stays
  upright. Question blocks never join a tool group, and `Ctrl+O` still restores
  Pi's native expanded rendering.

- Make the railed shell's body padding explicit: `renderRailedBlockLines` takes
  a `{ left, right }` padding, so the submitted-prompt shape (1/2) and the
  existing `!`-block shape (1/0) come from one code path instead of the body
  width being hardcoded.

- Extract the railed prompt shell into `src/prompt-shell.ts`. User `!` blocks
  and asked-question blocks share one implementation of the inset, rail,
  surface background, and background repaint instead of two.

- Read colors from the live palette instead of caching them against the
  theme object. Pi swaps the palette behind a stable theme Proxy, so every
  identity-keyed cache survived a theme switch: collapsed rows, the `+ Thought`
  label, and user `!` blocks kept the old colors until their content changed.
  Probes are map lookups, so the render caches now key on the resolved colors
  (`paletteSample`, including the bash-block line cache) and the label
  resolves its style per call.

- Stop grouping from resurrecting a tool that opted out of the transcript. A
  self-rendered tool that draws no lines stays hidden whether it renders alone
  or beside another call: the singleton and grouped paths share one
  draws-nothing rule.

- Go inert at the final owner's shutdown. Every prototype wrapper — tool
  presentation, container grouping, user bash blocks, thinking — delegates to
  the original when another extension's wrapper has buried it and removal is
  impossible, so collapsed rows and restyled labels cannot outlive their owner.
  A later install re-enables the same wrappers.

- Roll back a container hook that mutates the child list and then throws.
  Its edit used to stick, dropping those rows from every later render. Both
  copies of the shared hook contract changed together.

- Own and release `/toggle-info` with the rest of the extension: the
  process-global filter hook and the hidden flag now leave with the last owner
  instead of filtering a transcript this package no longer renders.

- Track thinking rows for the `/toggle-info` replay instead of every assistant
  row, capped at 400 entries, so a long session or an abandoned branch cannot
  pin every message the transcript ever showed.

- Delete state nothing reads (the row→group map) and the duplicate
  `session_start` handler that applied the collapsed default twice.

- Drop the colon after every collapsed-row anchor: glyph rows read
  `│ ● src/a.ts` and bash rows `│ $ npm test`. The anchor runs bold with a
  single space before the call text, so the anchor alone separates the two.
  The whole seam — glyph map, `$` prompt, subagent fallback heading, and the
  tool-token drop — now lives in one function that both the singleton and
  grouped render paths call, and self-rendered labels no longer leak their
  tool name into the row under themes that tag instead of color.

- Drop the italics Pi puts on thinking. The hidden `+ Thought` label renders
  plain in every theme — the live spinner keeps its level tint, the settled
  row its muted tone, and a theme that resolves no color still loses the
  italics — and the visible trace stays italic only while it streams, then
  renders as ordinary transcript text once the row settles. The live/settled
  rule is shared with the label, so un-flagged row rebuilds (resize, theme
  switch) keep a live trace italic and a finished one plain.
  `PI_TOOL_CALL_MARKERS_THOUGHT_COLOR=inherit` remains the only opt-out that
  keeps Pi's native italic styling.

- Fail open when a theme rejects a thinking token. Pi's Theme throws on
  tokens it does not know, so the label probe now falls back to the plain
  treatment instead of throwing out of the row's update pass.

- Restore Pi 0.85's click-to-expand under the custom collapsed rows. Pi routes
  mouse clicks by per-child rendered line heights, and the grouping render
  bypassed the native render that refreshes that cache, so clicks on anything
  drawn after the first tool call landed nowhere (or one line off after a
  resize). The grouped render now publishes the drawn accounting, and a
  collapsed tool row toggles expansion on left-click like Pi's native result
  region.

- Restyle subagent rows: the subagent marker is now `↪` (was `&`), and single
  calls drop the `subagent` tool label — `↪ 🤖 [coder][c3po] Implement the…` —
  with chain/parallel step lines reordered to emoji, profile badge, name badge
  (`1. 🐝 [workhorse][bee] …`). Single-call headings are now scraped too, so
  agent emojis appear on single rows, not just chain/parallel steps.

- Color collapsed rows (tool calls, `+ Thought`, subagents) from the
  theme's `syntaxComment` token — which ships with every theme — instead of
  the louder muted/toolTitle/toolOutput split. The bolded tool name and the
  call content share the single tone, so collapsed blocks read as one
  muted unit under any theme without per-theme tuning. Failures stay
  error-colored and live spinners keep their thinking-level tint.
- Add optional `collapsedToolCall` and `collapsedThinkingCall` theme color
  tokens to override each collapsed kind independently; themes without
  them are unchanged.
- Fix settled "+ Thought" labels keeping stale colors after a mid-session
  theme switch: label styles now recompute whenever the theme object
  changes instead of only on session start and thinking-level selects.
- Add `/toggle-info`: hide tool calls and thinking entirely, or restore them
  collapsed. Execution rows (including user-run `!` blocks) are lifted out of
  the render pass via the shared chat-container hook; thinking blocks are
  stripped before Pi builds the label/expanded block and replayed on restore.
  Every session starts visible, and Ctrl+O/Ctrl+T behavior is unchanged when
  visible. The toggle state lives on globalThis because Pi loads each package
  entrypoint through jiti with module caching disabled — module-level state
  would otherwise be duplicated between entrypoints.
- Adopt Pi's native content-color split in collapsed rows: tool names ride
  `toolTitle` and call content/outcomes ride `toolOutput` (structural
  chrome stays muted; failed rows stay uniformly error).
- Quiet the settled "+ Thought" label to the muted tone collapsed tool
  calls use; only the live "⠋ Thinking…" spinner keeps the session's active
  thinking-level tint (thinkingOff…thinkingMax), re-tinting on
  thinking_level_select; the expanded thinking block is untouched. The
  PI_TOOL_CALL_MARKERS_THOUGHT_COLOR values are `level` (default),
  `mdheading`, and `inherit`; the midpoint `gray` variant and its RGB
  color math are gone.
- Paint user-run `!` bash block surfaces with the theme's
  `userMessageBg` token instead of a hardcoded hex, matching
  pi-content-layout's prompt surfaces under any theme.
- Show subagent progress in the collapsed plan headline: while running, the tail reads `→ N turns · provider/model` in the warning tone from streamed result details; settled calls keep the same `→ N turns · provider/model` in muted instead of a bare `→ done` (turns aggregate across tasks, model only when all tasks agree).
- Source the settled "+ Thought" label color from the theme's mdHeading
  token (orange in cobalt2, amber in Pi's stock themes) instead of a
  hardcoded RGB. The PI_TOOL_CALL_MARKERS_THOUGHT_COLOR experiment values
  are now `mdheading` (default), `gray`, and `inherit`.
- Fix: preserve the visible text of hyperlink-wrapped paths in collapsed rows. Pi renders `read` call paths as OSC 8 hyperlinks (`ESC]8;;url ESC\ <path> ESC]8;; ESC\`); the previous greedy OSC strip consumed the path text along with the sequences, collapsing `% read: README.md:1-400` to `% read: :1-400`. OSC payloads now end at their first BEL/ST terminator, so `read`/`write`/`ls` rows show their filenames again.
- Show settled `edit` changes inline: the call line gains a `+added/-removed` outcome stat, and the display diff from `result.details.diff` renders as a bounded block underneath (`+` lines in the added tone, `-` in the removed tone, context muted, `...` for folded regions; capped at 12 lines with a `+N more` tail). `Ctrl+O` still returns Pi's full native diff.
- Render subagent plans with a `&` marker instead of `%`, so delegated calls read differently from ordinary tool rows (both the parsed plan shape and the generic fallback).
- Render user-run `!` bash blocks (BashExecutionComponent) with the railed prompt shell previously owned by `pi-content-layout` — execution display now lives entirely in this package, while `pi-content-layout` keeps only the transcript surface (message insets, status rows, editor, user prompts). The bash-block inset mirrors that package's message inset.
- Render every collapsed tool call as a `% tool: call → outcome` line with the tool name bolded — one marker per call, no bullets, no blank lines between sections; grouped blocks share only their leading blank row (supersedes the nested sub-heading layout).
- Render subagent calls as an unboxed plan — `% subagent` heading with chain/parallel counts and numbered steps as they execute, agent names in accent with emojis scraped from the native plan component (args fallback) — replacing the accent-rail card; failed subagents follow the full-red failure tone.
- Strip display sequences and control bytes (notably `\r` from progress writers like git) from collapsed-row text so command output cannot return the cursor to column 0 and overwrite the row.
- Color the truncation ellipsis to match its row tone (`muted` settled, `error` failed) instead of the terminal default foreground left by pi-tui's truncation reset.
- Render failed tool rows entirely in `error` — marker, call label, and outcome tail including the arrow and truncation ellipsis — so errored calls stand out as full red lines.
- Render settled tool rows in one uniform `muted` tone — group headings, bullets, summaries, and outcomes — while keeping `warning` pending and `error` failure states semantic.
- Compose container-level rendering through the shared
  `kg.pi.chatContainerHooks.v1` registry so grouping no longer shadows (or is
  shadowed by) `pi-content-layout`'s system-message inset in either load order.
- Label self-rendered `edit` rows by path (`edit <path>`), matching Pi's native
  call line instead of dumping the raw `{ path, edits }` JSON payload.
- Redesign collapsed tools as unboxed, background-free transcript lines with a two-column outer inset, `%` tool/group headings, `•` grouped children, and semantic low-contrast foregrounds with clear warning/error states.
- Preserve compact outcomes, right-hand tail reservation, `bash` duration, errors, image output, quiet-turn grouping, grouped-render caching, and MCP/self-rendered tool labels in the new shell.
- Keep expanded rows fully native so `Ctrl+O` restores complete results, custom renderers, and errors without collapsed decoration.
- Label hidden local reasoning with Pi's native braille spinner sequence (`⠋ Thinking…`, `⠙ Thinking…`, …) while streaming and `+ Thought · X.Xs` when finalized; use `+ Thought` for restored messages and older runtimes without streaming metadata.
- Track thinking duration per assistant row in a `WeakMap`, forward optional/future `updateContent` arguments, retain display-only adjacent thinking merging, and add no timer or render loop.
- Feature-detect private tool and thinking component shapes and fail open to Pi's native rendering while retaining Pi `>=0.80.6` support.
- Compact multiline singleton calls into one width-safe summary after settlement, including timeout metadata, while preserving the full native call under `Ctrl+O`.
- Group adjacent calls while they are still running, update pending outcomes in place, and merge sequential calls across quiet assistant turns.
- Add `PI_TOOL_CALL_MARKERS_COLLAPSE_PARALLEL`, enabled by default, to optionally keep same-assistant-message calls individual.
- Only invalidate grouped-render caches on meaningful state transitions.

## 0.1.2

- Keep grouping within one assistant tool batch, so a later pending batch does not reopen completed groups.
- Wait for every tool in a batch to settle, including tools beyond failed or expanded siblings.
- Preserve partial and image-bearing results instead of collapsing them.
- Treat self-rendered tools as owning their full shell and use only their stable header line in grouped summaries.

## 0.1.1

- Wait for every call in a contiguous parallel run to settle before grouping successful calls, which prevents completed prefixes and suffixes from repeatedly collapsing around active calls.

## 0.1.0

- Collapse adjacent successful tool calls into one compact block per tool type, each with a gear header and bulleted call summaries.
- Add vertical spacing between tool types and a hanging indent for wrapped bullet summaries.
- Keep visible thinking/text, active calls, and errors as group boundaries; expand errors in place.
- Combine only directly adjacent thinking blocks, falling back to Pi's renderer exactly once on malformed content.
- Restore individual full blocks when tools are expanded (Ctrl+O).
