# @pi-kaush/pi-tool-call-markers

Give Pi's collapsed tool calls a quiet, width-safe transcript shell while preserving native details under `Ctrl+O`. The package also includes a display-only thinking-block adapter.

## What it changes

Collapsed tool rows use semantic theme colors with no gear, background fill, box padding, or filled blank rows:

```text
  % Read
    • src/a.ts                         42 lines
    • src/b.ts                         18 lines
```

- **Two-column outer inset.** Tool markers and image output align with an inset conversation surface. Very narrow terminals reduce the decoration before useful content.
- **`%` tool headings.** A singleton stays on one line when its summary and outcome fit. A multi-call group has one `%` heading per contiguous tool type.
- **`•` grouped children.** Bullets appear only for members of a multi-call group.
- **Semantic, low-contrast status.** Tool names are emphasized, summaries are muted, settled metadata is dim, pending state is warning-colored, and failures remain error-colored. Ordinary tool states have no background.
- **Width-safe outcome tails.** Long summaries truncate before useful tails such as `→ done`, `→ 42 lines`, `→ +2/-1`, or a `bash` duration.
- **Stable running groups.** Adjacent calls group as they appear. Pending state and elapsed `bash` time settle into the final outcome without changing the row count.
- **Quiet-turn grouping.** Sequential calls can join across an assistant row with no visible prose or thinking. Visible assistant content remains a boundary.
- **MCP and self-rendered tools.** Their stable call labels, compact arguments, pending state, success, and first error line use the same collapsed shell. Native self-rendered details return when expanded.
- **Images remain visible.** Image fallback text and terminal image components render below the corresponding marker with the same inset.
- **Native expansion remains authoritative.** `Ctrl+O` restores Pi's full individual tool rendering, including complete results, custom renderers, and error details.

## Subagent cards

A recognized ungrouped `subagent` call renders as a two-line accent-rail card:

```text
  ▌ Red Team Task — Challenge the compatibility conclusion
  ▌ Ctrl+O view subagents
```

Single, parallel, and chain argument shapes receive deterministic humanized titles and the first useful task sentence. The configured `app.tools.expand` keybinding is rendered through Pi's themed key hint. Subagents never join ordinary tool groups.

Malformed, ambiguous, future, or too-narrow shapes fall back to the generic `% subagent …` row rather than dropping information. Failed cards keep a compact error tail, and `Ctrl+O` still exposes the native subagent renderer.

## Bundled thinking-block extension

The second package entrypoint, `src/thinking-block-merger.ts`, combines only directly adjacent `thinking` blocks in a display copy. Tool calls, text, provider blocks, signatures, and stored session messages are unchanged.

When Pi exposes its per-row hidden-thinking and streaming fields, hidden reasoning uses these native-themed labels:

```text
⠋ Thinking…  →  ⠙ Thinking…  →  …
+ Thought · 2.5s
```

The live label samples Pi's native braille spinner sequence from the content updates Pi already renders; it does not add a timer. The adapter stores the first local streaming timestamp per assistant row in a `WeakMap`. A restored message or an older runtime with no streaming argument uses `+ Thought`. Visible-thinking mode remains native. There is no interval, timeout, render request, model call, or network work.

## Install

```bash
pi install npm:@pi-kaush/pi-tool-call-markers
```

For local development:

```bash
pi \
  -e ./extensions/pi-tool-call-markers/src/index.ts \
  -e ./extensions/pi-tool-call-markers/src/thinking-block-merger.ts
```

## Configuration

Grouping calls from the same assistant message is enabled by default. Pi normally executes those calls in parallel. To keep same-message calls as individual compact rows while continuing to group sequential calls across quiet turns:

```fish
set -lx PI_TOOL_CALL_MARKERS_COLLAPSE_PARALLEL 0
pi
```

`0`, `false`, `no`, and `off` disable parallel grouping. `1`, `true`, `yes`, and `on` enable it. The value is read when the extension loads.

## Compatibility and fallback policy

**Compatible Pi version:** `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` `>=0.80.6`.

Pi has no public hook for native tool rows, transcript grouping, or per-message hidden-thinking labels. The package therefore uses three small guarded prototype adapters:

- `ToolExecutionComponent` for collapsed presentation;
- `Container` for adjacent grouping; and
- `AssistantMessageComponent.updateContent` for display-only thinking merging and lifecycle labels.

Each adapter feature-detects the fields and methods it needs, keeps the original method, uses an idempotency symbol, catches cosmetic failures, and restores the original on `session_shutdown` when it still owns the patch. Unsupported shapes fail open to Pi's native rendering. The thinking adapter continues adjacent merging even when the private label shape is unavailable.

Expanded tools always use Pi's native renderer. The collapsed tool shell owns its two-column inset directly; transcript layout extensions should leave tool rows unchanged, preventing load-order-dependent double padding.

> TODO: migrate these adapters to public Pi transcript and tool-rendering APIs when available.

## Design

- No runtime dependencies.
- No mutation of tool arguments, tool results, provider content, or session messages.
- Group output is cached per row and invalidated on meaningful display transitions.
- No timers or independent render loops.

## Development

From the repository root:

```bash
npx vitest run extensions/pi-tool-call-markers/test
npm run typecheck
npm run package:check --workspace @pi-kaush/pi-tool-call-markers
```

Inspect the publish payload:

```bash
npm pack --workspace @pi-kaush/pi-tool-call-markers --dry-run
```

## License

MIT
