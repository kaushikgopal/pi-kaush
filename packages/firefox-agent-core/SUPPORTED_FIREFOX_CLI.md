# Supported firefox-cli

## Tested version

CLI: **0.4.1**. Firefox: **158.0.1**, macOS, local browser and agent.

Source reference:
<https://github.com/respawn-llc/firefox-cli/tree/c118396bcd36698a395773724663cc1f1493a04a>

The wrapper calls the public CLI. It does not import firefox-cli code, access its
native host directly, or copy its AGPL implementation.

## Implemented status contract

- `firefox-cli --version` returns plain version text.
- `firefox-cli doctor --json` returns a result object, not a protocol envelope.
- Doctor can exit 1 while returning valid diagnostic JSON for incomplete setup.
- The core projects only version and status fields. It omits native-host paths,
  next-action URLs, raw stderr, and pairing data.
- A different version produces a warning. Unknown status shapes fail explicitly.

Live installed and connected doctor output was verified on the target machine.
Disconnected, missing-native-host, and not-approved states were also observed
during setup. Unit tests cover malformed and mismatched responses.

## Verified browser capabilities

The following checks used synthetic local pages, not signed-in accounts:

| Capability                                      | Live result                                                              |
| ----------------------------------------------- | ------------------------------------------------------------------------ |
| Explicit tab IDs and normal-tab creation        | Passed                                                                   |
| Snapshot, ref generation, stale-ref errors      | Passed                                                                   |
| Fill, click, waits, public value getters        | Passed                                                                   |
| Actual `cookieStoreId` metadata                 | Passed for default and two containers                                    |
| CTC replacement candidates                      | Detected; owner confirmation preceded adoption                           |
| Cookie-store isolation                          | Passed; synthetic cookie cleared in each container                       |
| File-only screenshot                            | Passed; capture selects its target tab                                   |
| Network summaries                               | Passed when observation starts before fixture requests                   |
| Same-origin and cross-origin iframe diagnostics | Observed; no iframe actions attempted                                    |
| Privileged page                                 | `about:config` creation refused with `PERMISSION_DENIED`                 |
| Private window                                  | Not exposed with current permissions; further access explicitly excluded |

The integrated core also passed 20 synthetic workflow cycles, separate-process restart reuse, network summaries, private-file screenshots, scoped reads, typed extraction, and human-confirmed CTC adoption through the public Pi loader. See the core README for measured output sizes.

## Known limits

- Public tab creation has no container selector. No container enumeration command
  is available in the tested version.
- Container IDs are optional output fields. An absent ID does not prove the
  default container.
- CTC can remove the original tab and create another. The CLI provides no proven
  replacement lineage. A matching URL alone does not establish ownership.
- Snapshots contain rendered DOM text and generation metadata, not a structured
  browser accessibility tree.
- Network results expose request summaries, not response bodies or timestamps.
  Observation retention is bounded; capture is not an always-on history.
- Screenshots select their target tab. Full-page screenshots and a screenshot
  resize flag are unsupported.
- Page eval can fail under restrictive CSP. Public getters can still work.
- Synthetic JSON documents produced a host-access read failure where equivalent
  HTML was readable. Firefox's JSON viewer is a suspected cause, not proven.
- Private mutation refusal is source-backed but intentionally not live-tested.
  Do not enable private access to run this package.

Do not invent flags or silently bypass these limits. Recheck the public CLI
surface when upgrading the tested version.
