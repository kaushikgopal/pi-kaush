# @pi-kaush/pi-browser

Thin Pi-native browser driver. Attaches over CDP (puppeteer-core) to the
already-running Helium/Chrome — real profile, live logins — and exposes it as
native Pi tools. No MCP hop, no second browser.

## Status

WP1 vertical slice: `browser_navigate`, `browser_snapshot` (read-only AX
outline), `browser_evaluate`. Interaction tools, actionable refs, and profile
pinning land in WP2. See `aikado/.agents/dox/plan-browser-stack-migration.md`.

## Prerequisite

Enable remote debugging in the running browser once:
`helium://inspect/#remote-debugging` (or `chrome://inspect` for Chrome/Brave/Edge)
→ tick the checkbox → Allow. Tools connect lazily on first use.
