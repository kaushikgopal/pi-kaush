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
import { runChatContainerHooks } from "../src/container-hooks.ts";
import {
  infoVisibilityHidden,
  setInfoVisibilityHidden,
} from "../src/info-visibility-state.ts";
import { installInfoVisibility } from "../src/info-visibility.ts";
import thinkingBlockMerger from "../src/thinking-block-merger.ts";

type Handler = (event: unknown, ctx: unknown) => void;

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

  return {
    pi,
    commands,
    handlers,
    notifications,
    start(mode = "tui") {
      for (const handler of handlers.get("session_start") ?? []) {
        handler({}, { mode, ui: { theme: {} } });
      }
    },
    toggle() {
      return commands.get("toggle-info")!.handler("", ctx);
    },
  };
}

initTheme("dark");

beforeEach(() => {
  setInfoVisibilityHidden(false);
});

describe("toggle-info command", () => {
  test("flips visibility, restores on a second toggle, and notifies", async () => {
    const harness = createHarness();
    installInfoVisibility(harness.pi as ExtensionAPI);
    harness.start();

    expect(infoVisibilityHidden()).toBe(false);
    await harness.toggle();
    expect(infoVisibilityHidden()).toBe(true);
    expect(harness.notifications[0]).toContain("hidden");
    await harness.toggle();
    expect(infoVisibilityHidden()).toBe(false);
    expect(harness.notifications[1]).toContain("visible");
  });

  test("resets to visible on session start", async () => {
    const harness = createHarness();
    installInfoVisibility(harness.pi as ExtensionAPI);
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
    const harness = createHarness();
    installInfoVisibility(harness.pi as ExtensionAPI);
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

  test("is a no-op while visible and on containers without executions", () => {
    const harness = createHarness();
    installInfoVisibility(harness.pi as ExtensionAPI);
    harness.start();

    const withTool: unknown[] = [new Text("a", 0, 0), toolRow()];
    const restoreVisible = runChatContainerHooks(new Container(), withTool, 80);
    restoreVisible();
    expect(withTool).toHaveLength(2);

    setInfoVisibilityHidden(true);
    const proseOnly: unknown[] = [new Text("a", 0, 0)];
    const restoreEmpty = runChatContainerHooks(new Container(), proseOnly, 80);
    restoreEmpty();
    expect(proseOnly).toHaveLength(1);
  });
});

describe("thinking stripping with real components", () => {
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
  thinkingBlockMerger({
    on(event: string, handler: never) {
      if (event === "session_start") sessionStarts.push(handler);
    },
    getThinkingLevel: () => "medium",
  } as never);
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
    const state = proto[Symbol.for("kg.pi.thinkingGrouping.v2")] as {
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
