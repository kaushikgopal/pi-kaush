# first-edit-improvements-r1

A/B bench of the local **pi-better-read-edit** extension ("better") against Pi's built-in read/edit ("builtin") on exact fixture edits.

## Configuration

- Run: `first-edit-improvements-r1` (created 2026-08-29T03:49:44.505Z)
- Models: `instacart-openai/gpt-5.6-luna` (thinking low), `open-weights/deepseek-v4-flash-0731-priority` (thinking off), `instacart-anthropic/claude-haiku-4-5@20251001` (thinking off)
- Fixtures: two-splices, repeated-context, two-files, large-delete
- Trials per cell: 1 (seed 1)
- Per-arm timeout: 300.0 s, max tool calls: 200 (cap triggers at count >= max)
- Pi: `pi` 0.80.6
- Isolation: copied-config private `PI_CODING_AGENT_DIR` per arm; auth.json/models.json/models-store.json copied 0600, settings.json forced to betterReadEdit.avoidModels=[] — workspace in the system temp dir, no OS sandbox

> **Trust boundary:** this is not an OS sandbox. Models and their tools run as your user and may read or write beyond the scratch workspace. Benchmark only models you trust.

## Summary

Comparable completed pairs: **12 / 12**. Within those pairs, better was exact in **12/12** and builtin in **12/12**.
All attempted arms: 24/24 tree-exact; outcomes: completed 24.

### Comparable results by model

| Model | Pairs | Better exact | Builtin exact | Better median | Builtin median | Better tokens | Builtin tokens |
|-------|-------|--------------|---------------|---------------|----------------|---------------|----------------|
| instacart-anthropic/claude-haiku-4-5@20251001 | 4 | 4/4 | 4/4 | 5.6 s | 6.6 s | 69454 | 129290 |
| instacart-openai/gpt-5.6-luna | 4 | 4/4 | 4/4 | 5.8 s | 5.9 s | 42381 | 56063 |
| open-weights/deepseek-v4-flash-0731-priority | 4 | 4/4 | 4/4 | 6.9 s | 6.5 s | 147834 | 152425 |

## large-delete

Tree scoring is byte-exact over the complete workspace: only regular files are hashed, and any missing, extra, or changed file fails the arm.

| Arm | Attempts | Completed | Exact / completed | Median wall | Mean tools | Mean edit bytes | Tokens (sum) | Tool errors |
|-----|----------|-----------|-------------------|-------------|------------|-----------------|--------------|-------------|
| better | 3 | 3 | 3/3 | 13.2 s | 4 | 140 B | 198007 | 1 |
| builtin | 3 | 3 | 3/3 | 56.0 s | 5.7 | 20.1 KiB | 287989 | 0 |

### By model

| Model | Arm | Trial | Outcome | Tree | Wall | Tools | Edit bytes | First edit |
|-------|-----|-------|---------|------|------|-------|------------|------------|
| instacart-anthropic/claude-haiku-4-5@20251001 | better | 0 | completed | EXACT | 13.2 s | 5 | 210 B | error |
| instacart-anthropic/claude-haiku-4-5@20251001 | builtin | 0 | completed | EXACT | 46.8 s | 8 | 20.1 KiB | success |
| instacart-openai/gpt-5.6-luna | better | 0 | completed | EXACT | 7.4 s | 3 | 105 B | success |
| instacart-openai/gpt-5.6-luna | builtin | 0 | completed | EXACT | 56.5 s | 5 | 20.1 KiB | success |
| open-weights/deepseek-v4-flash-0731-priority | better | 0 | completed | EXACT | 21.7 s | 4 | 105 B | success |
| open-weights/deepseek-v4-flash-0731-priority | builtin | 0 | completed | EXACT | 56.0 s | 4 | 20.2 KiB | success |

## repeated-context

Tree scoring is byte-exact over the complete workspace: only regular files are hashed, and any missing, extra, or changed file fails the arm.

| Arm | Attempts | Completed | Exact / completed | Median wall | Mean tools | Mean edit bytes | Tokens (sum) | Tool errors |
|-----|----------|-----------|-------------------|-------------|------------|-----------------|--------------|-------------|
| better | 3 | 3 | 3/3 | 5.4 s | 2 | 131 B | 19976 | 0 |
| builtin | 3 | 3 | 3/3 | 6.8 s | 2.7 | 235.3 B | 19122 | 1 |

### By model

| Model | Arm | Trial | Outcome | Tree | Wall | Tools | Edit bytes | First edit |
|-------|-----|-------|---------|------|------|-------|------------|------------|
| instacart-anthropic/claude-haiku-4-5@20251001 | better | 0 | completed | EXACT | 5.4 s | 2 | 131 B | success |
| instacart-anthropic/claude-haiku-4-5@20251001 | builtin | 0 | completed | EXACT | 7.6 s | 3 | 374 B | error |
| instacart-openai/gpt-5.6-luna | better | 0 | completed | EXACT | 3.5 s | 2 | 131 B | success |
| instacart-openai/gpt-5.6-luna | builtin | 0 | completed | EXACT | 4.1 s | 2 | 203 B | success |
| open-weights/deepseek-v4-flash-0731-priority | better | 0 | completed | EXACT | 6.1 s | 2 | 131 B | success |
| open-weights/deepseek-v4-flash-0731-priority | builtin | 0 | completed | EXACT | 6.8 s | 3 | 129 B | success |

## two-files

Tree scoring is byte-exact over the complete workspace: only regular files are hashed, and any missing, extra, or changed file fails the arm.

| Arm | Attempts | Completed | Exact / completed | Median wall | Mean tools | Mean edit bytes | Tokens (sum) | Tool errors |
|-----|----------|-----------|-------------------|-------------|------------|-----------------|--------------|-------------|
| better | 3 | 3 | 3/3 | 5.4 s | 3 | 389 B | 21628 | 0 |
| builtin | 3 | 3 | 3/3 | 5.5 s | 4 | 235.3 B | 14814 | 0 |

### By model

| Model | Arm | Trial | Outcome | Tree | Wall | Tools | Edit bytes | First edit |
|-------|-----|-------|---------|------|------|-------|------------|------------|
| instacart-anthropic/claude-haiku-4-5@20251001 | better | 0 | completed | EXACT | 5.4 s | 3 | 287 B | success |
| instacart-anthropic/claude-haiku-4-5@20251001 | builtin | 0 | completed | EXACT | 5.5 s | 4 | 254 B | success |
| instacart-openai/gpt-5.6-luna | better | 0 | completed | EXACT | 4.8 s | 3 | 287 B | success |
| instacart-openai/gpt-5.6-luna | builtin | 0 | completed | EXACT | 6.8 s | 4 | 254 B | success |
| open-weights/deepseek-v4-flash-0731-priority | better | 0 | completed | EXACT | 7.6 s | 3 | 593 B | success |
| open-weights/deepseek-v4-flash-0731-priority | builtin | 0 | completed | EXACT | 4.7 s | 4 | 198 B | success |

## two-splices

Tree scoring is byte-exact over the complete workspace: only regular files are hashed, and any missing, extra, or changed file fails the arm.

| Arm | Attempts | Completed | Exact / completed | Median wall | Mean tools | Mean edit bytes | Tokens (sum) | Tool errors |
|-----|----------|-----------|-------------------|-------------|------------|-----------------|--------------|-------------|
| better | 3 | 3 | 3/3 | 6.1 s | 2 | 267 B | 20058 | 0 |
| builtin | 3 | 3 | 3/3 | 5.2 s | 2.3 | 328.7 B | 15853 | 1 |

### By model

| Model | Arm | Trial | Outcome | Tree | Wall | Tools | Edit bytes | First edit |
|-------|-----|-------|---------|------|------|-------|------------|------------|
| instacart-anthropic/claude-haiku-4-5@20251001 | better | 0 | completed | EXACT | 5.8 s | 2 | 267 B | success |
| instacart-anthropic/claude-haiku-4-5@20251001 | builtin | 0 | completed | EXACT | 5.2 s | 2 | 286 B | success |
| instacart-openai/gpt-5.6-luna | better | 0 | completed | EXACT | 6.8 s | 2 | 267 B | success |
| instacart-openai/gpt-5.6-luna | builtin | 0 | completed | EXACT | 5.0 s | 2 | 278 B | success |
| open-weights/deepseek-v4-flash-0731-priority | better | 0 | completed | EXACT | 6.1 s | 2 | 267 B | success |
| open-weights/deepseek-v4-flash-0731-priority | builtin | 0 | completed | EXACT | 6.2 s | 3 | 422 B | error |

## Failures and classifications

No failed or incomplete arms.

Outcome codes: `completed` agent finished; `timeout` killed after per-arm timeout; `tool-call-limit` killed at the max-calls cap; `output-limit` killed after an oversized protocol line; `provider-error` provider retry failed (final attempt); `assistant-error` final assistant stop-reason error; `process-error` non-zero exit; `parse-error` unusable protocol stream; `no-agent-end` clean exit without agent_end.

Generated by the pi-better-read-edit bench harness (schema pi-better-read-edit-bench/v1).
