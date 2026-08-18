# @pi-kaush/pi-inline-agent-identifier

> **Deprecated:** install [`@pi-kaush/pi-inline-identifier`](../pi-inline-identifier) instead. It is the canonical package for agent, skill, and prompt-template identifiers. Do not load both packages.

Use `&agent-name` references in Pi prompts while keeping delegation in the existing named-agent `subagent` tool.

## Prerequisite

Install and configure a Pi extension that registers a `subagent` tool with an `agent` parameter. Agent definitions are read from Pi's normal user agent directory and, when supported and trusted, the nearest project agent directory.

This package does not implement a subagent runner or call one directly. If no compatible `subagent` tool is active, it does nothing.

## Install

```sh
pi install npm:@pi-kaush/pi-inline-agent-identifier
```

Restart Pi or run `/reload` after the named-agent subagent extension is loaded.

To run the extension from a local checkout instead:

```sh
pi -e ~/path/to/pi-kaush/extensions/pi-inline-agent-identifier/src/index.ts
```

## Usage

Mention one known agent anywhere in a normal prompt:

```text
Ask &reviewer to review these changes.
```

The extension highlights known `&agent-name` aliases and transforms that prompt into an explicit request for Pi to delegate through the existing `subagent` tool. The original prompt remains the delegated task.

While typing, Pi's native autocomplete suggests matching agents after `&`. The extension does not intercept `@`, so Pi's native file attachment and completion behavior remains unchanged.

## Behavior

- Only aliases matching discovered Pi agent definitions are highlighted or transformed.
- User agents come from Pi's user `agents` directory.
- Trusted project agents come from the nearest project config `agents` directory when the active subagent tool supports `agentScope`; project definitions override user definitions with the same name.
- A prompt referencing exactly one known agent is transformed. Repeating that same agent still counts as one agent.
- Prompts referencing multiple different agents are left unchanged because parallel and chained delegation need explicit orchestration.
- Slash commands, unknown aliases, shell `&&` operators, `@` file references, and extension-generated input are left unchanged.
- Agent names support letters, numbers, `_`, and `-`, up to 64 characters.
- Autocomplete and highlighting only run in TUI mode. Input transformation remains available in print, JSON, and RPC modes.
- The extension does not replace the editor. It installs one guarded, lifecycle-scoped render wrapper that composes with other editor render wrappers.
