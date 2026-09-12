# 2026-09-12T07-23-33-742Z

A/B bench of the local **pi-better-read-edit** extension ("better") against Pi's built-in read/edit ("builtin") on exact fixture edits.

## Configuration

- Run: `2026-09-12T07-23-33-742Z` (created 2026-09-12T07:23:33.747Z)
- Models: `open-weights/glm-5.3-flash` (thinking low)
- Fixtures: two-splices, repeated-context, two-files, large-delete, long-doc-repeated-edits, semantic-locate, blank-heavy-repeats, append-eof-newline, ranged-read-tail, multi-file-rotation, repeated-region-edits, no-trailing-newline-append
- Trials per cell: 3 (seed 1)
- Per-arm timeout: 300.0 s, max tool calls: 200 (cap triggers at count >= max)
- Pi: `pi` 0.80.6
- Isolation: copied-config private `PI_CODING_AGENT_DIR` per arm; auth.json/models.json/models-store.json copied 0600, settings.json forced to betterReadEdit.avoidModels=[] — workspace in the system temp dir, no OS sandbox

> **Trust boundary:** this is not an OS sandbox. Models and their tools run as your user and may read or write beyond the scratch workspace. Benchmark only models you trust.

## Summary

Comparable completed pairs: **35 / 36**. Within those pairs, better was exact in **27/35** and builtin in **30/35**.
All attempted arms: 58/72 tree-exact; outcomes: completed 71, timeout 1.

### Comparable results by model

| Model | Pairs | Better exact | Builtin exact | Better median | Builtin median | Better tokens | Builtin tokens |
|-------|-------|--------------|---------------|---------------|----------------|---------------|----------------|
| open-weights/glm-5.3-flash | 35 | 27/35 | 30/35 | 5.9 s | 4.3 s | 933925 | 447247 |

## append-eof-newline

Tree scoring is byte-exact over the complete workspace: only regular files are hashed, and any missing, extra, or changed file fails the arm.

| Arm | Attempts | Completed | Exact / completed | Median wall | Mean tools | Mean edit bytes | Tokens (sum) | Tool errors |
|-----|----------|-----------|-------------------|-------------|------------|-----------------|--------------|-------------|
| better | 3 | 3 | 2/3 | 3.9 s | 2 | 191.3 B | 20909 | 0 |
| builtin | 3 | 3 | 1/3 | 3.5 s | 2 | 146.7 B | 12324 | 0 |

## blank-heavy-repeats

Tree scoring is byte-exact over the complete workspace: only regular files are hashed, and any missing, extra, or changed file fails the arm.

| Arm | Attempts | Completed | Exact / completed | Median wall | Mean tools | Mean edit bytes | Tokens (sum) | Tool errors |
|-----|----------|-----------|-------------------|-------------|------------|-----------------|--------------|-------------|
| better | 3 | 2 | 1/2 | 31.5 s | 10.5 | 2.8 KiB | 88793 | 9 |
| builtin | 3 | 3 | 3/3 | 5.8 s | 3 | 397.3 B | 18536 | 1 |

## large-delete

Tree scoring is byte-exact over the complete workspace: only regular files are hashed, and any missing, extra, or changed file fails the arm.

| Arm | Attempts | Completed | Exact / completed | Median wall | Mean tools | Mean edit bytes | Tokens (sum) | Tool errors |
|-----|----------|-----------|-------------------|-------------|------------|-----------------|--------------|-------------|
| better | 3 | 3 | 3/3 | 10.7 s | 6.7 | 351.3 B | 323815 | 7 |
| builtin | 3 | 3 | 3/3 | 66.4 s | 4.7 | 20.2 KiB | 96842 | 1 |

## long-doc-repeated-edits

Tree scoring is byte-exact over the complete workspace: only regular files are hashed, and any missing, extra, or changed file fails the arm.

| Arm | Attempts | Completed | Exact / completed | Median wall | Mean tools | Mean edit bytes | Tokens (sum) | Tool errors |
|-----|----------|-----------|-------------------|-------------|------------|-----------------|--------------|-------------|
| better | 3 | 3 | 3/3 | 8.6 s | 5.7 | 775.7 B | 66034 | 5 |
| builtin | 3 | 3 | 3/3 | 5.1 s | 4 | 333.7 B | 28839 | 0 |

## multi-file-rotation

Tree scoring is byte-exact over the complete workspace: only regular files are hashed, and any missing, extra, or changed file fails the arm.

| Arm | Attempts | Completed | Exact / completed | Median wall | Mean tools | Mean edit bytes | Tokens (sum) | Tool errors |
|-----|----------|-----------|-------------------|-------------|------------|-----------------|--------------|-------------|
| better | 3 | 3 | 3/3 | 4.1 s | 4 | 408 B | 21430 | 0 |
| builtin | 3 | 3 | 3/3 | 4.0 s | 6 | 305 B | 12488 | 0 |

## no-trailing-newline-append

Tree scoring is byte-exact over the complete workspace: only regular files are hashed, and any missing, extra, or changed file fails the arm.

| Arm | Attempts | Completed | Exact / completed | Median wall | Mean tools | Mean edit bytes | Tokens (sum) | Tool errors |
|-----|----------|-----------|-------------------|-------------|------------|-----------------|--------------|-------------|
| better | 3 | 3 | 3/3 | 2.9 s | 2 | 139 B | 19836 | 0 |
| builtin | 3 | 3 | 3/3 | 3.5 s | 3 | 148.7 B | 16042 | 0 |

## ranged-read-tail

Tree scoring is byte-exact over the complete workspace: only regular files are hashed, and any missing, extra, or changed file fails the arm.

| Arm | Attempts | Completed | Exact / completed | Median wall | Mean tools | Mean edit bytes | Tokens (sum) | Tool errors |
|-----|----------|-----------|-------------------|-------------|------------|-----------------|--------------|-------------|
| better | 3 | 3 | 3/3 | 6.2 s | 3 | 169 B | 207810 | 0 |
| builtin | 3 | 3 | 3/3 | 5.5 s | 3 | 106 B | 194754 | 0 |

## repeated-context

Tree scoring is byte-exact over the complete workspace: only regular files are hashed, and any missing, extra, or changed file fails the arm.

| Arm | Attempts | Completed | Exact / completed | Median wall | Mean tools | Mean edit bytes | Tokens (sum) | Tool errors |
|-----|----------|-----------|-------------------|-------------|------------|-----------------|--------------|-------------|
| better | 3 | 3 | 0/3 | 3.9 s | 3.3 | 379.7 B | 32800 | 4 |
| builtin | 3 | 3 | 3/3 | 5.1 s | 2.3 | 166.3 B | 13915 | 0 |

## repeated-region-edits

Tree scoring is byte-exact over the complete workspace: only regular files are hashed, and any missing, extra, or changed file fails the arm.

| Arm | Attempts | Completed | Exact / completed | Median wall | Mean tools | Mean edit bytes | Tokens (sum) | Tool errors |
|-----|----------|-----------|-------------------|-------------|------------|-----------------|--------------|-------------|
| better | 3 | 3 | 0/3 | 9.6 s | 6.3 | 1.1 KiB | 59628 | 7 |
| builtin | 3 | 3 | 0/3 | 5.6 s | 4.3 | 486.3 B | 23435 | 0 |

## semantic-locate

Tree scoring is byte-exact over the complete workspace: only regular files are hashed, and any missing, extra, or changed file fails the arm.

| Arm | Attempts | Completed | Exact / completed | Median wall | Mean tools | Mean edit bytes | Tokens (sum) | Tool errors |
|-----|----------|-----------|-------------------|-------------|------------|-----------------|--------------|-------------|
| better | 3 | 3 | 3/3 | 3.5 s | 2.3 | 369 B | 23387 | 1 |
| builtin | 3 | 3 | 3/3 | 2.9 s | 2 | 283 B | 12136 | 0 |

## two-files

Tree scoring is byte-exact over the complete workspace: only regular files are hashed, and any missing, extra, or changed file fails the arm.

| Arm | Attempts | Completed | Exact / completed | Median wall | Mean tools | Mean edit bytes | Tokens (sum) | Tool errors |
|-----|----------|-----------|-------------------|-------------|------------|-----------------|--------------|-------------|
| better | 3 | 3 | 3/3 | 4.1 s | 3 | 287 B | 20722 | 0 |
| builtin | 3 | 3 | 3/3 | 4.2 s | 4 | 182 B | 12036 | 0 |

## two-splices

Tree scoring is byte-exact over the complete workspace: only regular files are hashed, and any missing, extra, or changed file fails the arm.

| Arm | Attempts | Completed | Exact / completed | Median wall | Mean tools | Mean edit bytes | Tokens (sum) | Tool errors |
|-----|----------|-----------|-------------------|-------------|------------|-----------------|--------------|-------------|
| better | 3 | 3 | 3/3 | 7.0 s | 5 | 1.2 KiB | 48761 | 6 |
| builtin | 3 | 3 | 3/3 | 3.7 s | 2 | 340 B | 11989 | 0 |

## Failures and classifications

| Model | Fixture | Arm | Outcome | Tree | Notes |
|-------|---------|-----|---------|------|-------|
| open-weights/glm-5.3-flash | blank-heavy-repeats | better | completed | MISMATCH | completed; 1 tree file(s) differ |
| open-weights/glm-5.3-flash | repeated-region-edits | builtin | completed | MISMATCH | completed; 1 tree file(s) differ |
| open-weights/glm-5.3-flash | repeated-region-edits | better | completed | MISMATCH | completed; 1 tree file(s) differ |
| open-weights/glm-5.3-flash | repeated-context | better | completed | MISMATCH | completed; 1 tree file(s) differ |
| open-weights/glm-5.3-flash | append-eof-newline | builtin | completed | MISMATCH | completed; 1 tree file(s) differ |
| open-weights/glm-5.3-flash | append-eof-newline | better | completed | MISMATCH | completed; 1 tree file(s) differ |
| open-weights/glm-5.3-flash | repeated-context | better | completed | MISMATCH | completed; 1 tree file(s) differ |
| open-weights/glm-5.3-flash | repeated-context | better | completed | MISMATCH | completed; 1 tree file(s) differ |
| open-weights/glm-5.3-flash | blank-heavy-repeats | better | timeout | MISMATCH | timeout; 1 tree file(s) differ |
| open-weights/glm-5.3-flash | repeated-region-edits | better | completed | MISMATCH | completed; 1 tree file(s) differ |
| open-weights/glm-5.3-flash | repeated-region-edits | builtin | completed | MISMATCH | completed; 1 tree file(s) differ |
| open-weights/glm-5.3-flash | repeated-region-edits | better | completed | MISMATCH | completed; 1 tree file(s) differ |
| open-weights/glm-5.3-flash | repeated-region-edits | builtin | completed | MISMATCH | completed; 1 tree file(s) differ |
| open-weights/glm-5.3-flash | append-eof-newline | builtin | completed | MISMATCH | completed; 1 tree file(s) differ |

Outcome codes: `completed` agent finished; `timeout` killed after per-arm timeout; `tool-call-limit` killed at the max-calls cap; `output-limit` killed after an oversized protocol line; `provider-error` provider retry failed (final attempt); `assistant-error` final assistant stop-reason error; `process-error` non-zero exit; `parse-error` unusable protocol stream; `no-agent-end` clean exit without agent_end.

Generated by the pi-better-read-edit bench harness (schema pi-better-read-edit-bench/v1).
