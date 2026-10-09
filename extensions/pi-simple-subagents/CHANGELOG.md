# Changelog

## Unreleased

- Add opt-in managed workers via `subagent` actions `spawn`, `status`, `list`,
  `send`, `wait`, `stop`, and `resume`; bounded `run` remains the default.
  Managed workers reuse their session, share the bounded concurrency gate, and
  suspend on parent shutdown without replaying interrupted assignments.
- Report terminal managed-worker results to the parent automatically as
  bounded `managed-subagent-result` messages: idle parents start a turn, busy
  parents get a follow-up, and receipts persist in the parent session so reload
  and restart neither repeat nor drop reports. Manual `wait` stays optional.
- Keep spawn IDs and control hints in expanded tool output, hide collapsed
  completion metadata, and guide the parent to present answers without worker
  announcements or task recaps.
- Treat a worker that quits cleanly from its own TUI as exited rather than
  failed; its last result stays collectable.
- Host Herdr workers in unfocused panes split down from the caller, stack later
  workers below earlier ones, and close only extension-owned panes. Keep headless
  Pi RPC fallback and warn before manually opening an RPC worker's live session.
- Resolve subagent profiles and bare model overrides from Pi's refreshed,
  authenticated catalog instead of the parent's `enabledModels`/`--models`
  cycling scope. Delegation may use available models outside that scope.
- Honor agent `profile:` frontmatter with invocation overrides, reject agents
  declaring both `profile` and `model`, and report unavailable candidates
  without crashing parallel calls.
- Use the current `pi` executable when a long-lived parent outlives its Node
  installation; surface subprocess spawn errors instead of silent failures.
- Record a durable intent for every managed report send, including resends,
  so the three-send cap survives restarts.
- Follow `/tree` navigation when reading report receipts; results reported only
  on an abandoned branch may be reported again.
- Log each distinct unexpected error from background report and footer timers
  once instead of swallowing it; stale-context errors after reload stay silent.
- Wait for sibling tasks to settle when a parallel call is aborted, and count
  streaming children as running in parallel progress.
- Reject malformed `tasks[]` and `chain[]` items with explicit errors.
- Say "1 turn" instead of "1 turns" in worker inspection.

## 0.1.1

- Advertise user agents discovered at extension load in the model-facing tool
  guidance, distinguish agent behavior from profile compute, and treat agent/profile
  names as order-independent in natural-language requests.
- Fix a runtime crash on every subagent execution: the host Pi's extension
  context does not expose `scopedModels`, so delegation now falls back to all
  models available to the session.

## 0.1.0

- Initial package release, migrated from the user-local subagent extension:
  subprocess-isolated single/parallel/chain delegation, bounded recursion and
  concurrency, subtree lifecycle cleanup, child execution watchdogs, private
  transcript artifacts, structured `yield`, execution profiles from the shared
  machine-local `profiles.yaml` (reloaded on change), model resolution with
  profiles, and resumable child sessions with resume hints.
