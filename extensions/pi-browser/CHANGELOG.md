# Changelog

## 0.1.0 — unreleased

- WP1 vertical slice: CDP discovery via `DevToolsActivePort`, lazy puppeteer
  connect with tab ownership, and native `browser_navigate`,
  `browser_snapshot`, `browser_evaluate` tools. Owned tabs close on session
  shutdown; the user's browser and tabs are never touched.

- `pi-browser capture-export` CLI + daemon `captureExport` method: export the
  per-tab network buffer as signed ApiTap skill files (`@apitap/core` 2.2.2:
  `SkillGenerator`, `importSkillFile`, `AuthManager`), scoped by domain
  patterns / `since-seq` / `min-status` / session. Output is aggregate
  metadata only; credentials go to encrypted `$APITAP_DIR` auth storage.
