# @pi-kaush/pi-tool-call-markers

Give Pi's collapsed tool calls a quiet, width-safe transcript shell while preserving native details under `Ctrl+O`. The package also includes a display-only thinking-block adapter.

### Install

```fish
pi install npm:@pi-kaush/pi-tool-call-markers
```

Restart Pi or run `/reload`.

## What it changes

Collapsed tool rows use semantic theme colors with no gear, background fill, box padding, or filled blank rows:

```text
  │ ● src/a.ts                         42 lines
  │ ● src/b.ts                         18 lines
  │ $ npm test → done
```

- **Two-column outer inset.** Tool markers and image output align with an inset conversation surface. Very narrow terminals reduce the decoration before useful content.
- **`│` tool-call rail.** Every collapsed call anchors on a bold glyph instead of its tool name — `●` read, `+` write, `±` edit, `○` local search, `≡` ls, `↗` web search and fetch, and `$` bash; unmapped tools fall back to `*` — with a single space between the anchor and the call text, no joining colon. Grouped rows flow directly across tool types.
- **Semantic, low-contrast status.** The anchor and the call content share the collapsed mute, pending state is warning-colored, and failures remain error-colored. Ordinary tool states have no background.
- **Width-safe outcome tails.** Long summaries truncate before useful tails such as `→ done`, `→ 42 lines`, `→ +2/-1`, or a `bash` duration.
- **Stable running groups.** Adjacent calls group as they appear, including settled failures, which stay error-colored inside the group. Pending state and elapsed `bash` time settle into the final outcome without changing the row count.
- **Quiet-turn grouping.** Sequential calls can join across an assistant row with no visible prose or thinking. Visible assistant content remains a boundary.
- **MCP and self-rendered tools.** Their stable call labels, compact arguments, pending state, success, and first error line use the same collapsed shell. Native self-rendered details return when expanded.
- **Images remain visible.** Image fallback text and terminal image components render below the corresponding marker with the same inset.
- **User-run `!` bash blocks.** Execution display is owned here: user-typed commands trade Pi's green rules for the railed prompt shell (dark surface, status-colored rail) that submitted prompts use.
- **Native expansion remains authoritative.** `Ctrl+O` restores Pi's full individual tool rendering, including complete results, custom renderers, and error details.

## Subagent plans

A recognized `subagent` call renders as an unboxed plan in the shared tool aesthetic, marked with `↪` instead of the ordinary `│` tool-call rail:

```text
  ↪ subagent chain (3 steps) [repo-review]
    1. 🐝 bee [workhorse] Challenge the compatibility conclusion…
    2. 🐝 bee …
```

Single calls stay on one `↪ [<emoji>] [<profile>][<agent>] <task preview>` row — no tool label; the `↪` marker identifies it. Chain calls get a heading with the kind, count, and scope followed by numbered steps (parallel tasks list without numbers), with each step ordered emoji, profile badge, name badge. Agent display names (emoji + name) are scraped from the native plan component — including the single-call heading — with an args fallback, and render in `accent`; everything else stays muted, and failed subagents go full red. Subagents never join ordinary tool groups.

While a subagent runs, the plan headline's tail shows live progress from the streamed result details — `→ 1 turn · provider/model` in the warning tone — and a settled call keeps the same `→ N turns · provider/model` summary in muted (turns aggregate across tasks; the model shows only when every task used the same one).

Malformed, ambiguous, future, or too-narrow shapes fall back to the generic `↪ subagent …` collapsed row rather than dropping information, and `Ctrl+O` still exposes the native subagent renderer.

## Asked questions

A call that asks the user something is a user-input moment, not an execution row, so it renders in the submitted-prompt shell instead of the tool-call rail:

```text
  ▎
  ▎ > Which call-site shape should `notifications:` use?
  ▎ User: Nested within subagent (Recommended)
  ▎ > Which tier should the flag read at runtime?
  ▎ User: Client only, Client and server
  ▎
```

The block reuses `pi-content-layout`'s submitted-prompt geometry — the same rail, surface, inset, one-column left padding, two-column right padding, and background padding rows — so an asked question and a submitted prompt are the same shape in the transcript.

- **Shape-first recognition.** Any tool whose result carries an `answers` array of `{ question, answer | selected }` entries renders as a question block, so another author's question tool works without a change here. The tool name (`ask_user_question` and close variants) is the fallback for a call that failed before answering.
- **Answers, not options.** Each question shows its answer: an option label, typed custom text, or multi-select labels joined with commas. A question left blank reads `User: (no answer)`, a decline reads `User declined to answer questions`, and a validation failure keeps Pi's native failure row.
- **Quoted questions.** The question is the model's text read inside a user-input shell, so it renders italic under a `>` marker and the answer stays upright: the answer is the user's own words. A theme without italics renders the question plainly.
- **Prompt-shell tones.** The rail uses `borderAccent` and the body paints on `userMessageBg`, with the question in `text`, the `User:` label in `muted`, the answer in `userMessageText`, and a live row's `awaiting your answer…` in `warning`.
- **No grouping.** Question blocks never join an adjacent tool group and carry no tool glyph. `Ctrl+O` still restores Pi's native expanded rendering.

## Edit diffs

Settled `edit` calls collapse like every other row: the call line keeps its path and a `+added/-removed` outcome stat, and the hunk itself stays out of the collapsed row. `Ctrl+O` restores Pi's full native diff, including line numbers and intra-line word highlights. To keep edits expanded without pressing `Ctrl+O`, list `edit` in `PI_ALWAYS_EXPANDED_TOOL_CALL_MARKERS` (see Configuration).

Files and paths in collapsed rows are preserved as displayed by Pi: hyperlink-wrapped paths (Pi wraps `read` call paths in OSC 8 hyperlinks) keep their visible text when sanitized for one-line rows.

## Scope boundary

This package owns every **execution row** in the transcript: collapsed tool calls, tool grouping, subagent plans, asked-question blocks, thinking labels, and user-run `!` bash blocks (reshaped into the railed prompt shell). Transcript _surface_ layout — message insets, system-text and status-rule alignment, the editor surface, and the submitted-prompt shell for user messages — belongs to `@pi-kaush/pi-content-layout`, which never renders tool rows.

One shared visual contract crosses the line: `!` blocks and asked-question blocks align with message text, so their inset mirrors `pi-content-layout`'s message `contentInset` (see `src/prompt-shell.ts`, which owns the railed shell both use). Change indentation in both packages together.

## Hiding info entirely: /toggle-info

The default transcript keeps tool calls and thinking collapsed, and Ctrl+O /
Ctrl+T expand them as usual. When you want prose only, `/toggle-info` hides
tool calls (including user-run `!` blocks) and thinking completely; running it
again restores the collapsed view. The toggle is per-session: every session
starts visible.

## Bundled thinking-block extension

The second package entrypoint, `src/thinking-block-merger.ts`, combines only directly adjacent `thinking` blocks in a display copy. Tool calls, text, provider blocks, signatures, and stored session messages are unchanged.

When Pi exposes its per-row hidden-thinking and streaming fields, hidden reasoning uses these native-themed labels:

```text
⠋ Thinking…  →  ⠙ Thinking…  →  …
+ Thought · 2.5s
```

The live label samples Pi's native braille spinner sequence from the content updates Pi already renders; it does not add a timer. The adapter stores the first local streaming timestamp per assistant row in a `WeakMap`. A restored message or an older runtime with no streaming argument uses `+ Thought`. There is no interval, timeout, render request, model call, or network work.

Pi renders thinking labels and traces italic. This package drops those italics: both labels read as plain collapsed rows (the live spinner keeps its thinking-level tint, the settled row the muted tone, and a theme that resolves no color still loses the italics), and a visible trace stays italic only while it streams, then settles into ordinary transcript text. `PI_TOOL_CALL_MARKERS_THOUGHT_COLOR=inherit` is the opt-out that keeps Pi's native italic `thinkingText` styling.

## Local development

```fish
pi \
  -e ./extensions/pi-tool-call-markers/src/index.ts \
  -e ./extensions/pi-tool-call-markers/src/thinking-block-merger.ts
```

## Configuration

Grouping calls from the same assistant message is enabled by default. Pi normally executes those calls in parallel. To keep same-message calls as individual compact rows while continuing to group sequential calls across quiet turns:

```fish
set -lx PI_TOOL_CALL_MARKERS_COLLAPSE_PARALLEL 0
pi
```

`0`, `false`, `no`, and `off` disable parallel grouping. `1`, `true`, `yes`, and `on` enable it. The value is read when the extension loads.

To render chosen tools as Pi's native expanded block by default — full result and diff without `Ctrl+O` — list their names:

```fish
set -lx PI_ALWAYS_EXPANDED_TOOL_CALL_MARKERS edit,write
pi
```

Names are comma-separated and matched exactly. Listed rows never join a group, and the list stays authoritative: collapsing the transcript with `Ctrl+O` re-expands them. The value is read when the extension loads.

### Collapsed-row colors

Collapsed rows (tool calls, `+ Thought`, subagents) default to the theme's `syntaxComment` color — it ships with every Pi theme and reads as a muted tone — with the row's anchor and the call content sharing it. Failures stay error-colored and live spinners keep their existing tints.

A theme can override each collapsed kind independently with optional color tokens:

```json
{
  "colors": {
    "collapsedToolCall": "#6272a4",
    "collapsedThinkingCall": "#6272a4"
  }
}
```

## Compatibility and fallback policy

**Compatible Pi version:** `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` `>=0.80.6`.

Pi has no public hook for native tool rows, transcript grouping, or per-message hidden-thinking labels. The package therefore uses three small guarded prototype adapters:

- `ToolExecutionComponent` for collapsed presentation;
- `Container` for adjacent grouping; and
- `AssistantMessageComponent.updateContent` for display-only thinking merging, lifecycle labels, and the settled trace's italics.

Each adapter feature-detects the fields and methods it needs, keeps the original method, uses an idempotency symbol, catches cosmetic failures, and restores the original on `session_shutdown` when it still owns the patch. Unsupported shapes fail open to Pi's native rendering. The thinking adapter continues adjacent merging even when the private label shape is unavailable.

Teardown is owner-counted and inert: when another extension's wrapper sits above one of these, removal is impossible, so the buried wrapper delegates to the original instead of leaving collapsed rows or restyled labels behind after its owner shuts down. A later install re-enables it. The shared chat-container hook contract applies the same fail-open rule to hooks: a hook that throws after editing the child list has its edit rolled back, so a failed hook cannot drop rows from the transcript.

Colors are read live from the theme, so a mid-session theme switch repaints collapsed rows, labels, and `!` blocks; cached render output keys on the resolved palette rather than on the theme object, which Pi keeps stable across a switch.

Expanded tools always use Pi's native renderer. The collapsed tool shell owns its two-column inset directly; transcript layout extensions should leave tool rows unchanged, preventing load-order-dependent double padding.

> TODO: migrate these adapters to public Pi transcript and tool-rendering APIs when available.

## Design

- No runtime dependencies.
- No mutation of tool arguments, tool results, provider content, or session messages.
- Group output is cached per row and invalidated on meaningful display transitions.
- No timers or independent render loops.

## Development

From the repository root:

```bash
npx vitest run extensions/pi-tool-call-markers/test
npm run typecheck
npm run package:check --workspace @pi-kaush/pi-tool-call-markers
```

Inspect the publish payload:

```bash
npm pack --workspace @pi-kaush/pi-tool-call-markers --dry-run
```

## License

MIT
