# @pi-kaush/pi-welcome-screen

A compact, centered startup screen for the [Pi coding agent](https://pi.dev). It keeps Pi's loaded context, skills, prompts, and extensions visible while replacing the stock header with a responsive branded layout that leaves two columns inside each terminal edge whenever width permits.

![Responsive Pi welcome screen in three-column, two-column, and stacked layouts](https://raw.githubusercontent.com/kaushikgopal/pi-kaush/main/extensions/pi-welcome-screen/assets/pi-welcome.webp)

## Why use it

- **Zero runtime dependencies** — installs as readable TypeScript without pulling additional packages into your Pi setup.
- **Context files in load order** — shows exactly which instructions Pi loaded and the order in which they apply.
- **Extensions grouped by source** — separates Pi-local extensions, installed packages, and linked source paths.
- **Responsive layout** — adapts from a stacked view to a wide brand over two resource columns, then a dedicated brand beside two resource columns, while reserving two side-padding columns at normal widths and degrading that padding only on tiny terminals.
- **Fail-safe behavior** — waits for a complete resource snapshot, preserves diagnostics and third-party startup rows, and leaves incomplete native data untouched. When the layout itself is unrecognized, the header says so instead of degrading silently.
- **Extension health at a glance** — after load, checks installed package extensions against the npm registry and their store manifests: packages pinned behind the latest release (yellow), ranges that exclude the newer major (red), undeclared imports, and missing dependencies. A notification summarizes findings; offline and unreadable packages simply stay unannotated.

## Install

```sh
pi install npm:@pi-kaush/pi-welcome-screen@0.1.3
```

Restart Pi or run `/reload`.

## Run from a local clone

From any project, point Pi at the extension's source file:

```sh
pi -e ~/path/to/pi-kaush/extensions/pi-welcome-screen/src/index.ts
```

Use `--no-extensions` before `-e` to test it without your other configured extensions.

## Compatibility

The extension installs its header through Pi's public `ctx.ui.setHeader()` API. Pi does not expose structured startup-resource data, so the extension also uses a narrowly guarded bridge to inspect the native startup-resource panel.

The bridge recognizes the flat Pi 0.80–0.83 layout and the document-container layout introduced in Pi 0.84. It keeps Pi's document and resource panel mounted for regular and fullscreen rendering, then removes only the known context, skill, prompt, extension, and theme rows after a complete replacement snapshot is ready. Diagnostics, unknown sections, and third-party rows remain in place; incomplete snapshots remain entirely native. Tested against Pi 0.80.6 through 0.84.0.

Like any custom-header extension, it shares Pi's single header slot. If another extension also calls `setHeader()`, the last installed header wins; neither extension needs to replace the editor or intercept terminal input.

## Security and performance

The package contains readable TypeScript and has:

- no runtime dependencies or install scripts;
- no network, subprocess, clipboard, prompt, tool, model, or telemetry access;
- no background work after the short startup capture window completes.

At startup it reads only the names of entries in Pi's local extension directory and the text already rendered in Pi's startup-resource panel so extensions can be grouped by provenance. Resource capture uses at most three short 50 ms retries, including a brief reconciliation window for `/reload`.

## Development

From the repository root:

```sh
npm ci --ignore-scripts
npm run check
```

Inspect the exact publish payload:

```sh
npm pack --workspace @pi-kaush/pi-welcome-screen --dry-run
```

## License

MIT
