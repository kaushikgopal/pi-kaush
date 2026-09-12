# Changelog

## Unreleased

- Advertise user agents discovered at extension load in the model-facing tool
  guidance, distinguish agent behavior from profile compute, and treat agent/profile
  names as order-independent in natural-language requests.

## 0.1.0

- Initial package release, migrated from the user-local subagent extension:
  subprocess-isolated single/parallel/chain delegation, bounded recursion and
  concurrency, subtree lifecycle cleanup, child execution watchdogs, private
  transcript artifacts, structured `yield`, execution profiles from the shared
  machine-local `profiles.yaml` (reloaded on change), model resolution with
  profiles, and resumable child sessions with resume hints.
