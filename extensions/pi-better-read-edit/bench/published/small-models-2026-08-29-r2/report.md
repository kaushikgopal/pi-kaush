# small-models-2026-08-29-r2

A/B bench of the local **pi-better-read-edit** extension ("better") against Pi's built-in read/edit ("builtin") on exact fixture edits.

## Configuration

- Run: `small-models-2026-08-29-r2` (created 2026-08-29T03:19:09.793Z)
- Models: `instacart-openai/gpt-5.6-luna` (thinking low), `open-weights/deepseek-v4-flash-0731-priority` (thinking off), `instacart-anthropic/claude-haiku-4-5@20251001` (thinking off), `huggingface/zai-org/GLM-5.2` (thinking low)
- Fixtures: two-splices, repeated-context, two-files, large-delete
- Trials per cell: 1 (seed 1)
- Per-arm timeout: 300.0 s, max tool calls: 200 (cap triggers at count >= max)
- Pi: `pi` 0.80.6
- Isolation: copied-config private `PI_CODING_AGENT_DIR` per arm; auth.json/models.json/models-store.json copied 0600, settings.json forced to betterReadEdit.avoidModels=[] — workspace in the system temp dir, no OS sandbox

> **Trust boundary:** this is not an OS sandbox. Models and their tools run as your user and may read or write beyond the scratch workspace. Benchmark only models you trust.

## Summary

Comparable completed pairs: **12 / 16**. Within those pairs, better was exact in **12/12** and builtin in **11/12**.
All attempted arms: 23/32 tree-exact; outcomes: assistant-error 8, completed 24.

### Comparable results by model

| Model | Pairs | Better exact | Builtin exact | Better median | Builtin median | Better tokens | Builtin tokens |
|-------|-------|--------------|---------------|---------------|----------------|---------------|----------------|
| huggingface/zai-org/GLM-5.2 | 0 | 0/0 | 0/0 | — | — | 0 | 0 |
| instacart-anthropic/claude-haiku-4-5@20251001 | 4 | 4/4 | 4/4 | 6.6 s | 6.6 s | 78805 | 118366 |
| instacart-openai/gpt-5.6-luna | 4 | 4/4 | 3/4 | 9.5 s | 5.2 s | 64626 | 26323 |
| open-weights/deepseek-v4-flash-0731-priority | 4 | 4/4 | 4/4 | 5.4 s | 5.2 s | 70923 | 171635 |

## large-delete

Tree scoring is byte-exact over the complete workspace: only regular files are hashed, and any missing, extra, or changed file fails the arm.

| Arm | Attempts | Completed | Exact / completed | Median wall | Mean tools | Mean edit bytes | Tokens (sum) | Tool errors |
|-----|----------|-----------|-------------------|-------------|------------|-----------------|--------------|-------------|
| better | 4 | 3 | 3/3 | 14.0 s | 6.3 | 403.3 B | 142142 | 5 |
| builtin | 4 | 3 | 2/3 | 50.2 s | 6.7 | 13.4 KiB | 268570 | 0 |

### By model

| Model | Arm | Trial | Outcome | Tree | Wall | Tools | Edit bytes | First edit |
|-------|-----|-------|---------|------|------|-------|------------|------------|
| huggingface/zai-org/GLM-5.2 | better | 0 | assistant-error | MISMATCH | 679 ms | 0 | 0 B | none |
| huggingface/zai-org/GLM-5.2 | builtin | 0 | assistant-error | MISMATCH | 695 ms | 0 | 0 B | none |
| instacart-anthropic/claude-haiku-4-5@20251001 | better | 0 | completed | EXACT | 15.7 s | 6 | 324 B | error |
| instacart-anthropic/claude-haiku-4-5@20251001 | builtin | 0 | completed | EXACT | 50.2 s | 10 | 20.1 KiB | success |
| instacart-openai/gpt-5.6-luna | better | 0 | completed | EXACT | 14.0 s | 7 | 562 B | error |
| instacart-openai/gpt-5.6-luna | builtin | 0 | completed | MISMATCH | 15.9 s | 5 | 0 B | none |
| open-weights/deepseek-v4-flash-0731-priority | better | 0 | completed | EXACT | 11.2 s | 6 | 324 B | error |
| open-weights/deepseek-v4-flash-0731-priority | builtin | 0 | completed | EXACT | 55.2 s | 5 | 20.1 KiB | success |

## repeated-context

Tree scoring is byte-exact over the complete workspace: only regular files are hashed, and any missing, extra, or changed file fails the arm.

| Arm | Attempts | Completed | Exact / completed | Median wall | Mean tools | Mean edit bytes | Tokens (sum) | Tool errors |
|-----|----------|-----------|-------------------|-------------|------------|-----------------|--------------|-------------|
| better | 4 | 3 | 3/3 | 5.3 s | 2.3 | 299.3 B | 23048 | 1 |
| builtin | 4 | 3 | 3/3 | 5.7 s | 2.7 | 224 B | 18967 | 1 |

### By model

| Model | Arm | Trial | Outcome | Tree | Wall | Tools | Edit bytes | First edit |
|-------|-----|-------|---------|------|------|-------|------------|------------|
| huggingface/zai-org/GLM-5.2 | better | 0 | assistant-error | MISMATCH | 651 ms | 0 | 0 B | none |
| huggingface/zai-org/GLM-5.2 | builtin | 0 | assistant-error | MISMATCH | 713 ms | 0 | 0 B | none |
| instacart-anthropic/claude-haiku-4-5@20251001 | better | 0 | completed | EXACT | 7.4 s | 3 | 390 B | error |
| instacart-anthropic/claude-haiku-4-5@20251001 | builtin | 0 | completed | EXACT | 7.4 s | 3 | 376 B | error |
| instacart-openai/gpt-5.6-luna | better | 0 | completed | EXACT | 4.5 s | 2 | 174 B | success |
| instacart-openai/gpt-5.6-luna | builtin | 0 | completed | EXACT | 5.6 s | 2 | 167 B | success |
| open-weights/deepseek-v4-flash-0731-priority | better | 0 | completed | EXACT | 5.3 s | 2 | 334 B | success |
| open-weights/deepseek-v4-flash-0731-priority | builtin | 0 | completed | EXACT | 5.7 s | 3 | 129 B | success |

## two-files

Tree scoring is byte-exact over the complete workspace: only regular files are hashed, and any missing, extra, or changed file fails the arm.

| Arm | Attempts | Completed | Exact / completed | Median wall | Mean tools | Mean edit bytes | Tokens (sum) | Tool errors |
|-----|----------|-----------|-------------------|-------------|------------|-----------------|--------------|-------------|
| better | 4 | 3 | 3/3 | 5.6 s | 3.7 | 564.3 B | 25149 | 2 |
| builtin | 4 | 3 | 3/3 | 4.7 s | 4 | 235.3 B | 14794 | 0 |

### By model

| Model | Arm | Trial | Outcome | Tree | Wall | Tools | Edit bytes | First edit |
|-------|-----|-------|---------|------|------|-------|------------|------------|
| huggingface/zai-org/GLM-5.2 | better | 0 | assistant-error | MISMATCH | 688 ms | 0 | 0 B | none |
| huggingface/zai-org/GLM-5.2 | builtin | 0 | assistant-error | MISMATCH | 658 ms | 0 | 0 B | none |
| instacart-anthropic/claude-haiku-4-5@20251001 | better | 0 | completed | EXACT | 5.6 s | 3 | 373 B | success |
| instacart-anthropic/claude-haiku-4-5@20251001 | builtin | 0 | completed | EXACT | 5.7 s | 4 | 254 B | success |
| instacart-openai/gpt-5.6-luna | better | 0 | completed | EXACT | 9.1 s | 5 | 947 B | error |
| instacart-openai/gpt-5.6-luna | builtin | 0 | completed | EXACT | 4.7 s | 4 | 254 B | success |
| open-weights/deepseek-v4-flash-0731-priority | better | 0 | completed | EXACT | 5.5 s | 3 | 373 B | success |
| open-weights/deepseek-v4-flash-0731-priority | builtin | 0 | completed | EXACT | 4.6 s | 4 | 198 B | success |

## two-splices

Tree scoring is byte-exact over the complete workspace: only regular files are hashed, and any missing, extra, or changed file fails the arm.

| Arm | Attempts | Completed | Exact / completed | Median wall | Mean tools | Mean edit bytes | Tokens (sum) | Tool errors |
|-----|----------|-----------|-------------------|-------------|------------|-----------------|--------------|-------------|
| better | 4 | 3 | 3/3 | 5.8 s | 2.7 | 502.3 B | 24015 | 2 |
| builtin | 4 | 3 | 3/3 | 4.6 s | 2 | 301.3 B | 13993 | 0 |

### By model

| Model | Arm | Trial | Outcome | Tree | Wall | Tools | Edit bytes | First edit |
|-------|-----|-------|---------|------|------|-------|------------|------------|
| huggingface/zai-org/GLM-5.2 | better | 0 | assistant-error | MISMATCH | 758 ms | 0 | 0 B | none |
| huggingface/zai-org/GLM-5.2 | builtin | 0 | assistant-error | MISMATCH | 672 ms | 0 | 0 B | none |
| instacart-anthropic/claude-haiku-4-5@20251001 | better | 0 | completed | EXACT | 5.8 s | 2 | 310 B | success |
| instacart-anthropic/claude-haiku-4-5@20251001 | builtin | 0 | completed | EXACT | 4.8 s | 2 | 286 B | success |
| instacart-openai/gpt-5.6-luna | better | 0 | completed | EXACT | 10.0 s | 4 | 887 B | error |
| instacart-openai/gpt-5.6-luna | builtin | 0 | completed | EXACT | 3.6 s | 2 | 278 B | success |
| open-weights/deepseek-v4-flash-0731-priority | better | 0 | completed | EXACT | 4.4 s | 2 | 310 B | success |
| open-weights/deepseek-v4-flash-0731-priority | builtin | 0 | completed | EXACT | 4.6 s | 2 | 340 B | success |

## Failures and classifications

| Model | Fixture | Arm | Outcome | Tree | Notes |
|-------|---------|-----|---------|------|-------|
| huggingface/zai-org/GLM-5.2 | repeated-context | builtin | assistant-error | MISMATCH | assistant-error; 1 tree file(s) differ |
| huggingface/zai-org/GLM-5.2 | repeated-context | better | assistant-error | MISMATCH | assistant-error; 1 tree file(s) differ |
| huggingface/zai-org/GLM-5.2 | two-files | better | assistant-error | MISMATCH | assistant-error; 2 tree file(s) differ |
| huggingface/zai-org/GLM-5.2 | two-files | builtin | assistant-error | MISMATCH | assistant-error; 2 tree file(s) differ |
| huggingface/zai-org/GLM-5.2 | large-delete | builtin | assistant-error | MISMATCH | assistant-error; 1 tree file(s) differ |
| huggingface/zai-org/GLM-5.2 | large-delete | better | assistant-error | MISMATCH | assistant-error; 1 tree file(s) differ |
| instacart-openai/gpt-5.6-luna | large-delete | builtin | completed | MISMATCH | completed; 1 tree file(s) differ |
| huggingface/zai-org/GLM-5.2 | two-splices | better | assistant-error | MISMATCH | assistant-error; 1 tree file(s) differ |
| huggingface/zai-org/GLM-5.2 | two-splices | builtin | assistant-error | MISMATCH | assistant-error; 1 tree file(s) differ |

Outcome codes: `completed` agent finished; `timeout` killed after per-arm timeout; `tool-call-limit` killed at the max-calls cap; `output-limit` killed after an oversized protocol line; `provider-error` provider retry failed (final attempt); `assistant-error` final assistant stop-reason error; `process-error` non-zero exit; `parse-error` unusable protocol stream; `no-agent-end` clean exit without agent_end.

Generated by the pi-better-read-edit bench harness (schema pi-better-read-edit-bench/v1).
