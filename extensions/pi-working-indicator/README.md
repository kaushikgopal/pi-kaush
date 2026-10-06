# pi-working-indicator

Minimal Pi working indicator: a traveling wave of small squares replaces the native braille spinner and label.

While Pi streams a response, the editor area shows eight adjacent squares with a bright
four-square window sweeping left-to-right at 80 ms. The wave uses the user message rail color
(`borderAccent` — the purple ▎ bar on your messages), dim squares use the theme's dim color,
and the "Working" label is removed — just the squares. Run `/working-indicator` after a theme
switch to re-resolve the color.

## Commands

- `/working-indicator` — switch back to the square wave
- `/working-indicator none` — hide the indicator entirely
- `/working-indicator reset` — restore Pi's native spinner and label

## Install

```sh
pi install @pi-kaush/pi-working-indicator
```

## Related

- Pi's extension API: `ctx.ui.setWorkingIndicator({ frames, intervalMs })`, `ctx.ui.setWorkingMessage()`
