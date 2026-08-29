# Extension-local bench targets for pi-better-read-edit.
#
# These targets operate ONLY on local bench artifacts under bench/. They
# never commit, push, or upload. Note: this Makefile lives inside the
# extension directory, so `make publish` here creates a sanitized bundle —
# it does NOT publish to npm. The repository root Makefile's `publish`
# target (npm publishing via GitHub Actions) is a separate command run
# from the repo root.

BENCH := node bench/cli.mjs

.PHONY: bench bench-dry bench-quick publish report verify test format

## Full default bench (4 models x 4 fixtures x 2 arms).
bench:
	@npm run bench

## Print the deterministic plan; spawn no pi processes.
bench-dry:
	@npm run bench -- --dry-run

## One-fixture, one-model smoke run (cheap sanity check, low thinking).
bench-quick:
	@npm run bench -- --fixture two-splices --model instacart-openai/gpt-5.6-luna:low --trials 1

## Sanitized public bundle: make publish RUN=<runId>
publish:
	@$(BENCH) publish "$(RUN)"

## Regenerate report.md from raw.json (private runs dir): make report RUN=<runId>
report:
	@$(BENCH) report "$(RUN)"

## Independent verification of run + published bundle: make verify RUN=<runId>
verify:
	@$(BENCH) verify "$(RUN)"

## Vitest over the extension (source tests + bench harness tests).
test:
	@npx vitest run

## Prettier over the extension source (bench runs/ is gitignored output).
format:
	@npx prettier --write .
