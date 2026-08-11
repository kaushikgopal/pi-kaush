# pi-agent-mode

Activates a configured Pi agent as a persistent mode in the current session. It switches
the session to the agent's model, thinking level, and tool set, appends the agent's
prompt to Pi's base instructions, and restores the pre-activation baseline when cleared.
It does not spawn children and provides no delegated subagents.

## Install

```sh
pi install npm:@pi-kaush/pi-agent-mode
```

Restart Pi or run `/reload`. To pin a specific release, append its version, such as
`@0.1.0`.

## Usage

```text
/agent               open an agent selector
/agent <name>        activate the named user or project agent
/agent none          restore the pre-activation model, thinking level, and tools
/agent off           same as /agent none
```

Agent definitions come from Markdown files in Pi's user agent directory
(`~/.pi/agent/agents/*.md`) or the nearest project `agents/` directory (project
agents take precedence by name and are confirmed before activation unless the
agent sets `confirmProjectAgents: false`).

Supported frontmatter:

```yaml
---
name: reviewer # required
description: ... # required
emoji: 🔍 # optional, shown in the footer status
tools: read, grep # optional allowlist; unavailable tools are reported and omitted
model: provider/model:high # optional; thinking suffix may be :off/:low/:medium/:high/:max
confirmProjectAgents: false # project agents default to requiring confirmation
---
Prompt body appended to Pi's base instructions while the agent is active.
```

## Behavior

- The first activation captures the current model, thinking level, and active
  tools as one baseline. Switching agents keeps that original baseline, so
  clearing always returns to the pre-`/agent` session state.
- Missing models or failed authentication abort activation without corrupting
  the previous state.
- The active agent survives session resume and reload; the footer status shows
  the active agent, including its emoji when configured.
- Durable state is written as a namespaced `pi-agent-mode/state` session entry.
  Legacy `active-agent-state` entries from earlier local implementations are
  still read on resume; the newest recognized entry on the active branch wins.

## Development

```sh
npm run check
npm pack --workspace @pi-kaush/pi-agent-mode --dry-run
```

Load the live source in isolation:

```sh
pi --no-extensions -e ~/dev/oss/pi-kaush/extensions/pi-agent-mode/src/index.ts
```
