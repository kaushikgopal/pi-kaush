# A/B bench: local extension vs Pi built-in read/edit

Deterministic, isolated A/B evaluation of the `better` read/edit tools
against Pi's built-in `read`/`edit` on exact file-edit tasks. Scoring is
byte-exact over the complete workspace tree — a trial only passes when
every regular file's bytes match the expected tree and no file is missing
or extra.

## Commands (run from the extension folder)

```fish
make bench                          # full default matrix (4 models × 4 fixtures × 2 arms)
make bench-dry                      # print the plan, spawn nothing
make bench-quick                    # 1 model × 1 fixture × 2 arms smoke run
make publish RUN=<runId>            # sanitized public bundle → bench/published/<runId>/
make report RUN=<runId>             # regenerate report.md from raw.json (private runs dir)
make verify RUN=<runId>             # independent re-check of run + bundle
```

The same entry point is `npm run bench -- <args>` (add `--` before flags):

```fish
npm run bench -- --dry-run
npm run bench -- --fixture two-splices --trials 2
npm run bench -- --model instacart-openai/gpt-5.6-luna:low --model-filter "*luna*"
npm run bench -- --timeout 180 --max-calls 250
npm run bench -- publish <runId>
npm run bench -- report <runId>
npm run bench -- verify <runId>
```

Full option list: `node bench/cli.mjs --help`. Every knob has a `BENCH_*`
env-var equivalent (see cli.mjs header: `BENCH_MODEL`, `BENCH_FIXTURE`,
`BENCH_MODEL_FILTER`, `BENCH_THINKING`, `BENCH_TRIALS`, `BENCH_SEED`,
`BENCH_TIMEOUT_MS`, `BENCH_MAX_CALLS`, `BENCH_PI_BIN`, `BENCH_RUNS_DIR`,
`BENCH_PUBLISHED_DIR`, `BENCH_FIXTURES_DIR`, `BENCH_RUN_ID`,
`BENCH_AGENT_DIR`, `BENCH_EXTENSION_PATH`, `BENCH_DRY_RUN`). `--seed`
makes the per-trial slot shuffle reproducible; arm order within a slot is
counterbalanced by (cell + trial) parity, so even a single-trial run
alternates the starting arm across adjacent cells.

## Defaults

- Models: `instacart-openai/gpt-5.6-luna` (thinking low),
  `open-weights/deepseek-v4-flash-0731-priority` (off),
  `instacart-anthropic/claude-haiku-4-5@20251001` (off),
  `huggingface/zai-org/GLM-5.2` (low).
- Fixtures: `two-splices`, `repeated-context`, `two-files`, `large-delete`.
- Trials 1, seed 1, per-arm timeout 300 s, max tool calls 200 (the cap
  triggers at count `>=` max; exceeding it kills the whole process group).
- Extension entry: `src/index.ts`; pi binary from `BENCH_PI_BIN` or `pi`.

The default is a 32-arm run. `make bench-quick` takes one fixture and one
model; `--dry-run` prints every arm command with zero spawns, so the call
count is always visible before anything runs.

## Fixtures

Each fixture is a checked-in descriptor in `bench/fixtures/<name>.json`
with exact start and expected trees (or a deterministic generator, see
`large-delete`). Prompts allow only the `read` and `edit` tools and are
arm-neutral — a valid completion never requires a tool capability that
only one arm has. The manifest records each fixture's descriptor SHA-256
plus byte-exact start and expected tree snapshots (materialized fresh
before any arm runs), and `verify` re-materializes them to prove
determinism.

| Fixture            | What it probes                                                              |
| ------------------ | --------------------------------------------------------------------------- |
| `two-splices`      | two coordinated edits batched in one call                                   |
| `repeated-context` | unique targeting when exact text repeats                                    |
| `two-files`        | coordinated edits across two files (better batches; builtin uses two calls) |
| `large-delete`     | 500-row delete; edit argument bytes vs pasted oldText                       |

## Metric contract

Every arm records: outcome classification (`completed`, `timeout`,
`tool-call-limit`, `output-limit`, `provider-error`, `assistant-error`,
`process-error`, `parse-error`, `no-agent-end`), wall time, token usage (summed across
assistant `message_end` turns; the last `message_update` is only the
fallback when messages report no usage, noted via `source`), tool call
counts per tool, tool call errors, edit argument bytes, read argument
bytes, and the first-edit tri-state (`none` / `success` / `error`).
Classification uses the FINAL lifecycle: the last `agent_end` decides, a
provider retry only becomes a permanent `provider-error` when its last
`auto_retry_end` failed, and a nonzero exit takes precedence over event
traces. The protocol parser never drops lines: unparseable lines, unknown
event types, provider retries, and assistant stop-reason errors are
counted and surfaced. Pi's reported provider/model (from `message_end`)
is recorded per arm — `verify` rejects a run where it diverges from the
requested model.

## Isolation

Every arm gets a fresh workspace plus a private `PI_CODING_AGENT_DIR`
(chmod 0700) in the **system temp dir**, never inside the repository.
`auth.json`, `models.json`, and `models-store.json` are **copied** into it
(0600, existing files only) — never symlinked, and their contents are
never read or logged by the harness. The private dir also receives a
forced `settings.json` with `betterReadEdit.avoidModels: []`, so an
avoidlist from your global settings can never silently route the better
arm onto builtin tools. Arms run with `--no-extensions --no-skills
--no-prompt-templates --no-themes --no-context-files --no-approve
--no-session --tools read,edit` and the better arm additionally loads
`-e src/index.ts`.

**This is not an OS sandbox.** The model and its tools run as your user
and can read or write anything you can. The harness only guarantees a
fresh working directory and an isolated agent dir — benchmark only models
you trust. Because auth files are copied (and pi may refresh auth state),
do **not** run the bench concurrently with an interactive Pi session on
the same agent dir; a concurrent refresh could race with the copy.

## Artifacts

- Private: `bench/runs/<runId>/` (0700) with
  `{manifest.json, raw.json, arms/*.jsonl}` (0600). `raw.json` holds
  normalized events, error strings, and per-file tree evidence for
  debugging and is gitignored; per-arm `.jsonl` journals stream events as
  the arm runs and always end with an `arm_end` line. `manifest.json`
  records the reproducible config, fixture descriptor/start/expected
  hashes, the extension source digest, and the pi version.
- Public: `bench/published/<runId>/{manifest.json, results.json,
report.md, checksums.txt}` — a strict allowlist projection with no
  events, error strings, assistant prose, absolute paths, or credentials.
  Tree diffs keep per-file byte counts and SHA-256 digests so scoring can
  be re-verified exactly without leaking contents. `make publish` stages
  in a temp dir and atomically renames into place (idempotent, never a
  partial bundle), never runs git and never uploads.
- `make report` regenerates the markdown privately under
  `runs/<runId>/report.md`; the published bundle computes its own copy
  from `raw.json`.

`make verify` re-derives every metric and the reported identity from the
stored events, re-checks fixture descriptor/start/expected determinism
and the extension source digest, requires the published bundle to contain
exactly the four files (rejecting extras), and byte-compares the bundle —
including the regenerated report — plus checksums and deep projections
against `raw.json`.

Generated artifacts are gitignored (`.gitignore`); repo `format:check`
runs on the checked-in tree only.
