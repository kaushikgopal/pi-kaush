# @pi-kaush/pi-welcome-screen

A compact, centered startup screen for the [Pi coding agent](https://pi.dev). It keeps Pi's loaded context, skills, prompts, and extensions visible while replacing the stock header with a responsive branded layout.

![Responsive Pi welcome screen in three-column, two-column, and stacked layouts](https://raw.githubusercontent.com/kaushikgopal/pi-kaush/main/extensions/pi-welcome-screen/assets/pi-welcome.webp)

## Why use it

- **Zero runtime dependencies** — installs as readable TypeScript without pulling additional packages into your Pi setup.
- **Context files in load order** — shows exactly which instructions Pi loaded and the order in which they apply.
- **Extensions grouped by source** — separates Pi-local extensions, installed packages, and linked source paths.
- **Responsive layout** — adapts from a stacked view to asymmetric resource columns, then splits long package lists again on very wide terminals.
- **Useful optional metadata** — shows compact resource counts and an honest system-prompt estimate, with opt-in workspace details and configuration health warnings only when needed.
- **Fail-safe behavior** — preserves unfamiliar startup components and falls back to Pi's untouched native resource panel when the known resource snapshot is incomplete.

## Install

```sh
pi install npm:@pi-kaush/pi-welcome-screen@0.1.3
```

Restart Pi or run `/reload`.

## Configuration

Configure the extension in Pi's canonical global `~/.pi/agent/settings.json` or trusted project `.pi/settings.json`. Project fields override matching global fields; defaults remain in the extension, so no additional configuration file is created.

```json
{
  "welcomeScreen": {
    "showCounts": true,
    "showWorkspace": false,
    "showEstimate": true,
    "showHealth": true,
    "skillGateOnlyActive": false,
    "sourcePathDisplay": "full",
    "splitExtensionsAt": 180
  }
}
```

- `showCounts` adds compact context, skill, prompt, and extension counts below the Pi version.
- `showWorkspace` adds the repository or directory name, relative working directory, and session start reason.
- `showEstimate` adds the current model, context-window size, a local system-prompt estimate, and the active tool count. It uses measured Claude-family character ratios where they materially differ and an explicit characters-divided-by-four fallback elsewhere. Tool schemas are excluded because providers reshape them differently on the wire.
- `showHealth` displays invalid `welcomeScreen` settings. Empty health information is omitted.
- `skillGateOnlyActive` integrates with [pi-skill-gate](https://github.com/cullendotdev/pi-skill-gate). When enabled, the Skills section and its count include only skills whose effective global or exact-project state is `"enabled"` in `~/.pi/agent/config/skill-gate.json`. Missing or malformed skill-gate state means no skills are active, matching skill-gate's disabled-by-default behavior; malformed configuration is also reported under Health.
- `sourcePathDisplay` controls linked extension labels. Use `"compact"` to show the owning extension or package directory instead of the full path; ambiguous duplicate labels fall back to full paths. The default is `"full"`.
- `splitExtensionsAt` is the terminal width at which package extensions and compact source paths join the local extensions' responsive column layout. All participating extension groups use the same two- or three-column count. Set it to `false` to keep non-local groups in one column.

Only trusted project settings are read. Invalid fields are ignored individually, and valid global or default values remain active.

## Run from a local clone

From any project, point Pi at the extension's source file:

```sh
pi -e ~/path/to/pi-kaush/extensions/pi-welcome-screen/src/index.ts
```

Use `--no-extensions` before `-e` to test it without your other configured extensions.

## Compatibility

The extension installs its header through Pi's public `ctx.ui.setHeader()` API. Pi 0.84 does not expose structured startup-resource data, so the extension also uses a narrowly guarded bridge to inspect Pi's native startup-resource panel.

The bridge checks only Pi's documented-era startup positions: the legacy root panel and Pi 0.84's resource panel inside the stable document container. It never recursively traverses or renders the transcript, editor, layout stacks, or fullscreen scroll view. Once a complete snapshot is available, it removes only the known resource and theme children through the public `Container` API while leaving that container mounted in Pi's scroll document. Unknown status, diagnostic, and third-party children are never detached or re-added, so self-healing extensions cannot duplicate their startup blocks. If the known resource data is incomplete, the extension leaves Pi's native panel untouched rather than hiding information. The current release is tested against Pi 0.80.6 and 0.84.0.

Like any custom-header extension, it shares Pi's single header slot. If another extension also calls `setHeader()`, the last installed header wins; neither extension needs to replace the editor or intercept terminal input.

## Security and performance

The package contains readable TypeScript and has:

- no runtime dependencies or install scripts;
- no network, subprocess, clipboard, tool execution, or telemetry access;
- no background work after the startup resource snapshot completes.

At startup it reads Pi's global settings, trusted project settings, the names of entries in Pi's local extension directory, and the text already rendered in Pi's startup-resource panel. For the estimate it reads the current in-memory system-prompt length, model metadata, and active tool names through public Pi APIs; prompt contents and tool schemas are not rendered or persisted. When workspace details are enabled, it also walks parent directory names until it finds the workspace's `.git` entry; it does not inspect repository contents or run Git. Resource capture uses at most three short 50 ms retries. The native panel container remains mounted throughout capture so Pi retains ownership of fullscreen transcript layout and scrolling.

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
