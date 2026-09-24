# Changelog

## Unreleased

- Resolve subagent profiles and bare model overrides from Pi's refreshed,
  authenticated catalog instead of the parent's `enabledModels`/`--models`
  cycling scope. Delegation may use available models outside that scope.
- Honor agent `profile:` frontmatter with invocation overrides, reject agents
  declaring both `profile` and `model`, and report unavailable candidates
  without crashing parallel calls.
- Use the current `pi` executable when a long-lived parent outlives its Node
  installation; surface subprocess spawn errors instead of silent failures.

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
