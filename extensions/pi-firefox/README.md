# @pi-kaush/pi-firefox

Native Pi tools for the existing Firefox session, powered by firefox-cli.

## Current scope

The first implementation provides `ff_status` and `/firefox-status` only.
Session ownership, navigation, page reads, and CTC replacement confirmation are
not implemented yet. This is not a finished browser-control extension.

`@pi-kaush/firefox-core` contains the CLI transport and status logic. This package
only registers Pi tools, translates results, and renders status. It adds no
browser driver, MCP server, or second browser.

## 1. Install Firefox and firefox-cli

Install Firefox 150 or newer. The live checks used Firefox 158.0.1 on macOS.

Run these commands in fish:

```fish
npm install -g firefox-cli@0.4.1
firefox-cli setup
```

Open the matching extension URL printed by setup **in Firefox**. Install the
extension through Firefox's installation prompt. For CLI 0.4.1, the URL is:

<https://github.com/respawn-llc/firefox-cli/releases/download/v0.4.1/firefox-cli-0.4.1.xpi>

Keep Firefox running. Leave private-window access disabled.

## 2. Approve the browser connection

WARNING: Pairing firefox-cli grants full control over the signed-in Firefox
session. Approve it only if you trust the software and users that can run the
CLI on this machine.

```fish
firefox-cli connect
firefox-cli doctor --json
```

Approve the request in Firefox. Doctor should report native host `installed`
and extension connection `connected`. These are explicit setup actions; the Pi
extension never installs components or requests pairing automatically.

## 3. Load the local Pi extension

These packages are not published. Use the existing repository checkout:

```fish
cd ~/dev/oss/pi-kaush
npm install
npm run build --workspace @pi-kaush/firefox-core
pi -e ./extensions/pi-firefox
```

The repository uses Node 20 or newer. Core compiles to ordinary ESM JavaScript;
Pi loads the adapter's TypeScript entrypoint. Run `/firefox-status` in Pi, or ask
the model to call `ff_status`.

To keep the extension configured after this invocation:

```fish
pi install ./extensions/pi-firefox
```

Restart Pi or run `/reload`. Browser status names do not collide with
`pi-browser`'s `/browser-status` or `browser_*` tools.

## Results and troubleshooting

`ff_status` reports the CLI version, supported version, version match,
native-host state, connection state, and warnings. The tool is read-only.
Programmatic callers receive the same structured result as the tool's details.
Expected failures set `isError` and include a stable code and safe message.
Native-host paths, pairing URLs, and raw diagnostic output are omitted.

- CLI missing: install firefox-cli, then check `firefox-cli --version`.
- Native host missing: run `firefox-cli setup` yourself.
- Connection not approved: run `firefox-cli connect` yourself.
- Disconnected: keep Firefox running and check that FF-CLI Bridge is enabled.
- Version mismatch: prefer the tested CLI 0.4.1. Status warns rather than hiding
  the mismatch.

CTC owns container routing. This status-only implementation does not read CTC
rules, change containers, or alter browser permissions. Normal Pi tool output
can reach your selected model provider; this package adds no external analysis
or telemetry.

## Update or remove

After updating the checkout, install workspace dependencies and rebuild core:

```fish
npm install
npm run build --workspace @pi-kaush/firefox-core
```

Reload Pi after the build. For a configured local installation, use `pi list`
to find its source, then remove that source with `pi remove`.

Removing the Pi package does not revoke firefox-cli pairing. Revoke pairing
explicitly if desired:

```fish
firefox-cli unpair
```

To remove the backend, remove FF-CLI Bridge through Firefox's Add-ons Manager.
Uninstall the CLI separately:

```fish
npm uninstall -g firefox-cli
```

These steps do not claim to remove native-host registration files. Check the
upstream setup documentation for those platform-specific files.

## Validation

Run `npm run check` from the repository root. Focused status and adapter tests
cover parsing, safe output, timeout, cancellation, output caps, structured tool
results, lazy loading, and command-name coexistence.
