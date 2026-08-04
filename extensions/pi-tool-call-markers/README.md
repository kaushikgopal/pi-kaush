# @pi-kaush/pi-tool-call-markers

Collapse Pi's adjacent successful tool calls into one compact, gear-headed block per tool type, so a run of similar calls reads as a tidy bulleted list instead of a wall of repeated headers and results.

## What it changes

When several tool calls of the same type succeed in a row, Pi normally renders each one as its own expanded block. This extension groups them:

- **One gear header per contiguous tool type.** A run of `read` calls shares a single `⚙️ read` header; the following `write` run gets its own `⚙️ write` header.
- **Bulleted call summaries.** Each call in a group becomes one bullet with a short summary and, for common tools, a compact outcome such as `→ done`, `→ 42 lines`, or `→ +2/-1`.
- **Vertical spacing between tool types.** A blank line separates one tool group from the next.
- **One-line, width-safe summaries.** Long targets truncate before their useful outcome tail instead of wrapping into taller blocks.
- **Tool batches settle before grouping.** A tool batch stays ungrouped while any sibling call is active. Earlier groups remain stable while a later batch runs, then visually adjacent settled calls merge across assistant turns that rendered no prose.
- **Self-rendered tools keep their shell.** Tools that own their framing keep singleton previews intact. Grouped summaries use only their stable header instead of scraping preview or diff lines.
- **Partial and image results stay visible.** Streaming progress and image-bearing results are not collapsed into text-only groups.
- **Errors stay compact and visibly failed.** A failed call keeps its own error-colored block and native collapsed detail until expanded.
- **Ctrl+O restores full blocks.** Expanding tools (`setToolsExpanded(true)`) brings back Pi's individual full blocks, including complete error details and successful results.

## Bundled thinking-block extension

The package ships a second extension entrypoint, `src/thinking-block-merger.ts`. Pi loads it independently from the tool presentation extension, so its `AssistantMessageComponent` patch and shutdown lifecycle stay isolated while install, update, and removal remain one package operation.

It combines only directly adjacent `thinking` blocks for display. Tool calls, text, and other content remain boundaries; provider blocks and signatures are not modified.

## Install

After the first npm release:

```bash
pi install npm:@pi-kaush/pi-tool-call-markers@0.1.0
```

For local development:

```bash
pi \
  -e ./extensions/pi-tool-call-markers/src/index.ts \
  -e ./extensions/pi-tool-call-markers/src/thinking-block-merger.ts
```

## Compatibility and risk

The tool presentation entrypoint currently relies on **guarded, reversible prototype patches** against two Pi component classes:

- `ToolExecutionComponent` (render + display presentation),
- `Container` (transcript grouping).

The bundled thinking-block entrypoint separately patches `AssistantMessageComponent.updateContent`. Its patch and lifecycle do not share state with tool presentation.

Pi exposes no public transcript or tool-grouping hook today, so the extension patches those prototypes and restores the originals on `session_shutdown`. Every patch is wrapped in `try`/`catch` with an idempotency guard (`Symbol.for(...)` markers), so if Pi's internals change the extension silently no-ops and Pi's default rendering is preserved.

**Compatible Pi version:** `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` `>=0.80.6`. Because the patches touch internal prototype methods, a future Pi release that renames or restructures those methods can silently disable the affected presentation until this package is updated. All original methods are restored on shutdown.

> TODO: migrate to a public Pi tool/transcript rendering API when one becomes available, and remove the prototype patches.

## Design

- No runtime dependencies.
- Startup only registers `session_start` / `session_shutdown` handlers and installs the reversible patches; no I/O, subprocesses, model requests, or timers.
- Grouped output is cached per row and invalidated when any member's display version changes, so repeated renders reuse work while stale groups refresh on demand.
- Removing the package restores Pi's default rendering on the next session.

## Development

From the repository root:

```bash
npm ci --ignore-scripts
npm run check
```

Inspect the publish payload:

```bash
npm pack --workspace @pi-kaush/pi-tool-call-markers --dry-run
```

## License

MIT
