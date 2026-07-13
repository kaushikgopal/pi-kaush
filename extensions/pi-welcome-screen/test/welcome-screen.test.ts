import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@earendil-works/pi-coding-agent", () => ({
  VERSION: "0.80.6",
  getAgentDir: () => "/tmp/pi-agent",
}));
vi.mock("@earendil-works/pi-tui", () => ({
  truncateToWidth(text: string, width: number, suffix = "") {
    if (text.length <= width) return text;
    const clippedSuffix = suffix.slice(0, Math.max(0, width));
    return (
      text.slice(0, Math.max(0, width - clippedSuffix.length)) + clippedSuffix
    );
  },
  visibleWidth(text: string) {
    return text.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "").length;
  },
  wrapTextWithAnsi(text: string, width: number) {
    if (width <= 0) return [""];
    const lines: string[] = [];
    for (let offset = 0; offset < text.length; offset += width) {
      lines.push(text.slice(offset, offset + width));
    }
    return lines.length > 0 ? lines : [""];
  },
}));

const {
  default: welcomeScreen,
  normalizeExtensionName,
  parseWelcomeResources,
  renderCenteredWelcome,
} = await import("../src/index.ts");

const plainTheme = {
  bold: (text: string) => text,
  fg: (_color: string, text: string) => text,
};

function emptyComponent() {
  return {
    invalidate() {},
    render() {
      return [];
    },
  };
}

function sectionRows(
  lines: string[],
  title: string,
  nextTitle: string,
): string[] {
  const start = lines.findIndex((line) => line.includes(`[${title}]`));
  const next = lines.findIndex(
    (line, index) => index > start && line.includes(`[${nextTitle}]`),
  );
  const end = next === -1 ? lines.length : next;
  return lines.slice(start + 1, end).filter((line) => line.trim());
}

const originalOffline = process.env.PI_OFFLINE;

beforeEach(() => {
  process.env.PI_OFFLINE = "1";
});

afterEach(() => {
  if (originalOffline === undefined) delete process.env.PI_OFFLINE;
  else process.env.PI_OFFLINE = originalOffline;
});

describe("welcome resource formatting", () => {
  test("uses only requested Pi sections and converts lists to names", () => {
    const resources = parseWelcomeResources(
      `
\x1b[33m[Context]\x1b[0m
  ~/.pi/agent/AGENTS.md, AGENTS.md
[Skills]
  artifactor, research,
  librarian
[Prompts]
  /implement, /review
[Extensions]
  @scope/package:src/index.ts, /tmp/custom-footer.ts, subagent/index.ts,
  @scope/package:src/extra.ts, pi-web-access
[Themes]
  dracula
[Extension issues]
  ignored warning
`,
      new Set(["custom-footer", "subagent"]),
    );

    expect(resources).toEqual({
      context: ["~/.pi/agent/AGENTS.md", "AGENTS.md"],
      skills: ["artifactor", "research", "librarian"],
      prompts: ["/implement", "/review"],
      extensions: [
        "custom-footer",
        "pi-web-access",
        "subagent",
        "@scope/package",
      ],
      vendoredExtensions: ["pi-web-access", "@scope/package"],
    });
  });

  test("normalizes local and package extension labels", () => {
    expect(normalizeExtensionName("custom-footer.ts")).toBe("custom-footer");
    expect(normalizeExtensionName("subagent/index.ts")).toBe("subagent");
    expect(
      normalizeExtensionName(
        "C:\\Users\\kg\\.pi\\agent\\extensions\\welcome-screen.ts",
      ),
    ).toBe("welcome-screen");
    expect(normalizeExtensionName("/tmp/pi-welcome-screen/src/index.ts")).toBe(
      "pi-welcome-screen",
    );
    expect(normalizeExtensionName("@ff-labs/pi-fff:src/index.ts")).toBe(
      "@ff-labs/pi-fff",
    );
    expect(
      normalizeExtensionName("pi-web-access:extensions/web-search.ts"),
    ).toBe("pi-web-access");
  });

  test("keeps context files in load order and renders one item per row", () => {
    const loadOrder = [
      "zeta/AGENTS.md",
      "alpha/AGENTS.md",
      "middle/AGENTS.md",
      "project/AGENTS.md",
      "feature/AGENTS.md",
      "local/AGENTS.md",
      "nested/AGENTS.md",
    ];
    const resources = parseWelcomeResources(
      `[Context]\n  ${loadOrder.join(", ")}`,
    );
    expect(resources.context).toEqual(loadOrder);

    const rendered = renderCenteredWelcome(resources, plainTheme as never, 100);
    const contextRows = sectionRows(rendered, "Context", "Skills");
    expect(contextRows).toHaveLength(loadOrder.length);
    expect(
      contextRows.every((row) => (row.match(/•/g)?.length ?? 0) === 1),
    ).toBe(true);
    expect(
      contextRows.map((row) => row.slice(row.indexOf("•") + 1).trim()),
    ).toEqual(loadOrder);
  });

  test("uses two columns for long labels and safely truncates exceptional ones", () => {
    const labels = Array.from(
      { length: 14 },
      (_, index) => `item-${index + 1}`,
    );
    labels[3] = "audit-kb-for-consistency";
    const resources = {
      context: [],
      skills: labels,
      prompts: [],
      extensions: Array.from(
        { length: 14 },
        (_, index) => `extension-${index + 1}`,
      ),
    };

    const wide = renderCenteredWelcome(resources, plainTheme as never, 100);
    const skillRows = sectionRows(wide, "Skills", "Prompts");
    const extensionRows = sectionRows(wide, "Extensions", "missing");
    expect(skillRows).toHaveLength(7);
    expect(extensionRows).toHaveLength(7);
    expect(skillRows.every((row) => (row.match(/•/g)?.length ?? 0) <= 2)).toBe(
      true,
    );
    expect(
      extensionRows.every((row) => (row.match(/•/g)?.length ?? 0) <= 2),
    ).toBe(true);
    expect(skillRows.join("\n")).toContain("audit-kb-for-consistency");
    expect(skillRows.join("\n")).not.toContain("…");

    const exceptional = { ...resources, skills: [...labels] };
    exceptional.skills[3] = "exceptionally-long-label-".repeat(3);
    const truncated = renderCenteredWelcome(
      exceptional,
      plainTheme as never,
      100,
    );
    expect(sectionRows(truncated, "Skills", "Prompts").join("\n")).toContain(
      "…",
    );
  });

  test("centers an 80-column layout and remains within narrow terminals", () => {
    const resources = {
      context: ["AGENTS.md"],
      skills: ["artifactor", "research"],
      prompts: ["/implement"],
      extensions: ["welcome-screen"],
    };

    const wide = renderCenteredWelcome(resources, plainTheme as never, 100);
    const versionSummaryIndex = wide.findIndex((line) =>
      line.includes("v0.80.6"),
    );
    const lastLogoLineIndex = wide
      .map((line) => line.includes("█"))
      .lastIndexOf(true);
    expect(wide[versionSummaryIndex]?.trim()).toBe("v0.80.6");
    expect(wide[lastLogoLineIndex + 1]).toBe("");
    expect(versionSummaryIndex).toBe(lastLogoLineIndex + 2);
    expect(wide.every((line) => line.length <= 100)).toBe(true);
    expect(wide.join("\n")).not.toContain("[Themes]");
    expect(wide.join("\n")).not.toContain("[Version]");
    expect(wide.filter((line) => line.includes("█"))).toHaveLength(4);
    expect(wide.some((line) => line.includes("██████   ███"))).toBe(true);

    const narrow = renderCenteredWelcome(resources, plainTheme as never, 24);
    expect(narrow.every((line) => line.length <= 24)).toBe(true);
  });

  test("uses a vertically centered brand column only when the terminal is wide", () => {
    const resources = {
      context: ["AGENTS.md"],
      skills: ["artifactor"],
      prompts: ["/implement"],
      extensions: ["welcome-screen"],
    };

    const wide = renderCenteredWelcome(resources, plainTheme as never, 124);
    const firstResourceRow = wide.findIndex((line) =>
      line.includes("[Context]"),
    );
    const lastResourceRow = wide.findIndex((line) =>
      line.includes("welcome-screen"),
    );
    const firstLogoRow = wide.findIndex((line) => line.includes("█"));
    const versionRow = wide.findIndex((line) => line.includes("v0.80.6"));
    const resourceColumn = wide[firstResourceRow]?.indexOf("[Context]");

    expect(firstResourceRow).toBe(0);
    expect(resourceColumn).toBe(44);
    expect(firstLogoRow).toBeGreaterThan(firstResourceRow);
    expect(versionRow).toBeLessThan(lastResourceRow);
    const rowsAboveBrand = firstLogoRow - firstResourceRow;
    const rowsBelowBrand = lastResourceRow - versionRow;
    expect(Math.abs(rowsAboveBrand - rowsBelowBrand)).toBeLessThanOrEqual(1);
    expect(wide.every((line) => line.length <= 124)).toBe(true);

    const tight = renderCenteredWelcome(resources, plainTheme as never, 100);
    const tightVersionRow = tight.findIndex((line) => line.includes("v0.80.6"));
    const tightContextRow = tight.findIndex((line) =>
      line.includes("[Context]"),
    );
    expect(tightContextRow).toBeGreaterThan(tightVersionRow);
  });

  test("columns local extensions and lists vendored packages separately", () => {
    const extensions = [
      "@ff-labs/pi-fff",
      "@juicesharp/rpiv-ask-user-question",
      "@juicesharp/rpiv-todo",
      "ast-grep",
      "custom-footer",
      "custom-input-editor",
      "custom-tool-routing",
      "herdr-agent-state",
      "inline-skill-identifier",
      "mitsupi",
      "pi-mcp-adapter",
      "pi-web-access",
      "read-plus",
      "split-fork",
      "subagent",
      "tool-call-markers",
      "welcome-screen",
    ];
    const resources = {
      context: ["AGENTS.md"],
      skills: Array.from({ length: 14 }, (_, index) => `skill-${index + 1}`),
      prompts: ["/implement"],
      extensions,
      vendoredExtensions: [
        "@ff-labs/pi-fff",
        "@juicesharp/rpiv-ask-user-question",
        "@juicesharp/rpiv-todo",
        "pi-mcp-adapter",
        "pi-web-access",
      ],
    };

    const wide = renderCenteredWelcome(resources, plainTheme as never, 100);
    const skillRows = sectionRows(wide, "Skills", "Prompts");
    const extensionRows = sectionRows(wide, "Extensions", "missing");
    const firstPackageRow = extensionRows.findIndex((row) =>
      resources.vendoredExtensions.some((name) => row.includes(name)),
    );
    const firstPackageLine = wide.findIndex((row) =>
      resources.vendoredExtensions.some((name) => row.includes(name)),
    );
    const localExtensionRows = extensionRows.slice(0, firstPackageRow);
    const packageExtensionRows = extensionRows.slice(firstPackageRow);
    expect(firstPackageRow).toBeGreaterThan(0);
    expect(wide[firstPackageLine - 1]).toBe("");
    expect(skillRows.length).toBeLessThanOrEqual(6);
    expect(localExtensionRows).toHaveLength(4);
    expect(
      localExtensionRows.every((row) => (row.match(/•/g)?.length ?? 0) <= 3),
    ).toBe(true);
    expect(
      skillRows.reduce(
        (count, row) => count + (row.match(/•/g)?.length ?? 0),
        0,
      ),
    ).toBe(14);
    expect(
      localExtensionRows.reduce(
        (count, row) => count + (row.match(/•/g)?.length ?? 0),
        0,
      ),
    ).toBe(12);
    expect(
      packageExtensionRows.reduce(
        (count, row) => count + (row.match(/•/g)?.length ?? 0),
        0,
      ),
    ).toBe(5);
    expect(
      packageExtensionRows.every((row) => (row.match(/•/g)?.length ?? 0) <= 1),
    ).toBe(true);
    expect(skillRows.some((row) => (row.match(/•/g)?.length ?? 0) > 1)).toBe(
      true,
    );
    expect(
      localExtensionRows.some((row) => (row.match(/•/g)?.length ?? 0) === 3),
    ).toBe(true);
    expect(packageExtensionRows.join("\n")).toContain(
      "@juicesharp/rpiv-ask-user-question",
    );
    expect(packageExtensionRows.join("\n")).toContain("pi-mcp-adapter");
    expect(packageExtensionRows.join("\n")).toContain("pi-web-access");
    expect(localExtensionRows.join("\n")).not.toContain("pi-mcp-adapter");
    expect(localExtensionRows.join("\n")).not.toContain("pi-web-access");
    expect(extensionRows.join("\n")).not.toContain("…");

    const narrow = renderCenteredWelcome(resources, plainTheme as never, 24);
    expect(sectionRows(narrow, "Skills", "Prompts")).toHaveLength(14);
  });

  test("uses heading color for labels and dim gray for every information row", () => {
    const colorCalls: Array<{ color: string; text: string }> = [];
    const recordingTheme = {
      bold: (text: string) => text,
      fg(color: string, text: string) {
        colorCalls.push({ color, text });
        return text;
      },
    };

    renderCenteredWelcome(
      {
        context: ["AGENTS.md"],
        skills: ["artifactor"],
        prompts: ["/implement"],
        extensions: ["welcome-screen"],
      },
      recordingTheme as never,
      80,
    );

    expect(colorCalls.find(({ text }) => text === "[Context]")?.color).toBe(
      "mdHeading",
    );
    expect(colorCalls.find(({ text }) => text === "v0.80.6")?.color).toBe(
      "dim",
    );
    expect(
      colorCalls.some(
        ({ color }) => color === "warning" || color === "success",
      ),
    ).toBe(false);
    expect(colorCalls.find(({ text }) => text === "artifactor")?.color).toBe(
      "dim",
    );
    expect(colorCalls.find(({ text }) => text.includes("•"))?.color).toBe(
      "dim",
    );
    expect(
      colorCalls
        .filter(({ color }) => color === "accent")
        .every(({ text }) => text.includes("█")),
    ).toBe(true);
  });
});

describe("welcome resource-panel bridge", () => {
  test("does not install a header outside TUI mode", () => {
    let sessionStart: ((event: unknown, context: any) => void) | undefined;
    welcomeScreen({
      on(event: string, handler: (event: unknown, context: any) => void) {
        if (event === "session_start") sessionStart = handler;
      },
    } as never);

    let headerInstalls = 0;
    sessionStart?.(
      {},
      {
        mode: "json",
        ui: {
          setHeader() {
            headerInstalls += 1;
          },
        },
      },
    );
    expect(headerInstalls).toBe(0);
  });

  test("waits for populated resources, caches them, and restores the panel", async () => {
    let sessionStart: ((event: unknown, context: any) => void) | undefined;
    welcomeScreen({
      on(event: string, handler: (event: unknown, context: any) => void) {
        if (event === "session_start") sessionStart = handler;
      },
    } as never);

    let headerFactory:
      | ((
          tui: any,
          theme: any,
        ) => { render(width: number): string[]; dispose?(): void })
      | undefined;
    sessionStart?.(
      {},
      {
        mode: "tui",
        ui: {
          setHeader(factory: typeof headerFactory) {
            headerFactory = factory;
          },
        },
      },
    );

    let resourceReads = 0;
    const resourceComponent = {
      ...emptyComponent(),
      getCollapsedText() {
        resourceReads += 1;
        return [
          "[Context]",
          "  AGENTS.md",
          "[Skills]",
          "  artifactor",
          "[Prompts]",
          "  /implement",
          "[Extensions]",
          "  src",
        ].join("\n");
      },
    };
    const themeComponent = {
      ...emptyComponent(),
      getCollapsedText() {
        return "[Themes]\n  dracula";
      },
    };
    const panel = {
      children: [] as Array<typeof resourceComponent | typeof themeComponent>,
      invalidate() {},
      render() {
        return [];
      },
    };
    const children = [
      { ...emptyComponent(), children: [] },
      panel,
      ...Array.from({ length: 7 }, emptyComponent),
    ];
    const tui = {
      children,
      removeChild(component: unknown) {
        const index = this.children.indexOf(component as never);
        if (index !== -1) this.children.splice(index, 1);
      },
      requestRender() {},
    };

    const header = headerFactory?.(tui, plainTheme);
    expect(tui.children).not.toContain(panel);
    const loadingRender = header?.render(80).join("\n");
    expect(loadingRender).not.toContain("[Context]");
    expect(loadingRender).not.toContain("(none)");
    await new Promise((resolve) => setTimeout(resolve, 0));
    panel.children.push(resourceComponent, themeComponent);
    expect(header?.render(80).join("\n")).not.toContain("[Context]");
    await new Promise((resolve) => setTimeout(resolve, 80));
    const firstRender = header?.render(80);
    expect(firstRender?.join("\n")).toContain("• AGENTS.md");
    expect(tui.children).not.toContain(panel);
    expect(header?.render(80)).toBe(firstRender);
    const readsAfterCapture = resourceReads;
    header?.render(80);
    expect(resourceReads).toBe(readsAfterCapture);

    header?.dispose?.();
    expect(tui.children[1]).toBe(panel);
  });

  async function expectNativePanelFallback(options: {
    nativeComponent?: any;
    heading?: string;
    waitMs?: number;
  }) {
    let sessionStart: ((event: unknown, context: any) => void) | undefined;
    welcomeScreen({
      on(event: string, handler: (event: unknown, context: any) => void) {
        if (event === "session_start") sessionStart = handler;
      },
    } as never);

    let headerFactory:
      | ((
          tui: any,
          theme: any,
        ) => { render(width: number): string[]; dispose?(): void })
      | undefined;
    sessionStart?.(
      { reason: "startup" },
      {
        mode: "tui",
        ui: {
          setHeader(factory: typeof headerFactory) {
            headerFactory = factory;
          },
        },
      },
    );

    const resourceComponent = {
      ...emptyComponent(),
      getCollapsedText() {
        return [
          "[Context]",
          "  AGENTS.md",
          "[Skills]",
          "  artifactor",
          "[Prompts]",
          "  /implement",
          "[Extensions]",
          "  @pi-kaush/pi-welcome-screen:src/index.ts",
        ].join("\n");
      },
    };
    const spacer = emptyComponent();
    const originalPanelChildren = options.nativeComponent
      ? [resourceComponent, spacer, options.nativeComponent]
      : [];
    const panel = {
      children: [] as any[],
      invalidate() {},
      render() {
        return this.children.flatMap((child) => child.render(1_000));
      },
    };
    const children = [
      { ...emptyComponent(), children: [] },
      panel,
      ...Array.from({ length: 7 }, emptyComponent),
    ];
    const tui = {
      children,
      removeChild(component: unknown) {
        const index = this.children.indexOf(component as never);
        if (index !== -1) this.children.splice(index, 1);
      },
      requestRender() {},
    };

    const header = headerFactory?.(tui, plainTheme);
    expect(tui.children).not.toContain(panel);
    await new Promise((resolve) => setTimeout(resolve, 0));
    panel.children.push(...originalPanelChildren);
    await new Promise((resolve) => setTimeout(resolve, options.waitMs ?? 80));

    const renderedHeader = header?.render(80).join("\n") ?? "";
    expect(renderedHeader).toContain("█████████");
    expect(renderedHeader).not.toContain("[Context]");
    expect(tui.children[1]).toBe(panel);
    expect(panel.children).toEqual(originalPanelChildren);
    if (options.heading) {
      expect(panel.render().join("\n")).toContain(options.heading);
    }

    header?.dispose?.();
    expect(tui.children.filter((child) => child === panel)).toHaveLength(1);
  }

  test("keeps the custom brand and restores Pi's untouched panel for diagnostics", () =>
    expectNativePanelFallback({
      nativeComponent: {
        invalidate() {},
        render: () => ["[Extension issues]", "  broken-extension.ts"],
      },
      heading: "[Extension issues]",
    }));

  test("keeps the custom brand and restores Pi's untouched panel for unknown native sections", () =>
    expectNativePanelFallback({
      nativeComponent: {
        invalidate() {},
        getCollapsedText: () => "[Future startup info]\n  important detail",
        render: () => ["[Future startup info]", "  important detail"],
      },
      heading: "[Future startup info]",
    }));

  test("restores Pi's native panel after three resource retries", () =>
    expectNativePanelFallback({ waitMs: 180 }));
});
