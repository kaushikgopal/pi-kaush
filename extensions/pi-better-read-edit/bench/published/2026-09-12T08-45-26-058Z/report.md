# 2026-09-12T08-45-26-058Z

A/B bench of the local **pi-better-read-edit** extension ("better") against Pi's built-in read/edit ("builtin") on exact fixture edits.

## Configuration

- Run: `2026-09-12T08-45-26-058Z` (created 2026-09-12T08:45:26.061Z)
- Models: `open-weights/glm-5.3-flash` (thinking low)
- Fixtures: two-splices, repeated-context, two-files, large-delete, long-doc-repeated-edits, semantic-locate, blank-heavy-repeats, append-eof-newline, ranged-read-tail, multi-file-rotation, repeated-region-edits, no-trailing-newline-append
- Trials per cell: 3 (seed 1)
- Per-arm timeout: 300.0 s, max tool calls: 200 (cap triggers at count >= max)
- Pi: `pi` 0.80.6
- Isolation: copied-config private `PI_CODING_AGENT_DIR` per arm; auth.json/models.json/models-store.json copied 0600, settings.json forced to betterReadEdit.avoidModels=[] — workspace in the system temp dir, no OS sandbox

> **Trust boundary:** this is not an OS sandbox. Models and their tools run as your user and may read or write beyond the scratch workspace. Benchmark only models you trust.

## Summary

Comparable completed pairs: **36 / 36**. Within those pairs, better was exact in **28/36** and builtin in **27/36**.
All attempted arms: 55/72 tree-exact; outcomes: completed 72.

### Comparable results by model

| Model | Pairs | Better exact | Builtin exact | Better median | Builtin median | Better tokens | Builtin tokens |
|-------|-------|--------------|---------------|---------------|----------------|---------------|----------------|
| open-weights/glm-5.3-flash | 36 | 28/36 | 27/36 | 5.5 s | 4.2 s | 966057 | 555462 |

## append-eof-newline

Tree scoring is byte-exact over the complete workspace: only regular files are hashed, and any missing, extra, or changed file fails the arm.

| Arm | Attempts | Completed | Exact / completed | Median wall | Mean tools | Mean edit bytes | Tokens (sum) | Tool errors |
|-----|----------|-----------|-------------------|-------------|------------|-----------------|--------------|-------------|
| better | 3 | 3 | 2/3 | 12.4 s | 8 | 1.0 KiB | 81162 | 10 |
| builtin | 3 | 3 | 1/3 | 3.5 s | 2.3 | 146.7 B | 13645 | 0 |

## blank-heavy-repeats

Tree scoring is byte-exact over the complete workspace: only regular files are hashed, and any missing, extra, or changed file fails the arm.

| Arm | Attempts | Completed | Exact / completed | Median wall | Mean tools | Mean edit bytes | Tokens (sum) | Tool errors |
|-----|----------|-----------|-------------------|-------------|------------|-----------------|--------------|-------------|
| better | 3 | 3 | 1/3 | 4.1 s | 2 | 295 B | 21736 | 0 |
| builtin | 3 | 3 | 2/3 | 4.0 s | 2 | 342.7 B | 13207 | 0 |

## large-delete

Tree scoring is byte-exact over the complete workspace: only regular files are hashed, and any missing, extra, or changed file fails the arm.

| Arm | Attempts | Completed | Exact / completed | Median wall | Mean tools | Mean edit bytes | Tokens (sum) | Tool errors |
|-----|----------|-----------|-------------------|-------------|------------|-----------------|--------------|-------------|
| better | 3 | 3 | 3/3 | 8.6 s | 4 | 174 B | 186457 | 2 |
| builtin | 3 | 3 | 3/3 | 68.1 s | 4.3 | 20.2 KiB | 170608 | 0 |

## long-doc-repeated-edits

Tree scoring is byte-exact over the complete workspace: only regular files are hashed, and any missing, extra, or changed file fails the arm.

| Arm | Attempts | Completed | Exact / completed | Median wall | Mean tools | Mean edit bytes | Tokens (sum) | Tool errors |
|-----|----------|-----------|-------------------|-------------|------------|-----------------|--------------|-------------|
| better | 3 | 3 | 3/3 | 9.3 s | 5.3 | 676.7 B | 61864 | 4 |
| builtin | 3 | 3 | 3/3 | 11.3 s | 4 | 331 B | 28837 | 0 |

## multi-file-rotation

Tree scoring is byte-exact over the complete workspace: only regular files are hashed, and any missing, extra, or changed file fails the arm.

| Arm | Attempts | Completed | Exact / completed | Median wall | Mean tools | Mean edit bytes | Tokens (sum) | Tool errors |
|-----|----------|-----------|-------------------|-------------|------------|-----------------|--------------|-------------|
| better | 3 | 3 | 3/3 | 4.0 s | 4 | 408 B | 21477 | 0 |
| builtin | 3 | 3 | 3/3 | 3.8 s | 6 | 305 B | 12471 | 0 |

## no-trailing-newline-append

Tree scoring is byte-exact over the complete workspace: only regular files are hashed, and any missing, extra, or changed file fails the arm.

| Arm | Attempts | Completed | Exact / completed | Median wall | Mean tools | Mean edit bytes | Tokens (sum) | Tool errors |
|-----|----------|-----------|-------------------|-------------|------------|-----------------|--------------|-------------|
| better | 3 | 3 | 3/3 | 3.3 s | 6.7 | 738.7 B | 72841 | 5 |
| builtin | 3 | 3 | 0/3 | 4.2 s | 2.7 | 117 B | 14783 | 0 |

## ranged-read-tail

Tree scoring is byte-exact over the complete workspace: only regular files are hashed, and any missing, extra, or changed file fails the arm.

| Arm | Attempts | Completed | Exact / completed | Median wall | Mean tools | Mean edit bytes | Tokens (sum) | Tool errors |
|-----|----------|-----------|-------------------|-------------|------------|-----------------|--------------|-------------|
| better | 3 | 3 | 3/3 | 5.8 s | 3.7 | 298 B | 242335 | 2 |
| builtin | 3 | 3 | 3/3 | 5.8 s | 3.3 | 106 B | 224179 | 0 |

## repeated-context

Tree scoring is byte-exact over the complete workspace: only regular files are hashed, and any missing, extra, or changed file fails the arm.

| Arm | Attempts | Completed | Exact / completed | Median wall | Mean tools | Mean edit bytes | Tokens (sum) | Tool errors |
|-----|----------|-----------|-------------------|-------------|------------|-----------------|--------------|-------------|
| better | 3 | 3 | 2/3 | 4.8 s | 2.3 | 250.7 B | 23146 | 1 |
| builtin | 3 | 3 | 3/3 | 4.1 s | 2.3 | 209.3 B | 14020 | 1 |

## repeated-region-edits

Tree scoring is byte-exact over the complete workspace: only regular files are hashed, and any missing, extra, or changed file fails the arm.

| Arm | Attempts | Completed | Exact / completed | Median wall | Mean tools | Mean edit bytes | Tokens (sum) | Tool errors |
|-----|----------|-----------|-------------------|-------------|------------|-----------------|--------------|-------------|
| better | 3 | 3 | 0/3 | 6.9 s | 10.3 | 1.6 KiB | 146029 | 17 |
| builtin | 3 | 3 | 0/3 | 4.9 s | 5 | 571.7 B | 27495 | 0 |

## semantic-locate

Tree scoring is byte-exact over the complete workspace: only regular files are hashed, and any missing, extra, or changed file fails the arm.

| Arm | Attempts | Completed | Exact / completed | Median wall | Mean tools | Mean edit bytes | Tokens (sum) | Tool errors |
|-----|----------|-----------|-------------------|-------------|------------|-----------------|--------------|-------------|
| better | 3 | 3 | 3/3 | 3.1 s | 2 | 266 B | 20815 | 0 |
| builtin | 3 | 3 | 3/3 | 2.9 s | 2 | 283 B | 12169 | 0 |

## two-files

Tree scoring is byte-exact over the complete workspace: only regular files are hashed, and any missing, extra, or changed file fails the arm.

| Arm | Attempts | Completed | Exact / completed | Median wall | Mean tools | Mean edit bytes | Tokens (sum) | Tool errors |
|-----|----------|-----------|-------------------|-------------|------------|-----------------|--------------|-------------|
| better | 3 | 3 | 3/3 | 4.2 s | 3 | 287 B | 20726 | 0 |
| builtin | 3 | 3 | 3/3 | 3.8 s | 4 | 182 B | 12043 | 0 |

## two-splices

Tree scoring is byte-exact over the complete workspace: only regular files are hashed, and any missing, extra, or changed file fails the arm.

| Arm | Attempts | Completed | Exact / completed | Median wall | Mean tools | Mean edit bytes | Tokens (sum) | Tool errors |
|-----|----------|-----------|-------------------|-------------|------------|-----------------|--------------|-------------|
| better | 3 | 3 | 2/3 | 8.2 s | 6.7 | 1.0 KiB | 67469 | 5 |
| builtin | 3 | 3 | 3/3 | 3.5 s | 2 | 343.3 B | 12005 | 0 |

## Failures and classifications

| Model | Fixture | Arm | Outcome | Tree | Notes |
|-------|---------|-----|---------|------|-------|
| open-weights/glm-5.3-flash | blank-heavy-repeats | better | completed | MISMATCH | completed; 1 tree file(s) differ |
| open-weights/glm-5.3-flash | repeated-region-edits | builtin | completed | MISMATCH | completed; 1 tree file(s) differ |
| open-weights/glm-5.3-flash | repeated-region-edits | better | completed | MISMATCH | completed; 1 tree file(s) differ |
| open-weights/glm-5.3-flash | no-trailing-newline-append | builtin | completed | MISMATCH | completed; 1 tree file(s) differ |
| open-weights/glm-5.3-flash | no-trailing-newline-append | builtin | completed | MISMATCH | completed; 1 tree file(s) differ |
| open-weights/glm-5.3-flash | no-trailing-newline-append | builtin | completed | MISMATCH | completed; 1 tree file(s) differ |
| open-weights/glm-5.3-flash | append-eof-newline | builtin | completed | MISMATCH | completed; 1 tree file(s) differ |
| open-weights/glm-5.3-flash | repeated-context | better | completed | MISMATCH | completed; 1 tree file(s) differ |
| open-weights/glm-5.3-flash | blank-heavy-repeats | better | completed | MISMATCH | completed; 1 tree file(s) differ |
| open-weights/glm-5.3-flash | blank-heavy-repeats | builtin | completed | MISMATCH | completed; 1 tree file(s) differ |
| open-weights/glm-5.3-flash | repeated-region-edits | better | completed | MISMATCH | completed; 1 tree file(s) differ |
| open-weights/glm-5.3-flash | repeated-region-edits | builtin | completed | MISMATCH | completed; 1 tree file(s) differ |
| open-weights/glm-5.3-flash | repeated-region-edits | better | completed | MISMATCH | completed; 1 tree file(s) differ |
| open-weights/glm-5.3-flash | repeated-region-edits | builtin | completed | MISMATCH | completed; 1 tree file(s) differ |
| open-weights/glm-5.3-flash | two-splices | better | completed | MISMATCH | completed; 1 tree file(s) differ |
| open-weights/glm-5.3-flash | append-eof-newline | better | completed | MISMATCH | completed; 1 tree file(s) differ |
| open-weights/glm-5.3-flash | append-eof-newline | builtin | completed | MISMATCH | completed; 1 tree file(s) differ |

Outcome codes: `completed` agent finished; `timeout` killed after per-arm timeout; `tool-call-limit` killed at the max-calls cap; `output-limit` killed after an oversized protocol line; `provider-error` provider retry failed (final attempt); `assistant-error` final assistant stop-reason error; `process-error` non-zero exit; `parse-error` unusable protocol stream; `no-agent-end` clean exit without agent_end.

Generated by the pi-better-read-edit bench harness (schema pi-better-read-edit-bench/v1).
