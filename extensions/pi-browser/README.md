# @pi-kaush/pi-browser

Thin Pi-native browser driver. Attaches over CDP (puppeteer-core) to the
already-running Helium/Chrome — real profile, live logins — and exposes it as
native Pi tools. No MCP hop, no second browser.

## Status

A persistent daemon starts lazily and keeps one CDP connection, so owned tabs
and browser state survive across Pi sessions. The extension supports navigation
and owned-tab lifecycle, accessibility snapshots with actionable refs, click,
fill, key, scroll, upload, and wait interactions, plus evaluation, screenshots,
network capture, console capture, and reviewed script execution. Profile pinning
is available through `/browser-profile`; inspect connection and pin state with
`/browser-status`.

## Safety

- Only tabs created by pi-browser can be switched or closed.
- Re-run `browser_snapshot` after navigation or tab switching because actionable
  refs may be stale.
- `browser_run_script` executes full trusted code with live Puppeteer and CDP
  access. It is not a sandbox.

## Prerequisite

Enable remote debugging in the running browser once:
`helium://inspect/#remote-debugging` (or `chrome://inspect` for Chrome/Brave/Edge)
→ tick the checkbox → Allow. Tools connect lazily on first use.
