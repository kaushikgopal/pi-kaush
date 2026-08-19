# @pi-kaush/pi-footer-minimal

A minimal [Pi](https://pi.dev) footer: cost and context sit on the first metadata line, and token stats appear on a second line you toggle on when you want them. Both metadata lines sit two columns in from the terminal edges.

## What it shows

One blank row separates the footer from the active prompt surface above it; footer metadata begins on the next row.

Default (one metadata line):

```text
  ~/dev/per/aikado (master) $0.55 • 44.6%/262k                     model • high
```

While the agent is working, an animated spinner appears immediately left of the model in a stable right-aligned position (replacing Pi's native working row):

```text
  ~/dev/per/aikado (master) $0.55 • 44.6%/262k                   ⠋ model • high
```

After `/footer-more-stats` (two metadata lines):

```text
  ~/dev/per/aikado (master) $0.55 • 44.6%/262k                     model • high
  ↑228k ↓72k ¢99.6% • (provider) • 🔌 2/3
```

- **Line 1:** cwd `(branch)` [session], session cost, and context usage (colorized at 60%/80% thresholds). Model, active agent, and thinking level stay right-aligned. During agent work, Pi's native braille sequence (`⠋`, `⠙`, `⠹`, …) animates immediately left of the model; there is no `Working…` label or provider field on this line.
- **Line 2** (via `/footer-more-stats [on|off|toggle]`, off by default): cumulative input/output tokens, the gateway provider when multiple providers are available, a compact 🔌 MCP badge, and any other extension statuses.

When the terminal is narrow, line 1 degrades in stages: the cwd flattens to its basename, then the session cost and optional active-agent status drop, with ellipsis truncation as a last resort. The right-aligned spinner/model core never changes shape; while active, the spinner is the highest-priority cell and remains visible even when the model itself must be clipped.

## Working state ownership

On TUI session start the extension calls `ctx.ui.setWorkingVisible(false)`, so Pi's native working row and its 80 ms timer never run. Instead the footer animates its own spinner on a single 80 ms interval, only while the agent is active (`agent_start` → `agent_end`/`agent_settled`). The interval is cleared on settle, footer disposal, and shutdown, and native working visibility is restored on `session_shutdown` so reloading or removing the extension never leaves Pi's status hidden.

## Why

Pi's native footer already shows token stats; this footer rearranges them to prioritize cost and context at a glance, moves the token detail behind a toggle, places the working spinner beside the model, and keeps the window clean. It uses only Pi's public extension APIs (`ctx.ui.setFooter`, `ctx.ui.setWorkingVisible`, `footerData`, `ctx.sessionManager`, `ctx.getContextUsage`) and reads other extensions' statuses (MCP badge, active agent) from Pi's status bus — nothing is imported from other packages.

## Install

After the first npm release:

```bash
pi install npm:@pi-kaush/pi-footer-minimal@0.1.0
```

For local development:

```bash
pi -e ./extensions/pi-footer-minimal/src/index.ts
```

## Use

- `/footer-more-stats` — show or hide the second line (`on`/`off`/`toggle`).
- The MCP badge parses whatever `pi-mcp-adapter` emits (`🔌 2`, `🔌 2/3`, …) and renders compactly.

## Compatibility

Requires Pi 0.80.6 or newer. Replaces the footer (like any `ctx.ui.setFooter` extension), so running two footer extensions at once means the last one wins. The MCP badge and active-agent marker only appear when the extensions that publish those statuses are loaded; everything degrades gracefully without them.

## Security and performance

The published package contains readable TypeScript and has:

- no runtime dependencies;
- no install scripts;
- no filesystem, network, subprocess, environment, or model access — it only reads the session, model, and status data Pi already exposes;
- no telemetry.

## Development

From the repository root:

```bash
npm ci --ignore-scripts
npm run check
```

Inspect the exact publish payload:

```bash
npm pack --workspace @pi-kaush/pi-footer-minimal --dry-run
```

## License

MIT
