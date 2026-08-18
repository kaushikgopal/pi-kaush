import type {
  AssistantMessage,
  ToolResultMessage,
  Usage,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI, ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { isAbsolute, relative, resolve, sep } from "node:path";

const stripAnsi = (text: string) =>
  text.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
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

function padFooterLine(line: string, width: number): string {
  if (width <= 2) return truncateToWidth(line, width, "");
  const contentWidth = width - 2;
  const clipped = truncateToWidth(line, contentWidth, "");
  return ` ${clipped}${" ".repeat(Math.max(0, contentWidth - visibleWidth(clipped)))} `;
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

export default function (pi: ExtensionAPI) {
  let showMoreStats = false;
  let requestFooterRender: (() => void) | undefined;

  pi.registerCommand("footer-more-stats", {
    description: "Toggle second footer line with token stats",
    handler: async (args, ctx) => {
      const mode = args.trim().toLowerCase();
      if (mode === "" || mode === "toggle") {
        showMoreStats = !showMoreStats;
      } else if (mode === "on") {
        showMoreStats = true;
      } else if (mode === "off") {
        showMoreStats = false;
      } else {
        ctx.ui.notify("Usage: /footer-more-stats [on|off|toggle]", "warning");
        return;
      }
      requestFooterRender?.();
      ctx.ui.notify(
        `Footer stats ${showMoreStats ? "shown" : "hidden"}`,
        "info",
      );
    },
  });

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;

    ctx.ui.setFooter((tui, theme, footerData) => {
      const rerender = () => tui.requestRender();
      requestFooterRender = rerender;
      const unsubBranch = footerData.onBranchChange(rerender);

      function render(width: number): string[] {
        const contentWidth = Math.max(1, width - 2);
        const statuses = footerData.getExtensionStatuses();

        // Cumulative session usage (same entries native pi counts)
        let input = 0,
          output = 0,
          cacheRead = 0,
          cacheWrite = 0,
          cost = 0;
        let cacheHitRate: number | undefined;
        for (const entry of ctx.sessionManager.getEntries()) {
          let usage: Usage | undefined;
          if (
            entry.type === "message" &&
            (entry.message.role === "assistant" ||
              entry.message.role === "toolResult")
          ) {
            usage = (entry.message as AssistantMessage | ToolResultMessage)
              .usage;
          } else if (
            entry.type === "compaction" ||
            entry.type === "branch_summary"
          ) {
            usage = (entry as { usage?: Usage }).usage;
          }
          if (!usage) continue;
          input += usage.input;
          output += usage.output;
          cacheRead += usage.cacheRead;
          cacheWrite += usage.cacheWrite;
          cost += usage.cost.total;
          const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
          if (promptTokens > 0)
            cacheHitRate = (usage.cacheRead / promptTokens) * 100;
        }

        // Context usage, colorized by thresholds matching statusline.sh: <60 gray, 60-79 orange, >=80 red
        const contextUsage = ctx.getContextUsage();
        const contextWindow =
          contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
        const percent = contextUsage?.percent ?? 0;
        const percentLabel =
          contextUsage?.percent !== null
            ? `${percent.toFixed(1)}%/${formatTokens(contextWindow)}`
            : `?/${formatTokens(contextWindow)}`;
        let contextColored: string;
        if (percent >= 80) contextColored = theme.fg("error", percentLabel);
        else if (percent >= 60)
          contextColored = theme.fg("warning", percentLabel);
        else contextColored = theme.fg("muted", percentLabel);

        // Line 1 left: cwd (branch) • session — then cost • context
        const home = process.env.HOME || process.env.USERPROFILE;
        const cwd = formatCwdForFooter(ctx.sessionManager.getCwd(), home);
        const slash = cwd.lastIndexOf(sep);
        const lastName = slash >= 0 ? cwd.slice(slash + 1) : cwd;
        const cwdSection =
          slash > 0
            ? `${theme.fg("dim", cwd.slice(0, slash + 1))}${theme.fg("muted", lastName)}`
            : theme.fg("muted", cwd);
        let prefix = "";
        const branch = footerData.getGitBranch();
        if (branch) prefix += theme.fg("dim", ` (${branch})`);
        const sessionName = ctx.sessionManager.getSessionName();
        if (sessionName) prefix += theme.fg("dim", ` • ${sessionName}`);
        const costPart =
          cost > 0
            ? ` ${theme.fg("dim", `$${cost < 0.01 ? cost.toFixed(3) : cost.toFixed(2)} •`)}`
            : "";
        const contextPart = ` ${contextColored}`;
        // When horizontal space is tight, drop pieces in order: (provider) prefix,
        // flatten cwd to its basename, then the session cost
        const leftFull = cwdSection + prefix + costPart + contextPart;
        const leftFlat =
          theme.fg("muted", lastName) + prefix + costPart + contextPart;
        const leftFlatNoCost =
          theme.fg("muted", lastName) + prefix + contextPart;

        // Line 1 right: [active agent •] (provider) model • thinking
        let modelSide = theme.fg(
          "muted",
          ctx.model?.name || ctx.model?.id || "no-model",
        );
        if (ctx.model?.reasoning) {
          const level = pi.getThinkingLevel() || "off";
          const thinkingSuffix =
            level === "off" ? " • thinking off" : ` • ${level}`;
          modelSide += theme.fg(
            THINKING_COLORS[level] ?? "dim",
            thinkingSuffix,
          );
        }
        const activeAgent = statuses.get("active-agent");
        const agentPrefix = activeAgent
          ? `${activeAgent}${theme.fg("dim", " • ")}`
          : "";
        const rightLean = `${agentPrefix}${modelSide}`;
        const rightFull =
          footerData.getAvailableProviderCount() > 1 && ctx.model
            ? `${theme.fg("dim", `(${ctx.model.provider}) `)}${rightLean}`
            : rightLean;

        const fits = (l: string, r: string) =>
          visibleWidth(l) + 2 + visibleWidth(r) <= contentWidth;
        let usedLeft = leftFull;
        let usedRight = rightFull;
        if (!fits(usedLeft, usedRight)) {
          usedRight = rightLean;
          if (!fits(usedLeft, usedRight)) {
            usedLeft = leftFlat;
            if (!fits(usedLeft, usedRight)) {
              usedLeft = leftFlatNoCost;
            }
          }
        }

        const leftWidth = visibleWidth(usedLeft);
        const rightWidth = visibleWidth(usedRight);
        let mainLine: string;
        if (leftWidth + 2 + rightWidth <= contentWidth) {
          mainLine =
            usedLeft +
            theme.fg("dim", " ".repeat(contentWidth - leftWidth - rightWidth)) +
            usedRight;
        } else {
          const availableForLeft = contentWidth - rightWidth - 2;
          if (availableForLeft > 0) {
            const truncatedLeft = truncateToWidth(
              usedLeft,
              availableForLeft,
              theme.fg("dim", "..."),
            );
            const padding = " ".repeat(
              Math.max(
                0,
                contentWidth - visibleWidth(truncatedLeft) - rightWidth,
              ),
            );
            mainLine = truncatedLeft + theme.fg("dim", padding) + usedRight;
          } else {
            mainLine = truncateToWidth(usedRight, contentWidth, "");
          }
        }

        const lines: string[] = [padFooterLine(mainLine, width)];

        // Line 2 (toggled with /footer-more-stats): token stats • MCP badge • other statuses
        if (showMoreStats) {
          const tokenBits: string[] = [];
          if (input) tokenBits.push(`↑${formatTokens(input)}`);
          if (output) tokenBits.push(`↓${formatTokens(output)}`);
          if (cacheRead > 0 && cacheHitRate !== undefined) {
            tokenBits.push(`¢${cacheHitRate.toFixed(1)}%`);
          }
          const statusBits = Array.from(statuses.entries())
            .filter(([key]) => key !== "active-agent")
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, text]) => {
              if (key !== "mcp") return sanitize(text);
              const plain = stripAnsi(sanitize(text));
              // Adapter formats: "MCP 2/3" (compact), "3 servers enabled (2 connected)" (full), "MCP: 2/3 servers" (legacy)
              const slash = plain.match(/MCP:?\s+(\d+)\s*\/\s*(\d+)/i);
              if (slash)
                return theme.fg("accent", `🔌 ${slash[1]}/${slash[2]}`);
              const connected = plain.match(
                /(\d+)\s+servers?\s+(?:enabled\b[^(]*)?\((\d+)\s+connected\)/i,
              );
              if (connected)
                return theme.fg("accent", `🔌 ${connected[2]}/${connected[1]}`);
              const count = plain.match(/(\d+)/);
              return theme.fg(
                "accent",
                count ? `🔌 ${count[1]}` : plain.replace(/^MCP:?\s*/i, ""),
              );
            })
            .filter((bit) => visibleWidth(bit) > 0);
          const secondBits: string[] = [];
          if (tokenBits.length > 0)
            secondBits.push(theme.fg("dim", tokenBits.join(" ")));
          if (statusBits.length > 0) secondBits.push(statusBits.join(" "));
          const secondLine = secondBits.join(theme.fg("dim", " • "));
          if (secondLine) {
            lines.push(
              padFooterLine(
                truncateToWidth(
                  secondLine,
                  contentWidth,
                  theme.fg("dim", "..."),
                ),
                width,
              ),
            );
          }
        }
        return lines;
      }

      return {
        dispose() {
          unsubBranch();
          if (requestFooterRender === rerender) requestFooterRender = undefined;
        },
        invalidate() {},
        render,
      };
    });
  });
}
