import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("@earendil-works/pi-coding-agent", () => ({
  CONFIG_DIR_NAME: ".pi",
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
  buildWelcomeEstimate,
  default: welcomeScreen,
  loadWelcomeSettings,
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

describe("welcome settings", () => {
  test("uses code defaults when canonical Pi settings are absent", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-welcome-settings-"));
    try {
      expect(loadWelcomeSettings(join(root, "project"), true, root)).toEqual({
        settings: {
          showCounts: true,
          showWorkspace: false,
          showEstimate: true,
          showHealth: true,
          splitExtensionsAt: 180,
        },
        warnings: [],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("merges trusted project settings over global settings by field", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-welcome-settings-"));
    const agentDir = join(root, "agent");
    const cwd = join(root, "project");
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({
        welcomeScreen: {
          showCounts: false,
          showWorkspace: true,
          showEstimate: false,
          splitExtensionsAt: false,
        },
      }),
    );
    writeFileSync(
      join(cwd, ".pi", "settings.json"),
      JSON.stringify({
        welcomeScreen: {
          showCounts: true,
          showEstimate: true,
          showHealth: false,
        },
      }),
    );

    try {
      expect(loadWelcomeSettings(cwd, true, agentDir).settings).toEqual({
        showCounts: true,
        showWorkspace: true,
        showEstimate: true,
        showHealth: false,
        splitExtensionsAt: false,
      });
      expect(loadWelcomeSettings(cwd, false, agentDir).settings).toEqual({
        showCounts: false,
        showWorkspace: true,
        showEstimate: false,
        showHealth: true,
        splitExtensionsAt: false,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("ignores invalid values and reports actionable health warnings", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-welcome-settings-"));
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, "settings.json"),
      JSON.stringify({
        welcomeScreen: {
          showCounts: "yes",
          splitExtensionsAt: 12.5,
          extraNoise: true,
        },
      }),
    );

    try {
      const loaded = loadWelcomeSettings(join(root, "project"), false, root);
      expect(loaded.settings).toEqual({
        showCounts: true,
        showWorkspace: false,
        showEstimate: true,
        showHealth: true,
        splitExtensionsAt: 180,
      });
      expect(loaded.warnings).toHaveLength(3);
      expect(loaded.warnings.join("\n")).toContain("showCounts");
      expect(loaded.warnings.join("\n")).toContain("splitExtensionsAt");
      expect(loaded.warnings.join("\n")).toContain("extraNoise");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("builds an honest prompt-only estimate from public Pi context", () => {
    const estimate = buildWelcomeEstimate(
      { getActiveTools: () => ["read", "grep", "git"] } as never,
      {
        getSystemPrompt: () => "x".repeat(8_001),
        model: {
          provider: "openai-codex",
          id: "gpt-5.4",
          contextWindow: 272_000,
        },
      } as never,
    );

    expect(estimate).toEqual({
      promptChars: 8_001,
      promptTokens: 2_001,
      denominator: 4,
      activeTools: 3,
      model: "openai-codex/gpt-5.4",
      contextWindow: 272_000,
    });
    expect(
      buildWelcomeEstimate(
        { getActiveTools: () => ["read"] } as never,
        {
          getSystemPrompt: () => "x".repeat(8_001),
          model: {
            provider: "anthropic",
            id: "claude-opus-4-7",
            contextWindow: 200_000,
          },
        } as never,
      ),
    ).toMatchObject({ denominator: 2.6, promptTokens: 3_078 });
    expect(
      buildWelcomeEstimate(
        { getActiveTools: () => [] } as never,
        {
          getSystemPrompt: () => {
            throw new Error("not ready");
          },
          model: undefined,
        } as never,
      ),
    ).toBeUndefined();
  });
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

  test("uses the owning local extension name for compiled entry points", () => {
    const resources = parseWelcomeResources(
      `[Extensions]\n  dist`,
      new Set(["alpha", "beta"]),
      [
        "[Extensions]",
        "  user",
        "    ~/.pi/agent/extensions/alpha/dist",
        "    ~/.pi/agent/extensions/beta/dist/index.js",
      ].join("\n"),
    );

    expect(resources.extensions).toEqual(["alpha", "beta"]);
    expect(resources.packageExtensions).toEqual([]);
    expect(resources.sourceExtensions).toEqual([]);
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

  test("uses two columns for long labels and safely wraps exceptional ones", () => {
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
    const exceptionalRows = sectionRows(truncated, "Skills", "Prompts");
    expect(exceptionalRows.join("\n")).not.toContain("…");
    expect(
      exceptionalRows
        .map((row) => row.slice(0, 44).trim())
        .join("")
        .replace(/•/g, ""),
    ).toContain(exceptional.skills[3]);
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

  test("renders compact extensions as one grouped item per row", () => {
    const resources = {
      context: ["AGENTS.md"],
      skills: ["pohuy", "tasks-handoff"],
      prompts: ["/session-diagnostic"],
      extensions: [
        "pi-autoname",
        "pi-command-center",
        "@narumitw/pi-lsp",
        "~/projects/pi-switch/packages/pi-tasks/src/host/pi-extension.ts",
      ],
      packageExtensions: ["@narumitw/pi-lsp"],
      sourceExtensions: [
        "~/projects/pi-switch/packages/pi-tasks/src/host/pi-extension.ts",
      ],
    };

    const compact = renderCenteredWelcome(resources, plainTheme as never, 83);
    const extensionRows = sectionRows(compact, "Extensions", "missing");
    const bullets = bulletRows(extensionRows);

    expect(bullets).toHaveLength(resources.extensions.length);
    expect(bullets.every((row) => (row.match(/•/g)?.length ?? 0) === 1)).toBe(
      true,
    );
    expect(extensionRows.join("\n")).not.toContain(",");
    expect(extensionRows.join("\n")).toContain("Local");
    expect(extensionRows.join("\n")).toContain("Packages");
    expect(extensionRows.join("\n")).toContain("Source paths");
  });

  test("uses one, two, or three responsive grid columns as space allows", () => {
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
    expect(twoColumns[versionRow + 2]?.trim()).toBe("1 ctx · 1 skill");
    expect(twoColumns[versionRow + 3]?.trim()).toBe("1 prompt · 12 ext");
    expect(firstResourceRow).toBeGreaterThan(versionRow + 3);
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
    expect(threeColumnTopRow?.indexOf("[Context]")).toBe(28);
    expect(threeColumnTopRow?.indexOf("[Extensions]")).toBe(72);
    expect(threeColumns.every((line) => !/[\[•]/.test(line.slice(0, 24)))).toBe(
      true,
    );
    const threeColumnFirstLogoRow = threeColumns.findIndex((line) =>
      line.includes("█"),
    );
    const threeColumnLastBrandRow = threeColumns.findIndex((line) =>
      line.includes("prompt · 12 ext"),
    );
    expect(
      Math.abs(
        threeColumnFirstLogoRow -
          (threeColumns.length - threeColumnLastBrandRow - 1),
      ),
    ).toBeLessThanOrEqual(1);
    expect(threeColumns.every((line) => line.length <= 128)).toBe(true);
  });

  test("gives wide terminals a narrow brand rail and a wider extension rail", () => {
    const resources = {
      context: ["~/.pi/agent/AGENTS.md", "AGENTS.md"],
      skills: ["model-facing-api-design", "tasks-handoff"],
      prompts: ["/session-diagnostic"],
      extensions: [
        "welcome-screen",
        "@juicesharp/rpiv-ask-user-question",
        "~/projects/contribute/pi-kaush/extensions/pi-welcome-screen/src",
      ],
      packageExtensions: ["@juicesharp/rpiv-ask-user-question"],
      sourceExtensions: [
        "~/projects/contribute/pi-kaush/extensions/pi-welcome-screen/src",
      ],
    };

    const wide = renderCenteredWelcome(resources, plainTheme as never, 200);
    const headingRow = wide.find(
      (line) => line.includes("[Context]") && line.includes("[Extensions]"),
    );
    const contextStart = headingRow?.indexOf("[Context]") ?? -1;
    const extensionStart = headingRow?.indexOf("[Extensions]") ?? -1;

    expect(contextStart).toBe(28);
    expect(extensionStart).toBe(100);
    expect(extensionStart - contextStart).toBeGreaterThan(60);
    expect(200 - extensionStart).toBeGreaterThanOrEqual(100);
    expect(wide.join("\n")).toContain(resources.sourceExtensions[0]);
    expect(wide.every((line) => line.length <= 200)).toBe(true);
  });

  test("splits only package extensions at the configured wide breakpoint", () => {
    const packages = Array.from(
      { length: 14 },
      (_, index) => `package-${index + 1}`,
    );
    const sourcePath = "~/projects/example/extensions/custom/src/index.ts";
    const resources = {
      context: ["AGENTS.md"],
      skills: [],
      prompts: [],
      extensions: ["welcome-screen", ...packages, sourcePath],
      packageExtensions: packages,
      sourceExtensions: [sourcePath],
    };
    const options = {
      settings: { splitExtensionsAt: 180 },
    };

    const before = renderCenteredWelcome(
      resources,
      plainTheme as never,
      179,
      options,
    );
    const after = renderCenteredWelcome(
      resources,
      plainTheme as never,
      180,
      options,
    );
    const packageRows = (lines: string[]) => {
      const start = lines.findIndex((line) => line.trim() === "Packages");
      const end = lines.findIndex(
        (line, index) => index > start && line.trim() === "Source paths",
      );
      return lines.slice(start + 1, end);
    };

    expect(
      packageRows(before).every((row) => (row.match(/•/g)?.length ?? 0) <= 1),
    ).toBe(true);
    expect(
      packageRows(after).some((row) => (row.match(/•/g)?.length ?? 0) === 2),
    ).toBe(true);
    expect(after.join("\n")).toContain(sourcePath);
    expect(after.every((line) => line.length <= 180)).toBe(true);

    const disabled = renderCenteredWelcome(
      resources,
      plainTheme as never,
      200,
      { settings: { splitExtensionsAt: false } },
    );
    expect(
      packageRows(disabled).every((row) => (row.match(/•/g)?.length ?? 0) <= 1),
    ).toBe(true);
  });

  test("renders optional counts, workspace, and non-empty health information", () => {
    const resources = {
      context: ["AGENTS.md", "project/AGENTS.md"],
      skills: ["tasks-handoff"],
      prompts: ["/review"],
      extensions: ["welcome-screen", "pi-subagents"],
    };
    const rendered = renderCenteredWelcome(
      resources,
      plainTheme as never,
      128,
      {
        settings: { showWorkspace: true },
        workspace: [
          "pi-kaush",
          "extensions/pi-welcome-screen",
          "Session: resume",
        ],
        healthWarnings: ["welcomeScreen.extraNoise is not supported."],
        estimate: {
          promptChars: 8_001,
          promptTokens: 2_001,
          denominator: 4,
          activeTools: 3,
          model: "openai-codex/gpt-5.4",
          contextWindow: 272_000,
        },
      },
    );
    const text = rendered.join("\n");

    expect(text).toContain("2 ctx · 1 skill");
    expect(text).toContain("1 prompt · 2 ext");
    expect(text).toContain("[Workspace]");
    expect(text).toContain("Session: resume");
    expect(text).toContain("[Estimate]");
    expect(text).toContain("System prompt ~2k tokens");
    expect(text).toContain("3 active tools · schemas excluded");
    expect(text).toContain("[Health]");
    expect(text).toContain("extraNoise");
    expect(rendered.every((line) => line.length <= 128)).toBe(true);

    const hidden = renderCenteredWelcome(resources, plainTheme as never, 128, {
      settings: {
        showCounts: false,
        showWorkspace: false,
        showEstimate: false,
        showHealth: false,
      },
      workspace: ["pi-kaush"],
      estimate: {
        promptChars: 8_000,
        promptTokens: 2_000,
        denominator: 4,
      },
      healthWarnings: ["bad setting"],
    }).join("\n");
    expect(hidden).not.toContain("ctx ·");
    expect(hidden).not.toContain("[Workspace]");
    expect(hidden).not.toContain("[Estimate]");
    expect(hidden).not.toContain("[Health]");
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
      getActiveTools() {
        return ["read", "grep"];
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
        cwd: "/tmp/project",
        isProjectTrusted: () => false,
        getSystemPrompt: () => "x".repeat(4_000),
        model: {
          provider: "openai-codex",
          id: "gpt-5.4",
          contextWindow: 272_000,
        },
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
      addChild(component: typeof resourceComponent | typeof themeComponent) {
        this.children.push(component);
      },
      removeChild(component: typeof resourceComponent | typeof themeComponent) {
        const index = this.children.indexOf(component);
        if (index !== -1) this.children.splice(index, 1);
      },
      clear() {
        this.children.splice(0);
      },
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
    const documentContainer = {
      ...emptyComponent(),
      children,
      removeChild(component: unknown) {
        const index = this.children.indexOf(component as never);
        if (index !== -1) this.children.splice(index, 1);
      },
      addChild(component: (typeof children)[number]) {
        this.children.push(component);
      },
      clear() {
        this.children.splice(0);
      },
    };
    const renderRequests: boolean[] = [];
    const tui = {
      children: [documentContainer],
      requestRender(force?: boolean) {
        renderRequests.push(force ?? false);
      },
    };

    const header = headerFactory?.(tui, plainTheme);
    expect(documentContainer.children).toContain(panel);
    const loadingRender = header?.render(80).join("\n");
    expect(loadingRender).not.toContain("[Context]");
    expect(loadingRender).not.toContain("(none)");
    await new Promise((resolve) => setTimeout(resolve, 0));
    renderRequests.length = 0;
    panel.children.push(resourceComponent, themeComponent);
    expect(header?.render(80).join("\n")).not.toContain("[Context]");
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(renderRequests).toContain(true);
    const firstRender = header?.render(80);
    expect(firstRender?.join("\n")).toContain("• AGENTS.md");
    expect(firstRender?.join("\n")).toContain("[Estimate]");
    expect(firstRender?.join("\n")).toContain("System prompt ~1k tokens");
    expect(firstRender?.join("\n")).toContain(
      "2 active tools · schemas excluded",
    );
    expect(firstRender?.join("\n")).toContain(
      "~/dev/pi-kaush/extensions/pi-double-paste/src",
    );
    expect(firstRender?.join("\n")).not.toMatch(/• src\s*$/m);
    expect(documentContainer.children).toContain(panel);
    expect(panel.children).toEqual([]);
    expect(header?.render(80)).toBe(firstRender);
    const readsAfterCapture = resourceReads;
    header?.render(80);
    expect(resourceReads).toBe(readsAfterCapture);

    header?.dispose?.();
    expect(documentContainer.children[1]).toBe(panel);
  });

  async function expectSelectiveResourceReplacement(options: {
    nativeComponent?: any;
    heading?: string;
    repairsWhenCleared?: boolean;
    rebuildsResourceAfterCapture?: boolean;
    renderWidth?: number;
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
        cwd: "/tmp/project",
        isProjectTrusted: () => false,
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
    const leadingSpacer = new Spacer(1);
    const trailingSpacer = new Spacer(1);
    const originalPanelChildren = options.nativeComponent
      ? [
          leadingSpacer,
          resourceComponent,
          trailingSpacer,
          options.nativeComponent,
        ]
      : [];
    const panel = {
      children: [] as any[],
      addChild(component: any) {
        this.children.push(component);
      },
      removeChild(component: any) {
        const index = this.children.indexOf(component);
        if (index !== -1) this.children.splice(index, 1);
      },
      clear() {
        const nativeWasMounted =
          options.nativeComponent &&
          this.children.includes(options.nativeComponent);
        this.children.splice(0);
        if (options.repairsWhenCleared && nativeWasMounted) {
          this.children.push(options.nativeComponent);
        }
      },
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
    expect(tui.children).toContain(panel);
    await new Promise((resolve) => setTimeout(resolve, 0));
    panel.children.push(...originalPanelChildren);
    await new Promise((resolve) => setTimeout(resolve, 80));

    const rebuiltResourceComponent = {
      ...resourceComponent,
      getCollapsedText() {
        return [
          "[Context]",
          "  AGENTS-reloaded.md",
          "[Skills]",
          "  artifactor",
          "[Prompts]",
          "  /implement",
          "[Extensions]",
          "  @pi-kaush/pi-welcome-screen:src/index.ts",
        ].join("\n");
      },
    };
    if (options.rebuildsResourceAfterCapture) {
      panel.children.push(rebuiltResourceComponent);
      await new Promise((resolve) => setTimeout(resolve, 80));
    }

    const renderedHeader =
      header?.render(options.renderWidth ?? 80).join("\n") ?? "";
    expect(renderedHeader).toContain("█████████");
    expect(renderedHeader).toContain("[Context]");
    expect(renderedHeader).toContain(
      options.rebuildsResourceAfterCapture
        ? "• AGENTS-reloaded.md"
        : "• AGENTS.md",
    );
    expect(tui.children[1]).toBe(panel);
    expect(panel.children).toEqual(
      options.nativeComponent ? [options.nativeComponent] : [],
    );
    if (options.nativeComponent) {
      expect(
        panel.children.filter((child) => child === options.nativeComponent),
      ).toHaveLength(1);
    }
    if (options.heading) {
      expect(panel.render().join("\n")).toContain(options.heading);
    }

    header?.dispose?.();
    expect(tui.children.filter((child) => child === panel)).toHaveLength(1);
    expect(panel.children).toEqual(
      options.nativeComponent
        ? [
            options.nativeComponent,
            leadingSpacer,
            options.rebuildsResourceAfterCapture
              ? rebuiltResourceComponent
              : resourceComponent,
            trailingSpacer,
          ]
        : [
            options.rebuildsResourceAfterCapture
              ? rebuiltResourceComponent
              : resourceComponent,
          ],
    );
  }

  test("replaces known resources while retaining Pi diagnostics", () =>
    expectSelectiveResourceReplacement({
      nativeComponent: {
        invalidate() {},
        render: () => ["[Extension issues]", "  broken-extension.ts"],
      },
      heading: "[Extension issues]",
    }));

  test("replaces known resources while retaining unknown native sections", () =>
    expectSelectiveResourceReplacement({
      nativeComponent: {
        invalidate() {},
        getCollapsedText: () => "[Future startup info]\n  important detail",
        render: () => ["[Future startup info]", "  important detail"],
      },
      heading: "[Future startup info]",
    }));

  test("never detaches a self-healing third-party startup component", () => {
    const contextimate = {
      invalidate() {},
      render: () => ["[Contextimate]", "  Total harness ~24k tokens"],
    };
    return expectSelectiveResourceReplacement({
      nativeComponent: contextimate,
      heading: "[Contextimate]",
      repairsWhenCleared: true,
      renderWidth: 24,
    });
  });

  test("replaces a native resource component rebuilt shortly after reload", () =>
    expectSelectiveResourceReplacement({
      nativeComponent: {
        invalidate() {},
        render: () => ["[Contextimate]", "  Total harness ~24k tokens"],
      },
      heading: "[Contextimate]",
      rebuildsResourceAfterCapture: true,
    }));

  test("restores Pi's native panel after three resource retries", async () => {
    let sessionStart: ((event: unknown, context: any) => void) | undefined;
    welcomeScreen({
      on(event: string, handler: (event: unknown, context: any) => void) {
        if (event === "session_start") sessionStart = handler;
      },
    } as never);

    let headerFactory:
      | ((tui: any, theme: any) => { render(width: number): string[] })
      | undefined;
    sessionStart?.(
      { reason: "startup" },
      {
        mode: "tui",
        cwd: "/tmp/project",
        isProjectTrusted: () => false,
        ui: {
          setHeader(factory: typeof headerFactory) {
            headerFactory = factory;
          },
        },
      },
    );

    const panel = {
      children: [] as any[],
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
      render() {
        return [];
      },
    };
    const tui = {
      children: [emptyComponent(), panel],
      requestRender() {},
    };
    const header = headerFactory?.(tui, plainTheme);

    await new Promise((resolve) => setTimeout(resolve, 180));

    expect(header?.render(80).join("\n")).not.toContain("[Context]");
    expect(panel.children).toEqual([]);
  });
});
