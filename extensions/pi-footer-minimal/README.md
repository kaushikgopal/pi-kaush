# @pi-kaush/pi-footer-minimal

A minimal [Pi](https://pi.dev) footer: cost and context sit on the first metadata line, and token stats appear on a second line you toggle on when you want them. Both metadata lines sit two columns in from the terminal edges.

### Install

```fish
pi install npm:@pi-kaush/pi-footer-minimal
```

Restart Pi or run `/reload`.

## What it shows

One blank row separates the footer from the active prompt surface above it; footer metadata begins on the next row.

Default (one metadata line):

```text
  ~/dev/per/aikado (master) $0.55 • 44.6%/262k                     model • high
```

After `/footer-more-stats` (two metadata lines):

```text
  ~/dev/per/aikado (master) $0.55 • 44.6%/262k                     model • high
  ↑228k ↓72k ¢99.6% • (provider) • 🔌 2/3
```

- **Line 1:** cwd `(branch)` [session], session cost, and context usage (colorized at 60%/80% thresholds). Model, active agent, and thinking level stay right-aligned. Working state stays with Pi's native indicator in the chat output — nothing is animated or hidden here.
- **Line 2** (via `/footer-more-stats [on|off|toggle]`, off by default): cumulative input/output tokens, the gateway provider when multiple providers are available, a compact 🔌 MCP badge, and any other extension statuses.

When the terminal is narrow, line 1 degrades in stages: the cwd flattens to its basename, then the session cost and optional active-agent status drop, with ellipsis truncation as a last resort. The right-aligned model never changes shape and remains the final visible cell.

## Why

Pi's native footer already shows token stats; this footer rearranges them to prioritize cost and context at a glance, moves the token detail behind a toggle, and keeps the window clean. It uses only Pi's public extension APIs (`ctx.ui.setFooter`, `footerData`, `ctx.sessionManager`, `ctx.getContextUsage`) and reads other extensions' statuses (MCP badge, active agent) from Pi's status bus — nothing is imported from other packages.

## Local development

```fish
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
