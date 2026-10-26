# Firefox CLI Phase 0 live smoke

## Outcome

**Initial smoke passed; container checks remain pending.** Firefox CLI 0.4.1 reported an installed native host and a connected extension. The environment baseline reported Firefox 158.0.1.

The fixture served only synthetic HTML on loopback at `http://127.0.0.1:56252/start`. Its link navigated to `http://127.0.0.1:56252/second`. The server stopped after the probe.

One background tab was created in window 7. The CLI returned `target.tabId=9`. Tab listing confirmed tab 9 was non-private, inactive, and had `cookieStoreId=firefox-default`. The creation response showed `target.url=about:blank`; the snapshot and navigation wait later showed the requested fixture routes.

The original tab remained present. The active tab stayed unchanged. The test tab closed successfully. The final tab count matched the initial count.

## Probe results

Byte counts are stdout/stderr. JSON byte counts include the final newline.

| Probe | Exit | Bytes | Observed result |
|---|---:|---:|---|
| `--version` | 0 | 6 / 0 | Plain text `0.4.1`. |
| `doctor --json` | 0 | 217 / 0 | Keys: `nativeHostManifest`, `extensionConnection`; statuses `installed`, `connected`. |
| `capabilities --json` | 0 | 4,859 / 0 | Key: `capabilities`; 67 entries, 61 `mvp`, 6 `unsupported`. |
| Initial tab list | 0 | 522 / 0 | Key: `tabs`; one tab. Filtered IDs and container metadata remain in a local temporary file. |
| Initial window list | 0 | 237 / 0 | Key: `windows`; window 7 focused, one tab. |
| `tab new` | 0 | 223 / 0 | Key: `target`; numeric `tabId=9`, `windowId=7`. |
| Tab list after creation | 0 | 760 / 0 | Key: `tabs`; two tabs. Original tab remained; tab 9 was inactive, non-private, and used `firefox-default`. |
| Window list after creation | 0 | 237 / 0 | Key: `windows`; window remained focused; active tab stayed unchanged. |
| `snapshot --json` | 0 | 810 / 0 | Keys: `target,text,generationId,refs,truncated,frames`; generation `gmvoax4gh-1`, 10 refs, not truncated, zero frames. |
| `ref @e6 --generation` | 0 | 426 / 0 | Keys: `target,element`; resolved the synthetic textbox. |
| `find text 'Fixture Start'` | 0 | 1,765 / 0 | Keys: `target,elements`; returned three candidates. |
| `find selector h1` | 1 | 0 / 36 | Error: `Missing or invalid find kind/value.` |
| Synthetic fill | 0 | 502 / 0 | Keys: `target,ok,action,element,valueLength`; filled 21 characters. |
| Local button click | 0 | 483 / 0 | Keys: `target,ok,action,element`; action succeeded. |
| Text wait | 0 | 323 / 0 | Keys: `target,matched,elapsedMs,kind,value`; matched `Clicked locally`. |
| Constant aggregate eval | 0 | 511 / 0 | Keys: `target,value,elapsedMs`; one heading, two list items, one navigation link, expected synthetic input, updated status. |
| Fixture-link click | 0 | 495 / 0 | Keys: `target,ok,action,element`; action succeeded. |
| URL wait | 0 | 338 / 0 | Keys: `target,matched,elapsedMs,kind,value`; matched the `/second` route. |
| Stale ref after navigation | 1 | 0 / 85 | `REF_NOT_FOUND: Element ref is stale or unknown. Run `firefox-cli snapshot -i` again.` |
| `network list --json` | 0 | 55 / 0 | Keys: `action,ok,requests`; zero requests returned. |
| `console list --json` | 0 | 99 / 0 | Keys: `action,ok,entries,truncated,droppedEntries`; zero entries, not truncated. |
| Close tab 9 | 0 | 47 / 0 | Keys: `closedTabId,nextActiveTabId`; closed tab 9. |
| Final tab list | 0 | 522 / 0 | Key: `tabs`; initial tab count and filtered IDs/container metadata matched. |

## Skipped and untested

- Screenshot was skipped because the CLI activates its target tab. Screenshot focus effects remain untested.
- No tab selection, window selection, resize, private tab, cookie creation, or container creation occurred.
- Container capabilities remain untested. The observed `cookieStoreId` is metadata only.
- The network listing returned no captured requests despite successful fixture navigation.
- The worker attempted unsupported `find selector` syntax. Its usage error is expected, not a supported-locator regression. The supported text lookup succeeded but returned three candidates.

Filtered before/after tab IDs and container metadata remain in the local temporary directory. Raw tab-list outputs were removed. No unrelated tab titles or URLs are included here.
