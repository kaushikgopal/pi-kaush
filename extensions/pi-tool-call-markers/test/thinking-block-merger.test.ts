import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

class MockAssistantMessageComponent {
  lastMessage?: { content: unknown[] };

  updateContent(message: { content: unknown[] }) {
    this.lastMessage = message;
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
});

describe("thinking block merger", () => {
  test("combines only adjacent thinking blocks", () => {
    const assistant = new MockAssistantMessageComponent();
    assistant.updateContent({
      content: [
        { type: "thinking", thinking: "first" },
        { type: "thinking", thinking: "second" },
        { type: "toolCall", name: "read" },
        { type: "thinking", thinking: "third" },
        { type: "thinking", thinking: "fourth" },
        { type: "text", text: "answer" },
        { type: "thinking", thinking: "fifth" },
      ],
    });

    expect(assistant.lastMessage?.content).toEqual([
      { type: "thinking", thinking: "first\n\nsecond" },
      { type: "toolCall", name: "read" },
      { type: "thinking", thinking: "third\n\nfourth" },
      { type: "text", text: "answer" },
      { type: "thinking", thinking: "fifth" },
    ]);
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
      ) {
        originalCalls++;
        this.lastMessage = message;
      };

    install();
    try {
      const assistant = new MockAssistantMessageComponent();
      const malformed = {
        get content() {
          throw new Error("combine failure");
        },
      };

      assistant.updateContent(malformed as never);
      expect(originalCalls).toBe(1);
      expect(assistant.lastMessage).toBe(malformed);
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
