# Firefox container live checks

## Environment and authorization

Firefox 158.0.1 and firefox-cli 0.4.1 run on Brainiac. The owner approved two temporary test containers, CTC rules, synthetic-cookie probes, and screenshot capture. The owner confirmed candidate tab 14 as FFX Test Work and candidate tab 16 as FFX Test Personal before adoption. Only synthetic loopback fixture pages were used. No CTC configuration or Firefox internals were accessed through a back channel.

## Observed results

| Probe | Outcome |
| --- | --- |
| Default seed 13 navigates to Work | CTC removes 13; one new matching candidate 14 reports `firefox-container-6` |
| Work candidate adoption | Owner confirms 14; URL and actual container are revalidated before actions |
| Work snapshot and label lookup | Success; 25 refs, bounded snapshot, one matching label |
| Work fill | Success |
| Work → shared route | Same confirmed tab ID and actual container survive |
| Default seed 15 navigates to Personal | CTC removes 15; one new matching candidate 16 reports `firefox-container-7` |
| Personal candidate adoption | Owner confirms 16; URL and actual container are revalidated before actions |
| Personal snapshot | Success; 25 refs, not truncated |
| Personal → shared route | Same confirmed tab ID and actual container survive |
| Same shared URL in both containers | Different synthetic field values remain separate after both fills and re-reads |
| Existing tabs | Existing IDs remain present; new test tabs remain inactive |

These results prove container metadata and independent page state for the observed tabs. They do not yet prove cookie-store isolation, wrapper behavior, race safety, or automatic ownership provenance.

## Constraint found

The test fixture's restrictive CSP blocks firefox-cli eval with `EVAL_ERROR: Eval failed: call to Function() blocked by CSP`. Public `get value` succeeds. Keep CSP intact and use the supported getter; do not bypass the page policy. The earlier no-CSP smoke fixture allowed eval.

## Follow-up live probes

Firefox 158.0.1 and firefox-cli 0.4.1 were connected. Before testing, tabs 14 and 16 still matched their confirmed IDs, shared fixture route, window 7, and container IDs `firefox-container-6` and `firefox-container-7`.

| Probe and sanitized command | Result |
| --- | --- |
| `firefox-cli --version`; `firefox-cli tab --window id:7 --json` | Version was `0.4.1`. Revalidation confirmed only the approved test tabs and their expected container IDs. |
| `get value 'input[name="synthetic-note"]' --window id:7 --tab id:14 --json`; same for tab 16 | Both exited 0. Returned synthetic string lengths were 23 and 27. Values were not recorded. |
| `firefox-cli capabilities --json` | Exit 0; 67 entries. `screenshot`, `frame`, `cookies`, `network`, `console`, and `set.viewport` were `mvp`; `screenshot --full` was `unsupported`. |
| `snapshot -i -c -d 2 -s main --max-output 512 --window id:7 --tab id:14 --json` | Exit 0; JSON parsed; `truncated=false`; rendered text was 133 bytes. `snapshot -c -d 1 -s main --max-output 64 --window id:7 --tab id:14 --json` exited 0 with `truncated=true`, 37 text bytes, and 396 JSON bytes. |
| `ref @e5 --generation gmvoeoofx-1`; `click @e5 --generation gmvoeoofx-1` | Both exited 0. The click reset fixture comparison state. After navigation, the same ref returned this exact error: REF_NOT_FOUND: Element ref is stale or unknown. Run `firefox-cli snapshot -i` again. |
| Fixture cookie form clicks | Exact commands and outcomes follow the table. No cookie CLI was used. |
| `get text body` after either observation POST | Exit 1: `SCRIPT_INJECTION_FAILED: Cannot run firefox-cli in this tab because Firefox denied extension host access. Re-approve host permissions and try again. Firefox reported: Missing host permission for the tab Try a normal web page tab and reload it after updating the extension.` The aggregate equality was unreadable, so cookie isolation is **blocked, not passed**. |
| `network list --window id:7 --tab id:14 --json`; `console list --window id:7 --tab id:14 --json` | Both exited 0 before and after fixture requests. Network returned zero fixture requests. Console returned zero entries, not truncated. No bodies or timestamps were read. |
| `screenshot <private-temp>.png --format png --window id:7 --tab id:14 --json` | Exit 0; PNG was 1043 × 904 and 60,861 bytes. It activated tab 14 but did not focus the window. The private temporary file was removed. |
| `frame --window id:7 --tab id:14 --json` | Exit 0; zero frames at that time. The later fixture correction adds safe frame routes; see the results below. |
| `tab new about:config --window id:7 --json` | Exit 1: `PERMISSION_DENIED: Illegal URL: about:config`. No tab was created. Private-window creation was skipped because the public CLI exposes no private-window option. |

### Cookie form commands

- Set Work only: `click 'form[action="?action=cookie-set"] button' --window id:7 --tab id:14 --json` exited 0 on retry. Its first attempt returned the same host-permission error after the JSON reset response. `get text body --window id:7 --tab id:14 --json` read the successful retry confirmation.
- Observe Work: `open http://127.0.0.1:48765/pi-firefox-test/work/ --window id:7 --tab id:14 --json`, then `click 'form[action="?action=cookie-observe"] button' --window id:7 --tab id:14 --json`. Both exited 0.
- Observe Personal: `open http://127.0.0.1:48765/pi-firefox-test/personal/ --window id:7 --tab id:16 --json`, then `click 'form[action="?action=cookie-observe"] button' --window id:7 --tab id:16 --json`. Both exited 0.
- Read aggregates with `get text body --window id:7 --tab id:14 --json` and `get text body --window id:7 --tab id:16 --json`; both returned the host-permission error above.
- Clear Work with `click 'form[action="?action=cookie-clear"] button' --window id:7 --tab id:14 --json`; clear Personal with the same command and `--tab id:16`. Both exited 0 and returned the synthetic clear confirmation. Reset with `click 'form[action="?action=cookie-reset"] button' --window id:7 --tab id:14 --json`; exit 0.

## Cleanup and remaining limits

Both synthetic-cookie clear forms returned their fixture confirmation. The server comparison state was reset. `tab close id:14 --window id:7 --json` and `tab close id:16 --window id:7 --json` exited 0. Both confirmed IDs were absent afterward. Fixture PID 57610 matched the expected script and port listener before SIGTERM; the process and listener stopped. No CTC settings changed. Manual removal of the four test rules and two test containers remains required.

Phase 0 is incomplete. Cookie isolation equality, network capture effectiveness, iframe behavior, and private-window behavior remain unverified. No account cookies, headers, page bodies, screenshot bytes, or unrelated tab URLs were recorded.

## Fixture correction and default-container probe

The fixture now serves `/phase0-probe/`, `/phase0-frame/`, and `/phase0-json/` outside the CTC route prefix. The probe CSP permits only the two explicit frame URLs. The same-origin and `localhost` cross-origin frame URLs returned HTTP 200 in local checks. The immediate network list saw both sub-frame requests. `frame` listed one same-origin frame and one `localhost` cross-origin frame. It returned no unsupported/read-only flags. No iframe interaction was attempted, so frame control remains untested.

`/phase0-probe/` returned HTML containing `false`. The same-origin `/phase0-json/` returned `application/json` containing `{"equal":false}`. Public `firefox-cli get text body` read the HTML result. It failed on the JSON result with `SCRIPT_INJECTION_FAILED` and Firefox's missing-host-permission message. This reproduces a content-type-dependent read failure. Firefox's internal JSON viewer is a suspected cause, not a proven cause.

The `cookie-reset` and `cookie-observe` responses now use HTML with `<pre id="aggregate">` containing only the JSON equality aggregate. On a newly created default-store tab, the reset response was readable as `{"equal":null}`. The observe response was readable as `{"equal":true}` after synthetic no-cookie observations. No cookie values or account content were read. This checks response readability only; cookie isolation remains unverified.

The immediate network check recorded zero requests before navigation and three afterward: one main-frame request and two sub-frame requests. The declared 4097-byte POST returned HTTP 413. `node --check` passed.

Probe tab 17 was absent from the baseline. It remained in window 7 with `firefox-default` after navigation, then closed successfully. The pre-existing tab remained present. No CTC rules or containers changed, and no candidate tab was adopted.

The fixture server remains running on `127.0.0.1:48765`. PID: `62548`. Private state directory, mode 700: `/private/var/folders/v1/x77khwrn3zv67l3mqqfxrvcr0000gn/T/pi-firefox-container-server.aWjMOf`.

## Cookie isolation retest: passed

The owner confirmed new candidate tab 19 as Work (`firefox-container-6`) and tab 21 as Personal (`firefox-container-7`). Exact tab ID, synthetic route, and actual container were revalidated before each action. The original confirmed tabs had already been closed during the earlier cleanup.

Using the corrected HTML fixture responses, public `get text #aggregate` returned `{"equal":false}` after setting the synthetic cookie in Work only and observing both containers. After setting the same synthetic cookie in Personal, comparison returned `{"equal":true}`. Both checks passed. Cookies were set through fixture forms only; no account cookies or cookie headers were read. Both clear forms returned their confirmation afterward.

Tabs 19 and 21 remain open for remaining checks. The fixture server is still running. Earlier cookie-isolation and network blockers above are historical: cookie comparison and immediate network capture now pass. Private-window mutation refusal is still source-backed but not live-verified. Snapshot iframe diagnostics were observed; cross-origin iframe control remains unsupported.

## Private-window boundary: owner-approved scope

The owner opened a temporary private window. Public `firefox-cli window --json` returned no windows marked private. No private tab content was read and no private mutation was attempted. Firefox's current extension permissions do not expose that window.

The owner explicitly declined enabling private-window access and accepted the existing permission boundary. Do not request or enable private-window access for this project. The direct private-mutation guard is source-backed but intentionally not live-tested. This test is skipped by owner decision, not a live pass.
