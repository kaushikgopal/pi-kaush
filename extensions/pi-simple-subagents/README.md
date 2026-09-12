# pi-simple-subagents

Delegate bounded tasks to isolated Pi subagent processes. Each invocation spawns
a separate `pi` process with its own context window; the parent collects
structured output and keeps its own context lean.

Despite the name, this is the full-featured subagent tool — "simple" refers to
the contract: bounded tasks in, structured result out.

## What it adds

- `subagent`, an LLM-callable tool with three modes:
  - **single** — one agent, one task
  - **parallel** — a `tasks[]` batch with an optional shared immutable `context`
  - **chain** — sequential steps where `{previous}` placeholders receive the
    prior step's output
- **Execution profiles** (`quick`, `coder`, `default`, `thinker`,
  `deep-thinker`): ordered model-candidate ladders from the shared machine-local
  `~/.pi/agent/profiles.yaml`, shared with `@pi-kaush/pi-agent-mode` and
  `@pi-kaush/pi-model-profiles`. Profiles reload on file change — ladder edits
  apply to long-running sessions without a restart.
- **Model-facing discovery**: user agents are read from
  `~/.pi/agent/agents/*.md` when the extension loads and listed alongside the
  execution profiles in the tool guidance. Agent names select behavior and tools;
  profile names select compute. When both appear in a request, their order does
  not matter: `thinker redteam` and `redteam thinker` select the same pair.
- **Bounded delegation**: depth 2, five children per call, five active children
  per Pi session, at most thirty simultaneously active descendants. Completed
  children release their slots.
- **Subtree-safe lifecycle**: depth-1 children lead POSIX process groups; abort,
  timeout, and session shutdown terminate the whole subtree (graceful then
  forced). Windows uses `taskkill /T`.
- **Child watchdogs**: two hours total runtime and fifteen minutes without
  output by default; either configurable in `src/limits.json`, `0` disables.
  The orchestrator is never watchdogged.
- **Resumable child sessions**: children persist real Pi sessions, named
  `subagent(<agent>): <task preview>`. Expanded tool output shows the full
  session ID with a `pi --session <id>` resume hint and the session file path
  for live `tail -f` viewing. Disable with `persistChildSessions: false`.
- **Transcript artifacts**: every child's complete stdout/stderr streams to a
  private JSONL artifact under `~/.pi/agent/subagent-runs/`; tool details keep
  bounded previews and artifact paths.
- **Structured yield**: delegated children finish through a terminating `yield`
  tool (`completed`, `blocked`, `failed`), with artifact paths; ordinary final
  assistant output remains a fallback.
- **Model resolution**: explicit invocation model overrides profile, overrides
  agent frontmatter; bare ids resolve family-scoped by nearest version.

## Agents

Profiles of agents are Markdown files with optional frontmatter (`emoji`,
`model`, `tools`, `systemPrompt`, `confirmProjectAgents`). Discovery:

1. user: `~/.pi/agent/agents/*.md`
2. project: nearest `.pi/agents/*.md`, with `agentScope: "project" | "both"`

User agents are advertised to the parent model at extension load. Additions or
renames need `/reload` to refresh that catalog. Project agents remain dynamically
discoverable by exact name without being embedded in the global catalog.
Project-controlled agents prompt for confirmation before first use.

## Configuration

`src/limits.json` bounds delegation (validated against hard ceilings):

```json
{
  "maxDepth": 2,
  "maxChildrenPerCall": 5,
  "maxConcurrency": 5,
  "maxRuntimeMs": 7200000,
  "maxInactivityMs": 900000,
  "persistChildSessions": true
}
```

The model-profiles schema lives in
[`@pi-kaush/pi-model-profiles`](https://www.npmjs.com/package/@pi-kaush/pi-model-profiles).
