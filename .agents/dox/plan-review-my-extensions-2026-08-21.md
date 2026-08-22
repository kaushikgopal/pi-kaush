# Exec plan: /review-my --fix loop across independent extensions

Date: 2026-08-21
Status: complete 2026-08-21 — 11 reviewed, 2 deferred (pi-content-layout, pi-openai-compaction: parallel session activity; rerun later)

## Goal and why

Run the `/review-my` fix loop once per independent extension in this repo,
focused on leanness/efficiency improvements. Each extension gets a fresh
subagent chain; the main session judges whether the applied changes were worth
keeping before moving on. Long-running: this plan tracks per-extension state.

## Scope and mode

- Mode: `--fix`, `--loop 1` per extension (user said "loop with fix", no N).
- Review target per extension: the extension's full current source (working
  tree is clean, so there is no diff boundary; this is a whole-package
  lean/efficiency review, a deliberate adaptation of the diff-based contract).
- 13 extensions have TS source. Two dirs are empty shells and are excluded:
  - `pi-openai-text-verbosity` (LICENSE + README only, no package.json)
  - `pi-split-session` (only a packed .tgz, no package.json)
- Trusted support root: `~/.pi/agent/prompts/review-my/` canonicalizes to
  `/Users/kg/dev/per/aikado/config/pi/agent/prompts/review-my` — outside this
  repo, so trusted. Selector: `bun run <root>/select-guidance.ts` with the
  extension's source paths as literal argv.
- Subagent model: `gpt-5.6-sol` on every chain step (user instruction
  overrides the packet's no-model-pinning default).

## Per-extension work package (repeat for each, in order)

1. **Main session**: capture fixed point (branch, HEAD, status, extension file
   inventory); run guidance selector; read selected assessment files; assemble
   clean-room reviewer packet (target, inventory, repo criteria incl.
   AGENTS.md, intent = package README, selected guidance). No prior findings,
   no orchestration material, no rationale in packet.
2. **Subagent chain** (one fresh `subagent` call, chain mode, model
   `gpt-5.6-sol` on each step):
   - Assessment: `red-team`, profile `deep-thinker` — findings + coverage +
     simplification gate only.
   - Judgment: `bee`, profile `deep-thinker` — one disposition per finding,
     execution packet for accepted items.
   - Execution: `bee`, profile `fast-code` — apply accepted local edits,
     run smallest meaningful validation, no staging/commits.
3. **Main session judgment**: inspect the actual diff (`git diff`), decide
   keep vs revert per change; if a validated material edit landed, run one
   fresh read-only `red-team` terminal review of the result. The executor's
   return must include the judgment stage's full disposition ledger verbatim
   (chain mode surfaces only the last step's output).
4. **Validate**: extension tests + repo `npm run check` must pass before the
   extension is marked done.
5. Record outcome in the tracker below; proceed to next extension.

## Extension tracker (execution order: smallest first, to bank quick wins)

| #   | Extension                  | Size (ts lines) | Status  | Kept changes | Notes                                                                                                                                     |
| --- | -------------------------- | --------------: | ------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | pi-double-paste            |             528 | done    | 2            | isLongPaste predicate order (efficiency); expiration window anchored to first-paste observation + regression test. Terminal review clean. |
| 2   | pi-footer-minimal          |             558 | pending |              |                                                                                                                                           |
| 3   | pi-inline-skill-identifier |             612 | pending |              |                                                                                                                                           |
| 4   | pi-btw                     |             797 | pending |              |                                                                                                                                           |
| 5   | pi-inline-agent-identifier |             894 | pending |              |                                                                                                                                           |
| 6   | pi-response-style          |            1193 | pending |              |                                                                                                                                           |
| 7   | pi-agent-mode              |            1401 | pending |              |                                                                                                                                           |
| 8   | pi-content-layout          |            1863 | pending |              |                                                                                                                                           |
| 9   | pi-inline-identifier       |            1887 | pending |              |                                                                                                                                           |
| 10  | pi-welcome-screen          |            1981 | pending |              |                                                                                                                                           |
| 11  | pi-browser                 |            2757 | pending |              |                                                                                                                                           |
| 12  | pi-tool-call-markers       |            5356 | pending |              |                                                                                                                                           |
| 13  | pi-openai-compaction       |            6962 | pending |              |                                                                                                                                           |

## Validation

- Per extension: executor's focused validation + `npm run check` (repo gate
  per AGENTS.md).
- Final: full `npm run check`; `git diff --stat` summary of everything kept.

## Guardrails

- No staging, commits, pushes, tags, publishes, or PRs.
- Preserve unrelated/user-owned changes; tree starts clean, so any drift is
  from this workflow and must be explained before the next executor stage.
- Findings may be rejected or deferred; "no change" is a valid outcome for an
  extension. Report dispositions, never silently drop findings.

## Unresolved blockers

- None.

## Deferred to user

- pi-footer-minimal S3: README claims "no environment access" but src/index.ts
  reads `process.env.HOME`/`USERPROFILE` to abbreviate cwd to `~`. Either remove
  the `~` abbreviation feature or fix the README claim. Deferred in cycle 2
  because it changes either behavior or docs contract.
- pi-browser S1 (cycle): npm pack excludes both bin/ entrypoints while
  client.ts requires bin/pi-browser-daemon.mjs — PUBLISHING IS BROKEN; also
  `typebox` undeclared. Needs manifest/dependency policy decisions.
- pi-browser Q6: run_script `readOnly` is persisted and reported but never
  enforced — arbitrary code with page/CDP/fs access cannot be meaningfully
  read-only via a small guard; contract needs a human decision.
- pi-browser Q2: AX [eN] refs live per extension process while invalidation is
  daemon-side; cross-session stale-ref race needs daemon-recognized page
  identity — not masked with client-local clearing.
- pi-browser terminal Q1: socket-lifecycle consumer paths (connect/unlink/
  respawn, overflow teardown) lack tests; needs an export seam or in-process
  net servers — test-architecture decision.
- pi-inline-skill-identifier SPEC-1 (terminal review): alias matching runs on
  the ANSI-encoded render line, so an escape sequence starting mid-token can
  break the visible-token boundary. Pre-existing design property, rare; a full
  ANSI-stripping matcher is not worth it on this deprecated package. Documented
  in a code comment.
- pi-better-read-edit is a SEPARATE live session's new package (user confirmed
  2026-08-21): excluded from this loop; executors tolerate its files as
  known-external and treat repo-gate failures traced solely to it as external
  blockages. Their session also edits pi-content-layout and
  pi-openai-compaction (both in this loop's list) and root README.md —
  drift contract widened to tolerate those scopes; defer decision on reviewing
  those two extensions pending user input.
- 2026-08-21: external session committed and released pi-content-layout@0.1.6
  mid-loop (HEAD a4f9cfd → 9634831) and fixed the tool-call-markers harness
  breakage; all 21 kept files intact. pi-content-layout + pi-openai-compaction
  DEFERRED per user. Fixed-point contract now tolerates HEAD moves whose commit
  paths fall solely in known-external scopes.

## Decision log

- 2026-08-21: Whole-package review instead of diff review — working tree is
  clean and the user asked for lean/efficiency review of each extension.
- 2026-08-21: Model `gpt-5.6-sol` pinned on chain steps per explicit user
  instruction, superseding the reviewer-packet default of no model pinning.
- 2026-08-21: `pi-openai-text-verbosity` and `pi-split-session` excluded —
  no package.json or source, nothing to review.
- 2026-08-21: Global support root trusted — canonical path lives in
  `~/dev/per/aikado`, outside the reviewed repository boundary.
- 2026-08-21: Smallest-first ordering — banks quick wins and calibrates the
  loop on low-risk packages before the three large ones.
- 2026-08-21: Chain mode surfaces only the final step's output, so the cycle-1
  judgment ledger never reached the main session; executor return contract now
  requires the verbatim ledger.
- 2026-08-21: `.agents/dox/` files must stay prettier-clean — the repo gate
  runs `prettier --check .` over them and blocked the first `npm run check`.
- 2026-08-21: pi-double-paste kept both accepted fixes (SPEC-01 timing anchor,
  QUALITY-01 predicate order). HEAD unchanged at a4f9cfd; all edits remain
  uncommitted per the no-commit guardrail.
- 2026-08-21: pi-footer-minimal kept S1 (cumulative cache rate) + S2 (unknown
  context marker) + Q2 (configurable test harness). Q1 (per-render full history
  fold) avoided — line 1 needs cumulative cost, caching would add lifecycle
  state for unproven benefit. S3 deferred to user (see Deferred section).
- 2026-08-21: pi-btw kept SPEC-1 + QUAL-1, both small spec-alignment fixes with
  regression tests; terminal review clean.
- 2026-08-21: pi-inline-agent-identifier kept RM-S1 only. RM-S2 (ANSI-interrupted
  tokens, same class as pi-inline-skill-identifier SPEC-1), RM-Q1 (per-render fs
  rescan caching), RM-Q2 (patch-upgrade test) all avoided for complexity on a
  deprecated package.
- 2026-08-21: pi-tool-call-markers kept S1 (visual spec-alignment: grouped
  headings/bullets per README — user-visible change), Q1, Q2, Q3, Q5; S2
  rejected (thinking merge cannot retain multiple provider signatures); Q4
  deferred (no measured perf threshold). Terminal review caught 3 defects in
  the cycle's own code; repaired via remediation chain (remediation stage +
  execution stage, gpt-5.6-sol), incl. aligning grouped-bash `$:` label
  expectations (the `$:` prefix is NOT the `% bash` heading token).
- 2026-08-21: pi-response-style took three chain attempts: two executors
  correctly blocked on drift from the parallel pi-better-read-edit session
  (fixed-point gates worked as designed). User then authorized scoped drift
  gates. Kept S1/S2/Q1/Q2/Q3 + terminal-review repair (ambiguous-label
  fail-safe). tsc/prettier repo-gate failures verified to be solely from
  pi-better-read-edit.
- 2026-08-21: pi-inline-skill-identifier kept S1 + Q1 + Q2. Terminal review
  found QUAL-1 (SGR scanner misread compound background colors) in code the
  cycle itself added — repaired directly by the main session (48;5/48;2 args now
  skipped like 38) with a regression test, instead of spinning another executor
  chain. This is the reconcile-in-main-session path for terminal findings.
