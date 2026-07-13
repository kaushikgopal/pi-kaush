# @pi-kaush/pi-welcome-screen

A compact, centered startup screen for the [Pi coding agent](https://pi.dev). It keeps Pi's loaded context, skills, prompts, and extensions visible while replacing the stock header with a responsive branded layout.

![Pi welcome screen showing context, skills, prompts, and extensions](https://raw.githubusercontent.com/kaushikgopal/pi-kaush/main/extensions/pi-welcome-screen/assets/pi-welcome.webp)

## Features

- Responsive stacked and wide terminal layouts
- Pi version displayed beside a compact banner
- Loaded resources grouped into readable sections
- Extensions split into Pi-local, installed-package, and linked source-path groups
- Full linked source paths shown instead of ambiguous labels such as `src`
- Unknown startup diagnostics preserved through a fail-safe fallback

## Install

```sh
pi install npm:@pi-kaush/pi-welcome-screen@0.1.1
```

Restart Pi or run `/reload`.

## Run from a local clone

From any project, point Pi at the extension's source file:

```sh
pi -e ~/path/to/pi-kaush/extensions/pi-welcome-screen/src/index.ts
```

Use `--no-extensions` before `-e` to test it without your other configured extensions.

## Compatibility

The extension installs its header through Pi's public `ctx.ui.setHeader()` API. Pi 0.80.6 does not expose structured startup-resource data, so the extension also uses a narrowly guarded bridge to inspect and temporarily relocate Pi's native startup-resource panel.

Every expected component shape is checked before it is touched. If Pi changes the panel, exposes an unknown section, or produces incomplete resource data, the extension restores Pi's untouched native panel rather than hiding information. The initial release is tested against Pi 0.80.6.

Like any custom-header extension, it shares Pi's single header slot. If another extension also calls `setHeader()`, the last installed header wins; neither extension needs to replace the editor or intercept terminal input.

## Security and performance

The package contains readable TypeScript and has:

- no runtime dependencies or install scripts;
- no network, subprocess, clipboard, prompt, tool, model, or telemetry access;
- no background work after the startup resource snapshot completes.

At startup it reads only the names of entries in Pi's local extension directory and the text already rendered in Pi's startup-resource panel so extensions can be grouped by provenance. Resource capture uses at most three short 50 ms retries and is then disposed or replaced by Pi's native panel.

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
