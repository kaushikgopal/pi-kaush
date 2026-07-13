# pi-kaush

Small, composable extensions for the [Pi coding agent](https://pi.dev).

## Packages

| Package                                                         | Description                                                                       |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| [`@pi-kaush/pi-double-paste`](./extensions/pi-double-paste)     | Paste the same large block twice to expand Pi's paste markers into editable text. |
| [`@pi-kaush/pi-welcome-screen`](./extensions/pi-welcome-screen) | Show a responsive startup header with Pi's loaded resources.                      |

Every package is independently versioned and published to npm. Runtime source is readable TypeScript, and packages avoid runtime dependencies where practical.

## Use an extension

### Install from npm (recommended)

Install an extension globally through Pi's package manager:

```sh
pi install npm:@pi-kaush/pi-double-paste
pi install npm:@pi-kaush/pi-welcome-screen
```

Restart Pi or run `/reload`. To pin a specific release, append its version, such as `@0.1.0`.

### Run from a local clone

Clone the repository:

```sh
git clone https://github.com/kaushikgopal/pi-kaush.git
cd pi-kaush
npm ci --ignore-scripts
npm run check
```

Then launch Pi from any project and point `-e` at the extension's entry file, replacing the example path with the location of your clone:

```sh
pi -e ~/path/to/pi-kaush/extensions/pi-double-paste/src/index.ts
pi -e ~/path/to/pi-kaush/extensions/pi-welcome-screen/src/index.ts
```

Run one command for the extension you want. This loads the live TypeScript source without installing or copying it. It also keeps your normally configured Pi extensions enabled. Use `--no-extensions` before `-e` if you want to test it in isolation.
