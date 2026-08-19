# pi-kaush

Small, composable extensions for the [Pi coding agent](https://pi.dev).

## Packages

| Package                                                               | Description                                                                         |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| [`@pi-kaush/pi-agent-mode`](./extensions/pi-agent-mode)               | Activate a configured Pi agent as a persistent mode in the current session.         |
| [`@pi-kaush/pi-double-paste`](./extensions/pi-double-paste)           | Paste the same large block twice to expand Pi's paste markers into editable text.   |
| [`@pi-kaush/pi-inline-identifier`](./extensions/pi-inline-identifier) | Highlight and route inline Pi skill, agent, and prompt-template references.         |
| [`@pi-kaush/pi-openai-compaction`](./extensions/pi-openai-compaction) | Preserve OpenAI native Responses compaction checkpoints across compatible Pi turns. |
| [`@pi-kaush/pi-btw`](./extensions/pi-btw)                             | Ask a question in a Herdr side fork or switch to a local session fork.              |
| [`@pi-kaush/pi-tool-call-markers`](./extensions/pi-tool-call-markers) | Show unboxed tool groups, subagent plans, and live/final thinking markers.          |
| [`@pi-kaush/pi-welcome-screen`](./extensions/pi-welcome-screen)       | Show a responsive startup header with Pi's loaded resources.                        |

Every package is independently versioned and published to npm. Runtime source is readable TypeScript, and packages avoid runtime dependencies where practical.

### In development

| Package                                                         | Description                                                                                |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| [`@pi-kaush/pi-content-layout`](./extensions/pi-content-layout) | Inset the conversation; use a full-width dark editor and a compact submitted-prompt shell. |
| [`@pi-kaush/pi-footer-minimal`](./extensions/pi-footer-minimal) | Show cost/context in an inset footer and move Pi's working spinner into that footer.       |

These packages are available from a local clone but are not published to npm yet.

### Retired packages

[`@pi-kaush/pi-openai-text-verbosity`](./extensions/pi-openai-text-verbosity) is retired. Pi 0.84.1 and newer can set OpenAI Responses `text.verbosity` directly through model `samplingParams`.

[`@pi-kaush/pi-inline-skill-identifier`](./extensions/pi-inline-skill-identifier) and [`@pi-kaush/pi-inline-agent-identifier`](./extensions/pi-inline-agent-identifier) are deprecated. Use the consolidated [`@pi-kaush/pi-inline-identifier`](./extensions/pi-inline-identifier) package instead.

## Use an extension

### Install from npm (recommended)

Install an extension globally through Pi's package manager:

```sh
pi install npm:@pi-kaush/pi-double-paste
pi install npm:@pi-kaush/pi-agent-mode
pi install npm:@pi-kaush/pi-inline-identifier
pi install npm:@pi-kaush/pi-openai-compaction
pi install npm:@pi-kaush/pi-btw
pi install npm:@pi-kaush/pi-tool-call-markers
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
pi -e ~/path/to/pi-kaush/extensions/pi-agent-mode/src/index.ts
pi \
  -e ~/path/to/pi-kaush/extensions/pi-inline-identifier/src/skill.ts \
  -e ~/path/to/pi-kaush/extensions/pi-inline-identifier/src/agent.ts \
  -e ~/path/to/pi-kaush/extensions/pi-inline-identifier/src/prompt.ts
pi -e ~/path/to/pi-kaush/extensions/pi-openai-compaction/index.ts
pi -e ~/path/to/pi-kaush/extensions/pi-btw/src/index.ts
pi -e ~/path/to/pi-kaush/extensions/pi-content-layout/src/index.ts
pi -e ~/path/to/pi-kaush/extensions/pi-footer-minimal/src/index.ts
pi \
  -e ~/path/to/pi-kaush/extensions/pi-tool-call-markers/src/index.ts \
  -e ~/path/to/pi-kaush/extensions/pi-tool-call-markers/src/thinking-block-merger.ts
pi -e ~/path/to/pi-kaush/extensions/pi-welcome-screen/src/index.ts
```

Run one command for the extension you want. This loads the live TypeScript source without installing or copying it. It also keeps your normally configured Pi extensions enabled. Use `--no-extensions` before `-e` if you want to test it in isolation.

## Publishing

Packages publish from `.github/workflows/publish.yml` with npm Trusted Publishing. GitHub Actions exchanges its OIDC identity for a short-lived npm credential, so the repository stores no npm write token.

Each npm package must trust the following publisher:

- Provider: GitHub Actions
- Organization or user: `kaushikgopal`
- Repository: `pi-kaush`
- Workflow filename: `publish.yml`
- Environment: `npm`
- Allowed action: `npm publish`

Create a GitHub release whose tag identifies the workspace and exactly matches its package version:

```text
pi-double-paste-v0.1.0
pi-agent-mode-v0.1.0
pi-inline-identifier-v0.1.0
pi-openai-compaction-v0.1.0
pi-btw-v0.1.0
pi-tool-call-markers-v0.1.0
pi-welcome-screen-v0.1.2
```

The workflow verifies the tag against `package.json`, runs the full repository check, and publishes only that workspace. A package's first release must be bootstrapped interactively on npm before its Trusted Publisher can be configured; subsequent releases use GitHub OIDC without local login or write-action 2FA prompts.
