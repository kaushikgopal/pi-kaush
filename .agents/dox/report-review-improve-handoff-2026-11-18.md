# Review handoff — 18 November 2026

Resume with **pi-content-layout**, not another full markers review. The last markers unit checkpoint was [7c0ac94](https://github.com/kaushikgopal/pi-kaush/commit/7c0ac94). The later question-replay styling change is [19c4e7a](https://github.com/kaushikgopal/pi-kaush/commit/19c4e7a). It passed a separate full check. The earlier unit gates do not cover that requested styling change.

The review paused before the final whole-branch gates or blind review. The [findings report](report-review-improve-findings-2026-11-18.md) preserves candidate IDs and evidence; the [commit index](report-review-improve-commits-2026-11-18.md) maps the applied changes to their findings. Both are usable without the original machine's raw ledgers or artifacts.

## Resume on another machine

1. In a clean clone, run `git pull --ff-only origin main`. Confirm the final styling and report commits are present. Preserve any local changes before pulling.
2. Set the new review base to the verified tip. Use the reports to carry forward settled evidence. Do not reapply fixes or reopen rejected proposals unless new evidence warrants it.
3. Start with layout. Four fresh layout scout files were saved at `7c0ac94`: boundary-failures, data-modeling, domain-language, and duplication. Their actionable rows are summarized in the findings report. Defensive-code and the other seven layout lenses did not finish. Recheck candidates against the new base; none of those four scout files applied a fix.
4. Finish layout scouting, triage, investigations, and unit gates. Continue the remaining units in order. The original run's cap was `all`. The earlier ledger and prompt snapshot stay local; these tracked reports are the cross-machine handoff.
5. After all units, run the whole-branch gates and an independent blind review. Then handle the requested package releases. Verify registry versions and dependencies before publishing. Published packages must use registry versions, not local paths or workspace-only ranges.

## Unit order and status

1. `pi-tool-call-markers` — done through `7c0ac94`: unit gates passed. The requested styling change at `19c4e7a` passed its own full check.
2. `pi-content-layout` — pending: the earlier run landed six investigated fixes and test corrections but had not reached unit gates; the fresh scout was interrupted after four lenses.
3. `pi-welcome-screen`
4. `repo-automation` (`.github`, `scripts`, `Makefile`)
5. `pi-footer-minimal`
6. `pi-model-profiles` and `pi-agent-mode` together
7. `pi-simple-subagents`
8. `pi-better-read-edit` runtime and scripts
9. `pi-inline-identifier`
10. `pi-verbatim-compaction`
11. `pi-btw`
12. `pi-response-style`
13. `pi-browser`
14. `pi-double-paste`
15. `pi-working-indicator`
16. `pi-better-read-edit` benchmarks
17. `firefox-agent-core` and `pi-firefox` together
18. `pi-reload-hotkey`
19. `pi-intercom-hotkey`
20. `startup-benchmark`

Units 3–20 are pending and were not started in the fresh run. Grouped units reflect package dependencies; keep better-read-edit runtime separate from its benchmarks.

## Validation and release state

The fresh run started at merge [43acfc7](https://github.com/kaushikgopal/pi-kaush/commit/43acfc7). Its markers range was [43acfc7..7c0ac94](https://github.com/kaushikgopal/pi-kaush/compare/43acfc7...7c0ac94), with 12 linear commits. At `7c0ac94`, the serial unit gate passed with **1,495 Vitest tests passed, two skipped, and 57 Bun tests passed**. The recorded command was:

```fish
timeout 900 sh -c 'env -u PI_SUBAGENT_DEPTH npm run check'
```

The check includes formatting, TypeScript, Vitest, and workspace packaging. The separate check at `19c4e7a` also passed with **1,495 Vitest tests passed, two skipped, and 57 Bun tests passed**. The 22 focused asked-question tests passed. The updated style test fails on the previous renderer and passes with the change, including wrapped lines and the blank-answer placeholder.

The official `@pi-kaush/pi-tool-call-markers@0.3.25` release was a separate markers-only release; GitHub Publish run `44374824489` passed and the registry's latest tag was independently verified at the time. Later review code was pushed to GitHub `main` but was not part of that npm release. No later package publication is recorded. Check the current registry before making any new release decision.

## Timing and test environment

Three tests in `extensions/pi-simple-subagents/test/subagent-managed-runtime.test.ts` failed under parallel load and each passed one isolated rerun: config-write failure during stop, watchdog cleanup failure, and termination of a worker ignoring its inactivity limit. The last has a 5,000 ms test limit. No sleeps, retries, or timeouts were changed. Run full validation serially and report any failure and exact rerun rather than hiding it.

A separate five-case failure in `subagent-profile-tool.test.ts` came from inherited `PI_SUBAGENT_DEPTH=1`, not the timing flakes. Clearing that variable made all nine cases pass in both parent and bounded worker. Preserve the recorded environment when comparing results.

The first and last fresh markers commit timestamps span about **61 minutes**; that is elapsed wall-clock time between commits, not measured active effort or an estimate for the remaining review. No reliable completion estimate was recorded.
