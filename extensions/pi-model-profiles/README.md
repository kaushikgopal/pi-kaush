# pi-model-profiles

Shared, machine-local **model profiles** for Pi extensions: named, ordered
model candidates with optional thinking levels. Profiles describe _compute_
(which model to try, with how much thinking, and in what fallback order) —
never behavior. Agent definitions (persona, prompt, tools) stay separate and
compose a profile by name.

Library-only by design: no commands, no session state, no model mutation.

### Install

```fish
pi install npm:@pi-kaush/pi-model-profiles
```

The package ships no extension entry point; it is consumed as a library by
other Pi packages (e.g. `@pi-kaush/pi-agent-mode`, the delegated-subagent
extension). Restart Pi or run `/reload` after installing a _consumer_.

## Configuration

One machine-local file:

```
~/.pi/agent/profiles.yaml            # runtime ladder (gitignored, per machine)
~/.pi/agent/profiles.template.yaml   # schema reference; never loaded
```

Schema (`version` is required and must be `1`):

```yaml
version: 1
profiles:
  quick:
    description: Fast, low-cost execution for straightforward, low-risk tasks.
    candidates:
      - model: instacart-openai/gpt-5.6-luna
        thinkingLevel: xhigh
  coder:
    description: Fast, coding-specialized execution for bounded implementation work.
    candidates:
      - model: open-weights/deepseek-flash-latest-priority
        thinkingLevel: high
      - model: open-weights/kimi-code-latest
```

Validation rules:

- Profile names are lowercase kebab-case (`/^[a-z][a-z0-9-]*$/`).
- Each profile needs a non-empty description and at least one candidate.
- Candidates use canonical `provider/model` references (no fuzzy patterns),
  appear at most once per profile, and take an optional thinking level from
  `off, minimal, low, medium, high, xhigh, max`.

## Precedence

Consumers resolve model selection in a single deterministic order. For a
launch (session start, `/agent` activation, delegated child):

1. **Explicit launch `model`** — an exact override on the invocation; wins
   over everything.
2. **Explicit launch `profile`** — a profile named on the invocation.
3. **Agent `profile`** — the agent definition's `profile:` frontmatter.
4. **Agent `model`** — legacy single-model frontmatter (`provider/model` with
   optional `:thinking`). An agent must not declare both `profile` and
   `model`.
5. **Session default** — whatever Pi already had.

## Fallback semantics

Candidate fallback happens **only at activation** — when a session or child
is being launched. Consumers walk the profile's candidates in order and use
the first candidate whose model exists and is authenticated. Once a session
is running, consumers must not silently switch models mid-request; Pi's own
retry behavior owns transient failures.

## API

```ts
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  formatProfileCandidate,
  formatProfileGuidance,
  loadModelProfiles,
  resolveProfilesPath,
  selectProfileCandidates,
} from "@pi-kaush/pi-model-profiles";

const profiles = loadModelProfiles(resolveProfilesPath(getAgentDir()));
const { available } = selectProfileCandidates(
  profiles.profiles.coder,
  (model) => isModelAvailable(model), // registry + auth check
);
// walk `available` in order; first hit wins
```

## Development

```sh
npm run check
npm pack --workspace @pi-kaush/pi-model-profiles --dry-run
```
