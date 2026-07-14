import { describe, expect, test, vi } from "vitest";

const tuiMock = vi.hoisted(() => {
  class FakeEditor {
    constructor(private readonly lines: string[]) {}

    render(_width: number): string[] {
      return this.lines;
    }
  }

  return {
    FakeEditor,
    visibleWidth(text: string) {
      return text.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "").length;
    },
  };
});

vi.mock("@earendil-works/pi-tui", () => ({
  Editor: tuiMock.FakeEditor,
  visibleWidth: tuiMock.visibleWidth,
}));

const {
  colorizeSkillAliases,
  createSkillAutocompleteProvider,
  default: inlineSkillIdentifier,
  getSkillNames,
  referencedSkills,
} = await import("../src/index.ts");

type Handler = (event: any, context: any) => any;

function createHarness(
  commands: Array<{ name: string; source: string; description?: string }>,
) {
  const handlers = new Map<string, Handler>();
  const fallbackSuggestions = {
    prefix: "#",
    items: [{ value: "#fallback", label: "#fallback" }],
  };
  const currentAutocomplete = {
    getSuggestions: vi.fn(async () => fallbackSuggestions),
    applyCompletion: vi.fn(
      (
        lines: string[],
        cursorLine: number,
        cursorCol: number,
        item: { value: string },
        prefix: string,
      ) => {
        const line = lines[cursorLine] ?? "";
        const before = line.slice(0, cursorCol - prefix.length);
        const after = line.slice(cursorCol);
        const next = [...lines];
        next[cursorLine] = before + item.value + after;
        return {
          lines: next,
          cursorLine,
          cursorCol: before.length + item.value.length,
        };
      },
    ),
    shouldTriggerFileCompletion: vi.fn(() => true),
  };
  let autocompleteProvider: any;
  const pi = {
    getCommands: () => commands,
    on(name: string, handler: Handler) {
      handlers.set(name, handler);
    },
  };

  inlineSkillIdentifier(pi as never);
  return {
    input(text: string, source = "interactive") {
      return handlers.get("input")?.({ text, source }, {});
    },
    start(mode: string) {
      handlers.get("session_start")?.(
        {},
        {
          mode,
          ui: {
            addAutocompleteProvider(factory: (current: any) => any) {
              autocompleteProvider = factory(currentAutocomplete);
            },
          },
        },
      );
    },
    shutdown() {
      handlers.get("session_shutdown")?.({}, {});
    },
    autocompleteProvider: () => autocompleteProvider,
    currentAutocomplete,
    fallbackSuggestions,
  };
}

const commands = [
  {
    name: "skill:review",
    source: "skill",
    description: "Review changes",
  },
  {
    name: "skill:review-my",
    source: "skill",
    description: "Review my changes",
  },
  { name: "skill:review", source: "skill" },
  { name: "deploy", source: "extension" },
];

describe("inline skill discovery", () => {
  test("strips the native prefix and de-duplicates skill commands", () => {
    expect(getSkillNames({ getCommands: () => commands } as never)).toEqual([
      "review",
      "review-my",
    ]);
  });

  test("finds each known referenced skill once", () => {
    expect(
      referencedSkills(
        "Use $review, then $review again; skip $unknown.",
        new Set(["review"]),
      ),
    ).toEqual(["review"]);
  });

  test("requires the complete skill token", () => {
    const longestName = "a".repeat(64);

    expect(referencedSkills("Skip $review-my.", new Set(["review"]))).toEqual(
      [],
    );
    expect(
      referencedSkills(`Use $${longestName}.`, new Set([longestName])),
    ).toEqual([longestName]);
    expect(
      referencedSkills(`Skip $${longestName}x.`, new Set([longestName])),
    ).toEqual([]);
  });
});

describe("inline skill input", () => {
  test("routes exactly one known skill through Pi's native command", () => {
    const harness = createHarness(commands);

    expect(harness.input("Use $review to inspect this.")).toEqual({
      action: "transform",
      text: "/skill:review Use $review to inspect this.",
    });
    expect(harness.input("Use $review twice, then $review again.")).toEqual({
      action: "transform",
      text: "/skill:review Use $review twice, then $review again.",
    });
  });

  test("leaves unknown, multi-skill, slash, and extension input unchanged", () => {
    const harness = createHarness(commands);

    expect(harness.input("Use $unknown.")).toEqual({ action: "continue" });
    expect(harness.input("Use $review and $review-my.")).toEqual({
      action: "continue",
    });
    expect(harness.input("  /model $review")).toEqual({ action: "continue" });
    expect(harness.input("Use $review.", "extension")).toEqual({
      action: "continue",
    });
  });

  test("does not route a known skill that only prefixes a longer token", () => {
    const harness = createHarness([{ name: "skill:review", source: "skill" }]);

    expect(harness.input("Use $review-my.")).toEqual({ action: "continue" });
  });

  test("keeps input routing active outside TUI mode", () => {
    const harness = createHarness(commands);
    harness.start("json");

    expect(harness.input("Use $review.")).toEqual({
      action: "transform",
      text: "/skill:review Use $review.",
    });
    harness.shutdown();
  });
});

describe("inline skill autocomplete", () => {
  test("suggests matching loaded skills through Pi's autocomplete", async () => {
    const harness = createHarness(commands);
    harness.start("tui");
    const provider = harness.autocompleteProvider();

    expect(provider.triggerCharacters).toEqual(["$"]);
    const initialSuggestions = await provider.getSuggestions(["Use $"], 0, 5, {
      signal: new AbortController().signal,
    });
    expect(initialSuggestions?.prefix).toBe("$");
    expect(
      initialSuggestions?.items.map((item: { value: string }) => item.value),
    ).toEqual(["$review", "$review-my"]);

    await expect(
      provider.getSuggestions(["Use $rev"], 0, 8, {
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      prefix: "$rev",
      items: [
        {
          value: "$review",
          label: "$review",
          description: "Review changes",
        },
        {
          value: "$review-my",
          label: "$review-my",
          description: "Review my changes",
        },
      ],
    });
    harness.shutdown();
  });

  test("closes after a space following an empty or partial alias", async () => {
    const harness = createHarness(commands);
    const provider = createSkillAutocompleteProvider(
      { getCommands: () => commands } as never,
      harness.currentAutocomplete as never,
    );
    const signal = new AbortController().signal;

    await expect(
      provider.getSuggestions(["Use $ "], 0, 6, { signal }),
    ).resolves.toBeNull();
    await expect(
      provider.getSuggestions(["Use $rev "], 0, 9, { signal }),
    ).resolves.toBeNull();
    expect(harness.currentAutocomplete.getSuggestions).not.toHaveBeenCalled();

    await expect(
      provider.getSuggestions(["Use $rev "], 0, 9, { signal, force: true }),
    ).resolves.toEqual(harness.fallbackSuggestions);
    expect(harness.currentAutocomplete.getSuggestions).toHaveBeenCalledOnce();
  });

  test("delegates unrelated input and completion behavior", async () => {
    const harness = createHarness(commands);
    const provider = createSkillAutocompleteProvider(
      { getCommands: () => commands } as never,
      harness.currentAutocomplete as never,
    );
    const signal = new AbortController().signal;

    await expect(
      provider.getSuggestions(["Use $unknown"], 0, 12, { signal }),
    ).resolves.toEqual(harness.fallbackSuggestions);
    await expect(
      provider.getSuggestions(["/model $rev"], 0, 11, { signal }),
    ).resolves.toEqual(harness.fallbackSuggestions);
    expect(harness.currentAutocomplete.getSuggestions).toHaveBeenCalledTimes(2);

    expect(
      provider.applyCompletion(
        ["Use $rev now"],
        0,
        8,
        { value: "$review", label: "$review" },
        "$rev",
      ),
    ).toEqual({
      lines: ["Use $review now"],
      cursorLine: 0,
      cursorCol: 11,
    });
    expect(harness.currentAutocomplete.applyCompletion).toHaveBeenCalledOnce();
  });
});

describe("inline skill highlighting", () => {
  test("colors known aliases without changing visible width", () => {
    const original = "Use $review-my, $review, and $unknown.";
    const colored = colorizeSkillAliases(original, ["review", "review-my"]);

    expect(tuiMock.visibleWidth(colored)).toBe(tuiMock.visibleWidth(original));
    expect(colored).toContain("\x1b[38;2;251;148;255m$review-my\x1b[39m");
    expect(colored).toContain("\x1b[38;2;251;148;255m$review\x1b[39m");
    expect(colored).toContain("$unknown");
  });

  test("does not color a known skill that only prefixes a longer token", () => {
    const original = "Use $review-my and $reviewing.";
    expect(colorizeSkillAliases(original, ["review"])).toBe(original);
  });

  test("patches the editor once across session reloads", () => {
    const first = createHarness(commands);
    first.start("tui");

    const firstLine = new tuiMock.FakeEditor(["Use $review-my."]).render(
      80,
    )[0]!;
    expect(firstLine.match(/\x1b\[38;2;251;148;255m/g)).toHaveLength(1);
    first.shutdown();

    const second = createHarness(commands);
    second.start("tui");
    const secondLine = new tuiMock.FakeEditor(["Use $review-my."]).render(
      80,
    )[0]!;
    expect(secondLine.match(/\x1b\[38;2;251;148;255m/g)).toHaveLength(1);
    second.shutdown();
  });

  test("refreshes discovered skills and deactivates outside TUI lifecycle", () => {
    const discoveredCommands = [{ name: "skill:review", source: "skill" }];
    const tui = createHarness(discoveredCommands);
    tui.start("tui");

    const beforeDiscovery = new tuiMock.FakeEditor([
      "Use $review and $deploy.",
    ]).render(80)[0]!;
    expect(beforeDiscovery).toContain("\x1b[38;2;251;148;255m$review\x1b[39m");
    expect(beforeDiscovery).not.toContain("\x1b[38;2;251;148;255m$deploy");

    discoveredCommands.push({ name: "skill:deploy", source: "skill" });
    const afterDiscovery = new tuiMock.FakeEditor(["Use $deploy."]).render(
      80,
    )[0]!;
    expect(afterDiscovery).toContain("\x1b[38;2;251;148;255m$deploy\x1b[39m");
    tui.shutdown();

    const headless = createHarness([{ name: "skill:deploy", source: "skill" }]);
    headless.start("json");
    const headlessLine = new tuiMock.FakeEditor([
      "Use $review and $deploy.",
    ]).render(80)[0]!;
    expect(headlessLine).toBe("Use $review and $deploy.");
    headless.shutdown();
  });
});
