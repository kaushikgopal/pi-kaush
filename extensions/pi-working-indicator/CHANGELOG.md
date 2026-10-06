# Changelog

## 0.1.0

- Color the wave with the theme's `borderAccent` token — the same purple as the user message rail; dim squares use the theme's dim color. `/working-indicator` re-resolves after a theme switch.
- Remove the "Working" label via `ctx.ui.setWorkingMessage("")`; only the squares remain.
- Replace Pi's native braille working spinner with a traveling wave of small squares: eight adjacent cells, a four-square bright window moving left-to-right with wraparound at 80 ms.
- Add `/working-indicator [wave|none|reset]` to switch between the wave, a hidden indicator, and Pi's native spinner without restarting.
