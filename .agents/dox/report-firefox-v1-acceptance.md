# Firefox browser-use acceptance

## Outcome

The harness-neutral core and thin Pi adapter are locally installed. The public Pi package command installed `extensions/pi-firefox`. No package was published. No additional commit, push, or release occurred.

The adapter registers 16 tools and three noncolliding commands. It packages a Firefox-use skill. The core has zero runtime dependencies and no harness imports. Firefox CLI and CTC remain unchanged.

## Validation

- `npm run check`: passed after the final path/limit changes. Vitest reports 1,319 passed and two skipped. All package allowlists pass. The existing Bun suite reports 57 passed.
- Public Node browser test: passed 20 fill/click/wait/extract workflow cycles against a CSP-restricted synthetic HTML page.
- Separate-process restart: reused the exact live tab without creating another tab.
- Independent sessions: created distinct tabs and read both concurrently.
- Reads: summary, full, scoped, locator, and typed extraction passed.
- Network: observed 20 synthetic requests; returned metadata omitted query values.
- Screenshot: returned a file path only. The private PNG measured 58,031 bytes at 1,200 × 1,040 pixels after local resizing.
- CTC: the owner approved the exact fresh candidate. The public Pi tool invoked its approval callback, adopted the verified Work container, read the fixture, and closed its owned tab.
- Native Pi loader: all 16 tools loaded. Real status, ensure, summary/full read, extraction, and close passed without a model request.
- Cleanup: original tab/window IDs remained intact. Fixture servers, private state, and screenshots were removed.
- Working tree: unrelated lockfile updates remain unchanged. The latest commit remains `4a59a59`.

A first CTC approval expired before the human reply. The approved expired test tab was explicitly closed. The fresh approval test passed. Expiry never triggered automatic adoption.

## Measured output

The final Pi-loader fixture measured the actual text in native tool results. Native envelope bytes include content, details, and structured content; they are not provider-token measurements.

| Read | Model-facing text bytes | Native result envelope bytes |
| --- | ---: | ---: |
| Summary | 327 | 1,116 |
| Full | 1,186 | 3,749 |
| Title extraction | 326 | 1,117 |

Summary text used 73% fewer bytes than the explicit full read on this fixture. Provider token counts were not measured. The four-page backend/helper baseline remains a separate measurement.

The 20-cycle core fixture returned 402 JSON bytes per four-step workflow. Its summary returned 370 bytes. These fixtures differ from the Pi-loader fixture above.

One full-check attempt exposed a timing assumption in the new session-lane test. The test now waits for confirmed lock entry instead of sleeping five milliseconds. Focused tests and the complete check passed after that correction.

## Safety corrections

Integration tests and independent review identified five root causes. The implementation now uses exclusive screenshot publication, cleanup without idle-time refresh, unique opaque refs across sessions and clients, process-start evidence for activity ownership, and one shared gate independent of configurable session-state paths.

## Limits and skipped checks

- Private-window access remains disabled by owner decision. It is not a passed check.
- Actual execution used Node 26.12.1 on macOS with Firefox 158.0.1 and CLI 0.4.1. Node 20 execution and Linux browser integration remain unverified.
- The human-approved adapter callback ran through the public Pi loader. Native terminal-modal rendering has unit coverage, not a separate visual test.
- Pending CTC approvals do not survive a process restart. Missing seed ownership cannot authorize candidate adoption.
- Full-page screenshots, container enumeration/creation selectors, response bodies, historical network capture, iframe actions, and arbitrary eval remain unsupported or excluded.
- Browser restart identity uses hashed same-user OS process metadata because the CLI lacks an instance ID. Unknown identity fails closed.
- Direct CLI callers and human tab changes do not participate in wrapper coordination.
- Synthetic CTC test containers and their manually configured rules remain available. No normal routing rule changed.

## Use

1. Run `/reload` in Pi to load the installed package.
2. Run `/firefox-status` to check the connection.

Setup and configuration: `extensions/pi-firefox/README.md`.
API, workflow example, and limits: `packages/firefox-agent-core/README.md`.

## Package layout follow-up

Core now lives at `packages/firefox-agent-core` as `@pi-kaush/firefox-agent-core`. The Pi extension remains `@pi-kaush/pi-firefox`. See `report-firefox-agent-core-move.md` for migration checks. The v1 measurements above precede this layout-only change.
