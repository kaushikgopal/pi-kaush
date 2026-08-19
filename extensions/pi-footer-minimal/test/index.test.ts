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

function createHarness() {
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, (args: string, ctx: unknown) => unknown>();
  const workingVisibility: boolean[] = [];
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
    getThinkingLevel: () => "off",
  } as never);

  const context = {
    mode: "tui",
    model: {
      id: "model",
      name: "model",
      provider: "provider",
      reasoning: false,
      contextWindow: 262_000,
    },
    sessionManager: {
      getCwd: () => "/workspace/very/long/project",
      getSessionName: () => "session",
      getEntries: () => [
        {
          type: "message",
          message: {
            role: "assistant",
            usage: {
              input: 1,
              output: 1,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 2,
              cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: 1.23,
              },
            },
          },
        },
      ],
    },
    getContextUsage: () => ({ percent: 44.6, contextWindow: 262_000 }),
    ui: {
      setFooter(factory: typeof footerFactory) {
        footerFactory = factory;
      },
      setWorkingVisible(visible: boolean) {
        workingVisibility.push(visible);
      },
      notify() {},
    },
  };

  const fire = (event: string, ctx: Record<string, any> = context) =>
    handlers.get(event)?.({}, ctx);

  return {
    context,
    commands,
    fire,
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
        theme,
        {
          getExtensionStatuses: () => new Map(),
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

  test("drops path and cost before clipping the model", () => {
    const harness = createHarness();
    const footer = harness.start();

    const leftLean = "project (branch) • session 44.6%/262k";
    const rightCore = "model";
    const line = mainLine(footer, widthFor(leftLean, rightCore) - 1);
    expect(line).not.toContain("Working…");
    expect(line).not.toContain("$1.23");
    expect(line).not.toContain("(provider)");
    expect(line).toMatch(/model\s+$/);
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
