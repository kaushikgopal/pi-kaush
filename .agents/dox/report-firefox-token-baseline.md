# Firefox token baseline

## Scope and method

The live baseline used Firefox CLI 0.4.1 and Node 26.12.1. A local HTTP fixture served four synthetic pages: form, list, article, and dialog. The test used no accounts, passwords, or cookies.

The harness created one new `about:blank` tab in the unique normal window. It confirmed the new tab ID before it navigated. It targeted every navigation and snapshot by that window ID and tab ID. The original tab and window IDs remained unchanged.

The harness compared CLI `--verbose` and `--compact` snapshots. It also collected a `main`-scoped, depth-7 compact snapshot and passed its text to the existing pure `summarizeSnapshot` helper. The helper import is development-only and requires Node 26.

## Snapshot sizes

Each snapshot cell shows **snapshot text bytes (~tokens); CLI JSON response bytes (~tokens)**. The token estimate is rounded bytes divided by four. It is a heuristic, not a provider tokenizer.

| Page | Fixture HTML bytes | Verbose text; response | Compact text; response | Scoped depth 7 text; response | Helper JSON bytes (~tokens) |
| --- | ---: | ---: | ---: | ---: | ---: |
| Form | 829 | 1,153 (~288); 1,540 (~385) | 824 (~206); 1,211 (~303) | 796 (~199); 1,183 (~296) | 184 (~46) |
| List | 1,133 | 1,792 (~448); 2,213 (~553) | 1,379 (~345); 1,800 (~450) | 1,339 (~335); 1,760 (~440) | 141 (~35) |
| Article | 1,252 | 1,655 (~414); 2,054 (~514) | 1,367 (~342); 1,766 (~442) | 1,339 (~335); 1,738 (~435) | 214 (~54) |
| Dialog | 857 | 872 (~218); 1,249 (~312) | 696 (~174); 1,073 (~268) | 680 (~170); 1,057 (~264) | 197 (~49) |

All 12 snapshots used a 60,000-byte output cap. None were truncated. All four helper summaries used a 4,000-byte cap. None were truncated.

CLI response bytes include the CLI JSON result. Snapshot text bytes and helper JSON bytes are separate measures. These results do not represent final Pi wire output and do not claim parity with surf.

## Calls and screenshot

The harness made 55 Firefox CLI calls: 2 window lists, 30 tab lists, 1 tab creation, 4 navigations, 4 load waits, 12 snapshots, 1 screenshot, and 1 tab close. It called the local summary helper four times.

The one screenshot measured 1043 × 876 pixels and 43,577 bytes. Its theoretical base64 length is 58,104 bytes. The image stayed in a private temporary directory and was removed. No image data entered the report.

## Cleanup

The harness confirmed the owned tab was closed. The original tab and normal-window IDs remained unchanged. The loopback server stopped. No private page was accessed.

## Reproduction

Run `node .agents/dox/test-firefox-token-baseline.mjs` with Node 26 and Firefox CLI 0.4.1. The script serves the fixture asynchronously while it runs CLI commands. It stops if the normal window is ambiguous or the owned tab changes unexpectedly.
