# Supported Firefox CLI — provisional Phase 0 inventory

## Status and evidence

This is a **provisional inventory**, not a claim that all Firefox runtime behavior works. It reviews `firefox-cli` 0.4.1 at commit [`c118396bcd36698a395773724663cc1f1493a04a`](https://github.com/respawn-llc/firefox-cli/tree/c118396bcd36698a395773724663cc1f1493a04a). The source package version is [0.4.1](https://github.com/respawn-llc/firefox-cli/blob/c118396bcd36698a395773724663cc1f1493a04a/packages/cli/package.json#L1-L4). Source findings come from pinned docs, parsers, formatters, protocol schemas, implementation, and narrow CLI tests. Limited live evidence is recorded in the [container live report](report-firefox-container-live.md); Phase 0 remains incomplete.

Successful `--json` output serializes the **result payload**, not the full protocol envelope. Protocol and usage errors normally use stderr, empty stdout, and exit 1. Exceptions include `doctor --json`, which can return a status object on stdout with exit 1, and batch step failures, which return a JSON result on stdout with exit 1. These are source-confirmed stream rules, not observed runtime output. ([formatter](https://github.com/respawn-llc/firefox-cli/blob/c118396bcd36698a395773724663cc1f1493a04a/packages/cli/src/format.ts#L114-L121), [CLI result handling](https://github.com/respawn-llc/firefox-cli/blob/c118396bcd36698a395773724663cc1f1493a04a/packages/cli/src/result.ts#L1-L16), [doctor](https://github.com/respawn-llc/firefox-cli/blob/c118396bcd36698a395773724663cc1f1493a04a/packages/cli/src/commands/setup-doctor.ts#L164-L212), [batch](https://github.com/respawn-llc/firefox-cli/blob/c118396bcd36698a395773724663cc1f1493a04a/packages/cli/src/format.ts#L197-L206), [CLI tests](https://github.com/respawn-llc/firefox-cli/blob/c118396bcd36698a395773724663cc1f1493a04a/packages/cli/src/cli-screenshot.test.ts#L7-L79))

## Health, version, and capabilities

- There is no public `health` command in the pinned CLI route inventory. Use `firefox-cli doctor [--fix] [--json]` for diagnostics. Its JSON payload is `{nativeHostManifest:{status,path,...},nativeHostRegistration?:{status,...},extensionConnection:{status,nextAction?}}`. Status values include manifest `installed|missing|stale|invalid`, Windows registration `installed|missing|stale`, and connection `connected|not-approved|version-mismatch|pairing-mismatch|disconnected`. `--fix` can modify native-host registration, so it is not a read-only probe. ([command docs](https://github.com/respawn-llc/firefox-cli/blob/c118396bcd36698a395773724663cc1f1493a04a/docs/commands.md#L24-L35), [doctor output and exit](https://github.com/respawn-llc/firefox-cli/blob/c118396bcd36698a395773724663cc1f1493a04a/packages/cli/src/commands/setup-doctor.ts#L164-L212), [status shapes](https://github.com/respawn-llc/firefox-cli/blob/c118396bcd36698a395773724663cc1f1493a04a/packages/cli/src/commands/setup-doctor.ts#L238-L261), [connection status](https://github.com/respawn-llc/firefox-cli/blob/c118396bcd36698a395773724663cc1f1493a04a/packages/cli/src/commands/setup-doctor.ts#L320-L354))
- `firefox-cli --version` and `firefox-cli -V` print the injected version string. There is no JSON result shape. The live executable reported `0.4.1`. ([runner](https://github.com/respawn-llc/firefox-cli/blob/c118396bcd36698a395773724663cc1f1493a04a/packages/cli/src/runner.ts#L37-L44))
- `firefox-cli capabilities [--json]` returns `{capabilities:[{command,status,reason?}]}`. Status is `mvp|prototype-gated|deferred|unsupported`; no list-size limit is declared. ([docs](https://github.com/respawn-llc/firefox-cli/blob/c118396bcd36698a395773724663cc1f1493a04a/docs/commands.md#L30-L35), [schema](https://github.com/respawn-llc/firefox-cli/blob/c118396bcd36698a395773724663cc1f1493a04a/packages/protocol/src/core.ts#L81-L85), [result](https://github.com/respawn-llc/firefox-cli/blob/c118396bcd36698a395773724663cc1f1493a04a/packages/protocol/src/core.ts#L166-L169))

## Windows, tabs, and open

Public syntax is documented as:

```text
tab [--window target] [--json]
tab new [url] [--focus] [--window target] [--json]
tab select [target] [--focus] [--json]
tab close [target] [--json]
window [--json]
window new [url] [--focus] [--json]
window select [target] [--window target] [--json]
window close [target] [--window target] [--json]
open [--new-tab] [--focus] <url> [--json]
```

Targets are `active`, a nonnegative index, or `id:<number>`. Use `--tab` and `--window` where supported. Page-targeted commands accept both selectors; `tab`, `tab new`, `window select`, `window close`, and `set viewport` accept `--window` only. `open --new-tab` resolves only a window. Omitted targets require an unambiguous browser surface. `open` normalizes URLs without a scheme to `https://`. `--new-tab` creates an unselected tab; `--focus` requests tab selection and window foregrounding. ([target rules](https://github.com/respawn-llc/firefox-cli/blob/c118396bcd36698a395773724663cc1f1493a04a/docs/commands.md#L3-L20), [commands](https://github.com/respawn-llc/firefox-cli/blob/c118396bcd36698a395773724663cc1f1493a04a/docs/commands.md#L37-L52), [route selector syntax](https://github.com/respawn-llc/firefox-cli/blob/c118396bcd36698a395773724663cc1f1493a04a/packages/cli/src/route-registry.ts#L162-L172))

- Tab listing returns `{target?,tabs:[{id,index,active,title?,url?,windowId,private?,cookieStoreId?}]}`. Window listing returns `{windows:[{id,index,focused,activeTabId?,tabCount,private?,left?,top?,width?,height?}]}`. Schemas declare no maximum array size. `cookieStoreId` is optional and may be absent. ([target schemas](https://github.com/respawn-llc/firefox-cli/blob/c118396bcd36698a395773724663cc1f1493a04a/packages/protocol/src/target.ts#L3-L15), [window and list schemas](https://github.com/respawn-llc/firefox-cli/blob/c118396bcd36698a395773724663cc1f1493a04a/packages/protocol/src/target.ts#L52-L76))
- `tab new` and `tab select` return `{target}`; `tab close` returns `{closedTabId,nextActiveTabId?}`. `window new` and `window select` return `{window,target?}`; `window close` returns `{closedWindowId}`. Creation accepts optional URL and focus. ([result schemas](https://github.com/respawn-llc/firefox-cli/blob/c118396bcd36698a395773724663cc1f1493a04a/packages/protocol/src/target.ts#L78-L126))
- `open` returns `{target,url?,loadState?}`; load state is `unknown|complete`. ([schema](https://github.com/respawn-llc/firefox-cli/blob/c118396bcd36698a395773724663cc1f1493a04a/packages/protocol/src/target.ts#L128-L145))
- No public command or parameter creates or enumerates Firefox containers. Tab creation has no container selector. A tab's optional `cookieStoreId` is observational metadata, not proof when absent. ([tab schema](https://github.com/respawn-llc/firefox-cli/blob/c118396bcd36698a395773724663cc1f1493a04a/packages/protocol/src/target.ts#L3-L15), [tab creation schema](https://github.com/respawn-llc/firefox-cli/blob/c118396bcd36698a395773724663cc1f1493a04a/packages/protocol/src/target.ts#L78-L94))
- Source inconsistency: route help labels positional tab/window targets as `target-or-url`, but the parser accepts only `active`, an index, or `id:<number>`. Do not rely on URL-substring selection without a live check. ([route help](https://github.com/respawn-llc/firefox-cli/blob/c118396bcd36698a395773724663cc1f1493a04a/packages/cli/src/route-registry.ts#L164-L171), [parser](https://github.com/respawn-llc/firefox-cli/blob/c118396bcd36698a395773724663cc1f1493a04a/packages/cli/src/parse.ts#L212-L243))

## Snapshots and refs

Syntax: `snapshot [-i|--interactive] [-c|--compact] [--verbose] [-d|--depth N] [-s|--selector CSS] [--max-output bytes] [--json]`; `ref <@eN> [--generation ID] [--json]`. Snapshot JSON is `{target?,text,generationId,refs,truncated,frames}`. It is a text rendering of visible main-frame DOM elements with role/name-like labels, not a structured accessibility tree. Iframes are diagnostic-only; iframe refs and targeted commands are unsupported. Default depth is 8, maximum 50; default output cap is 60,000 bytes, maximum 1,000,000 bytes; each generation holds at most 1,000 refs. The registry retains up to five generations for ten minutes. Refs resolve against the latest generation unless `--generation` is given. Detached, expired, evicted, or unknown refs fail with `REF_NOT_FOUND`. ([docs](https://github.com/respawn-llc/firefox-cli/blob/c118396bcd36698a395773724663cc1f1493a04a/docs/commands.md#L54-L72), [schemas](https://github.com/respawn-llc/firefox-cli/blob/c118396bcd36698a395773724663cc1f1493a04a/packages/protocol/src/content.ts#L6-L37), [rendering](https://github.com/respawn-llc/firefox-cli/blob/c118396bcd36698a395773724663cc1f1493a04a/packages/extension/src/content-snapshot/snapshot-render.ts#L15-L47), [ref registry](https://github.com/respawn-llc/firefox-cli/blob/c118396bcd36698a395773724663cc1f1493a04a/packages/extension/src/element-ref-registry.ts#L1-L3))

## Actions and waits

Documented action syntax:

```text
click|dblclick|focus|hover <selector|@ref> [--generation ID] [--json]
fill|type <selector|@ref> <text> [--generation ID] [--json]
press <key> [--json]
keyboard type|inserttext <text> [--json]
check|uncheck <selector|@ref> [--generation ID] [--json]
select <selector|@ref> <value...> [--generation ID] [--json]
scroll|swipe up|down|left|right [px] [selector|@ref] [--generation ID] [--json]
scrollintoview <selector|@ref> [--generation ID] [--json]
drag <source> <target> [--json]
upload <selector|@ref> <file...> [--generation ID] [--json]
mouse move|down|up|wheel [selector|@ref] [--x N] [--y N] [--button NAME] [--delta-x N] [--delta-y N] [--generation ID] [--json]
keydown|keyup <key> [selector|@ref] [--generation ID] [--json]
```

JSON action results use `{target?,action,ok:true,element}`; text actions add `valueLength`, select adds `selectedValues`, and scroll actions add `scroll:{x,y}`. These use content-script/WebExtension events, not OS input. Scroll distance is capped at 100,000 px. Uploads allow at most 20 files, 512,000 bytes per file, and 640,000 bytes total per command or batch. ([syntax and behavior](https://github.com/respawn-llc/firefox-cli/blob/c118396bcd36698a395773724663cc1f1493a04a/docs/commands.md#L105-L128), [parser flags](https://github.com/respawn-llc/firefox-cli/blob/c118396bcd36698a395773724663cc1f1493a04a/packages/cli/src/argv-contracts.ts#L42-L50), [action result schemas](https://github.com/respawn-llc/firefox-cli/blob/c118396bcd36698a395773724663cc1f1493a04a/packages/protocol/src/actions.ts#L140-L203), [limits](https://github.com/respawn-llc/firefox-cli/blob/c118396bcd36698a395773724663cc1f1493a04a/packages/protocol/src/constants.ts#L14-L16))

Wait syntax includes `wait <ms>`, `wait <selector|@ref> [--state visible|hidden|attached]`, `--text`, `--url`, `--fn`, `--load domcontentloaded|complete|networkidle`, and `--download [id|filename-glob]`. All accept `--timeout` and `--interval`. JSON is a discriminated result with `kind`, `matched:true`, and `elapsedMs`; variants may add `element`, `value`, or `download`. Defaults are 30,000 ms timeout and 100 ms interval. Maximum timeout/duration is 600,000 ms, interval is 60,000 ms, and function source is 20,000 characters. ([docs](https://github.com/respawn-llc/firefox-cli/blob/c118396bcd36698a395773724663cc1f1493a04a/docs/commands.md#L91-L103), [schema](https://github.com/respawn-llc/firefox-cli/blob/c118396bcd36698a395773724663cc1f1493a04a/packages/protocol/src/content.ts#L207-L268), [timeout policy](https://github.com/respawn-llc/firefox-cli/blob/c118396bcd36698a395773724663cc1f1493a04a/packages/protocol/src/timeout-policy.ts#L42-L50))

## Eval, screenshot, and resize

- `eval <js>|--stdin|--base64 <base64-js> [--timeout ms] [--max-output bytes] [--json]` accepts exactly one script source. It runs in the page main world. JSON result is `{target?,value:{type:"undefined"}|{type:"json",value},elapsedMs}`. Script limit is 100,000 bytes; default result limit is 900,000 bytes; timeout defaults to 30,000 ms and caps at 600,000 ms. ([docs](https://github.com/respawn-llc/firefox-cli/blob/c118396bcd36698a395773724663cc1f1493a04a/docs/commands.md#L130-L140), [CLI parser](https://github.com/respawn-llc/firefox-cli/blob/c118396bcd36698a395773724663cc1f1493a04a/packages/cli/src/commands/eval.ts#L18-L53), [schema and limits](https://github.com/respawn-llc/firefox-cli/blob/c118396bcd36698a395773724663cc1f1493a04a/packages/protocol/src/browser/eval-screenshot.ts#L16-L52))
- `screenshot [path] [--focus] [--format png|jpeg] [--screenshot-quality 1-100] [--timeout ms] [--max-output bytes] [--json]` writes an image file. Default path is `<cwd>/screenshot.png`; JSON returns `{target?,path,format,bytes,width?,height?,activation:{tabActivated,windowFocused}}`, not image bytes. Capture activates the requested tab; `--focus` requests window foregrounding. PNG/JPEG are supported; quality applies only to JPEG; max image size is 8,000,000 bytes; default timeout is 30,000 ms, maximum 600,000 ms. `--screenshot-format` is also parsed. `--full` is parsed but returns `UNSUPPORTED_CAPABILITY`. No screenshot resize flag is documented or parsed. ([docs](https://github.com/respawn-llc/firefox-cli/blob/c118396bcd36698a395773724663cc1f1493a04a/docs/commands.md#L130-L140), [CLI parser](https://github.com/respawn-llc/firefox-cli/blob/c118396bcd36698a395773724663cc1f1493a04a/packages/cli/src/commands/screenshot.ts#L20-L63), [file write and byte removal](https://github.com/respawn-llc/firefox-cli/blob/c118396bcd36698a395773724663cc1f1493a04a/packages/native-host/src/host-broker.ts#L268-L328), [result schema](https://github.com/respawn-llc/firefox-cli/blob/c118396bcd36698a395773724663cc1f1493a04a/packages/protocol/src/browser/eval-screenshot.ts#L54-L100))
- Window resizing is separate: `set viewport <width> <height> [--window target] [--json]`. It returns `{window}`; each positive dimension is capped at 10,000. Window-manager rules may prevent the requested size. ([docs](https://github.com/respawn-llc/firefox-cli/blob/c118396bcd36698a395773724663cc1f1493a04a/docs/commands.md#L154-L173), [schema](https://github.com/respawn-llc/firefox-cli/blob/c118396bcd36698a395773724663cc1f1493a04a/packages/protocol/src/browser/output.ts#L78-L90))

## Network, console, and batch

- `network list|clear [--url glob] [--json]` returns `{action,ok:true,requests?}`; each request has `id,url,method?,type?,statusCode?`. Public results have **no bodies and no timestamps**. The tracker keeps at most 1,000 completed requests per tab. ([docs](https://github.com/respawn-llc/firefox-cli/blob/c118396bcd36698a395773724663cc1f1493a04a/docs/commands.md#L154-L173), [schema](https://github.com/respawn-llc/firefox-cli/blob/c118396bcd36698a395773724663cc1f1493a04a/packages/protocol/src/browser/page-state.ts#L111-L135), [tracker cap and projection](https://github.com/respawn-llc/firefox-cli/blob/c118396bcd36698a395773724663cc1f1493a04a/packages/extension/src/network-tracker.ts#L34-L45))
- `console|errors list|clear [--json]` returns entries/errors with `level,text,timestamp`, plus optional `truncated,droppedEntries`. Buffers cap at 500 entries and 128,000 serialized bytes. ([docs](https://github.com/respawn-llc/firefox-cli/blob/c118396bcd36698a395773724663cc1f1493a04a/docs/commands.md#L165-L167), [schemas](https://github.com/respawn-llc/firefox-cli/blob/c118396bcd36698a395773724663cc1f1493a04a/packages/protocol/src/browser/output.ts#L7-L42), [limits](https://github.com/respawn-llc/firefox-cli/blob/c118396bcd36698a395773724663cc1f1493a04a/packages/protocol/src/constants.ts#L12-L13))
- `batch <json>|--stdin [--bail] [--timeout ms] [--max-output bytes] [--json]` accepts 1–100 argv-array or `{command,params}` steps. Steps run serially against a once-resolved default target. Without `--bail`, later steps continue after a failure. JSON is `{ok,steps:[{index,command,ok:true,result}|{index,command,ok:false,error}],firstFailedIndex?,elapsedMs}`. Timeout caps at 600,000 ms; result cap is 900,000 bytes. An argv step cannot itself read stdin. ([docs](https://github.com/respawn-llc/firefox-cli/blob/c118396bcd36698a395773724663cc1f1493a04a/docs/commands.md#L130-L152), [CLI parser](https://github.com/respawn-llc/firefox-cli/blob/c118396bcd36698a395773724663cc1f1493a04a/packages/cli/src/commands/batch.ts#L36-L56), [schema](https://github.com/respawn-llc/firefox-cli/blob/c118396bcd36698a395773724663cc1f1493a04a/packages/protocol/src/batch.ts#L64-L84), [result schema](https://github.com/respawn-llc/firefox-cli/blob/c118396bcd36698a395773724663cc1f1493a04a/packages/protocol/src/batch.ts#L153-L160))

## Phase 0 live-probe checklist

Run these only on the target machine after separate install/pairing approval. Use a disposable test tab and synthetic page. Preserve the user's existing Firefox tabs. Pass explicit owned tab/window IDs to every target-dependent probe. Sanitize output before recording installed version, exit code, stdout, stderr, and observed result fields. Do not record unrelated tab URLs or titles. Window selection and resizing require separate approval; they are not prerequisites for the first vertical slice.

1. Check `firefox-cli --version`, `firefox-cli doctor --json`, and `firefox-cli capabilities --json`. Do not use `doctor --fix`.
2. Check `firefox-cli window --json`. For each relevant window, use `firefox-cli tab --window id:<window-id> --json`; compare actual container metadata with the optional source field.
3. On a disposable test window, probe `window new <synthetic-fixture-url> --json`, `window select id:<window-id> --json`, and `window close id:<window-id> --json`. Close only that test window.
4. On a disposable test tab, probe `open --new-tab <synthetic-fixture-url> --json`, `tab new <synthetic-fixture-url> --json`, `tab select id:<tab-id> --json`, `snapshot --json`, `ref <@eN> --generation <id> --json`, one action, one wait, and `tab close id:<tab-id> --json`. Close only the test-created tab.
5. Probe `eval --json`, write a screenshot to a designated temporary path, test `set viewport <width> <height> --json`, then check `network list --json`, `console list --json`, and one small `batch <json> --json`. Record file metadata, not image bytes.

CTC remains the routing authority. This inventory adds no routing or provenance helper. The approved before/after tab-metadata comparison and human confirmation baseline still needs live validation. Do not start wrapper implementation until Phase 0 live probes complete.


## Live Phase 0 evidence addendum

A bounded run used Firefox 158.0.1 and connected firefox-cli 0.4.1. See [container live checks](report-firefox-container-live.md) for sanitized commands and outcomes.

- Public `get value` succeeded on both confirmed container tabs. Scoped, compact snapshots parsed with `truncated` false at a 512-byte cap and true at 64 bytes. Ref resolution and a generation-bound click succeeded. The ref returned the documented `REF_NOT_FOUND` error after navigation.
- The screenshot command succeeded at 1043 × 904 and 60,861 bytes. It activated the target tab without focusing the window. The temporary image was removed.
- Synthetic cookie set, observe, clear, and reset forms ran. `get text body` could not read either observation response. Firefox returned `SCRIPT_INJECTION_FAILED` because it denied host access to the JSON response. Cookie isolation is not proven.
- `network list` returned zero fixture requests before and after requests. `console list` returned zero entries. Capture effectiveness remains unverified.
- `frame` returned zero frames. `tab new about:config` returned `PERMISSION_DENIED: Illegal URL: about:config`. Private-window creation and iframe behavior were not tested.
- The confirmed tabs and exact fixture process were cleaned up. Manual CTC removal remains required. No wrapper implementation or package change followed these probes.
