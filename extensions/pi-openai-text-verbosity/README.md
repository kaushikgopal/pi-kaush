# @pi-kaush/pi-openai-text-verbosity (retired)

This extension is retired. Pi 0.84.1 and newer support generic `samplingParams` in `models.json`, which can set OpenAI Responses `text.verbosity` without an extension.

## Migration

Remove the package from Pi:

```sh
pi remove npm:@pi-kaush/pi-openai-text-verbosity
```

Replace the extension-specific `textVerbosity` field on each affected model:

```json
{
  "id": "gpt-5.6-sol",
  "samplingParams": {
    "text": {
      "verbosity": "low"
    }
  }
}
```

For a built-in model, use the same value in `modelOverrides`:

```json
{
  "providers": {
    "openai": {
      "modelOverrides": {
        "gpt-5.6-sol": {
          "samplingParams": {
            "text": {
              "verbosity": "low"
            }
          }
        }
      }
    }
  }
}
```

Valid verbosity values remain `low`, `medium`, and `high`. Pi applies `samplingParams` to `openai-responses`, `azure-openai-responses`, and `openai-completions` request bodies.

The extension was never published to npm. Older Pi installations can recover the `0.1.0` source from Git history if needed.
