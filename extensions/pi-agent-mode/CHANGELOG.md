# Changelog

## 0.1.0

- Add the `/agent` command for activating a configured Pi agent as a persistent mode in the current session.
- Support `/agent <name>`, an interactive selector, and `/agent none` / `/agent off` restoration of the pre-activation baseline.
- Capture model, thinking level, and active tools as one baseline on first activation; keep it across agent switches.
- Append agent prompts to Pi's base prompt, apply tool allowlists with missing-tool reporting, and support model thinking suffixes (`:low`, `:high`, `:max`).
- Restore the last active agent across session resume and reload, reading both the namespaced `pi-agent-mode/state` entry and legacy `active-agent-state` entries (newest recognized entry on the active branch wins).
- Keep the package standalone with zero runtime dependencies: discovery and display helpers are self-contained and no delegated-subagent runner is required.
