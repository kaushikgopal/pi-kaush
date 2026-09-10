# Changelog

## 0.1.2

- Inline a minimal schema example in the missing-config error so a fresh machine can bootstrap without the template file; version `profiles.template.yaml` in the package as the canonical illustration.


## 0.1.0

- Add the shared model-profiles library: parse, validate, and load machine-local `~/.pi/agent/profiles.yaml` (version 1, kebab-case names, canonical `provider/model` candidates with optional thinking levels).
- Add ordered candidate selection (`selectProfileCandidates`) and display helpers (`formatProfileCandidate`, `formatProfileGuidance`) for consumers that compose profiles with agent definitions.
- Library-only package: no commands, no session state, no model mutation.
