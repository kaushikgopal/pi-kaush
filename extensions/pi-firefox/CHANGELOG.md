# Changelog

## Unreleased

- Register every public Firefox core tool through a lazy per-session Pi adapter.
- Forward structured core results unchanged and mark only failed results as errors.
- Require human approval for replacement candidates and pass tool cancellation through.
- Add the packaged `pi-firefox` safety skill and read-only status, session, and container commands.
- Keep browser behavior, configuration, and ownership policy in the core package.

## 0.1.0

- Add the `ff_status` tool and `/firefox-status` command.
- Report Firefox CLI and native-host status without browser control.
