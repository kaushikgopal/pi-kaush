# CTC provenance options: decision summary

## Constraint

firefox-cli remains unchanged. CTC owns routing. The wrapper must not adopt unrelated tabs based only on matching URLs.

Two bounded source/documentation reviews compared browser metadata, extension pages, messaging, native messaging, loopback transport, and downloads. No live Firefox probe ran. Claims about timing and installed-browser behavior remain unverified.

## Findings

| Option | Works without firefox-cli changes? | Assessment |
| --- | --- | --- |
| Before/after tab IDs plus human confirmation | Yes | Smallest baseline. No extra integration. A candidate match is not automatic ownership proof. |
| CTC native messaging plus a separate local receipt helper | Yes, with CTC and wrapper/helper changes | Preferred option when automatic proven adoption is required. Adds a permission, native-host registration, private local rendezvous, and lifecycle handling. |
| CTC extension-to-extension receipt API | Not through the current CLI | Cleanest browser API in isolation, but requires a firefox-cli feature or another browser extension plus a separate agent connection. Excluded under the current constraint. |
| Opener ID, title, window, or tab group | Not sufficient | Current CLI omits some fields. Mutable metadata and opener lifetime do not prove CTC creation. |
| CTC extension page read through eval | No supported route established | Firefox restricts extension-page injection. Dynamic extension URLs and polling do not establish a trusted receipt channel. |
| Receipt downloaded as a file | Possible with CTC changes | Removes native-host registration but adds downloads permission, file lifecycle, freshness, spoofing/replay concerns, and browser-download artifacts. Not a demonstrated improvement. |
| Authenticated loopback endpoint | Possible with CTC and wrapper changes | Avoids native-host registration but adds listener discovery, authentication, host permissions, and request-origin risks. Not preferred. |
| Signed receipt through webpage DOM | Possible in principle, not established | Requires a content bridge, pinned verification key, replay defenses, and page lifecycle handling. More complex than native messaging. |

## Recommendation

Do not call an excluded extension-to-extension design the recommendation. One worker report preferred it in isolation, but it violates the unchanged-firefox-cli constraint.

Start with the before/after comparison and explicit confirmation when ownership is unproven. If hands-off loops require automatic adoption, investigate the separate CTC native-messaging helper. Research found no clearly simpler authenticated automatic channel through the current public CLI.

The helper is not a second browser driver. It carries CTC-authored replacement evidence only. Keep all browser reads and actions on firefox-cli. A helper outage must never block ordinary CTC navigation.

## Next bounded proof

Before implementation approval, test a minimal CTC-to-native-host receipt path using synthetic tab identifiers. Confirm Firefox's caller identity checks, host registration, receipt expiry, background suspension behavior, and private local delivery. Do not modify or reuse firefox-cli's private native host. No such test is authorized or complete here.

## Evidence

- [Browser-only review](research-ctc-browser-only-options.md)
- [Transport review](research-ctc-local-transports.md), whose primary recommendation is excluded by the current constraint.
- [Firefox native messaging](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Native_messaging)
- [Native manifests](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Native_manifests)
- [Script-injection restrictions](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/scripting/executeScript)

No source code, dependencies, upstream issues, installations, or pairing state changed. These are research artifacts, not a completed integration.
