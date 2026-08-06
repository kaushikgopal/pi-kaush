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

function bulletRows(lines: string[]): string[] {
  return lines.filter((line) => line.includes("•"));
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
        "subagent/index.ts",
        "pi-web-access",
        "@scope/package",
      ],
      packageExtensions: ["pi-web-access", "@scope/package"],
      sourceExtensions: [],
    });
  });

  test("normalizes local and package extension labels without hiding index paths", () => {
    expect(normalizeExtensionName("custom-footer.ts")).toBe("custom-footer");
    expect(normalizeExtensionName("subagent/index.ts")).toBe(
      "subagent/index.ts",
    );
    expect(
      normalizeExtensionName(
        "C:\\Users\\kg\\.pi\\agent\\extensions\\welcome-screen.ts",
      ),
    ).toBe("welcome-screen");
    expect(normalizeExtensionName("/tmp/pi-welcome-screen/src/index.ts")).toBe(
      "/tmp/pi-welcome-screen/src/index.ts",
    );
    expect(normalizeExtensionName("@ff-labs/pi-fff:src/index.ts")).toBe(
      "@ff-labs/pi-fff",
    );
    expect(
      normalizeExtensionName("pi-web-access:extensions/web-search.ts"),
    ).toBe("pi-web-access");
  });

  test("shows package extension filenames and abbreviates pinned git revisions", () => {
    const resources = parseWelcomeResources(
      `[Extensions]\n  unified-edit`,
      new Set(),
      [
        "[Extensions]",
        "  user",
        "    git:github.com/mitsuhiko/agent-stuff@c77d49797ad3fb78888e5b002ae606a93777c6b1",
        "      extensions/unified-edit.ts",
      ].join("\n"),
    );

    expect(resources.packageExtensions).toEqual([
      "github.com/mitsuhiko/agent-stuff unified-edit.ts @c77d49",
    ]);
    expect(resources.extensions.join("\n")).not.toContain(
      "c77d49797ad3fb78888e5b002ae606a93777c6b1",
    );
  });

  test("keeps all package extension filenames in expanded order", () => {
    const resources = parseWelcomeResources(
      `[Extensions]\n  zeta, alpha`,
      new Set(),
      [
        "[Extensions]",
        "  user",
        "    git:github.com/example/extensions",
        "      extensions/zeta.ts",
        "      extensions/alpha.ts",
      ].join("\n"),
    );

    expect(resources.packageExtensions).toEqual([
      "github.com/example/extensions zeta.ts alpha.ts",
    ]);
  });

  test("uses expanded provenance to separate local, package, and source extensions", () => {
    const sourcePath = "~/dev/pi-kaush/extensions/pi-double-paste/src";
    const resources = parseWelcomeResources(
      `[Extensions]\n  mitsupi, src, @ff-labs/pi-fff`,
      new Set(["mitsupi"]),
      [
        "[Extensions]",
        "  user",
        "    ~/.pi/agent/extensions/mitsupi",
        "    npm:@ff-labs/pi-fff",
        "      src",
        `    ${sourcePath}`,
      ].join("\n"),
    );

    expect(resources.extensions).toEqual([
      "mitsupi",
      "@ff-labs/pi-fff",
      sourcePath,
    ]);
    expect(resources.packageExtensions).toEqual(["@ff-labs/pi-fff"]);
    expect(resources.sourceExtensions).toEqual([sourcePath]);

    const rendered = renderCenteredWelcome(
      resources,
      plainTheme as never,
      80,
    ).join("\n");
    expect(rendered).toContain("Local");
    expect(rendered).toContain("Packages");
    expect(rendered).toContain("Source paths");
    expect(rendered).toContain(sourcePath);
    expect(rendered).not.toMatch(/• src\s*$/m);
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

    const rendered = renderCenteredWelcome(resources, plainTheme as never, 80);
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

    const wide = renderCenteredWelcome(resources, plainTheme as never, 80);
    const skillRows = sectionRows(wide, "Skills", "Prompts");
    const extensionRows = bulletRows(
      sectionRows(wide, "Extensions", "missing"),
    );
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

    const wide = renderCenteredWelcome(resources, plainTheme as never, 80);
    const versionSummaryIndex = wide.findIndex((line) =>
      line.includes("v0.80.6"),
    );
    const lastLogoLineIndex = wide
      .map((line) => line.includes("█"))
      .lastIndexOf(true);
    expect(wide[versionSummaryIndex]?.trim()).toBe("v0.80.6");
    expect(wide[lastLogoLineIndex + 1]).toBe("");
    expect(versionSummaryIndex).toBe(lastLogoLineIndex + 2);
    expect(wide.every((line) => line.length <= 80)).toBe(true);
    expect(wide.join("\n")).not.toContain("[Themes]");
    expect(wide.join("\n")).not.toContain("[Version]");
    expect(wide.filter((line) => line.includes("█"))).toHaveLength(4);
    expect(wide.some((line) => line.includes("██████   ███"))).toBe(true);

    const narrow = renderCenteredWelcome(resources, plainTheme as never, 24);
    expect(narrow.every((line) => line.length <= 24)).toBe(true);
  });

  test("shows the active theme name alongside the version", () => {
    const resources = {
      context: ["AGENTS.md"],
      skills: ["artifactor"],
      prompts: ["/implement"],
      extensions: ["welcome-screen"],
    };
    const namedTheme = { ...plainTheme, name: "cobalt2" };

    const named = renderCenteredWelcome(resources, namedTheme as never, 80);
    const versionIndex = named.findIndex((line) => line.includes("v0.80.6"));
    expect(named[versionIndex]?.trim()).toBe("v0.80.6 [cobalt2]");

    const unnamed = renderCenteredWelcome(resources, plainTheme as never, 80);
    expect(unnamed.some((line) => line.trim() === "v0.80.6")).toBe(true);
  });

  test("renders the layout notice beneath the version", () => {
    const lines = renderCenteredWelcome(
      undefined,
      plainTheme as never,
      80,
      "pi-welcome-screen: unrecognized Pi layout — using native panel",
    );
    const versionIndex = lines.findIndex((line) => line.includes("v0.80.6"));
    expect(lines[versionIndex + 1]?.trim()).toBe(
      "pi-welcome-screen: unrecognized Pi layout — using native panel",
    );
    expect(lines.every((line) => line.length <= 80)).toBe(true);
  });

  test("uses one, two, or three equal-width grid columns as space allows", () => {
    const resources = {
      context: ["AGENTS.md"],
      skills: ["artifactor"],
      prompts: ["/implement"],
      extensions: [
        "welcome-screen",
        ...Array.from({ length: 11 }, (_, index) => `extension-${index + 1}`),
      ],
    };

    const stacked = renderCenteredWelcome(resources, plainTheme as never, 83);
    expect(
      stacked.findIndex((line) => line.includes("[Context]")),
    ).toBeGreaterThan(stacked.findIndex((line) => line.includes("v0.80.6")));

    const twoColumns = renderCenteredWelcome(
      resources,
      plainTheme as never,
      84,
    );
    expect(
      twoColumns
        .find((line) => line.includes("[Context]"))
        ?.indexOf("[Context]"),
    ).toBe(0);
    expect(
      twoColumns
        .find((line) => line.includes("[Extensions]"))
        ?.indexOf("[Extensions]"),
    ).toBe(44);

    const firstLogoRow = twoColumns.findIndex((line) => line.includes("█"));
    const versionRow = twoColumns.findIndex((line) => line.includes("v0.80.6"));
    const firstResourceRow = twoColumns.findIndex((line) =>
      line.includes("[Context]"),
    );
    expect(twoColumns[firstLogoRow]?.indexOf("█")).toBe(36);
    expect(firstLogoRow).toBe(1);
    expect(firstResourceRow - versionRow - 1).toBe(firstLogoRow);
    expect(
      twoColumns.map((line) => line.includes("extension-11")).lastIndexOf(true),
    ).toBeGreaterThan(
      twoColumns.map((line) => line.includes("/implement")).lastIndexOf(true),
    );

    const threeColumns = renderCenteredWelcome(
      resources,
      plainTheme as never,
      128,
    );
    const threeColumnTopRow = threeColumns.find(
      (line) => line.includes("[Context]") && line.includes("[Extensions]"),
    );
    expect(threeColumnTopRow?.indexOf("[Context]")).toBe(44);
    expect(threeColumnTopRow?.indexOf("[Extensions]")).toBe(88);
    expect(threeColumns.every((line) => !/[\[•]/.test(line.slice(0, 40)))).toBe(
      true,
    );
    const threeColumnFirstLogoRow = threeColumns.findIndex((line) =>
      line.includes("█"),
    );
    const threeColumnVersionRow = threeColumns.findIndex((line) =>
      line.includes("v0.80.6"),
    );
    expect(
      Math.abs(
        threeColumnFirstLogoRow -
          (threeColumns.length - threeColumnVersionRow - 1),
      ),
    ).toBeLessThanOrEqual(1);
    expect(threeColumns.every((line) => line.length <= 128)).toBe(true);
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

    const wide = renderCenteredWelcome(resources, plainTheme as never, 80);
    const skillRows = sectionRows(wide, "Skills", "Prompts");
    const extensionRows = sectionRows(wide, "Extensions", "missing");
    const firstPackageRow = extensionRows.findIndex((row) =>
      resources.vendoredExtensions.some((name) => row.includes(name)),
    );
    const firstPackageLine = wide.findIndex((row) =>
      resources.vendoredExtensions.some((name) => row.includes(name)),
    );
    const localExtensionRows = bulletRows(
      extensionRows.slice(0, firstPackageRow),
    );
    const packageExtensionRows = bulletRows(
      extensionRows.slice(firstPackageRow),
    );
    expect(firstPackageRow).toBeGreaterThan(0);
    expect(wide[firstPackageLine - 1]).toContain("Packages");
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
      getExpandedText() {
        return [
          "[Extensions]",
          "  user",
          "    ~/dev/pi-kaush/extensions/pi-double-paste/src",
          "    ~/dev/pi-kaush/extensions/pi-welcome-screen/src",
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
    expect(firstRender?.join("\n")).toContain(
      "~/dev/pi-kaush/extensions/pi-double-paste/src",
    );
    expect(firstRender?.join("\n")).not.toMatch(/• src\s*$/m);
    expect(tui.children).not.toContain(panel);
    expect(header?.render(80)).toBe(firstRender);
    const readsAfterCapture = resourceReads;
    header?.render(80);
    expect(resourceReads).toBe(readsAfterCapture);

    header?.dispose?.();
    expect(tui.children[1]).toBe(panel);
  });

  test("captures resources from Pi 0.84's nested document container", async () => {
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
          "  src",
        ].join("\n");
      },
      getExpandedText() {
        return [
          "[Extensions]",
          "  user",
          "    ~/dev/pi-kaush/extensions/pi-welcome-screen/src",
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
    const makeContainer = () => ({
      ...emptyComponent(),
      children: [] as any[],
      removeChild(component: unknown) {
        const index = this.children.indexOf(component as never);
        if (index !== -1) this.children.splice(index, 1);
      },
    });
    const documentContainer = makeContainer();
    documentContainer.children.push(makeContainer(), panel, makeContainer());
    const tui = {
      children: [
        documentContainer,
        ...Array.from({ length: 6 }, emptyComponent),
      ],
      removeChild(component: unknown) {
        const index = this.children.indexOf(component as never);
        if (index !== -1) this.children.splice(index, 1);
      },
      requestRender() {},
    };

    const header = headerFactory?.(tui, plainTheme);
    expect(documentContainer.children).not.toContain(panel);
    expect(documentContainer.children).toHaveLength(2);
    await new Promise((resolve) => setTimeout(resolve, 0));
    panel.children.push(resourceComponent, themeComponent);
    await new Promise((resolve) => setTimeout(resolve, 80));

    const rendered = header?.render(80).join("\n");
    expect(rendered).toContain("• AGENTS.md");
    expect(rendered).toContain(
      "~/dev/pi-kaush/extensions/pi-welcome-screen/src",
    );
    expect(rendered).not.toContain("[Themes]");
    expect(rendered).not.toContain("dracula");
    expect(tui.children[0]).toBe(documentContainer);

    header?.dispose?.();
    expect(documentContainer.children[1]).toBe(panel);
  });

  test("warns in the header when Pi's layout shape is unrecognized", async () => {
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

    const tui = {
      children: Array.from({ length: 9 }, emptyComponent),
      removeChild() {},
      requestRender() {},
    };
    const header = headerFactory?.(tui, plainTheme);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const rendered = header?.render(80).join("\n");
    expect(rendered).toContain("█████████");
    expect(rendered).toContain(
      "pi-welcome-screen: unrecognized Pi layout — using native panel",
    );
  });

  test("warns when loaded sections never become parseable", async () => {
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

    const resourceComponent = {
      ...emptyComponent(),
      getCollapsedText() {
        return "[Context]\n  AGENTS.md\n[Extensions]\n  some-other-extension";
      },
    };
    const panel = {
      children: [] as Array<typeof resourceComponent>,
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
    await new Promise((resolve) => setTimeout(resolve, 0));
    panel.children.push(resourceComponent);
    await new Promise((resolve) => setTimeout(resolve, 180));

    const rendered = header?.render(80).join("\n");
    expect(rendered).toContain("unrecognized Pi layout");
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
    // Expected fallbacks (diagnostics, unknown sections, quiet startup)
    // restore Pi's panel without crying wolf.
    expect(renderedHeader).not.toContain("unrecognized Pi layout");
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
