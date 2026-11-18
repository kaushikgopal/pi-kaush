import { stripVTControlCharacters } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  BashExecutionComponent,
  initTheme,
  ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, test, vi } from "vitest";

const stripAnsi = (text: string) =>
  text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
import { afterEach } from "vitest";
import { runChatContainerHooks } from "../src/container-hooks.ts";
import {
  infoVisibilityHidden,
  setInfoVisibilityHidden,
} from "../src/info-visibility-state.ts";
import {
  installInfoVisibility,
  uninstallInfoVisibility,
} from "../src/info-visibility.ts";
import thinkingBlockMerger from "../src/thinking-block-merger.ts";

type Handler = (event: unknown, ctx: unknown) => void;

// Every harness releases the owners it installed when its test ends: the
// toggle state and the hook registry are process-global, so a test that
// leaves an owner behind would change what the next test observes.
const liveHarnesses: Array<{ shutdown(): void }> = [];

afterEach(() => {
  for (const harness of liveHarnesses.splice(0)) harness.shutdown();
});

function createHarness() {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<
    string,
    { handler: (args: string, ctx: unknown) => Promise<void> }
  >();
  const notifications: string[] = [];
  const pi = {
    on(event: string, handler: Handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerCommand(
      name: string,
      command: { handler: (args: string, ctx: unknown) => Promise<void> },
    ) {
      commands.set(name, command);
    },
  } as unknown as ExtensionAPI;
  const ctx = { ui: { notify: (text: string) => notifications.push(text) } };
  let owners = 0;

  const harness = {
    pi,
    commands,
    handlers,
    notifications,
    // Mirrors the entrypoint, which installs the toggle and releases it
    // again from its own shutdown handler.
    install() {
      installInfoVisibility(pi);
      owners += 1;
      return harness;
    },
    releaseOwner() {
      if (owners <= 0) return;
      owners -= 1;
      uninstallInfoVisibility();
    },
    shutdown() {
      while (owners > 0) harness.releaseOwner();
    },
    start(mode = "tui") {
      for (const handler of handlers.get("session_start") ?? []) {
        handler({}, { mode, ui: { theme: {} } });
      }
    },
    toggle() {
      return commands.get("toggle-info")!.handler("", ctx);
    },
  };
  liveHarnesses.push(harness);
  return harness;
}

initTheme("dark");

beforeEach(() => {
  setInfoVisibilityHidden(false);
});

describe("toggle-info command", () => {
  test("repaints the existing transcript on each toggle and notifies", async () => {
    const { AssistantMessageComponent } = await import(
      "@earendil-works/pi-coding-agent"
    );
    const harness = createHarness().install();
    const mergerStarts = installMerger();
    harness.start();
    for (const handler of mergerStarts) {
      handler({}, { mode: "tui", ui: { theme: {} } });
    }

    const transcript = new Container();
    transcript.addChild(new Text("Opening prose", 0, 0));
    transcript.addChild(
      new AssistantMessageComponent(
        {
          role: "assistant",
          content: [
            { type: "text", text: "First answer." },
            { type: "thinking", thinking: "First private thought." },
          ],
          stopReason: "stop",
        } as never,
        true,
      ),
    );
    const firstExecution = new BashExecutionComponent("printf first", {
      requestRender() {},
    } as never);
    firstExecution.appendOutput("first command output");
    firstExecution.setComplete(0, false);
    transcript.addChild(firstExecution);
    transcript.addChild(new Text("Middle prose", 0, 0));
    transcript.addChild(
      new AssistantMessageComponent(
        {
          role: "assistant",
          content: [
            { type: "text", text: "Second answer." },
            { type: "thinking", thinking: "Second private thought." },
          ],
          stopReason: "stop",
        } as never,
        true,
      ),
    );
    const secondExecution = new BashExecutionComponent("printf second", {
      requestRender() {},
    } as never);
    secondExecution.appendOutput("second command output");
    secondExecution.setComplete(0, false);
    transcript.addChild(secondExecution);
    transcript.addChild(new Text("Closing prose", 0, 0));

    const renderTranscript = () => {
      const restore = runChatContainerHooks(
        transcript,
        transcript.children,
        80,
      );
      try {
        return transcript
          .render(80)
          .map((line) => stripVTControlCharacters(line).trim())
          .filter(Boolean);
      } finally {
        restore();
      }
    };
    const visibleBefore = renderTranscript();
    expect(visibleBefore).toContain("Opening prose");
    expect(visibleBefore).toContain("Middle prose");
    expect(visibleBefore).toContain("Closing prose");
    expect(visibleBefore).toContain("First answer.");
    expect(visibleBefore).toContain("Second answer.");
    expect(
      visibleBefore.filter((line) => line.includes("Thought")),
    ).toHaveLength(2);
    expect(visibleBefore.join(" ")).toContain("first command output");
    expect(visibleBefore.join(" ")).toContain("second command output");

    expect(infoVisibilityHidden()).toBe(false);
    await harness.toggle();
    expect(infoVisibilityHidden()).toBe(true);
    expect(harness.notifications[0]).toContain("hidden");
    const hidden = renderTranscript();
    expect(hidden).toContain("Opening prose");
    expect(hidden).toContain("Middle prose");
    expect(hidden).toContain("Closing prose");
    expect(hidden).toContain("First answer.");
    expect(hidden).toContain("Second answer.");
    expect(hidden.some((line) => line.includes("Thought"))).toBe(false);
    expect(hidden.join(" ")).not.toContain("first command output");
    expect(hidden.join(" ")).not.toContain("second command output");

    await harness.toggle();
    expect(infoVisibilityHidden()).toBe(false);
    expect(harness.notifications[1]).toContain("visible");
    const visibleAfter = renderTranscript();
    expect(
      visibleAfter.filter((line) => line.includes("Thought")),
    ).toHaveLength(2);
    expect(visibleAfter.join(" ")).toContain("first command output");
    expect(visibleAfter.join(" ")).toContain("second command output");
  });

  test("resets to visible on session start", async () => {
    const harness = createHarness().install();
    harness.start();
    await harness.toggle();
    expect(infoVisibilityHidden()).toBe(true);
    harness.start();
    expect(infoVisibilityHidden()).toBe(false);
  });
});

describe("info filter hook", () => {
  // Prototype instances are enough: the filter hook only checks instanceof.
  function toolRow(): ToolExecutionComponent {
    return Object.create(ToolExecutionComponent.prototype);
  }
  function bashRow(): BashExecutionComponent {
    return Object.create(BashExecutionComponent.prototype);
  }

  test("lifts tool and bash rows out during render and restores them after", () => {
    const harness = createHarness().install();
    harness.start();
    setInfoVisibilityHidden(true);

    const children: unknown[] = [
      new Text("before", 0, 0),
      toolRow(),
      bashRow(),
      new Text("after", 0, 0),
    ];
    const original = [...children];

    const container = new Container();
    const restore = runChatContainerHooks(container, children, 80);
    try {
      expect(children).toHaveLength(2);
      expect(children.every((child) => child instanceof Text)).toBe(true);
    } finally {
      restore();
    }
    expect(children).toEqual(original);
  });

  test("removes the filter and resets the toggle at its last owner's shutdown", async () => {
    const harness = createHarness().install();
    harness.start();
    await harness.toggle();
    expect(infoVisibilityHidden()).toBe(true);

    harness.shutdown();
    expect(infoVisibilityHidden()).toBe(false);
    const children: unknown[] = [new Text("a", 0, 0), toolRow()];
    const restore = runChatContainerHooks(new Container(), children, 80);
    // With the hook gone nothing is lifted out of the render pass.
    expect(children).toHaveLength(2);
    restore();
    expect(children).toHaveLength(2);
  });

  test("keeps the filter while another owner remains", async () => {
    const harness = createHarness().install();
    harness.install();
    harness.start();
    await harness.toggle();

    // One install's teardown leaves the other's filter in place; the hook
    // leaves the registry only with the last owner.
    harness.releaseOwner();
    const filtered: unknown[] = [new Text("a", 0, 0), toolRow()];
    const restoreFiltered = runChatContainerHooks(
      new Container(),
      filtered,
      80,
    );
    expect(filtered).toHaveLength(1);
    restoreFiltered();
    expect(filtered).toHaveLength(2);

    harness.releaseOwner();
    expect(infoVisibilityHidden()).toBe(false);
    const restored: unknown[] = [new Text("a", 0, 0), toolRow()];
    const restoreRestored = runChatContainerHooks(
      new Container(),
      restored,
      80,
    );
    expect(restored).toHaveLength(2);
    restoreRestored();
  });

  test("is a no-op while visible and on containers without executions", () => {
    const harness = createHarness().install();
    harness.start();

    const withTool: unknown[] = [new Text("a", 0, 0), toolRow()];
    const originalWithTool = [...withTool];
    const restoreVisible = runChatContainerHooks(new Container(), withTool, 80);
    expect(withTool).toHaveLength(2);
    expect(withTool[0]).toBe(originalWithTool[0]);
    expect(withTool[1]).toBe(originalWithTool[1]);
    restoreVisible();
    expect(withTool).toHaveLength(2);
    expect(withTool[0]).toBe(originalWithTool[0]);
    expect(withTool[1]).toBe(originalWithTool[1]);

    setInfoVisibilityHidden(true);
    const proseOnly: unknown[] = [new Text("a", 0, 0)];
    const originalProse = [...proseOnly];
    const restoreEmpty = runChatContainerHooks(new Container(), proseOnly, 80);
    expect(proseOnly).toHaveLength(1);
    expect(proseOnly[0]).toBe(originalProse[0]);
    restoreEmpty();
    expect(proseOnly).toHaveLength(1);
    expect(proseOnly[0]).toBe(originalProse[0]);
  });
});

describe("thinking stripping with real components", () => {
  test.each(["before completion", "after completion"])(
    "keeps thinking duration unchanged when toggle-info interleaves with a trailing thinking run (show %s)",
    async (show) => {
      const { AssistantMessageComponent } = await import(
        "@earendil-works/pi-coding-agent"
      );
      const harness = createHarness().install();
      thinkingBlockMerger(harness.pi);
      harness.start();
      vi.useFakeTimers();
      try {
        const row = new AssistantMessageComponent(undefined, true);
        const update = row.updateContent.bind(row) as (
          message: unknown,
          streaming?: boolean,
        ) => void;
        const message = {
          role: "assistant",
          content: [
            { type: "text", text: "Earlier answer segment." },
            {
              type: "thinking",
              thinking: "Still considering the next segment.",
            },
          ],
        };
        const lines = () =>
          row
            .render(80)
            .map((line) => stripVTControlCharacters(line).trim())
            .filter(Boolean);

        vi.setSystemTime(1_000);
        update(message, true);
        expect(lines()).toEqual(["Earlier answer segment.", "▏⠋ Thinking…"]);

        vi.setSystemTime(2_000);
        await harness.toggle();
        expect(lines()).toEqual(["Earlier answer segment."]);

        if (show === "before completion") {
          vi.setSystemTime(3_000);
          await harness.toggle();
        }
        vi.setSystemTime(4_000);
        update({ ...message, stopReason: "stop" }, false);
        if (show === "after completion") {
          expect(lines()).toEqual(["Earlier answer segment."]);
          vi.setSystemTime(5_000);
          await harness.toggle();
        }
        expect(lines()).toEqual([
          "Earlier answer segment.",
          "▏* Thought · 3.0s",
        ]);
      } finally {
        for (const handler of harness.handlers.get("session_shutdown") ?? []) {
          handler({}, {});
        }
        vi.useRealTimers();
      }
    },
  );

  test("hides the collapsed thought label and restores it", async () => {
    const { AssistantMessageComponent } = await import(
      "@earendil-works/pi-coding-agent"
    );
    const sessionStarts = installMerger();
    for (const handler of sessionStarts) {
      handler({}, { mode: "tui", ui: { theme: {} } });
    }

    const message = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "ponder" },
        { type: "text", text: "answer" },
      ],
      stopReason: "stop",
    };
    const row = new AssistantMessageComponent(message as never, true);
    const hasThought = () =>
      row.render(60).some((line) => stripAnsi(line).includes("Thought"));
    expect(hasThought()).toBe(true);

    setInfoVisibilityHidden(true);
    const { refreshThinkingVisibility } = await import(
      "../src/thinking-block-merger.ts"
    );
    refreshThinkingVisibility();
    expect(hasThought()).toBe(false);

    setInfoVisibilityHidden(false);
    refreshThinkingVisibility();
    expect(hasThought()).toBe(true);
  });
});

function installMerger() {
  const sessionStarts: Handler[] = [];
  const sessionShutdowns: Handler[] = [];
  let released = false;
  thinkingBlockMerger({
    on(event: string, handler: never) {
      if (event === "session_start") sessionStarts.push(handler);
      if (event === "session_shutdown") sessionShutdowns.push(handler);
    },
    getThinkingLevel: () => "medium",
  } as never);
  liveHarnesses.push({
    shutdown() {
      if (released) return;
      released = true;
      for (const handler of sessionShutdowns) handler({}, {});
    },
  });
  return sessionStarts;
}

describe("thinking stripping", () => {
  const thinkingMessage = () => ({
    content: [
      { type: "thinking", thinking: "ponder" },
      { type: "text", text: "answer" },
    ],
  });

  test("strips thinking blocks while hidden and replays them when restored", async () => {
    const sessionStarts = installMerger();
    for (const handler of sessionStarts) {
      handler({}, { mode: "tui", ui: { theme: {} } });
    }

    const { AssistantMessageComponent } = await import(
      "@earendil-works/pi-coding-agent"
    );
    const proto = AssistantMessageComponent.prototype as unknown as Record<
      symbol,
      unknown
    > & {
      updateContent(message: unknown, ...args: unknown[]): void;
    };
    const state = proto[Symbol.for("kg.pi.thinkingGrouping.v3")] as {
      originalUpdateContent: (message: unknown, ...args: unknown[]) => void;
    };

    // Swap the patch state's original for a recorder, so we observe exactly
    // what Pi would render — after combine/strip.
    const received: unknown[] = [];
    const previous = state.originalUpdateContent;
    state.originalUpdateContent = (message: unknown) => {
      received.push(message);
    };
    try {
      setInfoVisibilityHidden(false);
      proto.updateContent.call({}, thinkingMessage(), false);
      expect((received.at(-1) as { content: unknown[] }).content).toHaveLength(
        2,
      );

      setInfoVisibilityHidden(true);
      proto.updateContent.call({}, thinkingMessage(), false);
      const stripped = received.at(-1) as { content: Array<{ type: string }> };
      expect(stripped.content).toHaveLength(1);
      expect(stripped.content[0]?.type).toBe("text");

      // Toggling back replays the row's last update with thinking restored.
      setInfoVisibilityHidden(false);
      const { refreshThinkingVisibility } = await import(
        "../src/thinking-block-merger.ts"
      );
      refreshThinkingVisibility();
      expect((received.at(-1) as { content: unknown[] }).content).toHaveLength(
        2,
      );
    } finally {
      state.originalUpdateContent = previous;
      setInfoVisibilityHidden(false);
    }
  });
});
