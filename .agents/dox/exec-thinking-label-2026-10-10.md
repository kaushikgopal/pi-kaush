# Exec plan: tool-call-markers thinking label

## Goal

Make hidden thinking read as part of the collapsed tool-call column, and
keep it correct: the label must never hide reply text, must not look hung
while the model thinks, and must not cause terminal redraw churn.

Package: `extensions/pi-tool-call-markers` (main file
`src/thinking-block-merger.ts`). Pi loads it from the local checkout via
`~/.pi/agent/settings.json` (`../../dev/oss/pi-kaush/extensions/pi-tool-call-markers`).

## Status

| Step | State |
|---|---|
| Railed labels: `│ ⠋ Thinking…` settling in place to `│ * Thought · 2.5s` | Done, `972c17d` + `564be7a` |
| Fix replies replaced by the label (substring match on any text node) | Done, `564be7a` |
| Spinner advances on redraws, not only on thinking deltas | Done, `564be7a` |
| Review follow-ups (below) | Done, `157851b` |
| Publish 0.3.15, switch settings back to npm, update local packages | Done, `b971a8d` |
| Interleaved-thinking gap in follow-up 1 (below) | Done, `5ffe884` |

npm has 0.3.15 with all fixes. Pi loads it from npm again
(`npm:@pi-kaush/pi-tool-call-markers`).

## Review follow-ups (`157851b`, in `src/thinking-block-merger.ts`)

1. **Settle when the answer starts.** The label stayed live for the whole
   streaming message, so once answer text pushed it above the viewport every
   spinner frame (and earlier, every delta) changed an offscreen line, which
   makes pi-tui clear and replay the whole transcript. `answerStarted()` now
   settles the label at the first visible text or tool call after the last
   thinking block. Live labels are always the last line, and the duration is
   the real thinking time.
2. **Never restyle Markdown.** A click-revealed trace (or old-Pi prose) that
   exactly equals the label could still be animated over. Candidates are now
   judged per child, unwrapped from Pi's MouseRegion, and Markdown is
   excluded by duck typing (`theme`/`defaultTextStyle` fields). `instanceof`
   does not work: the package resolves its own pi-tui copy.
3. **Replay stays current.** A tracked row whose final update dropped
   thinking kept its streaming snapshot; `/toggle-info` replay resurrected
   it as live. Tracked rows now always record their latest update.

Tests added in `test/real-renderer.test.ts`; all four fail against
`564be7a` and pass now. The prose test was tightened so its quote equals
the real label. `npm run check` passes.

## Gap found after 0.3.15

Follow-up 1 assumed one thinking run per message. Pi gives every run the
same `hiddenThinkingLabel`, so with `thinking → text → thinking` the first
label (above the answer) animated too, which brought back the offscreen
full-replay churn. A run followed by a tool call had the same problem,
because tool rows render below the message. Now earlier runs show a static
`│ * Thought`, and only the last run animates, and only when it is the
message's last child and the message has no tool calls. When it cannot
animate, it holds one spinner frame so thinking deltas do not change it.

New tests: interleaved and tool-call cases in `test/real-renderer.test.ts`
(failed before the fix), and old-Pi unwrapped Markdown equal to the label
in `test/thinking-block-merger.test.ts`. `npm run check` passes.

Not done: the reviewer's fake-terminal TUI regression (asserting idle
ticks never clear scrollback). The component tests cover the behavior
that causes it, not the terminal output itself.

## Next

1. `make publish PACKAGE=pi-tool-call-markers` (0.3.16), then `pi update`.

## Not ours

`src/index.ts` and `test/index.test.ts` carry an uncommitted rail-anchor
refactor (`TOOL_RAIL_MARKER`, `collapsedAnchor`) that predates this work.
Keep it out of these commits.

## Decision log

- Kept thoughts out of tool groups (reverted `de6d597`): structural row
  recognition, click forwarding, and cache keys were too much logic for a
  cosmetic gain. Restyling the label alone gives most of the continuity.
- Glyph `*` over `✦`/`+`: matches the plain ASCII feel of tool glyphs. It
  also is the fallback glyph for unmapped tools; the word `Thought`
  disambiguates.
- Spinner reads the clock at render time instead of adding a timer: Pi's
  working indicator already redraws every 80 ms. With the indicator hidden
  it degrades to advancing per delta.
- Rail keeps the settled tone in both states, so settling repaints only the
  glyph, words, and tint.
