# Manual tests: managed subagents and footer rows

Run these in a fresh Pi session (or `/reload`) after `~/.pi/agent/settings.json` points at the local `extensions/pi-simple-subagents` and `extensions/pi-footer-minimal` directories. Run inside Herdr to exercise pane hosting; run in a plain terminal to exercise the headless RPC host.

## Bounded delegation still works

1. `Use a quick bee subagent to count the .ts files under extensions/pi-btw/src and reply with the number only.`
   Expect one collapsed result; no worker row below the footer.
2. `In parallel, have two quick bee subagents each summarize one of extensions/pi-btw/README.md and extensions/pi-footer-minimal/README.md in one sentence.`
3. `Chain: a quick scott subagent lists the exported functions in extensions/pi-simple-subagents/src/_yield.ts, then a quick bee subagent writes one line describing {previous}.`

## Managed lifecycle

4. `Spawn a managed quick bee worker: read extensions/pi-btw/src/index.ts and tell me in 3 bullets what it does.`
   Expect: in Herdr, an unfocused pane split below this one; the caller pane keeps focus. A dim `below-footer` row shows the worker. The answer arrives automatically as a follow-up message; no manual `wait`.
5. While idle: `Send that worker a follow-up: now list any timers or intervals it creates.`
   Expect the same pane and session reused; a second assignment ID; a second automatic report.
6. Mid-run steer: spawn a longer task (`Spawn a managed bee worker to review every file in extensions/pi-footer-minimal/src and test for edge cases, slowly and thoroughly.`), then immediately `Steer that worker: focus only on width truncation.`
   Expect the steer merged into the active assignment and reported once.
7. `/subagent` — inspect, open (Herdr focuses the child pane), message, and stop from the picker.
8. `Stop the worker.` then `Resume it and ask what it remembers about the first task.`
   Expect context retained; no replay of interrupted work.

## Reload, restart, deduplication

9. Spawn a worker, run `/reload` while it is busy. Expect the worker to keep running and report exactly once.
10. Spawn a worker, quit Pi while it is busy, then `pi --continue`. Expect the worker to come back idle, the interrupted assignment reported as interrupted (not replayed), and no duplicate reports for already-delivered results.
11. `wait` on an assignment manually, then let it finish. Expect no second automatic report.

## Capacity

12. `Spawn five managed quick bee workers, each told to reply "ready" and then wait.` then `Run a bounded quick bee subagent to say hi.`
    Expect the bounded run to fail fast naming handles to stop, not hang. Stop one worker and retry.

## Footer

13. Narrow the pane to about 40 columns with a live worker. Expect worker rows clipped, dim, and below the stats row.
14. Switch between light and dark themes; rows stay faint but legible.

## Outside Herdr (plain terminal)

15. Repeat 4 and 7. Expect a warning that automatic opening is unavailable and a fish-safe `pi --session …` command; opening a live RPC worker should require stopping it first.
