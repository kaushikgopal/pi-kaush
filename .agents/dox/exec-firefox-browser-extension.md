# Exec plan: Firefox browser control through firefox-cli

## Goal and scope

Build a small Firefox integration for the owner's existing, signed-in browser. Use firefox-cli's public CLI for every browser operation. Keep reusable behavior outside Pi.

Pi is the first adapter. A future harness must reuse container, session, snapshot, workflow, and extraction behavior without core changes.

This plan controls implementation, validation, and handoff. It does not authorize installation, pairing, external issues, commits, publication, or changes to CTC.

**Status:** The v1 implementation is validated and locally installed. Phase 1A is committed as `4a59a59`. The v1 implementation and core relocation form the requested follow-up commit. Nothing is published. See [final acceptance and limits](report-firefox-v1-acceptance.md).

Current decisions supersede the initial proposals below: CTC alone owns routing; actual container IDs are mandatory; replacement adoption requires human approval; private access remains disabled. Unsupported backend capabilities remain explicit. The historical work packages do not require a duplicate CTC router or rule import.

## Initial planning checks (historical)

| Item | Finding |
| --- | --- |
| Repository | `pi-kaush`, with npm workspaces under `extensions/*` |
| Existing template | `extensions/pi-browser`, a Pi-native CDP integration |
| License | Root `LICENSE` and package metadata use MIT |
| Runtime | Root package requires Node >=20 |
| Validation | `npm run check`: formatting, typecheck, tests, package checks |
| TypeScript | Strict mode, exact optional properties, unchecked-index checks |
| Pi guidance | Public extension APIs; no input editor replacement |
| Local instructions | No `AGENTS.local.md` found under the checked parent directory |
| Existing working change | `package-lock.json` is modified; preserve it |
| firefox-cli | Not found on the current execution PATH |
| Firefox | Not found at `/Applications/Firefox.app/Contents/MacOS/firefox` |
| Source clones | firefox-cli 0.4.1 at `c118396bcd36698a395773724663cc1f1493a04a`; CTC at `5c4227ce08dd9a1c58f000da5d190b8c0baef0a2`; surf-cli 2.24.1 at `32c39d13682d2fa60b6c2fbca1703b3f233cab59` |
| Phase 0 report | [Source verification](report-firefox-phase-0-source-verification.md) |

The pinned source versions and selected contracts are verified in the [Phase 0 report](report-firefox-phase-0-source-verification.md). Live CLI behavior, installed-version behavior, and CTC export from the installed extension remain unverified. The assignment's desired behavior is a requirement, not backend evidence.

## Non-negotiable boundaries

1. Call firefox-cli's public CLI only.
2. Keep Pi and other harness imports out of core.
3. Import only the public core entrypoint from the Pi adapter.
4. Keep CTC authoritative for routing.
5. Verify tab identity and container state before account-sensitive actions.
6. Mutate or close only created tabs or replacement candidates explicitly approved by the user.
7. Never retry a mutation whose outcome is unknown.
8. Default to bounded text, compact diffs, and screenshot paths.
9. Keep pairing, cookie access, and arbitrary script execution out of agent tools.
10. Keep remote transport, MCP, Chromium support, and CTC changes out of v1.

## Approval gates and specification conflicts

Resolve conflicts before implementing the affected behavior. Do not treat silence as approval.

### G1: Inferred containers versus safe actions

The specification permits inferred container labels when firefox-cli cannot report actual containers. It also requires verification before actions.

CTC exports cannot prove a live tab's cookie store. Stale rules, manual container choices, and redirects can invalidate predictions.

**Recommended resolution, pending approval:** Report `verified`, `inferred`, or `unknown` evidence explicitly. Block account-sensitive actions without verified evidence. Do not claim the full container acceptance criteria pass under inference alone.

Phase 0 must show the exact missing command capability before proposing an upstream request. Missing eval alone does not block wrapper-side processing. Missing reliable container evidence can block safe v1 completion.

### G2: CTC replacement adoption versus owned-tab safety

The proposed URL-plus-time adoption algorithm can select an unrelated user tab. Concurrent agents can also create identical URLs.

**Recommended resolution, pending approval:** Require backend-supported replacement provenance or another demonstrated, unambiguous ownership proof. Fail with an adoption-ambiguity error otherwise. A unique URL match alone is not proof.

Do not add URL markers that change website behavior or bypass CTC without approval. Do not silently relax ownership safety to complete the demo.

### G3: Requested CTC prediction versus actual CTC behavior

The supplied rule schema and precedence require verification against CTC source and exports. High-priority block rules and multiple ordinary matches need exact semantics.

**Approved resolution:** CTC alone decides routing. Do not duplicate CTC rule evaluation or build a predictive router. Navigate through firefox-cli, let CTC route, and observe the actual resulting container. Any rule import must have a separately justified diagnostic purpose; it is not required for routing.

### G4: Privacy boundary versus agent output

The specification forbids third-party transfer of page content. Pi can use a remote model provider, which receives tool output.

**Recommended clarification, pending approval:** Core performs no external analysis or telemetry. Explicit tool results can reach the selected harness model. An absolute no-third-party requirement requires a local model and a separate harness policy.

Snapshots and screenshots can contain sensitive information. Redaction cannot guarantee removal of every secret from arbitrary page content. Exclude password values and known sensitive fields by construction. Keep logs and persisted state content-free.

### G5: Two package names versus one nested package

The proposed directory layout separates modules but does not create an independently named core package.

**Recommended resolution, pending approval:** Keep two workspace packages in this repository:

- `extensions/firefox-core`: `@pi-kaush/firefox-core`, with no Pi metadata or dependencies.
- `extensions/pi-firefox`: `@pi-kaush/pi-firefox`, containing the Pi adapter.

This fits the existing workspace glob without changing workspace discovery. Verify Pi does not auto-load the core as an extension. If the owner prefers one package, document that it provides separate exports, not two packages.

### G6: Existing Pi command names

`pi-browser` already provides `/browser-status`. Reusing that command can break coexistence.

**Recommended resolution, pending approval:** Use `/firefox-status`, `/firefox-container`, and `/firefox-session`. Keep `ff_*` tool names. Add no colliding aliases by default.

### G7: Authorization and release

Pairing grants full Firefox control. CTC tests can affect normal routing. Releases publish externally.

**Resolution:** Require explicit approval for installation, pairing, test-container setup, external issue filing, and release. Prepare drafts before external actions. Use this repository's release process only after explicit authorization.

## Proposed implementation shape

Use cohesive modules as needed. Do not create empty abstractions to match a file list.

```text
extensions/firefox-core/
  src/
    index.ts                 public functions, contracts, composition
    driver.ts                public CLI commands and capability checks
    transport.ts             local spawn, timeout, cancellation, limits
    types.ts                 validated domain types and result variants
    config.ts                config parsing and precedence
    containers.ts            CTC import, prediction, evidence
    sessions.ts              ownership, binding lifecycle, scheduling
    state.ts                 atomic state and cross-process coordination
    snapshot.ts              summary, scope, compaction, bounded output
    refs.ts                  backend mapping, generations, invalidation
    workflows.ts             bounded deterministic step execution
    extract.ts               selectors, typed conversion, evidence
    network.ts               safe summaries and bounded drill-down
    screenshots.ts           file output and supported resizing policy
    scripts/                 reviewed helpers only if Phase 0 proves need
  test/
  package.json
  README.md
  SUPPORTED_FIREFOX_CLI.md
  NOTES_ON_SURF.md

extensions/pi-firefox/
  src/index.ts               registration and lifecycle
  src/tools.ts               schema and result translation
  src/commands.ts            status and session UI wrappers
  test/
  package.json
  README.md
  CHANGELOG.md
```

Keep the core usable from a plain Node script. Test the actual packaged runtime, not just Pi's TypeScript loader. The repository supports Node 20, so raw TypeScript exports alone cannot prove headless Node compatibility.

Choose a minimal compiled ESM export for core unless repository inspection establishes a simpler supported path. Declare the core dependency explicitly. Do not rely on workspace hoisting or unpublished sibling paths.

Do not build a production debugging CLI by default. A headless script proves reuse without adding a second product surface.

### Core contracts

- Use parsed identifiers for sessions, tabs, containers, refs, and request cursors.
- Preserve firefox-cli's actual tab identifier type at its boundary.
- Represent actual container, requested container, and predicted container separately.
- Include container evidence and observation time in tab results.
- Distinguish default container from unknown container. Unknown is never `null` meaning default.
- Record ownership provenance, browser-binding identity, and snapshot generation.
- Keep expected failures as discriminated result values.
- Map errors to `{ ok: false, code, message, recovery }` at the public boundary.
- Include a concrete recovery function and valid arguments when recovery exists.
- Separate `unsupported`, `unverified_container`, `container_conflict`, `stale_ref`, `tab_lost`, `ownership_ambiguous`, `busy`, and `outcome_unknown`.
- Pass cancellation, clocks, and transport explicitly through reusable seams.

The Pi adapter maps public schemas and results. It owns no container evaluation, snapshot formatting, scheduling, extraction, or workflow execution.

## Work packages

### Phase 0: Prove the backend and container safety

**Outcome:** A capability report with real evidence and approved implementation boundaries.

1. Recheck local instructions and working changes.
2. Inspect existing `pi-browser` registration, lifecycle, tests, and package checks.
3. Locate existing upstream clones before creating clones.
4. Place open-source reference clones under `~/dev/oss` if needed.
5. Place the owner-maintained CTC clone under `~/dev/per` if needed.
6. Record upstream commit identifiers and license files.
7. Inspect firefox-cli's public documentation and command help.
8. Inspect surf's documented techniques without copying backend code.
9. Inspect CTC export types, rule evaluation, redirect creation, and tests.
10. Locate the target Firefox installation and firefox-cli executable.
11. Request installation approval if either prerequisite is missing.
12. Request pairing approval before connecting to the signed-in browser.
13. Run safe health and version checks after approval.
14. Probe required commands against synthetic local pages and owned test tabs.
15. Verify CTC import against an approved, redacted export.
16. Report capability gaps and specification conflicts.
17. Obtain approval for G1–G7 before Phase 1.

**Capability evidence:** Record exact commands, supported flags, exit codes, safe output examples, version, and observation date.

| Area | Required evidence |
| --- | --- |
| Connection | Setup, pairing, health, version, disconnected behavior |
| Tabs | List/create/select/close, exact identifiers, container fields, window scope |
| Navigation | Targeted navigation, readiness, redirects, target replacement |
| Snapshot | Actual JSON/text schema, refs, role/name/value, scope, caps |
| Actions | Click, fill/type, key, scroll, select, waits; explicit tab targeting |
| References | Lifetime, navigation invalidation, re-render behavior, stale errors |
| Containers | Enumeration, create-in-container support, verified cookieStoreId |
| CTC | Export schema, priority, block semantics, redirect provenance |
| Scripts | Whether public execution exists; execution context and return limits |
| Screenshots | File output, dimensions, resize support, focus side effects |
| Capture | Network/console availability, permissions, cursors, safe filtering |
| Errors | Exit/stderr/JSON shapes, timeouts, partial mutation outcomes |
| Limits | Private windows, privileged pages, cross-origin frames, blocked scripting |
| Concurrency | Per-command tab targeting, global selected-tab state, capture scope |

Do not assume `--json` exists. Keep unsupported features explicit. Do not manufacture a DOM accessibility tree and call it browser accessibility output.

**Artifacts:** `SUPPORTED_FIREFOX_CLI.md`, capability fixtures, CTC schema notes, draft upstream requests when needed. Store planning reports under `.agents/dox/` until package paths are approved.

**Exit gate:** Pairing, tab listing, targeted snapshots, and the approved container-safety path work on the target machine. Missing eval permits a documented wrapper-only fallback. Missing unsafe-to-emulate capabilities remain blocked.

**Stop:** Report the exact failed command and sanitized output if pairing, tab listing, or snapshots fail. Do not install workarounds or start wrapper code.

### Phase 1: Establish reusable core and safe vertical slice

**Outcome:** Pi and a plain Node script use the same public core.

1. Create the approved workspace packages.
2. Define validated domain types and public result contracts.
3. Implement transport with argument arrays and no shell interpolation.
4. Add bounded stdout/stderr capture, timeout, and cancellation.
5. Add first-use version and capability checks.
6. Implement dedicated output parsers with sanitized diagnostics.
7. Add minimal configuration and private state storage.
8. Add basic ownership and session binding checks.
9. Implement `ff_status`, `ff_session_ensure`, `ff_go`, and summary-only `ff_read`.
10. Register the four functions through the thin Pi adapter.
11. Add a headless Node smoke script.
12. Test packaging and extension coexistence.

Phase 1 does not bypass unresolved container gates. Return an explicit blocked state until actual container evidence satisfies the approved policy.

**Validation:** Fixture parsers, malformed output, version mismatch, missing binary, abort, oversized output, mutation timeout, default-container reporting, ownership refusal, and Pi error mapping.

**Exit gate:** Pi and Node ensure an owned session, navigate a synthetic page, and return a bounded summary with container evidence. Architecture tests reject forbidden imports.

### Phase 2: Prove containers, ownership, restart, and concurrency

**Outcome:** The core never chooses an account from URL alone.

1. Parse CTC exports into validated routing data.
2. Implement the approved source-backed prediction rules.
3. Record import timestamp and content digest.
4. Verify actual tab containers after navigation and relevant actions.
5. Implement bounded settle polling without assuming a fixed sleep proves readiness.
6. Implement only the approved replacement-provenance algorithm.
7. Stop on requested-versus-actual container conflicts.
8. Add per-session FIFO execution.
9. Add cross-process coordination for shared browser and state access.
10. Add fair browser-wide exclusion where backend behavior requires it.
11. Persist bindings through atomic writes and versioned state.
12. Revalidate browser identity and ownership after restart.
13. Implement session list, close, cleanup, and owned-tab listing.

Use private directories and mode-0600 files where supported. Handle corrupt state, interrupted writes, expired lock owners, process death, and browser restarts. A persisted tab id alone cannot prove ownership after a browser restart.

Do not persist token-bearing URLs. Prefer a safe origin or an explicitly approved sanitized reopen URL. If safe reopening loses necessary context, require the caller to supply the URL again.

A session key includes namespace, stable agent identity, and session name. A fresh process nonce alone does not provide restart continuity. The adapter passes identity explicitly; core reads no Pi session files.

Avoid queue deadlocks when workflows call session operations. Hold a workflow's session lane once. Define lock ordering before browser-wide operations acquire session resources.

**Validation:** CTC priority/block/open/restricted cases, malformed regex, conflicts, stale import visibility, verified-versus-inferred evidence, replacement races, identical URLs, duplicate session names, two OS processes, aborts, and restart recovery.

**Exit gate:** Container scenarios 2–5 from the assignment pass with proven ownership. No inference-only action counts as verified. Ambiguous adoption fails closed.

### Phase 3: Add bounded reads, refs, actions, and diagnostics

**Outcome:** Agents act through compact, auditable output.

1. Normalize firefox-cli snapshots without copying browser control.
2. Implement summary, scoped, and explicit full read modes.
3. Add compaction, depth, text-only, and structure-only views.
4. Enforce UTF-8 byte budgets without breaking JSON or character boundaries.
5. Include truncation counts and narrow recovery hints.
6. Bind public refs to backend targets and snapshot generations.
7. Implement deterministic role/name/text/label matching.
8. Reject ambiguous locators instead of selecting the first match.
9. Implement `ff_act` with verified session and container checks.
10. Return bounded post-action diffs after a configurable settle budget.
11. Add file-only screenshots through supported backend capabilities.
12. Add compact network summaries and explicit filtered drill-down.
13. Measure representative fixtures before tuning defaults.

Backend refs remain the action authority when possible. Preserve wrapper refs only when target identity is demonstrably stable. Never remap an old ref to a similar-looking new element.

A post-action internal snapshot may support a diff. It must not become an automatic full tool response. Suppress filled values and sensitive content from diffs.

Start scoped depth at 7, scoped content at 16,000 bytes, summary content at 4,000 bytes, settle budget at 2,000ms, and screenshot width at 1,200px. These are proposals, not measured guarantees. Define whether each cap covers content or the complete result; measure complete serialized results too.

If firefox-cli lacks resize support, report the gap before adding an image dependency or platform-specific helper. Screenshot commands can select a tab even without foregrounding a window; disclose actual backend focus behavior.

Network summaries strip URL credentials and query values. Drill-down requires an explicit field allowlist and byte caps. Do not expose auth headers or raw bodies by default. Do not add cookie-writing support merely because the assignment mentions browser-wide mutations.

**Validation:** Summary contains no refs; scope excludes unrelated nodes; caps include clear metadata; Unicode remains valid; password values never escape; refs expire on navigation; ambiguous targets fail; screenshot results contain no bytes; network cursors remain bounded.

**Exit gate:** Form read/locate/fill/diff succeeds without full default output. Measurements show actual savings, including envelope overhead and repeated-loop totals.

### Phase 4: Add deterministic workflows and typed extraction

**Outcome:** Bounded multi-step work completes without hidden model calls.

1. Define a versioned JSON workflow schema.
2. Implement navigate/read/locate/click/fill/key/scroll/wait/extract/assert steps.
3. Add explicit captures and validated substitutions.
4. Add bounded `repeat` and `each` execution.
5. Implement dry-run with no browser or filesystem mutations.
6. Enforce `allowWrite` before any potentially mutating step.
7. Implement explicit stop/continue outcomes and partial-progress reports.
8. Add deterministic extraction with evidence and typed conversions.
9. Validate a complete form workflow through Pi and Node.

Treat click, key, fill, select, and unknown effects as writes. Navigation and tab lifecycle change browser state; define their gate explicitly in the workflow contract. Dry-run never grants approval for execution.

Allow substitutions in data only, not code or command syntax. Set limits for total steps, loop iterations, wall time, captured bytes, and output bytes. Continue-on-error must not permit actions after an ownership or container-safety failure.

Natural-language extraction instructions are hints, not executable selectors. Add deterministic source selectors or a documented bounded matching grammar. Return `uncertain` when instructions cannot identify a unique source.

Represent extraction as explicit variants: extracted value with evidence, absent, or uncertain. Do not confuse the literal string `uncertain` with a legitimate text value. Define locale, timezone, date ambiguity, duration units, and numeric rounding rules.

**Validation:** Templating injection, invalid references, nested bounds, write denial, dry-run purity, cancellation, safety-failure stop, missing fields, ambiguous labels, dates, units, decimals, and list conversions.

**Exit gate:** One call completes an approved form flow and returns typed, sourced fields. No step performs an implicit model request.

### Phase 5: Harden, document, and hand off

**Outcome:** The owner can install locally and run the documented demo unaided.

1. Complete configuration documentation and environment overrides.
2. Add the approved non-colliding Pi commands.
3. Finish redacted logging and the default-off debug toggle.
4. Audit all persisted data and temporary artifacts.
5. Audit licenses and surf attribution against recorded source commits.
6. Complete setup, CTC import, safety, tool, and recovery documentation.
7. Run the complete integration matrix and long-loop test.
8. Run `npm run check`.
9. Verify package exports and tarball contents without publishing.
10. Run the demo through the documented installation path.
11. Write the final capability and limitation report.
12. Request separate release authorization if publication is wanted.

Do not publish a core dependency that the adapter cannot install. Coordinate both package versions only through an approved release plan. Use `make publish` after repository support and trusted publishing are configured. A first npm publish needs separate bootstrap approval.

**Exit gate:** All acceptance evidence is present. Any missing item remains explicitly incomplete. No release is required for local v1 acceptance.

## Validation strategy and artifacts

### Automated checks

Use repository Vitest and strict TypeScript checks. Keep most tests browser-free through public core seams and captured, sanitized CLI fixtures.

| Layer | Required proof |
| --- | --- |
| Architecture | Core has no harness imports; adapter uses public exports only |
| Driver | Real output fixtures, version/capability drift, timeout, no mutation retry |
| Containers | Source-backed precedence, conflicts, evidence, stale imports |
| Ownership | Proven creation/adoption, ambiguous replacements, tab-id reuse |
| Scheduling | FIFO, independent lanes, cross-process exclusion, cancellation |
| State | Atomic persistence, private permissions, crash/restart, no secret URLs |
| Snapshot | Scope, depth, compaction, byte caps, no-ref summary, sensitive fields |
| Refs/actions | Stable identity when proven, invalidation, ambiguity, bounded diffs |
| Workflows | Bounds, dry-run, captures, write gate, safety-stop behavior |
| Extraction | Typed conversion, evidence, absent/uncertain distinction |
| Capture | Safe URLs, body caps, filters, cursors, screenshot paths |
| Pi | Structured results, failed-result mapping, cancellation, reload, coexistence |
| Packaging | Plain Node import, dependency resolution, Pi loading, shipped assets |

Aim for the adapter to stay well under 20% of production source lines. Count generated code and tests separately. Treat the metric as a review signal, not a reason to move adapter concerns into core.

### Real-browser harness

Serve synthetic fixtures from a tiny local HTTP server. Include a form, dynamic list, headings/dialogs, large text, navigation, delayed updates, same-origin frames, cross-origin frames, and container-isolated cookies.

Use owner-approved temporary containers and test-only CTC rules. Do not replace existing CTC settings. Export a backup before any approved rule change. Remove only test artifacts that this task created.

Use hostnames and patterns that CTC actually supports. Verify the same-URL/two-container scenario is compatible with the test rules; do not install a rule that forces both sessions into one container.

### Real-browser acceptance matrix

1. Ensure Work, navigate, summarize, locate, fill, and verify a compact diff.
2. Follow an automatic CTC replacement into Personal with proven provenance.
3. Reject an explicit Personal request when the verified destination is Work.
4. Keep two same-URL sessions isolated through different synthetic cookies.
5. Handle a link-triggered container replacement without taking a user tab.
6. Return `stale_ref` after navigation with an exact recovery call.
7. Surface private-window mutation refusal without a workaround.
8. Surface privileged-page refusal without an injected script attempt.
9. Record summary/scoped/full sizes for three to five fixtures.
10. Complete 20 read/action cycles without stealing tabs or growing output unboundedly.
11. Restart Pi and re-ensure the same verified session.
12. Restart Firefox and reject stale ownership unless backend identity proves continuity.
13. Run two OS processes with identical URLs and distinct agent identities.
14. Cancel or kill a mutation and report unknown outcomes without replay.
15. Load `pi-browser` alongside `pi-firefox` without command or tool collisions.
16. Preview cleanup before closing only proven owned or adopted tabs.

Record each case as pass, fail, blocked, or skipped. Include version identifiers and safe evidence. A skipped safety case does not count as a pass.

### Measurement method

Use fixed fixtures and recorded backend versions. Compare equivalent content and controls.

Record raw backend bytes, normalized bytes, compacted bytes, complete result bytes, approximate tokens, tool-call count, and latency. Label the token estimator and its limitations. Byte savings are authoritative; a bytes-per-token estimate is not a provider tokenizer measurement.

Compare summary, scoped, and full outputs with compaction on and off. Include truncation metadata and container evidence in result totals. Record total output across the 20-cycle run.

Record screenshot dimensions, file bytes, and theoretical base64 bytes without returning image content to the model. Do not imply that file size predicts vision-token cost.

Set measured budgets after the baseline exists. Report weak or negative compaction results honestly. Do not claim parity with surf from unrelated pages or different browser sessions.

### Durable artifacts

| Artifact | Purpose |
| --- | --- |
| This plan | Status, gates, decisions, next work |
| `SUPPORTED_FIREFOX_CLI.md` | Versioned command and capability evidence |
| `NOTES_ON_SURF.md` | Technique attribution and any copied snippet provenance |
| Core README | Public API, headless use, config, state, safety, known limits |
| Pi README | Setup, tools, commands, pairing warning, walkthrough |
| CTC fixtures and schema notes | Reproducible import and routing tests |
| Benchmark fixture/report | Reproducible bytes, estimates, and call counts |
| Integration report | Actual browser test outcomes and blocked cases |
| CHANGELOG | User-visible changes before an authorized release |

Use synthetic examples only. Do not commit personal URLs, account labels, credentials, screenshots, or raw capture output.

## Progress reporting and change control

End each phase with a short report:

1. State the completed outcome.
2. List the exact validation results.
3. Report measured output and latency when relevant.
4. List blockers and unsupported capabilities.
5. Record approved departures from this plan.
6. State the next bounded work package.
7. Identify any approval needed from the owner.

Update this plan in small edits. Re-read it before editing because the owner may change it. Keep large command evidence, test output, and runbooks in separate artifacts.

If scope must shrink, propose workflow/extraction deferral first. Propose network drill-down deferral second. Never cut Phase 0, verified account safety, owned-tab safety, or the core/adapter split. A scope reduction requires approval and a revised acceptance checklist.

## Decision log

| ID | Decision or proposal | Rationale | State |
| --- | --- | --- | --- |
| D1 | Backend gate cleared for the approved scope | Live synthetic checks passed; private access was explicitly excluded | Complete |
| D2 | Keep two packages inside pi-kaush | Separate names and dependency boundaries remain visible | Owner approved |
| D3 | Inherit the repository MIT license | No new repository or license change | Active |
| D4 | Pin the version verified in Phase 0 | firefox-cli 0.4.1 is live-verified on Brainiac; Phase 0 remains incomplete | Evidence established; implementation gate pending |
| D5 | Block actions without actual container evidence | Required by the safety contract | Active |
| D6 | Require explicit human approval for replacement candidates | No automatic URL-only adoption | Owner approved |
| D7 | Use `/firefox-*` commands | Existing `/browser-status` remains usable | Active |
| D8 | No silent upstream issues or publication | External actions require explicit authorization | Active |
| D9 | Preserve `package-lock.json` changes | They predate this task | Active |
| D10 | Add no custom Firefox add-on | firefox-cli supplies the browser integration | Active |
| D11 | Delegate routing entirely to CTC; do not duplicate its rule engine | CTC is authoritative; observe actual containers instead of predicting them | Owner approved |

## Immediate next action

Continue with Phase 2: durable session identity, cross-process coordination, and safe recovery. Keep CTC authoritative and private-window access disabled.

## Planning validation

`npm run check` passes after plan creation. Vitest reports 1,194 passed tests and two skipped tests. The package checks pass, including 57 Bun tests. These checks validate the existing repository baseline, not Firefox capabilities. No Firefox integration test has run.

## Approved scope clarification: CTC routing

CTC owns routing completely. Earlier work items for a prediction engine, copied precedence rules, and mandatory routing-rule imports are superseded. Keep actual container observation, requested-versus-actual checks, and safe ownership handling. Reassess diagnostic rule imports only if a concrete need appears. The source report remains historical evidence, not the routing design.

## Approved scope: defer automatic CTC provenance integration

Use before/after tab metadata comparison for the initial implementation. Record existing tab IDs before navigation. If the owned tab disappears, identify candidate replacements by newly observed ID, expected URL, and actual container. Stop on missing or ambiguous candidates. Require explicit human confirmation before adopting a candidate whose ownership is unproven. Confirmation must bind to the specific candidate and state; revalidate before adoption.

Defer native messaging, local receipt helpers, direct CTC integration, and CTC code changes. Keep firefox-cli unchanged. Do not block the baseline on an automatic provenance channel. This approval does not waive actual-container verification or authorize installation/pairing. Phase 0 live capability checks remain required before wrapper implementation.

For harnesses without an interactive confirmation surface, return a structured confirmation-required result. Do not silently adopt a candidate. Automatic CTC replacement acceptance criteria are deferred; report confirmation-based coverage separately.

Decision D12: Owner approved the metadata-comparison baseline and deferred provenance optimization. Rationale: prove the useful workflow before adding integration components.

## Phase 0 source inventory and package reconnaissance completed

Two coder subagents completed independent bounded work:

- [Provisional CLI capability inventory](report-supported-firefox-cli.md): source-confirmed commands, output contracts, unsupported features, and required live probes.
- [Package integration report](report-firefox-package-integration.md): two workspaces, compiled ESM core for Node 20, public exports, Pi result mapping, and coexistence checks.

Repository location is approved: use the existing `~/dev/oss/pi-kaush` checkout. No new Git repository is required. Keep existing CTC clone under `~/dev/per/ff-container-traffic-control`; no CTC changes are in the current scope.

Environment discovery initially found neither firefox-cli on PATH nor Firefox under `/Applications` or `~/Applications`. Source inspection could not replace pairing and live command evidence. The target and setup approvals were later confirmed. No wrapper files were created. The source-inventory worker ran `npm run check`: passed, with 1,194 Vitest tests passed and two skipped. This is a repository baseline, not Firefox verification.

## Target prerequisite update: Brainiac Mac mini (historical)

Firefox is installed at `/Applications/Firefox.app` and running. Its application metadata reports version `158.0.1`. firefox-cli is not on PATH or at the checked standard CLI locations. No pairing request or browser command ran. The CLI installation and pairing prerequisites were completed later; see Live setup progress.

## Installation documentation requirement

The owner explicitly requires a final `README.md` with end-to-end installation instructions. Cover Firefox, tested firefox-cli version, CLI installation, native-host setup, matching Firefox extension installation, pairing and its full-control warning, connection checks, core/Pi package installation, CTC prerequisites, configuration, first safe demo, troubleshooting, update steps, and removal. Verify commands against the actual completed installation. Use fish syntax for user-facing shell commands. Link the core and Pi READMEs from the repository README as appropriate. Do not claim untested setup steps work.

The owner approved installing `firefox-cli@0.4.1` on Brainiac. Pairing was a separate approval step and was approved later.

## Live setup progress (historical)

- Installed npm CLI `firefox-cli@0.4.1` after approval.
- `firefox-cli --version` reports `0.4.1`.
- Ran approved `firefox-cli setup --json`; native-host registration succeeded.
- Initial `firefox-cli doctor --json` reported native host `installed` and extension connection `disconnected`; pairing later completed.
- Setup reports the matching Firefox extension URL: `https://github.com/respawn-llc/firefox-cli/releases/download/v0.4.1/firefox-cli-0.4.1.xpi`.
- The matching extension was installed, and pairing was approved later. The connected state is recorded below.

## Initial live smoke completed

Owner approved pairing. `firefox-cli connect --json` succeeded, and `doctor --json` now reports connected. A coder subagent tested one synthetic loopback page in an owned background tab. Creation, default-container metadata, snapshot/ref lookup, fill, click, wait, reviewed aggregate eval, navigation, stale-ref error, and exact-tab cleanup succeeded. Existing tabs and active-tab state remained unchanged. See [live smoke report](report-firefox-live-smoke.md).

A worker tried `find selector`, which is not a supported find kind; its usage error is not evidence of a broken supported locator. At that initial smoke, network capture, screenshot activation, and CTC/container behavior remained untested. Later results appear in [container live checks](report-firefox-container-live.md). Pairing approval URLs or request identifiers must not be copied into durable reports.

The owner later approved synthetic container setup and tests. Phase 0 remains incomplete. Do not start wrapper implementation.

## Synthetic container setup approved

Owner approved two temporary test containers and CTC test rules, preserving existing configuration. A coder subagent created a loopback-only synthetic fixture and manual setup guide. Node syntax and local HTTP GET smoke checks passed. No live browser settings changed. The fixture server is stopped. Manual Firefox setup is required because the approved public CLI cannot create containers or edit extension settings. See `guide-firefox-container-test-setup.md` and `test-firefox-container-server.mjs`.


## Phase 0 live follow-up — incomplete

The bounded live run validated public value reads, compact snapshot caps, generation-bound refs, stale-ref errors, screenshot metadata, and exact test-tab/server cleanup. The screenshot activated only the confirmed Work test tab and did not focus the Firefox window. See [container live checks](report-firefox-container-live.md) and [CLI live evidence](report-supported-firefox-cli.md).

Phase 0 remains incomplete. Firefox denied `get text body` access to the fixture's JSON observation responses, so synthetic-cookie equality is unknown. Network capture returned zero fixture requests after requests. No safe iframe route exists. The public CLI rejected `about:config` with `PERMISSION_DENIED: Illegal URL: about:config`; private-window behavior remains untested. Do not start wrapper implementation.

The confirmed Work and Personal tabs are closed. The fixture server is stopped. The four test CTC rules and two test containers still need manual removal. A future cookie probe needs a fixture response that the public getter can read; do not modify the running server without a planned restart.

## Cookie isolation gate passed

The owner confirmed replacement candidates 19 (Work) and 21 (Personal). Synthetic cookie isolation passed through ordinary fixture forms and public getters. Both synthetic cookies were cleared. Immediate network capture and iframe diagnostics also passed after the fixture correction. Current remaining live setup: a temporary private window, which the public CLI cannot create, to verify mutation refusal. No wrapper code exists yet.

## Private-window test explicitly excluded

The owner declined enabling FF-CLI Bridge in private windows. Current public window enumeration exposes no private windows. Keep that permission boundary. Do not request private-window access again. Mark live private mutation refusal skipped by owner decision; do not count it as a pass. This skip no longer blocks Phase 0 or initial implementation.

## Phase 0 exit and first implementation scope

The backend readiness gate is satisfied for the approved initial scope: installed and paired CLI, targeted normal-tab control, snapshots/refs, actual container metadata, confirmed CTC replacements, synthetic cookie isolation, screenshot files, immediate network summaries, iframe diagnostics, and privileged-page refusal. Private-window probing is intentionally excluded by the owner's decision. Cross-origin interaction, full-page screenshots, explicit create-in-container, container enumeration, response bodies, and general page eval under restrictive CSP remain unsupported or limited as recorded. This does not declare v1 acceptance complete.

All adopted test tabs are closed and the fixture server is stopped. Only the manually created test containers/rules remain. No account data was used.

Start Phase 1A: independently packaged harness-neutral core with bounded local CLI transport, defensive status parsing/version check, and a thin Pi `ff_status` tool plus `/firefox-status`. Prove headless Node use and Pi interoperability first. Session ownership, navigation, read summaries, and replacement confirmation follow in Phase 1B/2; do not expose unsafe placeholder tools now. Preserve the existing MIT license and package conventions.

## Phase 1A outcome

Implemented `extensions/firefox-core` and `extensions/pi-firefox` as separate npm workspaces. Core exposes `createFirefoxClient().status()` through compiled ESM and contains bounded spawn transport, timeout/cancellation, defensive version/doctor parsing, and safe result values. The Pi adapter registers `ff_status` and `/firefox-status`, preserves structured results, forwards cancellation, and adds no browser logic. No session/navigation placeholder tools are exposed.

Two coder subagents implemented independent packages. A third bounded review found no material issues in its scope. Parent integration corrected interface-to-JSON assignability, switched build hooks to explicit commands because `.npmrc` disables lifecycle scripts, fixed a child-test fixture's fallthrough, and reduced the default combined CLI-output budget to 64,000 bytes. No runtime dependency was added to core. Adapter depends only on core; Pi supplies its SDK and TypeBox peers.

Validation: focused core/adapter tests pass, public Node import returns the real connected status, private core subpaths are blocked, and the public Pi loader loads both Firefox and pi-browser without collisions. A real `ff_status` call through the loaded definition succeeds without a model request. Package allowlists pass. Node 20 itself was not available locally; runtime smoke checks used the installed Node 26.

An unrelated existing RPC-host test failed once because it read an empty file before the child finished writing. The focused rerun passed. The subsequent full repository check passed. This task did not change that test. Existing lock entries remain identical to the saved pre-task working baseline; only the four new workspace/package-link entries were added.

Installation instructions now exist in `extensions/pi-firefox/README.md`, linked from the root README. The tested CLI contract and live limitations ship in `extensions/firefox-core/SUPPORTED_FIREFOX_CLI.md`. README coverage must expand as later phases implement sessions and actions.

Test tabs and the fixture server are cleaned up. The four manually added CTC rules and two test containers remain for later integration tests. Do not remove or alter normal CTC rules. Private-window access remains disabled.

Final Phase 1A validation: `npm run check` passes with 1,212 Vitest tests passed and two skipped; package checks and 57 Bun tests pass. The Firefox packages contribute 18 focused tests. No commit, release, or persistent Pi configuration change was made.

## Phase 1B started

The owner requested committing the completed chunk and proceeding. Commit `4a59a59` includes only Firefox task changes; preexisting lockfile version updates remain unstaged. Phase 1B scope and disjoint worker responsibilities are in `spec-firefox-phase1b-contract.md`. Session state is intentionally in-memory until the later persistence/concurrency phase.

## Phase 1B implementation and validation

Core now exposes in-memory ensure, go, summary read, close, and human-confirmed replacement adoption through a public browser factory. Pi adds `ff_session_ensure`, `ff_go`, `ff_read`, and `ff_session_close`. No model-callable approval tool exists. Headless and declined confirmations remain failures. CTC alone routes URLs; expected destinations are distinct from the blank seed's actual container.

Parent integration resolved destination-versus-seed confusion, unverified snapshot targets, ignored explicit expectations while confirmation was pending, and nonzero mutation exits that could leave a binding usable. Regression tests cover those cases. Private pending evidence is copied before returning it. Expiry is checked before and after asynchronous adoption checks. Unknown JSON boundary data stays unknown until parsed. Import-boundary tests enforce the public core split. Requested URL queries no longer escape through mismatch recovery data.

Live test `test-firefox-phase1b-live.mjs` passed against paired Firefox: new owned tabs, idempotent ensure, verified default container, bounded ref-free summary (118 serialized bytes in this fixture), targeted navigation, query-free URL projection, close, closed-session refusal, concurrent independent sessions, real Pi loader tool execution, and preservation of original tabs. Test tabs closed and the fixture process stopped. This smoke does not claim CTC dialog UI, restart recovery, Node 20 execution, or v1 acceptance passed. See `report-firefox-phase1b-live.md` and `review-firefox-phase1b.md`.

The earlier full check reproduced the unrelated RPC-host test's empty-file race. Its focused rerun passed; no unrelated source was changed. The subsequent full check passed with 1,255 Vitest tests passed, two skipped, both Firefox package checks, and 57 Bun tests. The Firefox packages currently have 61 focused tests. Final validation after small privacy/documentation edits remains required.

Next chunk: durable session identity, cross-process coordination, and fuller CTC/error recovery under the existing safety policy. Do not add automated replacement provenance or private-window access.

Final Phase 1B validation after privacy and documentation edits: `npm run check` passes with 1,255 Vitest tests passed, two skipped, both Firefox package checks, and 57 Bun tests. All 61 focused Firefox tests pass. Public Node and real Pi-loader live smoke checks passed before the final error-output-only edits. No further commit or publish occurred. Temporary CTC test rules and containers remain for future integration checks; all program-created test tabs and fixture processes are closed.

## Authorization to complete the system

The owner requested continuing through the remaining phases until the browser-use system is usable. Continue through persistence, bounded actions/reads, workflows/extraction, Pi integration, live checks and local installation. Do not pause after intermediate chunks. Ask only for necessary owner decisions or browser intervention. No new commits or publication are implied. The completion contract is in `spec-firefox-v1-completion.md`.


## V1 completion

Persistence, cross-process coordination, bounded views, unique refs, actions, waits, network metadata, private-file screenshots, deterministic workflows, typed extraction, configuration, logging, Pi integration, and the usage skill are complete within the supported backend scope. Local installation used `pi install ./extensions/pi-firefox`.

Final repository validation passed: 1,319 Vitest tests, two skipped, 57 Bun tests, and all package checks. The live suite passed 20 workflow cycles, separate-process restart reuse, independent sessions, screenshot resizing, network observation, and owned cleanup. A fresh owner-approved CTC candidate passed through the public Pi tool callback. Public-loader measurements verified compact model-facing text.

The implementation does not claim unsupported backend parity. Native terminal-dialog rendering was not visually exercised. Node 20 execution and Linux live integration remain unverified. Pending approvals remain process-local and fail closed after restart. Private-window access remains disabled. These limits appear in the final acceptance report and package documentation.

Decision log: preserve CLI/CTC unchanged; use same-user process-start metadata for browser epochs; use private atomic state and journal markers; coordinate browser-wide work at one fixed OS-user gate; publish screenshots exclusively; keep opaque refs unique across clients; require explicit workflow writes; reject ambiguous extraction instead of guessing.

No additional commit or publication occurred. Unrelated lockfile changes remain intact. All adopted test tabs and fixture processes are closed. Temporary synthetic CTC containers/rules remain manually installed.

## Core package relocation

Move core to `packages/firefox-agent-core` and rename its npm package to `@pi-kaush/firefox-agent-core`. Keep `extensions/pi-firefox` unchanged as the Pi adapter location. This makes the library boundary explicit without a separate repository.

Update workspace discovery, TypeScript coverage, imports, package metadata, documentation links, and runnable validation scripts. Preserve historical reports. The migration changes no browser behavior or Firefox CLI dependency policy.

Validation: full `npm run check` passed with 1,321 Vitest tests passed and one skipped, 57 Bun tests, and both Firefox package checks. Public Node import and real read-only health passed. The old package name no longer resolves. Only the six expected lockfile entries changed relative to the migration baseline. No commit or publication occurred.
