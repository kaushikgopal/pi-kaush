# Review findings — 18 November 2026

These findings cover two review runs. The [commit index](report-review-improve-commits-2026-11-18.md) maps commits to their original row IDs. Reproduce open issues against the current tip before changing code. The review is incomplete; no final whole-branch gate or blind review has passed.

## Verified ranges and yield

- Earlier markers: [bdfcb14..030fc02](https://github.com/kaushikgopal/pi-kaush/compare/bdfcb14...030fc02), 45 linear commits; unit gates passed. The ledger checked 302 canonical rows: 227 keep, 51 fix (38 committed, 12 not applied, one reverted), and 24 human questions. Counts are dispositions, not unique defects.
- Earlier layout: [030fc02..5efcd42](https://github.com/kaushikgopal/pi-kaush/compare/030fc02...5efcd42), 20 commits. Six investigator fixes and test corrections landed, but the layout unit had not reached final gates. Merge [43acfc7](https://github.com/kaushikgopal/pi-kaush/commit/43acfc7) combined that checkpoint with the separate release branch. Its merged-tree check passed 1,481 Vitest tests, two skipped, and 57 Bun tests; it was not a layout gate.
- Fresh markers: [43acfc7..7c0ac94](https://github.com/kaushikgopal/pi-kaush/compare/43acfc7...7c0ac94), 12 linear commits; unit gates passed. Of 286 checked canonical rows, 254 were keep, 13 fix (12 committed, one explained), and 19 human. Five production fixes had independent red/green proofs; the performance row closed through an existing fix.
- Repository dependency lens: the earlier AST scan found 1,434 import-like occurrences in 317 tracked TS/JS-family files; the fresh scan found 1,438 in the same number of files. The fresh scan resolved 695 locally and 743 externally, with no unresolved local/workspace literals, three file cycles and no inter-package, inter-unit, or inter-folder cycles. It judged 25 of 26 concerns; one was intentionally not re-judged. These are static scans, not test coverage.
- Fresh layout scouting finished four lenses at `7c0ac94`: boundary-failures judged 29 groups (28 keep, one fix); data-modeling judged 29 (three fix); domain-language judged 18 (six fix, one out of scope); duplication judged 33 current candidates (seven fix). The 17 fix-marked rows may overlap and are proposals, not 17 verified bugs or completed changes. No layout tests were run by those four scouts.

The earlier runs completed all 12 scouting lenses for both markers and layout. Boundary, race, open-review and test-quality lenses produced concrete reproductions or stronger tests; duplication and data-modeling also found behavior-preserving candidates. The lens caps leave unjudged candidates, so a completed scout is not exhaustive coverage.

## Confirmed failures and race outcomes

- `pi-tool-call-markers-race-conditions-1`: hiding a live thinking block could corrupt its final duration. Fixed in [ebc34f1](https://github.com/kaushikgopal/pi-kaush/commit/ebc34f1).
- `pi-tool-call-markers-race-conditions-2`: after reload, a retained thinking wrapper could use the old owner's styling context. Fixed in [c4dcd09](https://github.com/kaushikgopal/pi-kaush/commit/c4dcd09).
- `pi-tool-call-markers-race-conditions-8`: a buried old tool-render wrapper could be reactivated after reload, leaving new default emojis absent. Fixed in [f7a497c](https://github.com/kaushikgopal/pi-kaush/commit/f7a497c). The proof used real old/new renderer code and wrapper orders, not a full end-to-end Pi reload.
- `pi-content-layout-race-conditions-1`: one of two installations could remove their shared system-text hook while the other remained active. Fixed in [a79b5b4](https://github.com/kaushikgopal/pi-kaush/commit/a79b5b4).
- Other examined queued-event races were kept based on synchronous render/update contracts. That does not prove arbitrary extension callbacks safe: a throwing undo can still leave rows missing, a separate synchronous failure question. Fresh markers `race-conditions-7` lacks a direct test changing arguments between draws.
- `pi-tool-call-markers-open-review-1` found split Unicode graphemes; [9441a81](https://github.com/kaushikgopal/pi-kaush/commit/9441a81) fixed wrapping. The same change closed `open-review-2`'s repeated-prefix performance problem. Before the fix, one local run measured about 96/531/6,850 ms for 1,600/3,200/6,400-character answers; these are observations, not test thresholds. Width-call counts fell from 19,255/78,505/317,005 to 1,607/3,207/6,407 at 80 columns.

## Open bugs and decisions

- `pi-content-layout-test-quality-9` reproduced submitted text visible before installation but missing after installation at width 6. Fresh `pi-content-layout-boundary-failures-29` proposes falling back to native rendering when padding hides the text. Recheck the behavior and desired contract on the current tip.
- `pi-content-layout-test-quality-10` reproduced a hook remaining registered after repeated starts and shutdown. Overlapping or repeated lifecycle events need a settled ownership contract and direct coverage.
- Marker `boundary-failures-19` and `-21` question malformed questionnaire answer details and errors; `-43` questions replayed agent identity. `hidden-state-1` through `-4` and `-6` concern partial publication or ownership after install failures. These remain human decisions, not all confirmed bugs. Recheck questionnaire behavior after the later styling change.
- Marker `repo-rules-1` and the November 18 repository rows `dependency-direction-16` through `-20` ask how documented rendering behavior should reconcile with private Pi component/editor shapes and the public-API rule. Marker `sibling-consistency-7`, `-8`, `-14`, and `-16` name differences in blank tasks, zero-count labels, emoji identity, and control actions.
- November 18 repository rows `dependency-direction-6` through `-8`, `-21` and `-22` remain behavior-neutral proposals: core barrel and type cycles, plus policy imports through filesystem or store adapters. November 17 `dependency-direction-18`, a cross-package presentation contract, was not applied because it expands the public API and was not re-judged in the fresh repo lens. Confirm row ownership and current source before revisiting.
- Fresh layout proposals include one shared submitted-prompt width calculation (`data-modeling-27`, `domain-language-15`, `duplication-32`) and a single selected intercom body (`data-modeling-28`, `duplication-8`). Each row retains its own proof requirements; do not count overlapping proposals as independent fixes.

## Tests corrected and removed

Earlier markers `test-quality` judged 31 families: 17 corrections landed, two proposed standalone cases were not applied, and `test-quality-13` was reverted. Gate repair strengthened existing tests for `-14` and `-20` rather than adding standalone cases. Six weaker test groups were consolidated or removed: `unnecessary-tests-1` and `-2` at `8ecd9db`, then `-3`, `-18`, `-26` and `-40` at `f0b727a`, `a84fd2b`, `a4a856b` and `030fc02`.

Earlier layout `test-quality-1` through `-8` and `-11` through `-14` strengthened existing assertions; `-9` and `-10` remain open above. No layout unnecessary-test removal was applied.

Fresh marker `test-quality-1` through `-3` strengthened model precedence, visible narrow-width content, and failure-emoji styling at `e0e9877`, `24b7342`, and `4860013`. `defensive-code-1` added saved-null-argument fallback coverage at `0530c4f`. `unnecessary-tests-41` removed two duplicate default-subagent mock cases at `7c0ac94`; retained real-renderer tests cover pending, settled, width, and expansion behavior. The frozen gate excluded a docs-only marker wording correction, `domain-language-19`, from that review range; inspect the later README change before treating it as still open.

## Coverage limits

- Fresh markers defensive-code detected 554 syntactic candidates but judged only 40; 514 were cap-limited. Its unnecessary-tests lens judged 40 of 41 candidates. Earlier markers recorded 502 defensive-code candidates and two unnecessary-test candidates unjudged at their caps.
- Earlier marker rows `boundary-failures-2` and `-27` lack distinguishing tests for unknown environment fallback/color values. `test-quality-15` and `-16` lack matching existing cases for cancellation and dim double-bang rails. Do not infer these are confirmed current defects.
- There is no configured Vitest coverage provider, so these are source-guided lens counts, not branch-coverage percentages. Repo dependency tests were inspected rather than run by the scan. No browser or remote-service checks are recorded for these reviews.
- Only markers passed a fresh unit gate. Layout's interrupted scout and all remaining units still need review. The separate styling change, [19c4e7a](https://github.com/kaushikgopal/pi-kaush/commit/19c4e7a), passed its own full check; it does not complete the review.

## Layout candidates to verify next

These 18 non-keep rows are from the four saved scouts, not approved fixes. Cross-check overlapping width, body-selection, and reply-metadata proposals before allocating investigators. Eight layout lenses still need to run.

- `pi-content-layout-boundary-failures-29` — Leave submitted prompts native when padding would hide the text. `extensions/pi-content-layout/src/index.ts:474-487`.
- `pi-content-layout-data-modeling-27` — Submitted wrap and paint derive the same shell widths separately. `extensions/pi-content-layout/src/index.ts:481-486`.
- `pi-content-layout-data-modeling-28` — Pass the selected body as required component data. `extensions/pi-content-layout/src/intercom-message.ts:33-49,192-234,245-253,307`.
- `pi-content-layout-data-modeling-29` — Share one live projection of printable reply metadata. `extensions/pi-content-layout/src/intercom-message.ts:106-108,119-135,154-179,237-243`.
- `pi-content-layout-domain-language-12` — Package description still calls the two prompt presentations matching blocks. `extensions/pi-content-layout/package.json:4`.
- `pi-content-layout-domain-language-13` — Column-alignment test title misstates the editor assertion. `extensions/pi-content-layout/test/index.test.ts:554-602`.
- `pi-content-layout-domain-language-14` — Root package table still calls the active editor dark. `README.md:20`. Own this in repo-automation, not the layout unit.
- `pi-content-layout-domain-language-15` — Give the submitted-prompt content width one name at wrapping and fitting. `extensions/pi-content-layout/src/index.ts:480-486`.
- `pi-content-layout-domain-language-16` — Intercom documentation promises unchanged content without the text boundary. `extensions/pi-content-layout/README.md:83-84`.
- `pi-content-layout-domain-language-17` — The default editor and extension fallback are not the same instance. `extensions/pi-content-layout/README.md:110-116`.
- `pi-content-layout-domain-language-18` — The render cache key holds a styled rail, not just colors. `extensions/pi-content-layout/src/render.ts:105-113,127-148`.
- `pi-content-layout-duplication-5` — Reuse the existing local line-fitting operation. `extensions/pi-content-layout/src/intercom-message.ts:78-82`.
- `pi-content-layout-duplication-7` — Give reply-target eligibility one owner. `extensions/pi-content-layout/src/intercom-message.ts:130-133,175-179`.
- `pi-content-layout-duplication-8` — Pass the selected valid body into the intercom component. `extensions/pi-content-layout/src/intercom-message.ts:40-49,192-234,245-254`.
- `pi-content-layout-duplication-12` — Share render descriptor restoration, not the hook adapters. `extensions/pi-content-layout/src/index.ts:342-343,369-372`.
- `pi-content-layout-duplication-32` — Give submitted-prompt geometry one width calculation. `extensions/pi-content-layout/src/index.ts:474-486`.
- `pi-content-layout-duplication-33` — Compute the intercom reply-command label once. `extensions/pi-content-layout/src/intercom-message.ts:120-123,154-164`.
- `pi-content-layout-duplication-36` — Use one sender-label prefix at narrow and roomy widths. `extensions/pi-content-layout/src/intercom-message.ts:65-67,85-100`.

## Source and test counts

- Original run base `bdfcb14`: 53,097 source lines, 42,143 test lines, 1,417 Vitest tests (1,415 passed, two skipped).
- Reconciled base `43acfc7`: 53,247 source lines, 43,906 test lines, 1,483 Vitest tests (1,481 passed, two skipped).
- Styling checkpoint `19c4e7a`: 53294 source lines, 44189 test lines, 1,497 Vitest tests (1,495 passed, two skipped). The final package checks also passed 57 Bun tests.

Line counts use tracked code and test fixtures, excluding docs, manifests, generated output, and caches. The largest remaining cognitive-complexity leads reported by `cccc` were `analyze` and `runSteps` in `packages/firefox-agent-core/src/workflows.ts`, the operation in `persistent.ts`, `handle` in `extensions/pi-browser/src/daemon.ts`, and `acquireLock` in `packages/firefox-agent-core/src/state-store.ts`.
