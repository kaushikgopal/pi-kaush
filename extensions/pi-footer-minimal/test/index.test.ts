import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, test, vi } from "vitest";
import registerFooter from "../src/index.ts";

type Footer = {
  render(width: number): string[];
  dispose(): void;
  invalidate(): void;
};

type Handler = (event: unknown, context: Record<string, any>) => void;

const theme = {
  fg: (_color: string, text: string) => text,
};

type HarnessOptions = {
  entries?: any[];
  contextUsage?: { percent: number | null; contextWindow: number } | undefined;
  statuses?: Map<string, string>;
  model?: Partial<{
    id: string;
    name: string;
    provider: string;
    reasoning: boolean;
    contextWindow: number;
  }>;
  thinkingLevel?: string;
  footerTheme?: { fg(color: string, text: string): string };
};

function usageEntry(
  input: number,
  output: number,
  cacheRead = 0,
  cacheWrite = 0,
  totalCost = 0,
) {
  return {
    type: "message",
    message: {
      role: "assistant",
      usage: {
        input,
        output,
        cacheRead,
        cacheWrite,
        totalTokens: input + output + cacheRead + cacheWrite,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: totalCost,
        },
      },
    },
  };
}

function createHarness(options: HarnessOptions = {}) {
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, (args: string, ctx: unknown) => unknown>();
  const workingVisibility: boolean[] = [];
  const notifications: Array<{ message: string; level: string }> = [];
  let footerFactory:
    | ((tui: any, theme: any, footerData: any) => Footer)
    | undefined;
  let renderRequests = 0;

  registerFooter({
    registerCommand(
      name: string,
      def: { handler: (args: string, ctx: unknown) => unknown },
    ) {
      commands.set(name, def.handler);
    },
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
    },
    getThinkingLevel: () => options.thinkingLevel ?? "off",
  } as never);

  const context = {
    mode: "tui",
    model: {
      id: "model",
      name: "model",
      provider: "provider",
      reasoning: false,
      contextWindow: 262_000,
      ...options.model,
    },
    sessionManager: {
      getCwd: () => "/workspace/very/long/project",
      getSessionName: () => "session",
      getEntries: () => options.entries ?? [usageEntry(1, 1, 0, 0, 1.23)],
    },
    getContextUsage: () =>
      "contextUsage" in options
        ? options.contextUsage
        : { percent: 44.6, contextWindow: 262_000 },
    ui: {
      setFooter(factory: typeof footerFactory) {
        footerFactory = factory;
      },
      setWorkingVisible(visible: boolean) {
        workingVisibility.push(visible);
      },
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
    },
  };

  const fire = (event: string, ctx: Record<string, any> = context) =>
    handlers.get(event)?.({}, ctx);

  return {
    context,
    commands,
    fire,
    notifications,
    workingVisibility,
    get renderRequests() {
      return renderRequests;
    },
    start(mode = "tui"): Footer {
      fire("session_start", { ...context, mode });
      if (!footerFactory) throw new Error("footer was not registered");
      return footerFactory(
        {
          requestRender() {
            renderRequests++;
          },
        },
        options.footerTheme ?? theme,
        {
          getExtensionStatuses: () => options.statuses ?? new Map(),
          getGitBranch: () => "branch",
          getAvailableProviderCount: () => 2,
          onBranchChange: () => () => {},
        },
      );
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

/** Full width for left + right: 2-column edge pad on both sides + 2-column gap. */
function widthFor(left: string, right: string): number {
  return 2 + visibleWidth(left) + 2 + visibleWidth(right) + 2;
}

function mainLine(footer: Footer, width: number): string {
  return footer.render(width)[1]!;
}

function plain(text: string): string {
  return text.replace(/\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
}

describe("edge padding", () => {
  test("prepends one blank separator row above the footer", () => {
    const harness = createHarness();
    const footer = harness.start();

    const lines = footer.render(80);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(lines[0]).toBe("");
    expect(visibleWidth(lines[1] ?? "")).toBeGreaterThan(0);
  });

  test("insets both footer lines by two columns from each edge", () => {
    const harness = createHarness();
    const footer = harness.start();
    harness.commands.get("footer-more-stats")?.("on", harness.context);

    const lines = footer.render(80);
    expect(lines).toHaveLength(3);
    expect(lines[1]).not.toContain("(provider)");
    expect(lines[2]).toContain("(provider)");
    for (const line of lines.slice(1)) {
      expect(visibleWidth(line)).toBe(80);
      expect(line.startsWith("  ")).toBe(true);
      expect(line.endsWith("  ")).toBe(true);
      expect(line[2]).not.toBe(" ");
    }
  });

  test("drops the inset decoration before clipping content at tiny widths", () => {
    const harness = createHarness();
    const footer = harness.start();
    for (const width of [4, 3, 1]) {
      const line = mainLine(footer, width);
      expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      expect(line.startsWith(" ")).toBe(false);
    }
  });

  test("budgets the full width for content below the inset threshold", () => {
    const harness = createHarness();
    const footer = harness.start();
    for (const width of [4, 3]) {
      const line = mainLine(footer, width);
      expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      // With the decoration dropped, more than a single cell of content
      // remains visible.
      expect(visibleWidth(line.trimEnd())).toBeGreaterThan(1);
    }
  });
});

describe("narrow footer degradation", () => {
  test("drops fields in order before truncating the left side", () => {
    const footer = createHarness().start();
    const full =
      "/workspace/very/long/project (branch) • session $1.23 • 44.6%/262k";
    const flat = "project (branch) • session $1.23 • 44.6%/262k";
    const noCost = "project (branch) • session 44.6%/262k";
    const right = "model";
    const render = (width: number) => mainLine(footer, width).trim();

    expect(render(widthFor(full, right))).toBe(`${full}  ${right}`);
    expect(render(widthFor(flat, right))).toBe(`${flat}  ${right}`);
    expect(render(widthFor(noCost, right))).toBe(`${noCost}  ${right}`);

    const truncated = render(widthFor(noCost, right) - 1);
    expect(truncated).toContain("...");
    expect(truncated).not.toContain("$1.23");
    expect(truncated).toMatch(/model$/);
  });

  test("drops the active agent before clipping the model", () => {
    const harness = createHarness({
      statuses: new Map([["active-agent", "Working…"]]),
    });
    const footer = harness.start();

    const leftLean = "project (branch) • session 44.6%/262k";
    const rightWithAgent = "Working… • model";
    expect(
      mainLine(footer, widthFor(leftLean, rightWithAgent)).trim(),
    ).toContain(rightWithAgent);

    const line = mainLine(footer, widthFor(leftLean, rightWithAgent) - 1);
    expect(line).not.toContain("Working…");
    expect(line).not.toContain("$1.23");
    expect(line).toMatch(/model\s+$/);
  });
});

describe("usage and context", () => {
  test("calculates the cache hit rate from cumulative usage", () => {
    const harness = createHarness({
      entries: [usageEntry(100, 10, 900), usageEntry(900, 20, 100, 1_000)],
    });
    const footer = harness.start();
    harness.commands.get("footer-more-stats")?.("on", harness.context);

    expect(footer.render(100)[2]).toContain("↑1.0k ↓30 ¢33.3%");
  });

  test.each([
    [undefined, "?/262k"],
    [{ percent: null, contextWindow: 262_000 }, "?/262k"],
  ])("renders unavailable context as unknown", (contextUsage, expected) => {
    const footer = createHarness({ contextUsage }).start();
    const line = mainLine(footer, 100);

    expect(line).toContain(expected);
    expect(line).not.toContain("0.0%/262k");
  });

  test.each([
    [59.9, "muted"],
    [60, "warning"],
    [80, "error"],
  ])("colors %s%% context as %s", (percent, expectedColor) => {
    const footer = createHarness({
      contextUsage: { percent, contextWindow: 262_000 },
      footerTheme: {
        fg: (color, text) => `[${color}]${text}[/${color}]`,
      },
    }).start();

    expect(mainLine(footer, 200)).toContain(
      `[${expectedColor}]${percent.toFixed(1)}%/262k[/${expectedColor}]`,
    );
  });
});

describe("extension status and command boundaries", () => {
  test.each([
    ["MCP 2/3", "🔌 2/3"],
    ["3 servers enabled (2 connected)", "🔌 2/3"],
    ["MCP: 4/5 servers", "🔌 4/5"],
  ])("compacts MCP status %s", (status, expected) => {
    const harness = createHarness({
      statuses: new Map([["mcp", status]]),
    });
    const footer = harness.start();
    harness.commands.get("footer-more-stats")?.("on", harness.context);

    expect(footer.render(100)[2]).toContain(expected);
  });

  test("shows the selected thinking level and color", () => {
    const footer = createHarness({
      model: { reasoning: true },
      thinkingLevel: "high",
      footerTheme: {
        fg: (color, text) =>
          `\x1b[${color === "thinkingHigh" ? "35" : "0"}m${text}\x1b[0m`,
      },
    }).start();

    expect(mainLine(footer, 200)).toContain("\x1b[35m • high\x1b[0m");
  });

  test("warns without changing state for an invalid stats command", async () => {
    const harness = createHarness();
    const footer = harness.start();
    expect(footer.render(100)).toHaveLength(2);

    await harness.commands.get("footer-more-stats")?.(
      "sometimes",
      harness.context,
    );

    expect(harness.notifications).toEqual([
      {
        message: "Usage: /footer-more-stats [on|off|toggle]",
        level: "warning",
      },
    ]);
    expect(harness.renderRequests).toBe(0);
    expect(footer.render(100)).toHaveLength(2);
  });
});

describe("working state", () => {
  test("never touches native working visibility", () => {
    const harness = createHarness();
    const footer = harness.start();
    harness.fire("agent_start");
    harness.fire("agent_end");
    footer.dispose();
    harness.fire("session_shutdown");
    expect(harness.workingVisibility).toEqual([]);
  });

  test("does not touch native working visibility outside TUI mode", () => {
    const harness = createHarness();
    expect(() => harness.start("rpc")).toThrow("footer was not registered");
    expect(harness.workingVisibility).toEqual([]);

    harness.fire("session_shutdown");
    expect(harness.workingVisibility).toEqual([]);
  });

  test("keeps only the model on the right with no braille indicator", () => {
    const harness = createHarness();
    const footer = harness.start();

    expect(plain(mainLine(footer, 12)).trimEnd()).toMatch(/model$/);
    expect(mainLine(footer, 12)).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
  });
});
