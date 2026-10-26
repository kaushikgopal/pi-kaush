# CTC tab lineage design

## Recommendation

Use a short-lived, CTC-authored replacement receipt. Keep CTC as the only router. Do not add a second routing predictor.

Before navigation, the wrapper records tab IDs through the public `firefox-cli` CLI. After navigation, it lists tabs again. It accepts a replacement only when one new tab matches the CTC receipt, the expected URL, and a present, verified `cookieStoreId`. Missing evidence or multiple matches means stop. A validated receipt can remove an ownership confirmation. It cannot remove a container check.

CTC currently creates a tab with `url`, `cookieStoreId`, `active`, and `index`, then removes the source tab. It sets neither `windowId` nor `openerTabId`. Its tab lookup also omits the source window ID. ([replacement code](https://github.com/kaushikgopal/ff-container-traffic-control/blob/5c4227ce08dd9a1c58f000da5d190b8c0baef0a2/src/background.js#L274-L291) · [tab lookup](https://github.com/kaushikgopal/ff-container-traffic-control/blob/5c4227ce08dd9a1c58f000da5d190b8c0baef0a2/src/background.js#L345-L365))

## Minimal responsibilities

1. **CTC:** After `tabs.create` succeeds, store a short-lived receipt keyed by the source tab ID. Include the replacement tab ID and actual window/container metadata. Store it before removing the source tab. Keep it briefly in `browser.storage.session`; CTC already has the `storage` permission. Firefox supports this store from version 115, and it survives background suspension but not browser shutdown. ([CTC manifest](https://github.com/kaushikgopal/ff-container-traffic-control/blob/5c4227ce08dd9a1c58f000da5d190b8c0baef0a2/manifest.json#L13-L46) · [storage.session](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/storage/session))

2. **CTC:** Add a read-only `runtime.onMessageExternal` receipt lookup. Accept messages only when `sender.id` equals firefox-cli’s stable ID, `ff-cli-bridge@respawn.pro`. CTC already has stable ID `ctc@kau.sh`. Firefox supports extension-to-extension `runtime.sendMessage`; Firefox does not support `externally_connectable`. ([CTC ID](https://github.com/kaushikgopal/ff-container-traffic-control/blob/5c4227ce08dd9a1c58f000da5d190b8c0baef0a2/manifest.json#L40-L46) · [firefox-cli ID](https://github.com/respawn-llc/firefox-cli/blob/c118396bcd36698a395773724663cc1f1493a04a/packages/extension/src/manifest.json#L6-L18) · [external messages](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/runtime/onMessageExternal) · [Firefox manifest support](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/externally_connectable))

3. **firefox-cli:** Let its extension backend request the receipt. Surface the replacement ID and provenance through the existing public tab operation. Handle the case where CTC removes the original ID before firefox-cli re-resolves it. The current `tab.new` handler and `open` navigation handler both re-resolve the original ID. Keep the wrapper limited to public CLI calls; do not use page eval or direct extension APIs. The current tab summary is strict and omits opener metadata. ([tab schema](https://github.com/respawn-llc/firefox-cli/blob/c118396bcd36698a395773724663cc1f1493a04a/packages/protocol/src/target.ts#L3-L15) · [tab.new handler](https://github.com/respawn-llc/firefox-cli/blob/c118396bcd36698a395773724663cc1f1493a04a/packages/extension/src/browser-handlers/tabs-windows.ts#L22-L35) · [open handler](https://github.com/respawn-llc/firefox-cli/blob/c118396bcd36698a395773724663cc1f1493a04a/packages/extension/src/browser-handlers/navigation.ts#L29-L38))

4. **Wrapper:** Compare before/after IDs. Match the receipt to exactly one new tab. Check its current URL and actual `cookieStoreId` through `firefox-cli`. Treat absent container data as unknown. Stop on missing, stale, conflicting, or ambiguous evidence. Do not evaluate CTC rules.

A receipt write or message failure must not change CTC routing. It must leave the replacement unowned to the wrapper.

## Why the simpler-looking alternatives do not suffice

| Option | Finding |
| --- | --- |
| `openerTabId` | Firefox requires the opener and new tab to share a window. `windowId` defaults to the current window, while CTC omits it. The `Tab.openerTabId` property is present only while the opener still exists in the same window. CTC removes that opener. The firefox-cli schema also omits the field. Treat it as a useful hint only, not a receipt. ([create](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/tabs/create) · [Tab](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/tabs/Tab)) |
| `tabs.onReplaced` | Firefox does not support this event. CTC uses explicit create/remove calls, not a browser tab-replacement operation. ([Firefox compatibility data](https://github.com/mdn/browser-compat-data/blob/main/webextensions/api/tabs.json) · [CTC code](https://github.com/kaushikgopal/ff-container-traffic-control/blob/5c4227ce08dd9a1c58f000da5d190b8c0baef0a2/src/background.js#L274-L291)) |
| CTC route preview | CTC could expose its existing evaluator without duplicating it. A preview can become stale before navigation and cannot prove the resulting tab ID or actual container. It adds API surface without proving ownership. |
| `sessions.setTabValue` | CTC lacks the required `sessions` permission. These values are private to CTC, so firefox-cli still needs a message bridge. The API supports restored-tab metadata; it does not expose that metadata to firefox-cli. Use `storage.session` for CTC-owned receipt data instead. ([sessions API](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/sessions/setTabValue)) |

## Evidence and live checks

**Source-backed:** CTC’s create/remove flow and permissions; firefox-cli’s strict tab schema and current re-resolution behavior; Firefox API documentation cited above.

**Not live-verified:** The local source report says Firefox was unavailable. Test external-message delivery and `sender.id`; `storage.session` receipt lookup after background suspension; replacement timing during `tab.new` and navigation; URL/container values after redirects; and same-window behavior. If CTC adds `openerTabId` as a secondary hint, explicitly set the source `windowId` and test the field after CTC closes the source. Do not assume that live result from documentation alone.

## API boundary decisions still needed

Receipt lookup should be read-only and repeatable until expiry, not destructive consumption; a lost CLI response must not destroy evidence. Include creation time and bounded lineage for successive replacements. Reject expired receipts and tab-ID reuse. Define request correlation and concurrent-navigation behavior before implementation.

A hard-coded firefox-cli sender is an initial trust proposal, not an approved harness-specific dependency in CTC. Consider an explicit allowlist of trusted extension IDs. A preview API remains optional and separate from replacement proof.

This design requires an upstream firefox-cli feature, not a local fork. A CTC-only change does not make receipts accessible through the current public CLI.
