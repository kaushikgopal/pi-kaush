# Changelog

## Unreleased

- Initial package extraction from the private footer extension in the aikado config.

## 0.1.0

- Add minimal footer: cost + context on line 1, model/agent/thinking right-aligned.
- Add `/footer-more-stats` toggle for a second line with token stats, cache-hit %, and a compact 🔌 MCP badge.
- Degrade gracefully on narrow terminals: drop provider prefix, then flatten cwd to basename.
- Read MCP and active-agent statuses from Pi's public status bus; render anything else generically.
