# Firefox Phase 0 source verification

## Scope and evidence

This is a source-only review. [firefox-cli 0.4.1](https://github.com/respawn-llc/firefox-cli/blob/c118396bcd36698a395773724663cc1f1493a04a/package.json#L1-L4) is pinned at [c118396bcd36698a395773724663cc1f1493a04a](https://github.com/respawn-llc/firefox-cli/tree/c118396bcd36698a395773724663cc1f1493a04a). CTC is pinned at [5c4227ce08dd9a1c58f000da5d190b8c0baef0a2](https://github.com/kaushikgopal/ff-container-traffic-control/tree/5c4227ce08dd9a1c58f000da5d190b8c0baef0a2). [surf-cli 2.24.1](https://github.com/nicobailon/surf-cli/blob/32c39d13682d2fa60b6c2fbca1703b3f233cab59/package.json#L1-L4) is pinned at [32c39d13682d2fa60b6c2fbca1703b3f233cab59](https://github.com/nicobailon/surf-cli/tree/32c39d13682d2fa60b6c2fbca1703b3f233cab59). Surf is a Chrome reference only; this report does not treat its capabilities as Firefox evidence.

| Area | Pinned-source finding | Design effect |
| --- | --- | --- |
| CTC export | The UI offers `no-rule`, `open`, and `restricted`. Export skips `no-rule` containers and blank patterns. Each emitted rule contains `containerName`, `action: open|restricted`, `urlPattern`, and `highPriority`. [options.html:107–112](https://github.com/kaushikgopal/ff-container-traffic-control/blob/5c4227ce08dd9a1c58f000da5d190b8c0baef0a2/src/options.html#L107-L112) · [options.js:356–393](https://github.com/kaushikgopal/ff-container-traffic-control/blob/5c4227ce08dd9a1c58f000da5d190b8c0baef0a2/src/options.js#L356-L393) | Disabled/no-rule is absence of exported rules, not an `action: no-rule` row. |
| CTC precedence | The engine keeps the current matching container before considering high priority. Otherwise, the first matching high-priority rule wins; normal ties also use rule order. [rule-engine.js:116–137](https://github.com/kaushikgopal/ff-container-traffic-control/blob/5c4227ce08dd9a1c58f000da5d190b8c0baef0a2/src/rule-engine.js#L116-L137) | Conflicts with the supplied evaluation order. Do not implement a competing router. |
| Tab/container data | Tab and resolved-target outputs include optional `cookieStoreId`, which can be absent. [tab summary](https://github.com/respawn-llc/firefox-cli/blob/c118396bcd36698a395773724663cc1f1493a04a/packages/protocol/src/target.ts#L3-L15) · [resolved target](https://github.com/respawn-llc/firefox-cli/blob/c118396bcd36698a395773724663cc1f1493a04a/packages/protocol/src/target.ts#L38-L50). `tab.new` accepts URL, focus, and a window target; its strict schema has no container selector. [schema](https://github.com/respawn-llc/firefox-cli/blob/c118396bcd36698a395773724663cc1f1493a04a/packages/protocol/src/target.ts#L78-L95) · [handler](https://github.com/respawn-llc/firefox-cli/blob/c118396bcd36698a395773724663cc1f1493a04a/packages/extension/src/browser-handlers/tabs-windows.ts#L22-L35) | Optional identity is not proof when absent. CLI cannot request a new tab in a chosen container. |
| Replacement ownership | CTC creates the replacement with URL, cookie store, active state, and index; it sets no opener or task-provenance field, then removes the old tab. [background.js:274–291](https://github.com/kaushikgopal/ff-container-traffic-control/blob/5c4227ce08dd9a1c58f000da5d190b8c0baef0a2/src/background.js#L274-L291). firefox-cli’s strict tab summary has no opener/provenance field. [target.ts:3–15](https://github.com/respawn-llc/firefox-cli/blob/c118396bcd36698a395773724663cc1f1493a04a/packages/protocol/src/target.ts#L3-L15) | URL/time matching cannot prove ownership of a CTC replacement. |
| Eval and snapshots | Eval runs in the page main world. [commands.md:130–142](https://github.com/respawn-llc/firefox-cli/blob/c118396bcd36698a395773724663cc1f1493a04a/docs/commands.md#L130-L142). Snapshot is a text representation with generation/ref metadata, not a structured accessibility tree. [commands.md:61–72](https://github.com/respawn-llc/firefox-cli/blob/c118396bcd36698a395773724663cc1f1493a04a/docs/commands.md#L61-L72) · [schema:29–37](https://github.com/respawn-llc/firefox-cli/blob/c118396bcd36698a395773724663cc1f1493a04a/packages/protocol/src/content.ts#L29-L37) | Keep eval out of extension-background assumptions. Do not claim structured AX output. |
| Network | The result schema exposes request ID, URL, method, type, and status code. It has no response-body field. [schema:111–135](https://github.com/respawn-llc/firefox-cli/blob/c118396bcd36698a395773724663cc1f1493a04a/packages/protocol/src/browser/page-state.ts#L111-L135) · [tracker:201–209](https://github.com/respawn-llc/firefox-cli/blob/c118396bcd36698a395773724663cc1f1493a04a/packages/extension/src/network-tracker.ts#L201-L209) | Limit network support to summaries; response-body drill-down is unsupported. |

## Conflicts and unapproved options

These are recommendations only. **NOT APPROVED.**

- **G3:** Ask whether to align the specification with CTC’s current precedence or block prediction until CTC behavior and specification agree.
- **G1:** Treat missing `cookieStoreId` as unknown. Block account-sensitive actions without verified container evidence.
- **G2:** Refuse replacement adoption without backend provenance or another proven ownership signal. Do not treat a unique URL match as proof.
- Keep snapshots textual and network output summary-only unless a separately approved backend capability exists.

## Validation and next decision

The CTC pure rule suite passed: 20/20 tests. This confirms current source behavior only; it is not a browser probe.

Firefox is absent at `/Applications/Firefox.app/Contents/MacOS/firefox`, and `firefox-cli` is absent from PATH. No browser commands ran. Live CLI output, installed-version behavior, actual container evidence, and replacement ownership remain blocked.

**Owner decision needed:** Resolve G3 and approve or reject the G1/G2 fail-closed options before Phase 1. No implementation choice is made here.
