import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

class MockAssistantMessageComponent {
  hiddenThinkingLabel = "Thinking...";
  hideThinkingBlock = true;
  lastArgs: unknown[] = [];
  lastMessage?: { content: unknown[] };

  setHiddenThinkingLabel(label: string) {
    this.hiddenThinkingLabel = label;
  }

  updateContent(message: { content: unknown[] }, ...args: unknown[]) {
    this.lastMessage = message;
    this.lastArgs = args;
  }
}

vi.mock("@earendil-works/pi-coding-agent", () => ({
  AssistantMessageComponent: MockAssistantMessageComponent,
}));

const { default: thinkingBlockMerger } = await import(
  "../src/thinking-block-merger.ts"
);
const shutdownHandlers: Array<() => void> = [];

function install(): void {
  thinkingBlockMerger({
    on(event: string, handler: () => void) {
      if (event === "session_shutdown") shutdownHandlers.push(handler);
    },
  } as never);
}

beforeEach(() => {
  shutdownHandlers.length = 0;
  install();
});

afterEach(() => {
  for (const handler of shutdownHandlers.splice(0)) handler();
  vi.restoreAllMocks();
});

const thinkingMessage = (thinking = "work") => ({
  content: [{ type: "thinking", thinking }],
});

describe("thinking block merger", () => {
  test("combines only adjacent thinking blocks in a display copy", () => {
    const assistant = new MockAssistantMessageComponent();
    const message = {
      content: [
        { type: "thinking", thinking: "first", signature: "one" },
        { type: "thinking", thinking: "second", signature: "two" },
        { type: "toolCall", name: "read" },
        { type: "thinking", thinking: "third" },
        { type: "thinking", thinking: "fourth" },
        { type: "text", text: "answer" },
        { type: "thinking", thinking: "fifth" },
      ],
    };

    assistant.updateContent(message);

    expect(assistant.lastMessage?.content).toEqual([
      {
        type: "thinking",
        thinking: "first\n\nsecond",
        signature: "one",
      },
      { type: "toolCall", name: "read" },
      { type: "thinking", thinking: "third\n\nfourth" },
      { type: "text", text: "answer" },
      { type: "thinking", thinking: "fifth" },
    ]);
    expect(message.content[0]).toEqual({
      type: "thinking",
      thinking: "first",
      signature: "one",
    });
    expect(message.content[1]).toEqual({
      type: "thinking",
      thinking: "second",
      signature: "two",
    });
  });

  test("labels a hidden streaming thought and freezes its final duration", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const assistant = new MockAssistantMessageComponent();
    const globalSetter = vi.spyOn(assistant, "setHiddenThinkingLabel");
    const message = thinkingMessage();

    assistant.updateContent(message, true);
    expect(assistant.hiddenThinkingLabel).toBe("⠋ Thinking…");

    vi.setSystemTime(1_080);
    assistant.updateContent(message, true);
    expect(assistant.hiddenThinkingLabel).toBe("⠙ Thinking…");

    // Resize/theme rebuilds can omit the optional flag while still live.
    assistant.updateContent(message);
    expect(assistant.hiddenThinkingLabel).toBe("⠙ Thinking…");

    vi.setSystemTime(3_460);
    assistant.updateContent(message, false);
    expect(assistant.hiddenThinkingLabel).toBe("+ Thought · 2.5s");

    // Pi can rebuild a finalized row without a streaming argument on resize.
    assistant.updateContent(message);
    expect(assistant.hiddenThinkingLabel).toBe("+ Thought · 2.5s");
    expect(globalSetter).not.toHaveBeenCalled();
  });

  test("timestamps the first stream update before thinking text arrives", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const assistant = new MockAssistantMessageComponent();

    assistant.updateContent(thinkingMessage(""), true);
    expect(assistant.hiddenThinkingLabel).toBe("Thinking...");
    vi.setSystemTime(3_000);
    assistant.updateContent(thinkingMessage("later"), false);
    expect(assistant.hiddenThinkingLabel).toBe("+ Thought · 2.0s");
  });

  test("uses a timeless final label for restored and older-runtime rows", () => {
    const assistant = new MockAssistantMessageComponent();
    assistant.updateContent(thinkingMessage());
    expect(assistant.hiddenThinkingLabel).toBe("+ Thought");
  });

  test("keeps per-row timestamps isolated", () => {
    vi.useFakeTimers();
    const first = new MockAssistantMessageComponent();
    const second = new MockAssistantMessageComponent();

    vi.setSystemTime(1_000);
    first.updateContent(thinkingMessage("first"), true);
    vi.setSystemTime(2_000);
    second.updateContent(thinkingMessage("second"), true);
    vi.setSystemTime(2_500);
    first.updateContent(thinkingMessage("first"), false);
    vi.setSystemTime(5_500);
    second.updateContent(thinkingMessage("second"), false);

    expect(first.hiddenThinkingLabel).toBe("+ Thought · 1.5s");
    expect(second.hiddenThinkingLabel).toBe("+ Thought · 3.5s");
  });

  test("leaves visible-thinking rows and unsupported label shapes native", () => {
    const visible = new MockAssistantMessageComponent();
    visible.hideThinkingBlock = false;
    visible.updateContent(thinkingMessage(), true);
    visible.updateContent(thinkingMessage(), false);
    expect(visible.hiddenThinkingLabel).toBe("Thinking...");

    const unsupported = new MockAssistantMessageComponent();
    (unsupported as { hiddenThinkingLabel?: unknown }).hiddenThinkingLabel =
      undefined;
    const adjacent = {
      content: [
        { type: "thinking", thinking: "one" },
        { type: "thinking", thinking: "two" },
      ],
    };
    unsupported.updateContent(adjacent, true);
    expect(unsupported.lastMessage?.content).toEqual([
      { type: "thinking", thinking: "one\n\ntwo" },
    ]);
  });

  test("forwards optional streaming and future trailing arguments", () => {
    const assistant = new MockAssistantMessageComponent();
    const marker = { future: true };
    assistant.updateContent(thinkingMessage(), true, marker, 42);
    expect(assistant.lastArgs).toEqual([true, marker, 42]);
  });

  test("introduces no timer or render loop", () => {
    const interval = vi.spyOn(globalThis, "setInterval");
    const timeout = vi.spyOn(globalThis, "setTimeout");
    const assistant = new MockAssistantMessageComponent();
    assistant.updateContent(thinkingMessage(), true);
    assistant.updateContent(thinkingMessage(), false);
    expect(interval).not.toHaveBeenCalled();
    expect(timeout).not.toHaveBeenCalled();
  });

  test("falls back to the original message when combining throws", () => {
    for (const handler of shutdownHandlers.splice(0)) handler();

    let originalCalls = 0;
    const originalUpdateContent =
      MockAssistantMessageComponent.prototype.updateContent;
    MockAssistantMessageComponent.prototype.updateContent =
      function updateContentCounting(
        this: MockAssistantMessageComponent,
        message: { content: unknown[] },
        ...args: unknown[]
      ) {
        originalCalls++;
        this.lastMessage = message;
        this.lastArgs = args;
      };

    install();
    try {
      const assistant = new MockAssistantMessageComponent();
      const malformed = {
        get content() {
          throw new Error("combine failure");
        },
      };

      assistant.updateContent(malformed as never, false, "future");
      expect(originalCalls).toBe(1);
      expect(assistant.lastMessage).toBe(malformed);
      expect(assistant.lastArgs).toEqual([false, "future"]);
    } finally {
      for (const handler of shutdownHandlers.splice(0)) handler();
      MockAssistantMessageComponent.prototype.updateContent =
        originalUpdateContent;
    }
  });

  test("restores the original renderer on shutdown", () => {
    const patched = MockAssistantMessageComponent.prototype.updateContent;
    expect(patched).not.toBeUndefined();

    for (const handler of shutdownHandlers.splice(0)) handler();
    expect(MockAssistantMessageComponent.prototype.updateContent).not.toBe(
      patched,
    );
  });
});
