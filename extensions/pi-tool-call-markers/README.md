# @pi-kaush/pi-tool-call-markers

Collapse Pi's adjacent successful tool calls into one compact, gear-headed block per tool type, so a run of similar calls reads as a tidy bulleted list instead of a wall of repeated headers and results.

## What it changes

When several tool calls of the same type succeed in a row, Pi normally renders each one as its own expanded block. This extension groups them:

- **One gear header per contiguous tool type.** A run of `read` calls shares a single `⚙️ read` header; the following `write` run gets its own `⚙️ write` header.
- **Bulleted call summaries.** Each call in a group becomes one bullet with a short summary (the tool name is stripped from the bullet since the header already names the tool).
- **Vertical spacing between tool types.** A blank line separates one tool group from the next.
- **Hanging indent for wrapped bullets.** When a summary wraps, continuation lines align under the bullet text rather than under the gear.
- **Boundaries stay separate.** Visible thinking or text, still-running (active) calls, and failed calls split groups, so they never get silently merged.
- **Errors expand in place.** A failed call keeps its own block and shows its full detail.
- **Ctrl+O restores full blocks.** Expanding tools (`setToolsExpanded(true)`) brings back Pi's individual full blocks, results and all.
- **Adjacent thinking blocks combine.** Only directly adjacent `thinking` blocks merge into one; a non-thinking block between them keeps them separate. Malformed thinking content safely falls back to Pi's renderer exactly once, so the display never breaks.

## Install

After the first npm release:

```bash
pi install npm:@pi-kaush/pi-tool-call-markers@0.1.0
```

For local development:

```bash
pi -e ./extensions/pi-tool-call-markers/src/index.ts
```

## Compatibility and risk

This extension currently relies on **guarded, reversible prototype patches** against a small number of Pi component classes:

- `ToolExecutionComponent` (render + display presentation),
- `Container` (transcript grouping), and
- `AssistantMessageComponent` (adjacent thinking merge).

Pi exposes no public transcript or tool-grouping hook today, so the extension patches those prototypes on `session_start` and restores the originals on `session_shutdown`. Every patch is wrapped in `try`/`catch` with an idempotency guard (`Symbol.for(...)` markers), so if Pi's internals change the extension silently no-ops and Pi's default rendering is preserved.

**Compatible Pi version:** `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` `>=0.80.6`. Because the patches touch internal prototype methods, a future Pi release that renames or restructures those methods can silently disable the grouping until this extension is updated. The extension never broadens the private-API footprint beyond the three classes above, and all original methods are restored on shutdown.

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
