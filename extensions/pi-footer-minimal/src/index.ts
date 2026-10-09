import type {
  ExtensionAPI,
  ExtensionContext,
  ReadonlyFooterDataProvider,
  SessionEntry,
  Theme,
  ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { isAbsolute, relative, resolve, sep } from "node:path";

const stripAnsi = (text: string) =>
  text
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)|\x9D[^\x07]*(?:\x07|\x9C)/g, "")
    .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "")
    .replace(/\x9B[0-?]*[ -/]*[@-~]/g, "");
const sanitize = (text: string) =>
  text
    .replace(/[\r\n\t]/g, " ")
    .replace(/ +/g, " ")
    .trim();

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

function formatCwdForFooter(cwd: string, home: string | undefined): string {
  if (!home) return cwd;
  const rel = relative(resolve(home), resolve(cwd));
  const insideHome =
    rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  if (!insideHome) return cwd;
  return rel === "" ? "~" : `~${sep}${rel}`;
}

// Shared outer inset with the conversation surface; below this width the
// decoration drops entirely before content is clipped.
const EDGE_PAD = 2;

function padFooterLine(line: string, width: number): string {
  if (width <= EDGE_PAD * 2) return truncateToWidth(line, width, "");
  const contentWidth = width - EDGE_PAD * 2;
  const clipped = truncateToWidth(line, contentWidth, "");
  const margin = " ".repeat(EDGE_PAD);
  const fill = " ".repeat(Math.max(0, contentWidth - visibleWidth(clipped)));
  return `${margin}${clipped}${fill}${margin}`;
}

/**
 * Extension statuses whose key starts with this prefix render as their own
 * dim rows below the footer, one per line of the status text, sorted by key.
 */
export const BELOW_FOOTER_PREFIX = "below-footer:";
/** Shown before the model on the main line; dropped first when space is tight. */
const ACTIVE_AGENT_STATUS = "active-agent";

function belowFooterStatusRows(
  statuses: ReadonlyMap<string, string>,
): string[] {
  return Array.from(statuses.entries())
    .filter(([key]) => key.startsWith(BELOW_FOOTER_PREFIX))
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([, value]) => stripAnsi(value).split("\n"))
    .map((line) =>
      line
        .replace(/\r/g, " ")
        .replace(/[\u0000-\u001F\u007F-\u009F]/g, " ")
        .replace(/ +/g, " ")
        .trim(),
    )
    .filter(Boolean);
}

const THINKING_COLORS: Record<string, ThemeColor> = {
  off: "thinkingOff",
  minimal: "thinkingMinimal",
  low: "thinkingLow",
  medium: "thinkingMedium",
  high: "thinkingHigh",
  xhigh: "thinkingXhigh",
  max: "thinkingMax",
};

interface UsageTotals {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly cost: number;
}

const NO_USAGE: UsageTotals = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const count = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

/** Usage recorded on a session entry; malformed fields count as zero. */
function parseUsage(value: unknown): UsageTotals | undefined {
  if (!isRecord(value)) return undefined;
  return {
    input: count(value.input),
    output: count(value.output),
    cacheRead: count(value.cacheRead),
    cacheWrite: count(value.cacheWrite),
    cost: count(isRecord(value.cost) ? value.cost.total : undefined),
  };
}

/** The same entries native Pi counts toward cumulative session usage. */
function entryUsage(entry: SessionEntry): UsageTotals | undefined {
  if (entry.type === "message") {
    const { message } = entry;
    return message.role === "assistant" || message.role === "toolResult"
      ? parseUsage(message.usage)
      : undefined;
  }
  if (entry.type === "compaction" || entry.type === "branch_summary")
    return parseUsage(entry.usage);
  return undefined;
}

function addUsage(a: UsageTotals, b: UsageTotals): UsageTotals {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    cost: a.cost + b.cost,
  };
}

/**
 * Session entries are append-only, so totals only need the entries added
 * since the last render; a shorter list means a different session.
 */
function createUsageCounter(): (
  entries: readonly SessionEntry[],
) => UsageTotals {
  let counted = 0;
  let totals = NO_USAGE;
  return (entries) => {
    if (entries.length < counted) {
      counted = 0;
      totals = NO_USAGE;
    }
    for (const entry of entries.slice(counted)) {
      const usage = entryUsage(entry);
      if (usage) totals = addUsage(totals, usage);
    }
    counted = entries.length;
    return totals;
  };
}

type StatsVisibility = "shown" | "hidden";

/** Everything one footer render shows, read from Pi before layout. */
interface FooterModel {
  /** Working directory with the home directory shortened to `~`. */
  readonly cwd: string;
  readonly gitBranch: string | undefined;
  readonly sessionName: string | undefined;
  readonly usage: UsageTotals;
  readonly context: {
    /** Undefined when Pi cannot estimate it yet. */
    readonly percent: number | undefined;
    readonly window: number;
  };
  readonly modelLabel: string;
  /** Present only for reasoning models. */
  readonly thinkingLevel: string | undefined;
  /** Present only when more than one provider is available. */
  readonly provider: string | undefined;
  readonly activeAgent: string | undefined;
  /** Remaining statuses for the stats line, sorted by key. */
  readonly statuses: readonly (readonly [key: string, text: string])[];
  readonly belowFooterRows: readonly string[];
  readonly stats: StatsVisibility;
}

interface FooterEnv {
  readonly home: string | undefined;
  readonly thinkingLevel: () => string;
  readonly stats: StatsVisibility;
  readonly usage: (entries: readonly SessionEntry[]) => UsageTotals;
}

function collectFooterData(
  ctx: ExtensionContext,
  footerData: ReadonlyFooterDataProvider,
  env: FooterEnv,
): FooterModel {
  const statuses = footerData.getExtensionStatuses();
  const contextUsage = ctx.getContextUsage();
  const model = ctx.model;
  return {
    cwd: formatCwdForFooter(ctx.sessionManager.getCwd(), env.home),
    gitBranch: footerData.getGitBranch() || undefined,
    sessionName: ctx.sessionManager.getSessionName() || undefined,
    usage: env.usage(ctx.sessionManager.getEntries()),
    context: {
      percent: contextUsage?.percent ?? undefined,
      window: contextUsage?.contextWindow ?? model?.contextWindow ?? 0,
    },
    modelLabel: model?.name || model?.id || "no-model",
    thinkingLevel: model?.reasoning ? env.thinkingLevel() || "off" : undefined,
    provider:
      model && footerData.getAvailableProviderCount() > 1
        ? model.provider
        : undefined,
    activeAgent: statuses.get(ACTIVE_AGENT_STATUS) || undefined,
    statuses: Array.from(statuses.entries())
      .filter(
        ([key]) =>
          key !== ACTIVE_AGENT_STATUS && !key.startsWith(BELOW_FOOTER_PREFIX),
      )
      .sort(([a], [b]) => a.localeCompare(b)),
    belowFooterRows: belowFooterStatusRows(statuses),
    stats: env.stats,
  };
}

function formatCost(cost: number): string {
  return `$${cost < 0.01 ? cost.toFixed(3) : cost.toFixed(2)}`;
}

/** Thresholds match statusline.sh: <60 gray, 60-79 orange, >=80 red. */
function contextColor(percent: number): ThemeColor {
  if (percent >= 80) return "error";
  if (percent >= 60) return "warning";
  return "muted";
}

function formatStatus(key: string, text: string, theme: Theme): string {
  if (key !== "mcp") return sanitize(text);
  const plain = stripAnsi(sanitize(text));
  // Adapter formats: "MCP 2/3" (compact), "3 servers enabled (2 connected)" (full), "MCP: 2/3 servers" (legacy)
  const slash = plain.match(/MCP:?\s+(\d+)\s*\/\s*(\d+)/i);
  if (slash) return theme.fg("accent", `🔌 ${slash[1]}/${slash[2]}`);
  const connected = plain.match(
    /(\d+)\s+servers?\s+(?:enabled\b[^(]*)?\((\d+)\s+connected\)/i,
  );
  if (connected)
    return theme.fg("accent", `🔌 ${connected[2]}/${connected[1]}`);
  const servers = plain.match(/(\d+)/);
  return theme.fg(
    "accent",
    servers ? `🔌 ${servers[1]}` : plain.replace(/^MCP:?\s*/i, ""),
  );
}

function layoutMainLine(
  model: FooterModel,
  contentWidth: number,
  theme: Theme,
): string {
  const { percent, window } = model.context;
  const percentLabel =
    percent !== undefined
      ? `${percent.toFixed(1)}%/${formatTokens(window)}`
      : `?/${formatTokens(window)}`;
  const contextColored = theme.fg(contextColor(percent ?? 0), percentLabel);

  // Left: cwd (branch) • session — then cost • context
  const cwd = model.cwd;
  const slash = cwd.lastIndexOf(sep);
  const lastName = slash >= 0 ? cwd.slice(slash + 1) : cwd;
  const cwdSection =
    slash > 0
      ? `${theme.fg("dim", cwd.slice(0, slash + 1))}${theme.fg("muted", lastName)}`
      : theme.fg("muted", cwd);
  let prefix = "";
  if (model.gitBranch) prefix += theme.fg("dim", ` (${model.gitBranch})`);
  if (model.sessionName) prefix += theme.fg("dim", ` • ${model.sessionName}`);
  const cost = model.usage.cost;
  const costPart =
    cost > 0 ? ` ${theme.fg("dim", `${formatCost(cost)} •`)}` : "";
  const contextPart = ` ${contextColored}`;
  // When horizontal space is tight, drop pieces in order: flatten cwd to its
  // basename, then the session cost, then the active agent.
  const leftFull = cwdSection + prefix + costPart + contextPart;
  const leftFlat =
    theme.fg("muted", lastName) + prefix + costPart + contextPart;
  const leftFlatNoCost = theme.fg("muted", lastName) + prefix + contextPart;

  // Right: [active agent •] model • thinking
  let rightCore = theme.fg("muted", model.modelLabel);
  if (model.thinkingLevel !== undefined) {
    const level = model.thinkingLevel;
    const thinkingSuffix = level === "off" ? " • thinking off" : ` • ${level}`;
    rightCore += theme.fg(THINKING_COLORS[level] ?? "dim", thinkingSuffix);
  }
  const agentPrefix = model.activeAgent
    ? `${model.activeAgent}${theme.fg("dim", " • ")}`
    : "";
  const rightLean = `${agentPrefix}${rightCore}`;

  const fits = (l: string, r: string) =>
    visibleWidth(l) + 2 + visibleWidth(r) <= contentWidth;
  let usedLeft = leftFull;
  let usedRight = rightLean;
  if (!fits(usedLeft, usedRight)) {
    usedLeft = leftFlat;
    if (!fits(usedLeft, usedRight)) {
      usedLeft = leftFlatNoCost;
      if (!fits(usedLeft, usedRight)) {
        // Active-agent status is optional; the model is not.
        usedRight = rightCore;
      }
    }
  }

  const leftWidth = visibleWidth(usedLeft);
  const rightWidth = visibleWidth(usedRight);
  if (leftWidth + 2 + rightWidth <= contentWidth)
    return (
      usedLeft +
      theme.fg("dim", " ".repeat(contentWidth - leftWidth - rightWidth)) +
      usedRight
    );
  const availableForLeft = contentWidth - rightWidth - 2;
  if (availableForLeft <= 0)
    return truncateToWidth(usedRight, contentWidth, "");
  const truncatedLeft = truncateToWidth(
    usedLeft,
    availableForLeft,
    theme.fg("dim", "..."),
  );
  const padding = " ".repeat(
    Math.max(0, contentWidth - visibleWidth(truncatedLeft) - rightWidth),
  );
  return truncatedLeft + theme.fg("dim", padding) + usedRight;
}

/** Optional stats line: token stats • provider • other statuses. */
function layoutStatsLine(model: FooterModel, theme: Theme): string {
  const { input, output, cacheRead, cacheWrite } = model.usage;
  const tokenBits: string[] = [];
  if (input) tokenBits.push(`↑${formatTokens(input)}`);
  if (output) tokenBits.push(`↓${formatTokens(output)}`);
  if (cacheRead > 0) {
    const promptTokens = input + cacheRead + cacheWrite;
    if (promptTokens > 0)
      tokenBits.push(`¢${((cacheRead / promptTokens) * 100).toFixed(1)}%`);
  }
  const statusBits = model.statuses
    .map(([key, text]) => formatStatus(key, text, theme))
    .filter((bit) => visibleWidth(bit) > 0);
  const bits: string[] = [];
  if (tokenBits.length > 0) bits.push(theme.fg("dim", tokenBits.join(" ")));
  if (model.provider !== undefined)
    bits.push(theme.fg("dim", `(${model.provider})`));
  if (statusBits.length > 0) bits.push(statusBits.join(" "));
  return bits.join(theme.fg("dim", " • "));
}

function layoutFooter(
  model: FooterModel,
  width: number,
  theme: Theme,
): string[] {
  // Below the inset threshold the decoration drops entirely, so the content
  // budget is the full width, matching padFooterLine.
  const contentWidth = width > EDGE_PAD * 2 ? width - EDGE_PAD * 2 : width;
  const lines = [
    padFooterLine(layoutMainLine(model, contentWidth, theme), width),
  ];
  if (model.stats === "shown") {
    const statsLine = layoutStatsLine(model, theme);
    if (statsLine)
      lines.push(
        padFooterLine(
          truncateToWidth(statsLine, contentWidth, theme.fg("dim", "...")),
          width,
        ),
      );
  }
  for (const row of model.belowFooterRows) {
    const clipped = truncateToWidth(row, contentWidth, "…");
    lines.push(
      padFooterLine(theme.style(clipped, { fg: "dim", dim: true }), width),
    );
  }
  return lines;
}

export default function (pi: ExtensionAPI) {
  let stats: StatsVisibility = "hidden";
  let requestFooterRender: (() => void) | undefined;

  pi.on("session_shutdown", () => {
    requestFooterRender = undefined;
  });

  pi.registerCommand("footer-more-stats", {
    description: "Toggle second footer line with token stats",
    handler: async (args, ctx) => {
      const mode = args.trim().toLowerCase();
      if (mode === "" || mode === "toggle") {
        stats = stats === "shown" ? "hidden" : "shown";
      } else if (mode === "on") {
        stats = "shown";
      } else if (mode === "off") {
        stats = "hidden";
      } else {
        ctx.ui.notify("Usage: /footer-more-stats [on|off|toggle]", "warning");
        return;
      }
      requestFooterRender?.();
      ctx.ui.notify(`Footer stats ${stats}`, "info");
    },
  });

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;

    ctx.ui.setFooter((tui, theme, footerData) => {
      const rerender = () => tui.requestRender();
      requestFooterRender = rerender;
      const unsubBranch = footerData.onBranchChange(rerender);
      const usage = createUsageCounter();

      return {
        dispose() {
          unsubBranch();
          if (requestFooterRender === rerender) requestFooterRender = undefined;
        },
        invalidate() {},
        render(width: number): string[] {
          const model = collectFooterData(ctx, footerData, {
            home: process.env.HOME || process.env.USERPROFILE,
            thinkingLevel: () => pi.getThinkingLevel(),
            stats,
            usage,
          });
          return layoutFooter(model, width, theme);
        },
      };
    });
  });
}
