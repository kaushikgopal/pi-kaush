# pi-response-style bench

Opt-in eval harness that **measures** (not asserts) two claims about the
response-style extension:

1. **Work is unchanged** when a style is active — proven by hidden coding
   tests that pass at equal rates with the style off vs on.
2. **Output is shorter and more skimmable** — measured by char count, words
   before the first bold marker, answer-in-first-line rate, longest unbroken
   text block, and deliverable purity.

No LLM judge. Every metric is a deterministic function over the reply string
(or a `node` test run for the coding set).

## Isolation

Every `pi` invocation runs with:

- `PI_CODING_AGENT_DIR` → a fresh temp dir (never the real `~/.pi/agent`).
- `cwd` → a fresh temp dir.
- `--no-session --no-extensions --no-tools --no-context-files`, so the system
  prompt is identical across arms except for the injected style body.

The ON arm adds `-e <package>/src/index.ts` and pre-seeds the temp agent dir's
`pi-response-style.state.json` with `{"lastUsed":"<style>"}` so the style
resolves at session start.

The only read of the real agent dir is a one-time, read-only lookup of the
bench provider in `~/.pi/agent/models.json` (the `fireworks-kimi` gateway
provider is not built in). That provider uses a dummy API key — real auth is
network-level at the gateway — so no secret is copied, and nothing is ever
written to the real agent dir.

## Run

```sh
npm run bench                            # readability + deliverable (+ coding
                                         #   if the first sets are clean & fast)
BENCH_MODEL=openai/gpt-4o-mini npm run bench
BENCH_STYLE=hemingway npm run bench
BENCH_SKIP_CODING=1 npm run bench        # force-skip coding
BENCH_FORCE_CODING=1 npm run bench       # force-run coding
```

Results are written to `bench/results/<timestamp>.json` and a summary table
is printed to stdout.

## Env

| Variable                    | Default                       | Purpose                                     |
| --------------------------- | ----------------------------- | ------------------------------------------- |
| `BENCH_MODEL`               | `fireworks-kimi/kimi-k3-fast` | Model pattern (must resolve in models.json) |
| `BENCH_STYLE`               | `simplicity`                  | Style name to pre-seed as `lastUsed`        |
| `BENCH_PER_CALL_TIMEOUT_MS` | `120000`                      | Per pi call timeout                         |
| `BENCH_CODING_BUDGET_MS`    | `480000`                      | Skip coding if first sets exceed this       |
| `BENCH_SKIP_CODING`         | unset                         | `1` never runs coding                       |
| `BENCH_FORCE_CODING`        | unset                         | `1` always runs coding                      |

This directory is deliberately **not** in `package.json` `files`, so the
harness never ships in the npm tarball; `npm run package:check` enforces that.
