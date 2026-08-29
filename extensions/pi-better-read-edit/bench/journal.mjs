// Per-arm journal: a durable JSONL event log written as the arm runs.
//
// Every arm that starts gets a journal under runs/<runId>/arms/. Journal
// lines are appended immediately after each parsed protocol event, so a
// crash mid-arm leaves a partial journal instead of a silent gap. A final
// "arm_end" line records the outcome. Journals are private artifacts
// (0700 dir / 0600 files) and excluded from the published bundle.

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isoNow } from "./util.mjs";

/** Open a journal for one arm; append() and finalize() are sync. */
export function createJournal(runDir, key) {
  const dir = join(runDir, "arms");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const path = join(dir, `${key}.jsonl`);
  const append = (record) => {
    writeFileSync(path, `${JSON.stringify({ t: isoNow(), ...record })}\n`, {
      flag: "a",
      mode: 0o600,
    });
  };
  return {
    path,
    append,
    finalize: (summary) => append({ type: "arm_end", ...summary }),
  };
}
