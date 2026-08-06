# @pi-kaush/pi-welcome-screen

A compact, centered startup screen for the [Pi coding agent](https://pi.dev). It keeps Pi's loaded context, skills, prompts, and extensions visible while replacing the stock header with a responsive branded layout.

![Responsive Pi welcome screen in three-column, two-column, and stacked layouts](https://raw.githubusercontent.com/kaushikgopal/pi-kaush/main/extensions/pi-welcome-screen/assets/pi-welcome.webp)

## Why use it

- **Zero runtime dependencies** — installs as readable TypeScript without pulling additional packages into your Pi setup.
- **Context files in load order** — shows exactly which instructions Pi loaded and the order in which they apply.
- **Extensions grouped by source** — separates Pi-local extensions, installed packages, and linked source paths.
- **Responsive layout** — adapts from a stacked view to a full-width brand over two resource columns, then a compact brand rail beside asymmetric resource columns that give long extension paths more room.
- **Fail-safe behavior** — if the startup data or UI shape is unfamiliar, restores Pi's untouched native resource panel instead of hiding information.

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

The extension installs its header through Pi's public `ctx.ui.setHeader()` API. Pi 0.84 does not expose structured startup-resource data, so the extension also uses a narrowly guarded bridge to inspect Pi's native startup-resource panel.

The bridge checks only Pi's documented-era startup positions: the legacy root panel and Pi 0.84's resource panel inside the stable document container. It never recursively traverses or renders the transcript, editor, layout stacks, or fullscreen scroll view. Once a complete snapshot is available, it clears the resource panel through the public `Container` API while leaving that container mounted in Pi's scroll document. If Pi changes the panel, exposes an unknown section, or produces incomplete resource data, the extension leaves Pi's native panel untouched rather than hiding information. The current release is tested against Pi 0.80.6 and 0.84.0.

Like any custom-header extension, it shares Pi's single header slot. If another extension also calls `setHeader()`, the last installed header wins; neither extension needs to replace the editor or intercept terminal input.

## Security and performance

The package contains readable TypeScript and has:

- no runtime dependencies or install scripts;
- no network, subprocess, clipboard, prompt, tool, model, or telemetry access;
- no background work after the startup resource snapshot completes.

At startup it reads only the names of entries in Pi's local extension directory and the text already rendered in Pi's startup-resource panel so extensions can be grouped by provenance. Resource capture uses at most three short 50 ms retries. The native panel container remains mounted throughout capture so Pi retains ownership of fullscreen transcript layout and scrolling.

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
