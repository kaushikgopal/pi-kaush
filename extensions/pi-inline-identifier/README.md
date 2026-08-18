# @pi-kaush/pi-inline-identifier

Use inline references for loaded Pi skills, named subagents, and prompt templates without replacing Pi's editor or command handling.

| Identifier      | Example           | Color  |
| --------------- | ----------------- | ------ |
| Skill           | `$review`         | Purple |
| Agent           | `&reviewer`       | Blue   |
| Prompt template | `/publish-pi-ext` | Green  |

## Install

```sh
pi install npm:@pi-kaush/pi-inline-identifier
```

Restart Pi or run `/reload`.

Do not load this package together with `@pi-kaush/pi-inline-skill-identifier` or `@pi-kaush/pi-inline-agent-identifier`. Those compatibility packages handle the same input independently and can transform it twice.

For local development:

```sh
pi \
  -e ./extensions/pi-inline-identifier/src/skill.ts \
  -e ./extensions/pi-inline-identifier/src/agent.ts \
  -e ./extensions/pi-inline-identifier/src/prompt.ts
```

## Selective loading

The package exposes skill, agent, and prompt handling as separate Pi extension entrypoints. Use `pi config` to disable any entrypoint you do not want. Disabled entrypoints are not imported, and the enabled entrypoints share one coordinator, autocomplete provider, and editor render patch.

## Native slash commands stay native

If the first non-whitespace character on the first line is `/`, the package does nothing: no custom completion, coloring, or input transformation.

```text
/model                             # untouched
/publish-pi-ext pi-inline-identifier # untouched; Pi expands it natively
Use /publish-pi-ext for this change # handled as an inline identifier
```

Every loaded prompt template is recognized inline. First-line slash commands still use Pi's native completion and expansion.

## Request preservation

The package routes a submitted request at most once:

- Repeating the same identifier still counts as one reference.
- More than one distinct known identifier, including identifiers from different categories, leaves the input unchanged rather than guessing a composition order.
- Extension-generated input is left unchanged.

### Skills

Exactly one known `$skill` reference is rewritten to Pi's native `/skill:name` command. Pi inserts the skill block followed by the original request once.

### Agents

Exactly one known `&agent` reference adds one delegation instruction followed by the original request once. A compatible `subagent` tool with an `agent` parameter is required. Trusted project agents are included only when that tool supports `agentScope`.

### Prompt templates

For an inline prompt reference, the package reads the already-discovered template only when the request is submitted. It expands Pi's positional, default, all-argument, and slicing placeholders while treating the complete surrounding request as one argument.

If the template inserts that argument through `$1`, `$@`, `$ARGUMENTS`, or a matching slice, the package does not append another copy. If the template has no placeholder that consumes the request, the expanded template is followed by one `Original request` section. Repeating a request placeholder inside the template still repeats it intentionally; the extension adds no extra copy.

## Compatibility

The package does not replace Pi's editor. It installs one guarded render wrapper for coloring and one guarded autocomplete-trigger wrapper so `/` can open completion after ordinary text. Pi otherwise reserves `/` for leading command completion and exposes no public inline-slash trigger API. If those editor internals change, inline slash autocomplete may require an update; input routing remains independent.

## Performance

- No prompt files or agent directories are read while the extension loads.
- Agent discovery is lazy and cached for the session after the first relevant `&` interaction.
- Disabled entrypoints are not evaluated.
- There are no runtime dependencies or background tasks.
- TUI-only autocomplete and coloring are skipped outside interactive mode; input routing remains available in print, JSON, and RPC modes.
