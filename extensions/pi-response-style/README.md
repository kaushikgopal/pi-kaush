# pi-response-style

Change how Pi talks to you in chat. Not how it thinks, not what it does. Just the
prose of its replies. You pick a named style from `/response-style`, and Pi
writes its chat replies in that voice from then on.

A style is a Markdown file with a title, a description, and a body. The body gets
appended to the system prompt each turn. Bundled styles ship with the package.
Your own styles live in `~/.pi/agent/response-styles/` and override the bundled
ones by filename.

## Install

```sh
pi install npm:@pi-kaush/pi-response-style
```

Restart Pi or run `/reload`. To pin a release, append the version, such as
`@0.1.0`.

## Usage

```text
/response-style              open the style picker
/response-style <name>       switch to the named style
/response-style off          turn styling off
```

Pick a style from the list and Pi starts writing its replies in that voice. After
you pick, Pi asks if you want that style as your default. Say yes and it sticks
across sessions.

Pressing Esc in the picker changes nothing. It leaves the current style as it was.

The footer stays quiet by design. Your default style is the baseline, so it
shows nothing. Only a style that differs from the default earns a small footer
marker, just the style's title. Other extensions can render it their own way:
the extension emits `pi-response-style:changed` on the `pi.events` bus with
`{ name, title, defaultName }` whenever the state changes.

Turning styling off is a real choice, not just the lack of one. `off` is
remembered. Pi will not fall back to a default or a last-used style until you
pick one again.

## Style file format

A style is a Markdown file. YAML frontmatter on top, prose body below.

```markdown
---
title: Terse
description: Short, blunt answers. No filler.
---

Write your chat replies in a terse, direct voice. Short sentences. Lead with the
answer. Cut hedging, throat-clearing, and summary restatements. Prefer plain
words over jargon.
```

`title` and `description` show in the picker. The body is what gets appended to
the system prompt. You do not need to write the thinking guardrail yourself. The
extension appends it to every style automatically.

Project styles go in `.pi/response-styles/*.md` inside a repo. Precedence is
bundled < user < project: a project file overrides your user file of the same
name, which overrides the bundled one. Project styles load only from projects
you have trusted, and the picker tags them so you can see where a style comes
from.

## Where styles live

Bundled styles ship inside the package under `styles/*.md`.

Your own styles go in `~/.pi/agent/response-styles/*.md`. A user file with the
same filename as a bundled style replaces it. That is how you edit or override a
bundled style: drop a file with the same name in your directory.

Edit a style file, then run `/reload` to pick up the change.

The extension never writes into your styles directory, with one exception: it
writes `config.json` there when you set a default.

## How selection resolves

When a session starts, Pi picks the active style in this order:

1. A style you picked this session.
2. The configured default (the `default` key in `config.json`).
3. The last style you used.
4. Off.

To clear a default, remove the `default` key from
`~/.pi/agent/response-styles/config.json`.

## Why this works

The interesting part of this extension is where the style instruction goes and
what it can and cannot promise. Here is the reasoning.

### System prompt, not the tail of the conversation

The style body is appended to the system prompt. That is the strongest, most
reliable place to put an instruction the model should follow every turn. It is
the same mechanism Claude Code uses for its output-styles feature.

There is a real alternative: inject the style as a message at the tail of the
conversation instead. That keeps the prompt cache intact, and recency makes a
tail message surprisingly strong. The model just read it, so it tends to obey it.

The tail approach loses on a different axis. Old style instructions pile up in the
history. Switch styles twice and the model is now reading three sets of
directions, two of them stale and contradictory. You would have to prune them,
and pruning the conversation has its own costs.

The system prompt wins because style switches are rare and reliability matters
more than the cache. One clean instruction, always current, always in the
strongest position.

### The KV cache trade-off

Changing the system prompt invalidates the cached prompt prefix. The next turn,
the model re-reads the conversation once to rebuild the cache. That is a one-time
spike in cost and latency on the switch. After that the new prefix re-caches and
later turns are cheap again.

For occasional switching this is fine. You pay once per switch, not once per
turn. Measured on a real ~150k-token session through an AI gateway: one style
switch caused exactly one full re-read (146k tokens, cache read 0), then the
cache refilled and later turns read from it again. The same session showed
full re-reads every five to ten minutes of wall time regardless, because the
prompt cache expires between turns while you read and type. So in interactive
use the marginal cost of a switch is often zero: the cache was going to lapse
before your next turn anyway.

If you find yourself switching many times in a single session, the tail-message
injection above is the documented escape hatch. It preserves the cache across
switches. It is not built here, because the common case is a few switches at
most.

One honest caveat: prompt caching only helps if it survives the trip through
whatever sits between you and the model. If you route through an AI gateway or
proxy, caching works only when the gateway preserves the cache headers. The
measurement above confirms it can work through a gateway, but verify on your
own setup before you count on it.

### Instruction is the only channel

There is no API that styles "just the chat text." A model's thinking and its
visible replies are the same model reading the same prompt. Nothing separates
them at the mechanism level.

So "write my replies in this style, but do not change how you reason" can only
ever be an instruction. There is no switch to flip. The good news: models are
genuinely good at this register-switch. They can reason in one voice and answer
in another when you ask.

Every style body ends with an explicit guardrail: apply the style only when
responding to the user in chat, never to internal reasoning, thinking traces,
tool calls, or code. In practice this is honored well. But it is a request, not a
fence. The model can leak the style into its reasoning if it slips, and nothing
stops it from doing so.

### Stricter enforcement was considered and rejected

Two designs give harder separation than an instruction. Both were rejected on
purpose.

**Display-layer transforms.** Restyle the chat text with synchronous string edits
in the display layer. This provably can never touch thinking traces, because it
runs on the output after the fact. But string edits are all it can do. You cannot
restyle prose with find-and-replace. There is no real styling here, so it was
dropped.

**Post-hoc LLM rewriting.** Let the model think and reply unconstrained, then run
a second model pass that rewrites the reply into the chosen style. This is the
"claudish-to-english" pattern. It gives true separation, because the styling
model never sees or affects the reasoning. But it breaks streaming (you cannot
show the reply until the rewrite finishes), costs a second model call per reply,
and mutates the stored message so the transcript no longer matches what the first
model produced. Too expensive for the benefit.

The guardrail-instruction approach is the right default. The trigger to revisit:
if the guardrail empirically leaks style into reasoning often enough to matter,
post-hoc rewriting becomes worth its cost.

## Development

```sh
npm run check
npm pack --workspace @pi-kaush/pi-response-style --dry-run
```

Load the live source in isolation:

```sh
pi --no-extensions -e ~/dev/oss/pi-kaush/extensions/pi-response-style/src/index.ts
```
