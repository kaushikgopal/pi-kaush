/** Token and cost accounting shared by bounded runs and managed workers, plus every usage display format. */

/** Running totals for a child run, worker, or assignment. */
export interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
  /** Context size reported by the latest turn that reported one. */
  contextTokens: number;
}

/** Usage reported by one assistant message, already validated. */
export interface TurnUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly cost: number;
  /** Absent when the message reported no positive context size. */
  readonly contextTokens?: number;
}

export function emptyUsage(): UsageStats {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    turns: 0,
    contextTokens: 0,
  };
}

/**
 * Counts one assistant turn and adds its usage. A turn without a context size
 * keeps the previous one, so a final aborted turn does not erase it.
 */
export function addTurnUsage(
  target: UsageStats,
  usage: TurnUsage | undefined,
): void {
  target.turns++;
  if (!usage) return;
  target.input += usage.input;
  target.output += usage.output;
  target.cacheRead += usage.cacheRead;
  target.cacheWrite += usage.cacheWrite;
  target.cost += usage.cost;
  if (usage.contextTokens !== undefined)
    target.contextTokens = usage.contextTokens;
}

/** Totals for display; aggregates may omit turns and context. */
export type UsageSummary = Readonly<
  Omit<UsageStats, "turns" | "contextTokens"> & {
    turns?: number;
    contextTokens?: number;
  }
>;

function turnsLabel(turns: number): string {
  return `${turns} turn${turns === 1 ? "" : "s"}`;
}

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

/** Compact single-line form for tool results and renderers, e.g. `2 turns ↑1.2k ↓300 $0.0100 ctx:4.1k model`. */
export function formatUsageCompact(
  usage: UsageSummary,
  model?: string,
): string {
  const parts: string[] = [];
  if (usage.turns) parts.push(turnsLabel(usage.turns));
  if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
  if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
  if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
  if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  if (usage.contextTokens && usage.contextTokens > 0)
    parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
  if (model) parts.push(model);
  return parts.join(" ");
}

/** Prose form for model-facing reports, e.g. `2 turns, 10 input tokens, 5 output tokens, $0.0100`. */
export function formatUsageProse(usage: UsageSummary): string {
  const parts: string[] = [];
  if (usage.turns) parts.push(turnsLabel(usage.turns));
  if (usage.input) parts.push(`${usage.input} input tokens`);
  if (usage.output) parts.push(`${usage.output} output tokens`);
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  return parts.join(", ");
}

/** Every field, unabbreviated, for inspection views. */
export function formatUsageDetailed(usage: Readonly<UsageStats>): string {
  return `in ${usage.input} · out ${usage.output} · cache ${usage.cacheRead}+${usage.cacheWrite} · context ${usage.contextTokens} · ${turnsLabel(usage.turns)} · $${usage.cost.toFixed(4)}`;
}
