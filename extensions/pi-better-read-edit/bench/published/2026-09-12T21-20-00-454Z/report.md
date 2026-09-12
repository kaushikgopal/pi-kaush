# 2026-09-12T21-20-00-454Z

A/B bench of the local **pi-better-read-edit** extension ("better") against Pi's built-in read/edit ("builtin") on exact fixture edits.

## Configuration

- Run: `2026-09-12T21-20-00-454Z` (created 2026-09-12T21:20:00.458Z)
- Models: `open-weights/glm-5.3-flash` (thinking low)
- Fixtures: two-splices, repeated-context, two-files, large-delete, long-doc-repeated-edits, semantic-locate, blank-heavy-repeats, append-eof-newline, ranged-read-tail, multi-file-rotation, repeated-region-edits, no-trailing-newline-append
- Trials per cell: 1 (seed 1)
- Per-arm timeout: 300.0 s, max tool calls: 200 (cap triggers at count >= max)
- Pi: `pi` 0.80.6
- Isolation: copied-config private `PI_CODING_AGENT_DIR` per arm; auth.json/models.json/models-store.json copied 0600, settings.json forced to betterReadEdit.avoidModels=[] — workspace in the system temp dir, no OS sandbox

> **Trust boundary:** this is not an OS sandbox. Models and their tools run as your user and may read or write beyond the scratch workspace. Benchmark only models you trust.

## Summary

Comparable completed pairs: **12 / 12**. Within those pairs, better was exact in **10/12** and builtin in **9/12**.
All attempted arms: 19/24 tree-exact; outcomes: completed 24.

### Comparable results by model

| Model | Pairs | Better exact | Builtin exact | Better median | Builtin median | Better tokens | Builtin tokens |
|-------|-------|--------------|---------------|---------------|----------------|---------------|----------------|
| open-weights/glm-5.3-flash | 12 | 10/12 | 9/12 | 6.0 s | 3.7 s | 229066 | 145461 |

## append-eof-newline

Tree scoring is byte-exact over the complete workspace: only regular files are hashed, and any missing, extra, or changed file fails the arm.

| Arm | Attempts | Completed | Exact / completed | Median wall | Mean tools | Mean edit bytes | Tokens (sum) | Tool errors |
|-----|----------|-----------|-------------------|-------------|------------|-----------------|--------------|-------------|
| better | 1 | 1 | 1/1 | 11.0 s | 7 | 710 B | 20332 | 2 |
| builtin | 1 | 1 | 0/1 | 3.3 s | 2 | 146 B | 4045 | 0 |

## blank-heavy-repeats

Tree scoring is byte-exact over the complete workspace: only regular files are hashed, and any missing, extra, or changed file fails the arm.

| Arm | Attempts | Completed | Exact / completed | Median wall | Mean tools | Mean edit bytes | Tokens (sum) | Tool errors |
|-----|----------|-----------|-------------------|-------------|------------|-----------------|--------------|-------------|
| better | 1 | 1 | 0/1 | 3.6 s | 2 | 223 B | 6398 | 0 |
| builtin | 1 | 1 | 0/1 | 4.5 s | 2 | 308 B | 4237 | 0 |

## large-delete

Tree scoring is byte-exact over the complete workspace: only regular files are hashed, and any missing, extra, or changed file fails the arm.

| Arm | Attempts | Completed | Exact / completed | Median wall | Mean tools | Mean edit bytes | Tokens (sum) | Tool errors |
|-----|----------|-----------|-------------------|-------------|------------|-----------------|--------------|-------------|
| better | 1 | 1 | 1/1 | 7.3 s | 6 | 312 B | 49415 | 2 |
| builtin | 1 | 1 | 1/1 | 69.2 s | 4 | 20.2 KiB | 26433 | 0 |

## long-doc-repeated-edits

Tree scoring is byte-exact over the complete workspace: only regular files are hashed, and any missing, extra, or changed file fails the arm.

| Arm | Attempts | Completed | Exact / completed | Median wall | Mean tools | Mean edit bytes | Tokens (sum) | Tool errors |
|-----|----------|-----------|-------------------|-------------|------------|-----------------|--------------|-------------|
| better | 1 | 1 | 1/1 | 11.0 s | 7 | 979 B | 25768 | 3 |
| builtin | 1 | 1 | 1/1 | 5.4 s | 4 | 331 B | 9594 | 0 |

## multi-file-rotation

Tree scoring is byte-exact over the complete workspace: only regular files are hashed, and any missing, extra, or changed file fails the arm.

| Arm | Attempts | Completed | Exact / completed | Median wall | Mean tools | Mean edit bytes | Tokens (sum) | Tool errors |
|-----|----------|-----------|-------------------|-------------|------------|-----------------|--------------|-------------|
| better | 1 | 1 | 1/1 | 5.7 s | 4 | 408 B | 6478 | 0 |
| builtin | 1 | 1 | 1/1 | 3.6 s | 6 | 305 B | 4151 | 0 |

## no-trailing-newline-append

Tree scoring is byte-exact over the complete workspace: only regular files are hashed, and any missing, extra, or changed file fails the arm.

| Arm | Attempts | Completed | Exact / completed | Median wall | Mean tools | Mean edit bytes | Tokens (sum) | Tool errors |
|-----|----------|-----------|-------------------|-------------|------------|-----------------|--------------|-------------|
| better | 1 | 1 | 1/1 | 2.8 s | 2 | 139 B | 5959 | 0 |
| builtin | 1 | 1 | 1/1 | 3.0 s | 2 | 119 B | 3853 | 0 |

## ranged-read-tail

Tree scoring is byte-exact over the complete workspace: only regular files are hashed, and any missing, extra, or changed file fails the arm.

| Arm | Attempts | Completed | Exact / completed | Median wall | Mean tools | Mean edit bytes | Tokens (sum) | Tool errors |
|-----|----------|-----------|-------------------|-------------|------------|-----------------|--------------|-------------|
| better | 1 | 1 | 1/1 | 6.4 s | 3 | 145 B | 65230 | 0 |
| builtin | 1 | 1 | 1/1 | 6.0 s | 3 | 106 B | 69669 | 0 |

## repeated-context

Tree scoring is byte-exact over the complete workspace: only regular files are hashed, and any missing, extra, or changed file fails the arm.

| Arm | Attempts | Completed | Exact / completed | Median wall | Mean tools | Mean edit bytes | Tokens (sum) | Tool errors |
|-----|----------|-----------|-------------------|-------------|------------|-----------------|--------------|-------------|
| better | 1 | 1 | 1/1 | 3.7 s | 3 | 297 B | 8356 | 1 |
| builtin | 1 | 1 | 1/1 | 3.1 s | 2 | 167 B | 4049 | 0 |

## repeated-region-edits

Tree scoring is byte-exact over the complete workspace: only regular files are hashed, and any missing, extra, or changed file fails the arm.

| Arm | Attempts | Completed | Exact / completed | Median wall | Mean tools | Mean edit bytes | Tokens (sum) | Tool errors |
|-----|----------|-----------|-------------------|-------------|------------|-----------------|--------------|-------------|
| better | 1 | 1 | 0/1 | 8.0 s | 6 | 981 B | 16947 | 2 |
| builtin | 1 | 1 | 0/1 | 5.0 s | 4 | 538 B | 7342 | 0 |

## semantic-locate

Tree scoring is byte-exact over the complete workspace: only regular files are hashed, and any missing, extra, or changed file fails the arm.

| Arm | Attempts | Completed | Exact / completed | Median wall | Mean tools | Mean edit bytes | Tokens (sum) | Tool errors |
|-----|----------|-----------|-------------------|-------------|------------|-----------------|--------------|-------------|
| better | 1 | 1 | 1/1 | 3.1 s | 2 | 266 B | 6275 | 0 |
| builtin | 1 | 1 | 1/1 | 3.1 s | 2 | 283 B | 4076 | 0 |

## two-files

Tree scoring is byte-exact over the complete workspace: only regular files are hashed, and any missing, extra, or changed file fails the arm.

| Arm | Attempts | Completed | Exact / completed | Median wall | Mean tools | Mean edit bytes | Tokens (sum) | Tool errors |
|-----|----------|-----------|-------------------|-------------|------------|-----------------|--------------|-------------|
| better | 1 | 1 | 1/1 | 4.4 s | 3 | 287 B | 6211 | 0 |
| builtin | 1 | 1 | 1/1 | 3.8 s | 4 | 198 B | 4020 | 0 |

## two-splices

Tree scoring is byte-exact over the complete workspace: only regular files are hashed, and any missing, extra, or changed file fails the arm.

| Arm | Attempts | Completed | Exact / completed | Median wall | Mean tools | Mean edit bytes | Tokens (sum) | Tool errors |
|-----|----------|-----------|-------------------|-------------|------------|-----------------|--------------|-------------|
| better | 1 | 1 | 1/1 | 7.3 s | 4 | 614 B | 11697 | 1 |
| builtin | 1 | 1 | 1/1 | 3.0 s | 2 | 340 B | 3992 | 0 |

## Failures and classifications

| Model | Fixture | Arm | Outcome | Tree | Notes |
|-------|---------|-----|---------|------|-------|
| open-weights/glm-5.3-flash | repeated-region-edits | better | completed | MISMATCH | completed; 1 tree file(s) differ |
| open-weights/glm-5.3-flash | repeated-region-edits | builtin | completed | MISMATCH | completed; 1 tree file(s) differ |
| open-weights/glm-5.3-flash | blank-heavy-repeats | better | completed | MISMATCH | completed; 1 tree file(s) differ |
| open-weights/glm-5.3-flash | blank-heavy-repeats | builtin | completed | MISMATCH | completed; 1 tree file(s) differ |
| open-weights/glm-5.3-flash | append-eof-newline | builtin | completed | MISMATCH | completed; 1 tree file(s) differ |

Outcome codes: `completed` agent finished; `timeout` killed after per-arm timeout; `tool-call-limit` killed at the max-calls cap; `output-limit` killed after an oversized protocol line; `provider-error` provider retry failed (final attempt); `assistant-error` final assistant stop-reason error; `process-error` non-zero exit; `parse-error` unusable protocol stream; `no-agent-end` clean exit without agent_end.

Generated by the pi-better-read-edit bench harness (schema pi-better-read-edit-bench/v1).
