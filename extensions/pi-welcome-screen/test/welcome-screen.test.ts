import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@earendil-works/pi-coding-agent", () => ({
  VERSION: "0.80.6",
  getAgentDir: () => "/tmp/pi-agent",
}));
vi.mock("@earendil-works/pi-tui", () => ({
  Spacer: class Spacer {
    constructor(private readonly height = 1) {}
    invalidate() {}
    render() {
      return Array.from({ length: this.height }, () => "");
    }
  },
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
const { Spacer } = await import("@earendil-works/pi-tui");

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
      104,
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
    expect(wide.every((line) => line.length <= 78)).toBe(true);
    expect(wide.filter(Boolean).every((line) => line.startsWith("  "))).toBe(
      true,
    );
    expect(wide.join("\n")).not.toContain("[Themes]");
    expect(wide.join("\n")).not.toContain("[Version]");
    expect(wide.filter((line) => line.includes("█"))).toHaveLength(4);
    expect(wide.some((line) => line.includes("██████   ███"))).toBe(true);

    const narrow = renderCenteredWelcome(resources, plainTheme as never, 24);
    expect(narrow.every((line) => line.length <= 22)).toBe(true);
    expect(narrow.filter(Boolean).every((line) => line.startsWith("  "))).toBe(
      true,
    );
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

    const stacked = renderCenteredWelcome(resources, plainTheme as never, 87);
    expect(
      stacked.findIndex((line) => line.includes("[Context]")),
    ).toBeGreaterThan(stacked.findIndex((line) => line.includes("v0.80.6")));

    const twoColumns = renderCenteredWelcome(
      resources,
      plainTheme as never,
      88,
    );
    expect(
      twoColumns
        .find((line) => line.includes("[Context]"))
        ?.indexOf("[Context]"),
    ).toBe(2);
    expect(
      twoColumns
        .find((line) => line.includes("[Extensions]"))
        ?.indexOf("[Extensions]"),
    ).toBe(46);

    const firstLogoRow = twoColumns.findIndex((line) => line.includes("█"));
    const versionRow = twoColumns.findIndex((line) => line.includes("v0.80.6"));
    const firstResourceRow = twoColumns.findIndex((line) =>
      line.includes("[Context]"),
    );
    expect(twoColumns[firstLogoRow]?.indexOf("█")).toBe(38);
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
      132,
    );
    const threeColumnTopRow = threeColumns.find(
      (line) => line.includes("[Context]") && line.includes("[Extensions]"),
    );
    expect(threeColumnTopRow?.indexOf("[Context]")).toBe(46);
    expect(threeColumnTopRow?.indexOf("[Extensions]")).toBe(90);
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
    expect(threeColumns.every((line) => line.length <= 130)).toBe(true);
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

    const wide = renderCenteredWelcome(resources, plainTheme as never, 84);
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
  function makeContainer(initialChildren: any[] = []) {
    return {
      children: [...initialChildren] as any[],
      addChild(component: any) {
        this.children.push(component);
      },
      removeChild(component: any) {
        const index = this.children.indexOf(component);
        if (index !== -1) this.children.splice(index, 1);
      },
      clear() {
        this.children.splice(0);
      },
      invalidate() {},
      render(width = 1_000) {
        return this.children.flatMap((child) => child.render(width));
      },
    };
  }

  function makeSection(
    heading: string,
    body: string,
    options: { expanded?: string; onRead?: () => void } = {},
  ) {
    return {
      ...emptyComponent(),
      getCollapsedText() {
        options.onRead?.();
        return `[${heading}]\n${body}`;
      },
      ...(options.expanded
        ? { getExpandedText: () => `[${heading}]\n${options.expanded}` }
        : {}),
    };
  }

  function makeKnownResourceChildren(
    contextFile = "AGENTS.md",
    onContextRead?: () => void,
  ) {
    return [
      new Spacer(1),
      makeSection("Context", `  ${contextFile}`, {
        ...(onContextRead ? { onRead: onContextRead } : {}),
      }),
      new Spacer(1),
      makeSection("Skills", "  artifactor"),
      new Spacer(1),
      makeSection("Prompts", "  /implement"),
      new Spacer(1),
      makeSection("Extensions", "  src", {
        expanded: [
          "  user",
          "    ~/dev/pi-kaush/extensions/pi-double-paste/src",
          "    ~/dev/pi-kaush/extensions/pi-welcome-screen/src",
        ].join("\n"),
      }),
      new Spacer(1),
      makeSection("Themes", "  dracula"),
      new Spacer(1),
    ];
  }

  function installHeader(reason = "startup") {
    let sessionStart: ((event: any, context: any) => void) | undefined;
    welcomeScreen({
      on(event: string, handler: (event: any, context: any) => void) {
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
      { reason },
      {
        mode: "tui",
        ui: {
          setHeader(factory: typeof headerFactory) {
            headerFactory = factory;
          },
        },
      },
    );
    if (!headerFactory) throw new Error("header factory was not installed");
    return headerFactory;
  }

  function makeLegacyTui(panel: ReturnType<typeof makeContainer>) {
    const renderRequests: boolean[] = [];
    const tui = {
      children: [
        makeContainer(),
        panel,
        ...Array.from({ length: 7 }, emptyComponent),
      ],
      requestRender(force?: boolean) {
        renderRequests.push(force ?? false);
      },
    };
    return { tui, renderRequests };
  }

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

  test("keeps the native panel mounted until a complete snapshot is ready", async () => {
    let resourceReads = 0;
    const nativeChildren = makeKnownResourceChildren(
      "AGENTS.md",
      () => (resourceReads += 1),
    );
    const panel = makeContainer();
    const { tui, renderRequests } = makeLegacyTui(panel);
    const header = installHeader()(tui, plainTheme);

    expect(tui.children[1]).toBe(panel);
    expect(header.render(80).join("\n")).not.toContain("[Context]");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(tui.children[1]).toBe(panel);

    panel.children.push(...nativeChildren);
    await new Promise((resolve) => setTimeout(resolve, 80));

    const firstRender = header.render(80);
    expect(firstRender.join("\n")).toContain("• AGENTS.md");
    expect(firstRender.join("\n")).toContain(
      "~/dev/pi-kaush/extensions/pi-double-paste/src",
    );
    expect(panel.children).toEqual([]);
    expect(tui.children[1]).toBe(panel);
    expect(renderRequests).toContain(true);
    expect(header.render(80)).toBe(firstRender);
    const readsAfterCapture = resourceReads;
    header.render(80);
    expect(resourceReads).toBe(readsAfterCapture);

    header.dispose?.();
    expect(panel.children).toEqual(nativeChildren);
    expect(tui.children[1]).toBe(panel);
  });

  test("keeps Pi 0.84's fullscreen document and resource panel mounted", async () => {
    const nativeChildren = makeKnownResourceChildren();
    const panel = makeContainer(nativeChildren);
    const headerContainer = makeContainer();
    const chatContainer = makeContainer();
    const documentContainer = makeContainer([
      headerContainer,
      panel,
      chatContainer,
    ]);
    const tui = {
      children: [
        documentContainer,
        ...Array.from({ length: 6 }, emptyComponent),
      ],
      requestRender() {},
    };

    const header = installHeader()(tui, plainTheme);
    expect(documentContainer.children[1]).toBe(panel);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(header.render(80).join("\n")).toContain("• AGENTS.md");
    expect(tui.children[0]).toBe(documentContainer);
    expect(documentContainer.children).toEqual([
      headerContainer,
      panel,
      chatContainer,
    ]);
    expect(panel.children).toEqual([]);

    header.dispose?.();
    expect(panel.children).toEqual(nativeChildren);
  });

  test("warns only after the TUI layout remains unrecognized", async () => {
    const tui = {
      children: Array.from({ length: 9 }, emptyComponent),
      requestRender() {},
    };
    const header = installHeader()(tui, plainTheme);

    await new Promise((resolve) => setTimeout(resolve, 180));
    const rendered = header.render(80).join("\n");
    expect(rendered).toContain("█████████");
    expect(rendered).toContain(
      "pi-welcome-screen: unrecognized Pi layout — using native panel",
    );
  });

  test("leaves an incomplete native snapshot unchanged without a layout warning", async () => {
    const nativeChildren = [
      new Spacer(1),
      makeSection("Context", "  AGENTS.md"),
      new Spacer(1),
      makeSection("Extensions", "  some-other-extension"),
      new Spacer(1),
    ];
    const panel = makeContainer(nativeChildren);
    const { tui } = makeLegacyTui(panel);
    const header = installHeader()(tui, plainTheme);

    await new Promise((resolve) => setTimeout(resolve, 180));

    expect(header.render(80).join("\n")).not.toContain(
      "unrecognized Pi layout",
    );
    expect(header.render(80).join("\n")).not.toContain("[Context]");
    expect(panel.children).toEqual(nativeChildren);
    expect(tui.children[1]).toBe(panel);
  });

  test("replaces known rows while preserving diagnostics and third-party rows", async () => {
    let diagnosticRenders = 0;
    let thirdPartyRenders = 0;
    const diagnostic = {
      invalidate() {},
      render() {
        diagnosticRenders += 1;
        return ["[Extension issues]", "  broken-extension.ts"];
      },
    };
    const thirdParty = {
      ...emptyComponent(),
      getCollapsedText: () => "[Future startup info]\n  important detail",
      render() {
        thirdPartyRenders += 1;
        return ["[Future startup info]", "  important detail"];
      },
    };
    const diagnosticSpacer = new Spacer(1);
    const trailingSpacer = new Spacer(1);
    const knownChildren = makeKnownResourceChildren();
    const originalChildren = [
      ...knownChildren,
      diagnostic,
      diagnosticSpacer,
      thirdParty,
      trailingSpacer,
    ];
    const panel = makeContainer(originalChildren);
    const { tui } = makeLegacyTui(panel);
    const header = installHeader()(tui, plainTheme);

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(header.render(80).join("\n")).toContain("• AGENTS.md");
    expect(panel.children).toEqual([
      diagnostic,
      diagnosticSpacer,
      thirdParty,
      trailingSpacer,
    ]);
    expect(diagnosticRenders).toBe(0);
    expect(thirdPartyRenders).toBe(0);

    header.dispose?.();
    expect(panel.children).toEqual(originalChildren);
  });

  test("reconciles resource rows rebuilt after session_start", async () => {
    const thirdParty = {
      ...emptyComponent(),
      getCollapsedText: () => "[Third party]\n  retained",
    };
    const initialChildren = makeKnownResourceChildren("AGENTS.md");
    const panel = makeContainer([...initialChildren, thirdParty]);
    const { tui } = makeLegacyTui(panel);
    const header = installHeader("reload")(tui, plainTheme);

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(header.render(80).join("\n")).toContain("• AGENTS.md");
    expect(panel.children).toEqual([thirdParty]);

    const rebuiltChildren = makeKnownResourceChildren("AGENTS-reloaded.md");
    panel.children.splice(
      0,
      panel.children.length,
      ...rebuiltChildren,
      thirdParty,
    );
    await new Promise((resolve) => setTimeout(resolve, 70));

    const rendered = header.render(80).join("\n");
    expect(rendered).toContain("• AGENTS-reloaded.md");
    expect(rendered).not.toContain("• AGENTS.md");
    expect(panel.children).toEqual([thirdParty]);

    header.dispose?.();
    expect(panel.children).toEqual([...rebuiltChildren, thirdParty]);
    expect(
      panel.children.some((child) => initialChildren.includes(child)),
    ).toBe(false);
  });
});
