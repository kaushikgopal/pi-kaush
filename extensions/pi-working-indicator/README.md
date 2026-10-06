# pi-working-indicator

Minimal Pi working indicator: a traveling wave of small squares replaces the native braille spinner and label.

While Pi streams a response, the editor area shows eight adjacent squares: a prominent center
square sweeps left-to-right at 80 ms with two muted squares trailing it and the rest dim —
a three-tier gray-scale wave. The "Working" label is removed — just the squares. Run `/working-indicator` after a theme switch to re-resolve the color.

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
