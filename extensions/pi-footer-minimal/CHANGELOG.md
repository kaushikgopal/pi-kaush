# Changelog

## Unreleased

- Prepend one blank separator row above the footer metadata, restoring visual separation from the active prompt surface (supersedes the zero-separator prototype).
- Start footer metadata immediately after the active prompt; its bottom rail-padding row provides separation without another blank row.
- Inset both footer metadata lines two columns from the terminal edges (was one).
- Move the working state into the footer: hide Pi's native working row via `ctx.ui.setWorkingVisible(false)` and animate only Pi's native braille indicator (`⠋`, `⠙`, `⠹`, …) immediately left of the right-aligned model.
- Remove the gateway provider from line 1 and show it only on the optional `/footer-more-stats` line.
- Run a single 80 ms spinner interval only while the agent is active; clear it on `agent_end`, `agent_settled`, footer disposal, and `session_shutdown`, and restore native working visibility on shutdown.
- Make the active spinner the highest-priority footer cell so provider, path, cost, and optional agent status degrade before it.
- Initial package extraction from the private footer extension in the aikado config.

## 0.1.0

- Add minimal footer: cost + context on line 1, model/agent/thinking right-aligned.
- Add `/footer-more-stats` toggle for a second line with token stats, cache-hit %, and a compact 🔌 MCP badge.
- Degrade gracefully on narrow terminals: drop provider prefix, then flatten cwd to basename.
- Read MCP and active-agent statuses from Pi's public status bus; render anything else generically.
