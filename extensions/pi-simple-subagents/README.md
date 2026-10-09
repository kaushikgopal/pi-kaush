# pi-simple-subagents

Delegate bounded tasks to isolated Pi child processes or opt in to persistent
managed workers with stable handles. Bounded runs collect structured output;
managed workers keep their Pi session between assignments.

Despite the name, this is the full-featured subagent tool — "simple" refers to
the bounded default: tasks in, structured results out.

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
  bounded children release their slots; idle managed workers do not.
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
- **Transcript artifacts**: bounded children's complete stdout/stderr streams to a
  private JSONL artifact under `~/.pi/agent/subagent-runs/`; managed workers retain
  Pi session transcripts, bounded status previews, and assignment result archives
  under `~/.pi/agent/managed-subagents/`.
- **Structured yield**: delegated children finish through a terminating `yield`
  tool (`completed`, `blocked`, `failed`), with artifact paths; ordinary final
  assistant output remains a fallback.
- **Model resolution**: before delegation, refresh Pi's authenticated model catalog
  locally; select profile candidates and bare model overrides from that catalog, not
  the parent's `enabledModels` / `scopedModels` cycling list. An explicit model
  overrides an invocation profile, which overrides the agent's `profile`
  frontmatter, then its legacy `model` field. Bare ids resolve family-scoped
  by nearest version; qualified refs pass through to the child for validation.

## Managed workers

The default `action: "run"` keeps the existing bounded single, parallel, and
chain behavior. Use `action: "spawn"` only when a worker should keep its session
for later assignments. Spawn accepts one agent/task or a `tasks[]` batch with
optional shared `context`; managed chains are not supported.

```json
{ "action": "spawn", "agent": "coder", "task": "Implement the parser", "profile": "coder" }
{ "action": "send", "handle": "mw-…", "message": "Also cover empty input" }
{ "action": "wait", "handle": "mw-…", "assignmentId": "a-…" }
```

Use `list` and `status` to inspect workers, `send` to steer active work, and
`wait` to collect a specific assignment. `delivery: "followUp"` queues a
separate assignment. Interrupted tasks are never replayed automatically; use
the returned assignment ID to avoid collecting an older result.

Finished assignments report themselves. Each terminal result (completed,
blocked, failed, timed out, aborted, interrupted, or cancelled) arrives in the
parent session as one bounded `managed-subagent-result` message with the
worker's identity, model, result preview, artifacts, usage, and transcript
path. An idle parent starts a turn to present the answer; a busy parent receives it
as a follow-up after the current turn. Steers merged into a running assignment
are reported with it. Reports are recorded in the parent session, so `/reload`
and restarts neither repeat nor lose them, and results already collected with
`wait` are not reported again. Receipts follow the active branch: after `/tree`
navigation, a result reported only on the abandoned branch is reported again.
Each report is sent at most three times. `wait` remains available for
deterministic collection inside a turn. The managed-worker status line hides
exited or stopped workers once their results are reported or collected; live
idle workers stay visible.

The status line is published as the extension status
`below-footer:managed-subagents`, one worker per line, at most five rows plus a
`+N more` row. With [pi-footer-minimal](../pi-footer-minimal/README.md)
installed, each line renders as its own dimmed row below the footer. Without it,
Pi's native footer joins every extension status into one line, so the worker
rows appear inline with other statuses, separated by spaces and clipped to the
terminal width.

Spawn confirmations and controls stay in the expanded tool output. IDs are
explicitly labeled `worker-handle [mw-…]` and `assignment-id [a-…]`; expand the
completion message to inspect status, task, usage, and transcript details. The
collapsed completion message adds no card or metadata above the parent's answer.
The parent is instructed to present brief answers directly without launch or
completion announcements, task recaps, IDs, or closing commentary. This is model
guidance, not filtering or rewriting its messages.

A worker handle identifies the reusable child session; use it with `status`,
`send`, `stop`, and `resume`. Each task or follow-up has an assignment ID; pass it
to `wait` alongside the handle to collect that specific result, not whichever
task finished most recently. Routine use needs neither copied ID: automatic
reports and `/subagent` provide the normal workflow.

Managed workers share the session's concurrency gate with bounded runs. An idle
worker keeps a slot until it exits, is stopped, or is suspended. `stop` retains
the worker's Pi session and transcripts; `resume` restarts it. Parent shutdown
suspends managed workers and releases their slots. They resume idle with their
saved context when that parent session starts again; interrupted instructions
and uncertain message deliveries are never replayed automatically. `/reload`
leaves managed children running. If every slot is held by a managed worker,
bounded runs fail immediately with handles to stop rather than waiting forever.
Managed sessions persist even when `persistChildSessions` is disabled for bounded runs.

In Herdr, each worker runs in an unfocused, extension-owned pane split down from
the caller; later workers stack below earlier ones. The `/subagent` picker can
inspect it or focus it for native TUI use. Outside Herdr, workers run through Pi
RPC and remain headless. Spawn warns when automatic opening is unavailable; the
expanded tool output and picker give a fish-safe command for the saved session
and tell you to stop a running headless worker before opening it elsewhere. That
command opens a standalone session, not a live attachment: close it before
resuming the worker from the parent. Open never resumes an unsupported headless
worker implicitly. `/reload` refreshes the
default host adapter without moving existing worker tabs or restarting processes;
subsequent launches use the current split layout. Host-specific launch, focus,
and cleanup remain behind the existing host port for future multiplexer adapters.

Future direction: [Pi Durable's multiplayer model](https://earendil.com/posts/pi-durable/#multiplayer)
could let multiple clients observe and steer the same running worker without
starting a second writer. One process owns storage; clients attach to that
owner. This could solve the headless-to-interactive attachment problem: opening
`pi --session` today starts another process, not a client of the existing worker.
Durable is an experimental, separate framework, not a drop-in attachment feature
for these Pi CLI workers. Adopting it would require a worker backend and UI adapter;
it does not make independent concurrent storage writers safe.

Herdr workers use the Herdr server's provider environment and the shared Pi agent
directory. Parent-only exported credentials are not copied into launch arguments.
Blocked trust or permission prompts are never automatically approved.

Managed profiles and model overrides are resolved at spawn time and reused for
later assignments. Explicit models override invocation profiles, which override
agent profiles and legacy agent models. The parent's cycling model scope is not
inherited. Isolation flags are opt-in; `noMcp` is currently supported only for
bounded runs (requires Pi 1.0.4 or newer), and `noExtensions` explicitly loads this package's child bridge
and `yield` tool.

The offline RPC smoke runs in the ordinary test suite. Native Herdr smoke is
opt-in because it creates and closes a real unfocused split pane:

```fish
env PI_MANAGED_HERDR_SMOKE=1 npx vitest run extensions/pi-simple-subagents/test/subagent-managed-cli.test.ts
```

Both smoke tests use a deterministic local provider, not network model calls.

## Agents

Agent definitions are Markdown files with optional frontmatter (`emoji`,
`profile`, `model`, `tools`, `confirmProjectAgents`). Declare either `profile`
or `model`, not both. Discovery:

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
