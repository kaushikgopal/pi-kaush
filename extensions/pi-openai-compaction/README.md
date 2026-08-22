# @pi-kaush/pi-openai-compaction

A thin Pi extension that uses OpenAI's standalone Responses compaction endpoint without patching Pi core or changing normal `store: false` requests.

This package is based on `unstableneutron/pi-openai-compaction`, descended from `jordyvandomselaar/pi-openai-compaction`. The original MIT license and attribution are retained.

## Scope

- Pi: `@earendil-works/pi-coding-agent >=0.83.0`
- Provider: `openai`
- API: `openai-responses`
- Endpoint: `POST <effective base URL>/responses/compact`
- Persistence: canonical compact output in append-only Pi compaction details
- Failure mode: fall back to Pi's normal text compaction

The checkpoint identity includes provider, API, model ID, and effective base URL. Canonical `message`, reasoning, and `compaction` items are replayed unchanged.

## Behavior

The extension:

1. intercepts Pi compaction with `session_before_compact`;
2. sends only `model`, `input`, and `instructions` to the standalone compact endpoint;
3. stores the canonical compact output in the branch's compaction entry;
4. replaces Pi's shim summary with the checkpoint plus the live branch tail in `before_provider_request`;
5. repeats native compaction from the latest compatible checkpoint;
6. lazily stores a hidden, context-visible portable checkpoint before switching to an incompatible model or checkpoint identity; and
7. restores the prior model if portable checkpoint creation fails.

Run `/native-compaction-detach` while the compatible GPT model is active before disabling or removing the extension. The command stores a portable checkpoint as a normal Pi custom message, so it remains in model context without the extension. The message explicitly supersedes the older opaque marker.

No prompt, response, checkpoint, encrypted reasoning, credential, or request-header debug artifacts are written.

## Use from this checkout

```fish
bun install
npm run typecheck
npm test
pi -e /Users/kg/dev/oss/pi-kaush/extensions/pi-openai-compaction/index.ts
```

In Pi, use `/compact` normally. Pi's existing compaction thresholds remain authoritative.

## Configuration

Defaults are in `settings.json`:

```json
{
  "enabled": true,
  "supportedProviders": ["openai"],
  "supportedApis": ["openai-responses"]
}
```

Global overrides belong under `openaiNativeCompaction` in `~/.pi/agent/settings.json`:

```json
{
  "openaiNativeCompaction": {
    "enabled": true,
    "supportedProviders": ["openai"],
    "supportedApis": ["openai-responses"]
  }
}
```

Environment variables override file settings:

- `PI_OPENAI_NATIVE_COMPACTION_ENABLED`
- `PI_OPENAI_NATIVE_COMPACTION_SUPPORTED_PROVIDERS` (comma-separated)
- `PI_OPENAI_NATIVE_COMPACTION_SUPPORTED_APIS` (comma-separated)

Project-local settings are intentionally ignored so an untrusted repository cannot enable the extension or broaden provider access.

## Validation

```fish
npm run typecheck
npm test
npm run package:check
```

The synthetic live Gateway contract test is opt-in and reads provider configuration from Pi without printing credentials or model output:

```fish
PI_OPENAI_COMPACTION_LIVE=1 bun test test/gateway-contract.bun.ts
```

It verifies encrypted reasoning, standalone compaction, and stateless canonical replay with synthetic data.
