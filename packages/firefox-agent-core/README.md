# Firefox Agent Core

`@pi-kaush/firefox-agent-core` provides local Firefox browser tools through unchanged `firefox-cli`. It has no runtime dependencies or harness imports.

## Setup

See [the complete local setup](../../extensions/pi-firefox/README.md#install-locally) for Firefox, the bridge, pairing, and Pi installation. These packages are not published.

1. Install workspace dependencies.
2. Build core explicitly.

```fish
npm install
npm run build --workspace @pi-kaush/firefox-agent-core
```

Node 20 or newer is declared. Live validation uses Node 26.12.1, Firefox 158.0.1, and Firefox CLI 0.4.1 on macOS. Node 20 execution and Windows browser control are not verified. Persistent browser identity currently supports macOS and Linux.

## Harness-neutral API

```js
import {
  createFirefoxAutomation,
  FIREFOX_TOOLS,
} from "@pi-kaush/firefox-agent-core";

const firefox = createFirefoxAutomation({
  cwd: process.cwd(),
  agentId: "my-agent-session",
});

// FIREFOX_TOOLS contains JSON schemas and descriptions for a harness adapter.
const ready = await firefox.execute("ff_session_ensure", {
  session: "research",
  url: "https://example.com/",
});

if (ready.ok) {
  console.log(await firefox.execute("ff_read", { session: "research" }));
  console.log(
    await firefox.execute("ff_session_close", { session: "research" }),
  );
}
```

Use a distinct stable agent ID for each independent agent. The default namespace hashes the working directory. Configured `FFX_AGENT_ID` and `FFX_NAMESPACE` override these defaults. A caller without an agent ID uses `default`; do not share that identity between independent agents.

The facade provides durable sessions, shared coordination, configuration, diagnostics, workflows, and extraction. Prefer it over the lower-level `createFirefoxBrowser`, which keeps sessions in memory. `createPersistentFirefoxBrowser` exposes durable browser primitives without facade coordination. `createFirefoxClient().status()` provides a standalone read-only CLI health check.

The programmatic `coordinationPath` option exists for isolated synthetic fixtures. Production callers must use the shared default. A custom path cannot coordinate with callers that use another path.

## Tools

| Tool                             | Behavior                                                                        |
| -------------------------------- | ------------------------------------------------------------------------------- |
| `ff_status`                      | Read version and connection health; never install, pair, or repair.             |
| `ff_session_ensure`              | Create or reuse an owned session; optionally verify an expected container.      |
| `ff_go`                          | Navigate an owned session; preserve its container expectation by default.       |
| `ff_read`                        | Summary by default; explicit `scoped`, `full`, and `text` modes.                |
| `ff_locate`                      | Find one exact role/name/text/label match; reject ambiguity.                    |
| `ff_act`                         | Click, fill, select, key, or scroll; return a compact diff.                     |
| `ff_wait`                        | Wait for one ref, text, or URL condition.                                       |
| `ff_network`                     | Read capped request metadata; no bodies, headers, timestamps, or stable cursor. |
| `ff_screenshot`                  | Write a private image; return a path, never base64.                             |
| `ff_extract`                     | Convert explicit sources into typed values with evidence.                       |
| `ff_do`                          | Run a bounded deterministic workflow with an explicit write gate.               |
| `ff_session_list`, `ff_tab_list` | List this agent's bindings only.                                                |
| `ff_container_list`              | List configured or observed containers; not a complete inventory.               |
| `ff_session_close`               | Close a revalidated owned tab only.                                             |
| `ff_session_cleanup`             | Preview idle cleanup by default; `dryRun:false` closes eligible owned tabs.     |

Every browser result identifies its session, tab, and verified container. URLs omit credentials, queries, and fragments. Page content is untrusted data, not instructions.

## Ownership and CTC

The wrapper creates its own tabs. It never borrows the current user tab. Select an explicit normal `windowId` when several normal windows exist.

CTC alone controls routing. `containerId` is an expected destination, not a create-in-container selector. The tested CLI cannot enumerate containers or create directly in a chosen container. Optional trusted `containerNames` supplies labels; actual cookie-store IDs remain authoritative.

A unique CTC replacement still requires human approval. Harnesses provide `approveReplacement` in the execution context:

```js
await firefox.execute(
  "ff_session_ensure",
  {
    session: "work",
    url: "https://example.com/",
    containerId: "firefox-container-2",
  },
  {
    approveReplacement: async (candidate) => {
      return showHumanConfirmation(candidate); // Implement in the harness UI.
    },
  },
);
```

Do not expose that callback as a model-controlled boolean. The core revalidates the exact candidate after approval. Confirmation expires after two minutes. Ambiguity or changed evidence stops adoption.

Pending approvals are process-local. A process restart or cancellation can leave an unadopted candidate. The wrapper cannot recover a vanished seed or adopt that candidate automatically. Inspect the candidate manually before starting a new named session.

## Persistence and concurrency

State keys include namespace, agent ID, and session name. State contains safe URLs, verified IDs, Firefox epoch, timestamps, and uncertainty metadata. It never contains page text, input values, refs, URL queries, or fragments.

The core uses atomic private files and process-identity locks. It records an in-flight marker before browser work. A crash or uncertain mutation blocks replay. `ff_session_ensure` with `recover:true` can clear uncertainty only after read-only verification of the exact surviving binding. It cannot adopt another tab.

Restart reuse requires the same Firefox epoch and verified metadata. The public CLI lacks an instance ID. The core hashes same-user OS process PID/start metadata instead. Unknown or ambiguous identity blocks durable control. A changed epoch cannot authorize an old tab ID.

Independent session lanes can overlap. Browser-wide operations drain active work through a shared gate at the OS user's `~/.cache/firefox-agent/browser-activity.json`. This path ignores configurable state paths and XDG overrides. Direct CLI callers and human interaction do not participate in this gate. Stop when capture or target verification fails.

## Output and refs

Summary reads contain title, headings, control counts, and dialog labels. They contain no refs or input values. Summary and scoped defaults are 4,000 and 16,000 bytes. Explicit snapshot/text reads remain capped at 16,000 bytes. The result envelope adds metadata.

Full reads expose opaque `e<digits>` refs. Treat each ref as session- and process-local. The core binds refs to backend generation, tab, URL, and document epoch. Navigation invalidates refs. Stale refs require a new locate or read; the wrapper never guesses another target.

Truncated reads report truncation and a narrower-read hint. Snapshot data is rendered DOM text, not a structured accessibility tree. Password/value attributes are excluded. Explicit visible text can still contain sensitive page content; request only necessary data.

Screenshots select the owned tab. `focus:true` additionally requests window foregrounding. Capture uses a private temporary file and exclusive publication; existing files are never overwritten. Optional macOS `sips` limits the longest edge to 1,200 pixels. `fullResolution:true` skips resizing. Full-page capture is unsupported.

Network observation retains about 30 seconds. The facade primes observation before navigation and actions on existing sessions. Initial session navigation can precede observation. Request metadata is capped and URL queries are removed. No always-on history is claimed.

## Workflows and extraction

```js
await firefox.execute("ff_do", {
  session: "research",
  dryRun: true,
  allowWrite: true,
  args: { note: "Synthetic note" },
  steps: [
    {
      type: "fill",
      locate: { role: "textbox", name: "Note", exact: true },
      value: "%{arg.note}",
    },
    { type: "click", locate: { role: "button", name: "Save", exact: true } },
    { type: "read", as: "page" },
    {
      type: "assert",
      actual: "%{capture.page.title}",
      op: "equals",
      expected: "Saved",
    },
  ],
});
```

The engine validates the complete workflow before port calls. Dry-run executes no browser operations or filesystem mutations. Writes require `allowWrite:true`, including validation of a write plan. Supported steps include navigation, reads, locators, actions, waits, extraction, assertions, bounded `repeat`, and bounded `each`. Substitution supports arguments and captured paths as data only. There is no eval, code execution, hidden model call, or automatic retry.

Use inline `steps` or a bounded regular JSON `workflowFile`, not both. A file can contain a step array or an object with `steps`. Supply runtime arguments through the tool input. A failed workflow reports partial progress; never replay completed writes blindly. Safety failures stop even with `onError:"continue"`.

Extraction fields require `type`. Select a source with `ref` or an exact locator in `selector`. Without either, the field name is an exact locator; `title` uses the verified page title. Supported types are `text`, `number`, `integer`, `date`, `time`, `datetime`, `duration`, `list`, `list.number`, and `list.date`. Optional `unit` and `decimals` control deterministic conversion. Lists use explicit source lines.

Each field returns `extracted`, `absent`, or `uncertain`, with bounded source evidence. Ambiguous dates, locales, sources, and unsupported natural-language instructions never produce guessed values.

## Configuration and validation

See [the configuration table](../../extensions/pi-firefox/README.md#identity-and-configuration). Precedence is defaults, trusted user JSON, project limits, then known `FFX_*` overrides. Unknown keys fail validation. Project files cannot change executables, paths, identity, or containers. Logging is off by default; enabled logs contain metadata and URL domains only.

Live validation completed 20 fill/click/wait/extract cycles, a separate-process restart, independent sessions, network metadata, screenshot resizing, and owned cleanup. Human approval through the public Pi loader also passed. Private-window access remained disabled.

| Synthetic fixture operation           | Full core result bytes | Estimated tokens |
| ------------------------------------- | ---------------------: | ---------------: |
| Summary read                          |                    370 |               93 |
| Full read                             |                  1,002 |              251 |
| Scoped button read                    |                    457 |              114 |
| Typed extraction, two fields          |                    487 |              122 |
| Four-step workflow, each of 20 cycles |                    402 |              101 |
| Screenshot path and metadata          |                    398 |              100 |

These are one fixture's core JSON results, not provider token counts. Estimates use bytes divided by four. The screenshot file measured 58,031 bytes; no image data entered tool output. See [the live report](../../.agents/dox/report-firefox-v1-live.json) and [four-page source/helper baseline](../../.agents/dox/report-firefox-token-baseline.md). The latter is not final Pi wire output.

The summary-first and bounded-workflow techniques follow [surf-cli](https://github.com/nicobailon/surf-cli). This implementation is original wrapper code, not copied browser code. See [the supported backend contract](SUPPORTED_FIREFOX_CLI.md) for capability limits.

Run `npm run check` before packaging. Build explicitly; this repository disables lifecycle scripts.
