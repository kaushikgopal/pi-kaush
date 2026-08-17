# Changelog

## 0.1.0 — unreleased

- WP1 vertical slice: CDP discovery via `DevToolsActivePort`, lazy puppeteer
  connect with tab ownership, and native `browser_navigate`,
  `browser_snapshot`, `browser_evaluate` tools. Owned tabs close on session
  shutdown; the user's browser and tabs are never touched.
