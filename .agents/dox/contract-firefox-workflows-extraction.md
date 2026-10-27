# Firefox workflow and extraction contract

## API

`workflows.ts` exports `runFirefoxWorkflow(input, port, { signal? })` and JSON-friendly workflow, port, and result types. The port exposes only `execute(step, resolvedArgs)`. The engine has no browser, session, SDK, or model dependency.

`extraction.ts` exports `extractFirefoxFields(fields, sources)` and field, candidate, evidence, and result types. The caller chooses each field's source. Conversion does not inspect a page or choose a candidate with a model.

Example workflow:

```ts
await runFirefoxWorkflow({
  steps: [
    { type: "read", as: "page" },
    { type: "assert", actual: "%{capture.page.title}", op: "equals", expected: "Inbox" },
  ],
}, port, { signal });
```

The port receives `{ type: "read" }` and current `{ args, captures }`. Use `%{arg.name}` or `%{capture.name.path}` for data substitutions. Exact substitutions can return JSON values. Embedded substitutions accept only strings, numbers, or booleans. The engine never evaluates code or templates.

Use `{ type: "repeat", count: 2, steps: [...] }` for bounded repetition. Use `{ type: "each", items: "%{arg.rows}", as: "row", steps: [...] }` for bounded arrays. A step's `as` captures its result. An each-loop `as` captures the current item. Captures from loops remain available after the loop; an empty each-loop does not create its item capture.

## Safety and limits

The engine validates all step shapes and known references before any port call. A capture-dependent value is checked when the engine resolves it, immediately before its operation. Dry-run validates the workflow and reports its bounded operation count. Dry-run never calls the port, including for reads.

Navigation accepts only HTTP, HTTPS, and `about:blank`, without URL credentials. Navigation, click, fill, key, scroll, and select require `allowWrite: true`. A failed assertion always stops. `onError: "continue"` continues only after ordinary port failures. Safety errors stop. The default error policy is `stop`.

The engine caps total input and expanded steps at 128, loop counts and each items at 32, nesting at five levels, workflow JSON at 128 KiB, captures at 32, total captures at 16 KiB, each captured value at 4 KiB, each operation result at 16 KiB, arguments at 16 KiB, JSON depth at 12, and waits at 30 seconds. Dry-run uses the 32-item bound for capture-dependent each loops. It accepts at most 256 JSON array entries and 128 object keys per value.

## Extraction rules

Fields use one of: `text`, `number`, `integer`, `date`, `time`, `datetime`, `duration`, `list`, `list.number`, or `list.date`. Each result has an explicit `extracted`, `absent`, or `uncertain` status. Evidence includes at most three source excerpts, each at most 240 characters. The engine reads at most 20 candidates per field, 64 fields, and 8 KiB per field result.

Numbers use ASCII digits and a dot decimal mark. Grouping, exponents, locale formats, excess configured decimal places, and unsafe numeric ranges are uncertain. Dates require valid `YYYY-MM-DD`. Times use 24-hour `HH:mm` or `HH:mm:ss`. Datetimes require an ISO date-time and explicit `Z` or numeric offset; results normalize to UTC. Durations accept ISO day/hour/minute/second values, or a decimal number with a `ms`, `s`, `min`, `h`, or `d` unit. Duration values return seconds.

Lists split on commas, semicolons, or newlines. Empty entries are uncertain. Lists preserve order and duplicates. No natural-language instructions, timezone guesses, locale guesses, or inferred values are accepted.
