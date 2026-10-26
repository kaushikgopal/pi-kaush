# Firefox Core

`@pi-kaush/firefox-core` provides a small, harness-neutral status check for the public `firefox-cli` executable.

Phase 1A includes only `createFirefoxClient().status()`. It checks the CLI version, runs `doctor --json`, and returns validated connection and native-host status. It does not install, pair, repair, open, or control Firefox.

## Use from Node.js

Node.js 20 or newer is required.

```js
import { createFirefoxClient } from "@pi-kaush/firefox-core";

const client = createFirefoxClient();
const status = await client.status();

if (!status.ok) {
  console.error(status.code, status.message);
} else {
  console.log(status.result);
}
```

The CLI defaults to `firefox-cli` on `PATH`. Set `binaryPath` to use a different executable. Set `timeoutMs` or `maxOutputBytes` to lower the per-command limits. Pass an `AbortSignal` to `status()` to cancel the check.

The expected CLI version is `0.4.1`. A different valid version appears as a warning. The client does not log command output. Returned status contains only version numbers, enumerated health states, and safe warnings.

## Build and package check

Run `npm run build --prefix extensions/firefox-core` from the repository root to compile ESM and declarations.

Run `npm run package:check --prefix extensions/firefox-core` to build and verify the package file list.

## Scope

This package does not provide sessions, tab ownership, navigation, page reads, actions, browser startup, or setup recovery. It imports no Pi APIs and has no runtime dependencies.

See [SUPPORTED_FIREFOX_CLI.md](SUPPORTED_FIREFOX_CLI.md) for the tested version, live evidence, and backend limits.
