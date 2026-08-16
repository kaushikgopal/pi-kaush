# Changelog

## Unreleased

- Add autocomplete and highlighting for known `&agent-name` aliases.
- Route prompts with exactly one known agent reference into an explicit delegation request for the existing named-agent `subagent` tool.
- Leave native `@` file attachment and completion untouched, and leave execution to the subagent extension.
