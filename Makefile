ROOT := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))

.PHONY: bench-pi check publish

# Run the full repository check (format, typecheck, test, package check).
check:
	npm run check

# Benchmark Pi startup in the current directory and home.
bench-pi:
	@bun run "$(ROOT)/benchmarks/startup-benchmark.ts"

# Publish an extension to npm via GitHub Actions OIDC.
#
#   make publish PACKAGE=pi-btw-with-imports               # patch bump
#   make publish PACKAGE=pi-agent-mode                     # patch bump
#   make publish PACKAGE=pi-btw-with-imports VERSION=0.2.0 # explicit version
#
# Bumps the version, runs checks, commits, pushes to main, and creates a
# GitHub Release whose tag triggers the OIDC publish workflow. The package
# must already exist on npm with a trusted publisher configured.
publish:
	@./scripts/publish.sh "$(PACKAGE)" "$(VERSION)"
