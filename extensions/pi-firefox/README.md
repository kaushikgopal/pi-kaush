# @pi-kaush/pi-firefox

Native Pi tools and safety guidance for owned Firefox sessions. The extension delegates all browser behavior to `@pi-kaush/firefox-agent-core` and `firefox-cli`.

This package is local-only. It is not published to npm.

## Tools

The extension registers every public Firefox core tool:

- Status and inventory: `ff_status`, `ff_session_list`, `ff_tab_list`, `ff_container_list`.
- Session and navigation: `ff_session_ensure`, `ff_go`, `ff_session_close`, `ff_session_cleanup`.
- Page operations: `ff_read`, `ff_locate`, `ff_act`, `ff_wait`, `ff_network`, `ff_screenshot`, `ff_extract`, `ff_do`.

The commands `/firefox-status`, `/firefox-session`, and `/firefox-container` show the matching core result. They do not add adapter-side browser logic.

The adapter uses public Pi APIs. It caches a lazy core automation instance by working directory and Pi session ID. It does not start Firefox, a process, or a socket while Pi loads the extension.

The model-facing tool text is JSON capped at 8,000 bytes. Larger results include a valid JSON truncation notice and preview. The Pi `details` and `structuredContent` fields keep the exact core result. The output schema closes the outer result object.

## Safety and limits

- Firefox access uses the public `firefox-cli` interface. This is not an MCP server or a remote browser backend.
- CTC controls container routing. The extension does not read or change CTC rules.
- `ff_container_list` reports configured or observed containers only. It cannot enumerate every Firefox container.
- Do not use private windows or private-page data.
- The tools do not read cookies, authentication headers, response bodies, or raw HTML. The `ff_network` tool returns bounded request metadata.
- `ff_read` returns a summary by default. Scoped, full, and text modes remain bounded.
- The extension does not provide arbitrary page evaluation.
- Pi can send tool content to the selected model provider. Do not request secrets or unnecessary personal data.

Firefox replacement approval uses Pi's human confirmation dialog. The dialog shows the exact candidate. The core revalidates it after approval. Confirmation expires after two minutes. Headless calls cannot approve a replacement. Pending approvals do not survive a process restart; inspect an unadopted candidate manually before starting a new named session.

Use `ff_do` with `dryRun: true` before a workflow. Writes require `allowWrite: true`. A failed workflow can include partial progress. Inspect its results before you try any operation again.

The package declares Node 20 or newer. The live Firefox CLI baseline ran with Node 26.12.1. Compatibility with earlier Node 20 releases is not established by that live run.

## Identity and configuration

The adapter keys its client cache by `ctx.cwd` and `ctx.sessionManager.getSessionId()`. It passes the Pi session ID as the default core agent ID. Resuming the same Pi session keeps that ID. A new Pi session gets a different ID.

The core's `FFX_AGENT_ID` setting overrides the default. Use it as a stable alias only when you need ownership continuity across different Pi sessions. Do not share an alias between independent agents. The core's default namespace hashes the working directory. `FFX_NAMESPACE` can set a trusted namespace explicitly.

The core reads user settings from `$XDG_CONFIG_HOME/firefox-agent/config.json`, or `~/.config/firefox-agent/config.json` by default. It reads optional project limits from `.pi-firefox.json`. Project files may set timing and output limits only.

| Setting              | Environment key         | Purpose                    |
| -------------------- | ----------------------- | -------------------------- |
| `binaryPath`         | `FFX_FIREFOX_CLI`       | Firefox CLI executable     |
| `timeoutMs`          | `FFX_TIMEOUT_MS`        | CLI timeout                |
| `maxOutputBytes`     | `FFX_MAX_OUTPUT_BYTES`  | Maximum CLI output         |
| `summaryMaxBytes`    | `FFX_MAX_BYTES`         | Summary read limit         |
| `scopedMaxBytes`     | `FFX_SCOPED_MAX_BYTES`  | Scoped read limit          |
| `settleTimeoutMs`    | `FFX_SETTLE_TIMEOUT_MS` | Page settle wait           |
| `statePath`          | `FFX_STATE_PATH`        | Owned-session state file   |
| `screenshotDir`      | `FFX_SCREENSHOT_DIR`    | Screenshot directory       |
| `logPath`            | `FFX_LOG_PATH`          | Diagnostic log path        |
| `logLevel`           | `FFX_LOG_LEVEL`         | `off`, `error`, or `debug` |
| `namespace`          | `FFX_NAMESPACE`         | Core ownership namespace   |
| `agentId`            | `FFX_AGENT_ID`          | Stable core agent identity |
| `defaultSession`     | `FFX_SESSION`           | Default session name       |
| `defaultContainerId` | `FFX_CONTAINER`         | Expected container ID      |

The shared activity gate always uses the OS user’s `~/.cache/firefox-agent/browser-activity.json`, independent of state paths and XDG overrides. Do not delete it while browser operations run.

The default state, screenshot, and log paths use `$XDG_CACHE_HOME/firefox-agent`, or `~/.cache/firefox-agent`. Logging is off by default. The core also accepts `containerNames` in trusted user config.

## Source and helper baseline

The Firefox CLI 0.4.1 baseline measured fixture HTML, CLI snapshot text and JSON, and the pure core summary helper. It does not measure final Pi wire output or claim tokenizer parity. Token estimates use bytes divided by four, not a provider tokenizer.

The final synthetic live check passed 20 fill/click/wait/extract cycles. Full core JSON measured 370 bytes for a summary and 402 bytes per four-step workflow. Human-confirmed CTC adoption through the public Pi loader also passed. See [core measurements and limits](../../packages/firefox-agent-core/README.md#configuration-and-validation).

The real Pi-loader fixture returned 327 model-facing text bytes for a summary and 1,186 for a full read. Native result envelopes measured 1,116 and 3,749 bytes, respectively. These are byte measurements, not provider token counts. See [native result measurements](../../.agents/dox/report-firefox-pi-wire-live.json).

See the [four-page source/helper baseline](../../.agents/dox/report-firefox-token-baseline.md).

## Install locally

Use a local checkout. Do not install this package from npm.

1. Install Firefox and Node 20 or newer.
2. Install the supported CLI and register its native host.

```fish
npm install -g firefox-cli@0.4.1
firefox-cli setup
```

3. Open the XPI URL printed by `setup` in Firefox.
4. Install FF-CLI Bridge through Firefox's prompt.

WARNING: Pairing grants CLI control of the connected normal Firefox profile. Pair only software and local users you trust.

5. Request pairing.

```fish
firefox-cli connect
```

6. Approve pairing in Firefox.
7. Check the connection.

```fish
firefox-cli doctor --json
```

The result must show an installed native host and connected extension. Private-window access is not required.

8. Install workspace dependencies from the checkout.

```fish
cd ~/dev/oss/pi-kaush
npm install
```

9. Build core explicitly.

```fish
npm run build --workspace @pi-kaush/firefox-agent-core
```

10. Install the Pi package.

```fish
pi install ./extensions/pi-firefox
```

11. Run `/reload` in Pi.
12. Run `/firefox-status` before browser work.

The extension does not install Firefox, the CLI, or FF-CLI Bridge. It does not change Firefox permissions or CTC settings.

## Test

Build the workspace core before running the focused tests. The tests make no browser connection.

```fish
npm run build --workspace @pi-kaush/firefox-agent-core
./node_modules/.bin/vitest run extensions/pi-firefox/test
```

The tests mock the public automation port and load the extension with `pi-browser`. They do not call a browser or a model.
