# Review commit index — 18 November 2026

The review ranges below exclude release, merge, and separately requested styling commits. See the [handoff](report-review-improve-handoff-2026-11-18.md) to resume. A listed commit records a landed change, not a claim that all units or final gates passed. Revert commits and their original rows are listed so their outcomes remain visible.

## Earlier markers

Range: `bdfcb14..030fc02` (45 commits).

- [44ccc6f](https://github.com/kaushikgopal/pi-kaush/commit/44ccc6f) Fix terminal control leakage in question blocks — `pi-tool-call-markers-boundary-failures-22`.
- [793db1f](https://github.com/kaushikgopal/pi-kaush/commit/793db1f) Fix bash rendering when optional decoration fails — `pi-tool-call-markers-repo-rules-11`.
- [f49385f](https://github.com/kaushikgopal/pi-kaush/commit/f49385f) Fix hidden question-tool failure results — `pi-tool-call-markers-boundary-failures-20`.
- [ebc34f1](https://github.com/kaushikgopal/pi-kaush/commit/ebc34f1) Fix thinking duration changes when toggling info — `pi-tool-call-markers-race-conditions-1`.
- [c4dcd09](https://github.com/kaushikgopal/pi-kaush/commit/c4dcd09) Fix thinking label styling after a retained-wrapper reload — `pi-tool-call-markers-race-conditions-2`.
- [d08747c](https://github.com/kaushikgopal/pi-kaush/commit/d08747c) Fix pending image results appearing settled — `pi-tool-call-markers-sibling-consistency-3`.
- [1292f09](https://github.com/kaushikgopal/pi-kaush/commit/1292f09) Assert visible-content grouping output — `pi-tool-call-markers-test-quality-3`.
- [b9ad5e3](https://github.com/kaushikgopal/pi-kaush/commit/b9ad5e3) Test grouped mouse click routing — `pi-tool-call-markers-test-quality-5`.
- [95631b7](https://github.com/kaushikgopal/pi-kaush/commit/95631b7) Assert narrow subagent fallback threshold — `pi-tool-call-markers-test-quality-4`.
- [76c3393](https://github.com/kaushikgopal/pi-kaush/commit/76c3393) Release thinking-merger test owners — `pi-tool-call-markers-test-quality-12`.
- [35b5347](https://github.com/kaushikgopal/pi-kaush/commit/35b5347) Assert grouping survives owner shutdown — `pi-tool-call-markers-test-quality-31`.
- [6411e30](https://github.com/kaushikgopal/pi-kaush/commit/6411e30) Assert hook effects during rendering — `pi-tool-call-markers-test-quality-6`.
- [dc42257](https://github.com/kaushikgopal/pi-kaush/commit/dc42257) Assert native shell output at narrow widths — `pi-tool-call-markers-test-quality-7`.
- [c2d3d96](https://github.com/kaushikgopal/pi-kaush/commit/c2d3d96) Assert visible filter preserves child identity — `pi-tool-call-markers-test-quality-9`.
- [247e1f6](https://github.com/kaushikgopal/pi-kaush/commit/247e1f6) Repaint transcript through toggle command — `pi-tool-call-markers-test-quality-10`.
- [766aaf4](https://github.com/kaushikgopal/pi-kaush/commit/766aaf4) Assert input preservation through thought replay — `pi-tool-call-markers-test-quality-11`.
- [dc44075](https://github.com/kaushikgopal/pi-kaush/commit/dc44075) Assert native renderer after shutdown — `pi-tool-call-markers-test-quality-19`.
- [c16be66](https://github.com/kaushikgopal/pi-kaush/commit/c16be66) Assert failed and pending batch output — `pi-tool-call-markers-test-quality-2`.
- [4c1e7b1](https://github.com/kaushikgopal/pi-kaush/commit/4c1e7b1) Pin grouped and individual tool rows — `pi-tool-call-markers-test-quality-1`.
- [aaae853](https://github.com/kaushikgopal/pi-kaush/commit/aaae853) Verify reordered indexed question answers — `pi-tool-call-markers-test-quality-14`.
- [f4cab00](https://github.com/kaushikgopal/pi-kaush/commit/f4cab00) Assert blank questionnaire answers — `pi-tool-call-markers-test-quality-13`.
- [e08754f](https://github.com/kaushikgopal/pi-kaush/commit/e08754f) Assert rendered settled-thinking output — `pi-tool-call-markers-test-quality-18`.
- [7e54729](https://github.com/kaushikgopal/pi-kaush/commit/7e54729) Assert fallback styling output — `pi-tool-call-markers-test-quality-17`.
- [6ed739e](https://github.com/kaushikgopal/pi-kaush/commit/6ed739e) Assert prompt surface after resets — `pi-tool-call-markers-test-quality-20`.
- [06f518c](https://github.com/kaushikgopal/pi-kaush/commit/06f518c) Strengthen reordered-answer fixture — `pi-tool-call-markers-test-quality-14`.
- [581190b](https://github.com/kaushikgopal/pi-kaush/commit/581190b) Revert standalone blank-answer tests — `pi-tool-call-markers-test-quality-13`.
- [c09fbc7](https://github.com/kaushikgopal/pi-kaush/commit/c09fbc7) Strengthen prompt surface coverage — `pi-tool-call-markers-test-quality-20`.
- [0b1ba75](https://github.com/kaushikgopal/pi-kaush/commit/0b1ba75) Share settled-row eligibility — `pi-tool-call-markers-duplication-2`.
- [5061917](https://github.com/kaushikgopal/pi-kaush/commit/5061917) Correct malformed subagent fallback test — `pi-tool-call-markers-data-modeling-23`.
- [d8d11a9](https://github.com/kaushikgopal/pi-kaush/commit/d8d11a9) Encode nonempty subagent plan steps — `pi-tool-call-markers-data-modeling-23`.
- [b165a48](https://github.com/kaushikgopal/pi-kaush/commit/b165a48) Parse multi-step subagent plans once — `pi-tool-call-markers-duplication-38`.
- [2d00c87](https://github.com/kaushikgopal/pi-kaush/commit/2d00c87) Strengthen grouped render cache test — `pi-tool-call-markers-data-modeling-18`.
- [90aba01](https://github.com/kaushikgopal/pi-kaush/commit/90aba01) Pair grouped members with display versions — `pi-tool-call-markers-data-modeling-18`.
- [9c9e414](https://github.com/kaushikgopal/pi-kaush/commit/9c9e414) Cover hidden-thinking lifecycle transitions — `pi-tool-call-markers-hidden-state-5`.
- [87f7cad](https://github.com/kaushikgopal/pi-kaush/commit/87f7cad) Model thinking timing transitions explicitly — `pi-tool-call-markers-hidden-state-5`.
- [91fde61](https://github.com/kaushikgopal/pi-kaush/commit/91fde61) Remove palette sampling forwarding helper — `pi-tool-call-markers-duplication-1`.
- [c038f6f](https://github.com/kaushikgopal/pi-kaush/commit/c038f6f) Characterize SGR stripping for thought labels — `pi-tool-call-markers-duplication-37`.
- [92859ce](https://github.com/kaushikgopal/pi-kaush/commit/92859ce) Reuse local SGR stripping for thought labels — `pi-tool-call-markers-duplication-37`.
- [0ff6465](https://github.com/kaushikgopal/pi-kaush/commit/0ff6465) Remove the shadowed read glyph entry — `pi-tool-call-markers-duplication-3`.
- [f5a0605](https://github.com/kaushikgopal/pi-kaush/commit/f5a0605) Remove unread plan remainder — `pi-tool-call-markers-data-modeling-25`.
- [8ecd9db](https://github.com/kaushikgopal/pi-kaush/commit/8ecd9db) Consolidate overlapping tool-group tests — `pi-tool-call-markers-unnecessary-tests-1`, `pi-tool-call-markers-unnecessary-tests-2`.
- [f0b727a](https://github.com/kaushikgopal/pi-kaush/commit/f0b727a) Remove redundant subagent rail smoke test — `pi-tool-call-markers-unnecessary-tests-3`.
- [a84fd2b](https://github.com/kaushikgopal/pi-kaush/commit/a84fd2b) Drop redundant native-render shutdown fixture — `pi-tool-call-markers-unnecessary-tests-18`.
- [a4a856b](https://github.com/kaushikgopal/pi-kaush/commit/a4a856b) Drop duplicate thinking teardown test — `pi-tool-call-markers-unnecessary-tests-26`.
- [030fc02](https://github.com/kaushikgopal/pi-kaush/commit/030fc02) Drop single-owner bash renderer smoke test — `pi-tool-call-markers-unnecessary-tests-40`.

## Earlier layout

Range: `030fc02..5efcd42` (20 commits).

- [01e99fb](https://github.com/kaushikgopal/pi-kaush/commit/01e99fb) Fix submitted prompts losing characters at wrap boundaries — `pi-content-layout-repo-rules-8`.
- [b64712d](https://github.com/kaushikgopal/pi-kaush/commit/b64712d) Fix malformed intercom metadata bypassing native fallback — `pi-content-layout-repo-rules-15`.
- [965153f](https://github.com/kaushikgopal/pi-kaush/commit/965153f) Fix terminal control leakage in intercom messages — `pi-content-layout-boundary-failures-19`.
- [a79b5b4](https://github.com/kaushikgopal/pi-kaush/commit/a79b5b4) Fix system notices disappearing when a layout owner shuts down — `pi-content-layout-race-conditions-1`.
- [1eac2a6](https://github.com/kaushikgopal/pi-kaush/commit/1eac2a6) Fix intercom restyling deleting instance renderers — `pi-content-layout-repo-rules-16`.
- [842890e](https://github.com/kaushikgopal/pi-kaush/commit/842890e) Fix stale submitted rails after a theme switch — `pi-content-layout-repo-rules-18`.
- [eae762e](https://github.com/kaushikgopal/pi-kaush/commit/eae762e) Assert native fallback during layout failures — `pi-content-layout-test-quality-11`.
- [7e714ee](https://github.com/kaushikgopal/pi-kaush/commit/7e714ee) Assert steering renderer restoration — `pi-content-layout-test-quality-4`.
- [33d6b65](https://github.com/kaushikgopal/pi-kaush/commit/33d6b65) Assert peer hooks survive layout shutdown — `pi-content-layout-test-quality-5`.
- [c145b59](https://github.com/kaushikgopal/pi-kaush/commit/c145b59) Assert chat hook rollback and cleanup — `pi-content-layout-test-quality-6`.
- [f9ae1ad](https://github.com/kaushikgopal/pi-kaush/commit/f9ae1ad) Assert message decoration cache reuse — `pi-content-layout-test-quality-3`.
- [991f81d](https://github.com/kaushikgopal/pi-kaush/commit/991f81d) Assert intercom cache transitions — `pi-content-layout-test-quality-13`.
- [d1ff814](https://github.com/kaushikgopal/pi-kaush/commit/d1ff814) Assert complete expanded intercom text — `pi-content-layout-test-quality-2`.
- [8d28ca5](https://github.com/kaushikgopal/pi-kaush/commit/8d28ca5) Assert non-steering previews keep native styling — `pi-content-layout-test-quality-1`.
- [cabeb63](https://github.com/kaushikgopal/pi-kaush/commit/cabeb63) Assert semantic control termination — `pi-content-layout-test-quality-7`.
- [6503d78](https://github.com/kaushikgopal/pi-kaush/commit/6503d78) Assert submitted background survives resets — `pi-content-layout-test-quality-8`.
- [b28fbc6](https://github.com/kaushikgopal/pi-kaush/commit/b28fbc6) Assert status recovery after editor render failure — `pi-content-layout-test-quality-12`.
- [70aad03](https://github.com/kaushikgopal/pi-kaush/commit/70aad03) Assert editor cache refresh after invalidation — `pi-content-layout-test-quality-14`.
- [f34844a](https://github.com/kaushikgopal/pi-kaush/commit/f34844a) Assert non-TUI sessions leave layout uninstalled — `pi-content-layout-defensive-code-27`.
- [5efcd42](https://github.com/kaushikgopal/pi-kaush/commit/5efcd42) Assert unnamed intercom senders use their ID — `pi-content-layout-defensive-code-31`.

## Fresh markers

Range: `43acfc7..7c0ac94` (12 commits).

- [3396ba8](https://github.com/kaushikgopal/pi-kaush/commit/3396ba8) Fix missing default emoji on generic subagent rows — `dependency-direction-1`.
- [10e1f06](https://github.com/kaushikgopal/pi-kaush/commit/10e1f06) Fix blank model overrides in subagent markers — `dependency-direction-2`.
- [fbf49c0](https://github.com/kaushikgopal/pi-kaush/commit/fbf49c0) Fix preview emojis overriding single subagent identities — `pi-tool-call-markers-open-review-3`.
- [f7a497c](https://github.com/kaushikgopal/pi-kaush/commit/f7a497c) Fix stale subagent markers after reload — `pi-tool-call-markers-race-conditions-8`.
- [9441a81](https://github.com/kaushikgopal/pi-kaush/commit/9441a81) Fix broken graphemes in question block wrapping — `pi-tool-call-markers-open-review-1`.
- [e0e9877](https://github.com/kaushikgopal/pi-kaush/commit/e0e9877) Test model precedence in generic subagent rows — `pi-tool-call-markers-test-quality-1`.
- [24b7342](https://github.com/kaushikgopal/pi-kaush/commit/24b7342) Test visible subagent rows at narrow widths — `pi-tool-call-markers-test-quality-2`.
- [4860013](https://github.com/kaushikgopal/pi-kaush/commit/4860013) Test error styling on default subagent emojis — `pi-tool-call-markers-test-quality-3`.
- [0530c4f](https://github.com/kaushikgopal/pi-kaush/commit/0530c4f) Test fallback for saved null subagent arguments — `pi-tool-call-markers-defensive-code-1`.
- [190f30a](https://github.com/kaushikgopal/pi-kaush/commit/190f30a) Share prompt shell content width calculation — `pi-tool-call-markers-duplication-4`.
- [ab7f643](https://github.com/kaushikgopal/pi-kaush/commit/ab7f643) Keep scraped subagent emojis without reparsing — `pi-tool-call-markers-duplication-41`.
- [7c0ac94](https://github.com/kaushikgopal/pi-kaush/commit/7c0ac94) Remove duplicate subagent default cases — `pi-tool-call-markers-unnecessary-tests-41`.

## Release, reconciliation, and requested styling

- [abb85f0](https://github.com/kaushikgopal/pi-kaush/commit/abb85f0) Added default subagent emojis before the second review.
- [d42c619](https://github.com/kaushikgopal/pi-kaush/commit/d42c619) Released `@pi-kaush/pi-tool-call-markers@0.3.25`.
- [43acfc7](https://github.com/kaushikgopal/pi-kaush/commit/43acfc7) Reconciled both main histories without rewriting commits. The combined check passed before the push.
- [19c4e7a](https://github.com/kaushikgopal/pi-kaush/commit/19c4e7a) Changed replay styling: muted italic questions, plain labels in the prompt text color, and bold replies in that same color. Focused asked-question checks and the full repository check passed.
