/**
 * Outline diff for post-mutation "Page changes" summaries. Compared without
 * [eN] markers — ref ids are re-minted every snapshot and would drown real
 * changes in noise.
 */

const REF_MARKER = /^\s*\[e\d+\] /;

const stripRef = (line: string): string =>
  line.replace(REF_MARKER, (m) => m.replace(/\[e\d+\] /, ""));

/** Multiset difference: added lines in `after`, removed lines from `before`. */
export const diffOutlines = (
  before: string,
  after: string,
  maxLines = 40,
): string => {
  const counts = new Map<string, number>();
  for (const line of before.split("\n")) {
    const key = stripRef(line);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const added: string[] = [];
  for (const line of after.split("\n")) {
    const key = stripRef(line);
    const remaining = counts.get(key) ?? 0;
    if (remaining > 0) counts.set(key, remaining - 1);
    else added.push(key);
  }
  const removed: string[] = [];
  for (const [key, count] of counts) {
    for (let i = 0; i < count; i++) removed.push(key);
  }

  if (added.length === 0 && removed.length === 0) return "Page unchanged.";

  const budget = Math.max(2, Math.floor(maxLines / 2));
  const format = (lines: string[], marker: string): string[] => {
    const shown = lines.slice(0, budget).map((l) => `${marker} ${l.trimEnd()}`);
    if (lines.length > budget)
      shown.push(`${marker} … (${lines.length - budget} more)`);
    return shown;
  };

  return ["Page changes:", ...format(added, "+"), ...format(removed, "-")].join(
    "\n",
  );
};
