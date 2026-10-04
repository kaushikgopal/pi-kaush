import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Mirrors Pi core: the hidden label renders as a Text node wrapped in
// italic + thinkingText, rebuilt on every update pass.
class MockLabelText {
  text: string;

  constructor(label: string) {
    this.text = `\x1b[3m\x1b[90m${label}\x1b[39m\x1b[23m`;
  }

  setText(text: string) {
    this.text = text;
  }
}

// Mirrors Pi core: a visible thinking trace renders as Markdown whose default
// text style carries the italic flag, and the component caches its lines.
class MockThinkingMarkdown {
  defaultTextStyle: { color: (text: string) => string; italic: boolean } = {
    color: (text: string) => text,
    italic: true,
  };
  invalidated = 0;

  invalidate() {
    this.invalidated++;
  }
}

class MockAssistantMessageComponent {
  hiddenThinkingLabel = "Thinking...";
  hideThinkingBlock = true;
  lastArgs: unknown[] = [];
  lastMessage?: { content: unknown[] };
  contentContainer: { children: unknown[] } = { children: [] };

  setHiddenThinkingLabel(label: string) {
    this.hiddenThinkingLabel = label;
  }

  updateContent(message: { content: unknown[] }, ...args: unknown[]) {
    this.lastMessage = message;
    this.lastArgs = args;
    const hasThinking = message.content.some(
      (content) =>
        (content as { type?: string } | undefined)?.type === "thinking",
    );
    this.contentContainer.children =
      this.hideThinkingBlock === true &&
      typeof this.hiddenThinkingLabel === "string"
        ? [new MockLabelText(this.hiddenThinkingLabel)]
        : hasThinking
          ? [new MockThinkingMarkdown()]
          : [];
  }

  get labelChild(): MockLabelText | undefined {
    const child = this.contentContainer.children[0];
    return child instanceof MockLabelText ? child : undefined;
  }

  get markdownChild(): MockThinkingMarkdown | undefined {
    const child = this.contentContainer.children[0];
    return child instanceof MockThinkingMarkdown ? child : undefined;
  }
}

vi.mock("@earendil-works/pi-coding-agent", () => ({
  AssistantMessageComponent: MockAssistantMessageComponent,
}));

const { default: thinkingBlockMerger, visibleThoughtLabel } = await import(
  "../src/thinking-block-merger.ts"
);
const shutdownHandlers: Array<() => void> = [];
const sessionStartHandlers: Array<
  (event: unknown, ctx: { mode: string; ui: { theme?: unknown } }) => void
> = [];

function install(): void {
  thinkingBlockMerger({
    on(event: string, handler: never) {
      if (event === "session_shutdown") shutdownHandlers.push(handler);
      if (event === "session_start") sessionStartHandlers.push(handler);
    },
    getThinkingLevel: () => "medium",
  } as never);
}

function startSession(theme?: unknown): void {
  for (const handler of sessionStartHandlers) {
    handler({}, { mode: "tui", ui: { theme } });
  }
}

// mdHeading resolves to cobalt2's orange (#ffb86c) in truecolor and muted to
// a distinct gray; the mock hands back the ready sequence like a real Theme
// would — including throwing on unknown tokens.
function fgAnsiStrict(known: Record<string, string>, color: string): string {
  const ansi = known[color];
  if (ansi === undefined) throw new Error(`Unknown theme color: ${color}`);
  return ansi;
}

function mockTheme(colorMode = "truecolor"): unknown {
  return {
    getColorMode: () => colorMode,
    getFgAnsi: (color: string) =>
      fgAnsiStrict(
        {
          mdHeading: "\x1b[38;2;255;184;108m",
          thinkingMedium: "\x1b[38;2;255;184;108m",
          muted: "\x1b[38;2;110;118;129m",
        },
        color,
      ),
  };
}

beforeEach(() => {
  shutdownHandlers.length = 0;
  sessionStartHandlers.length = 0;
  install();
});

afterEach(() => {
  for (const handler of shutdownHandlers.splice(0)) handler();
  vi.unstubAllEnvs();
  vi.useRealTimers();
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

  test("replaces label nodes: live level-colored, settled muted", () => {
    vi.useFakeTimers();
    startSession(mockTheme());
    const assistant = new MockAssistantMessageComponent();

    vi.setSystemTime(1_000);
    assistant.updateContent(thinkingMessage(), true);
    // The field stays plain; styling happens on the rendered Text node so
    // the TUI diff renderer cannot skip the italic reset.
    expect(assistant.hiddenThinkingLabel).toBe("⠋ Thinking…");
    expect(assistant.labelChild?.text).toBe(
      "\x1b[23m\x1b[38;2;255;184;108m⠋ Thinking…\x1b[39m",
    );

    vi.setSystemTime(3_500);
    assistant.updateContent(thinkingMessage(), false);
    expect(assistant.hiddenThinkingLabel).toBe("+ Thought · 2.5s");
    // Settled rows quiet down to the muted tool-call tone.
    expect(assistant.labelChild?.text).toBe(
      "\x1b[23m\x1b[38;2;110;118;129m+ Thought · 2.5s\x1b[39m",
    );
  });

  test("leaves visible-thinking rows without a replacement label node", () => {
    startSession(mockTheme());
    const visible = new MockAssistantMessageComponent();
    visible.hideThinkingBlock = false;
    visible.updateContent(thinkingMessage(), false);
    expect(visible.labelChild).toBeUndefined();
  });

  test("drops italics from a visible thinking trace once it settles", () => {
    const assistant = new MockAssistantMessageComponent();
    assistant.hideThinkingBlock = false;
    assistant.updateContent(thinkingMessage(), true);
    expect(assistant.markdownChild?.defaultTextStyle.italic).toBe(true);

    assistant.updateContent(thinkingMessage(), false);
    const settled = assistant.markdownChild;
    expect(settled?.defaultTextStyle.italic).toBe(false);
    expect(settled?.invalidated).toBe(1);
  });

  test("keeps a live trace italic through un-flagged rebuilds", () => {
    const assistant = new MockAssistantMessageComponent();
    assistant.hideThinkingBlock = false;
    assistant.updateContent(thinkingMessage(), true);
    // Resize and theme switches rebuild the row without the streaming flag.
    assistant.updateContent(thinkingMessage());
    expect(assistant.markdownChild?.defaultTextStyle.italic).toBe(true);

    assistant.updateContent(thinkingMessage(), false);
    assistant.updateContent(thinkingMessage());
    expect(assistant.markdownChild?.defaultTextStyle.italic).toBe(false);
  });

  test("treats restored visible thinking as settled", () => {
    const restored = new MockAssistantMessageComponent();
    restored.hideThinkingBlock = false;
    restored.updateContent(thinkingMessage());
    expect(restored.markdownChild?.defaultTextStyle.italic).toBe(false);
  });

  test("passes through the theme-resolved sequence on indexed terminals", () => {
    vi.stubEnv("PI_TOOL_CALL_MARKERS_THOUGHT_COLOR", "mdheading");
    startSession({
      getColorMode: () => "256color",
      getFgAnsi: (color: string) =>
        fgAnsiStrict({ mdHeading: "\x1b[38;5;215m" }, color),
    });
    expect(visibleThoughtLabel("+ Thought")).toBe(
      "\x1b[23m\x1b[38;5;215m+ Thought\x1b[39m",
    );
  });

  test("keeps native italic styling only for the inherit variant", () => {
    vi.stubEnv("PI_TOOL_CALL_MARKERS_THOUGHT_COLOR", "inherit");
    startSession({ getColorMode: () => "truecolor" });
    expect(visibleThoughtLabel("+ Thought")).toBe("+ Thought");

    startSession(undefined);
    expect(visibleThoughtLabel("+ Thought")).toBe("+ Thought");
  });

  test("drops italics even when the theme resolves no color", () => {
    startSession({
      getColorMode: () => "truecolor",
      getFgAnsi: () => {
        throw new Error("Unknown theme color");
      },
    });
    expect(visibleThoughtLabel("+ Thought")).toBe("\x1b[23m+ Thought");
    expect(visibleThoughtLabel("⠋ Thinking…")).toBe("\x1b[23m⠋ Thinking…");

    startSession(undefined);
    expect(visibleThoughtLabel("+ Thought")).toBe("\x1b[23m+ Thought");
  });

  test("tints the live label with the level token and settles muted", () => {
    startSession({
      getColorMode: () => "truecolor",
      getFgAnsi: (color: string) =>
        fgAnsiStrict(
          {
            thinkingMedium: "\x1b[38;5;67m",
            muted: "\x1b[38;5;244m",
          },
          color,
        ),
    });
    expect(visibleThoughtLabel("⠋ Thinking…")).toBe(
      "\x1b[23m\x1b[38;5;67m⠋ Thinking…\x1b[39m",
    );
    expect(visibleThoughtLabel("+ Thought")).toBe(
      "\x1b[23m\x1b[38;5;244m+ Thought\x1b[39m",
    );
  });

  test("keeps thinking merging and styling until the final owner shuts down", () => {
    install();
    startSession(mockTheme());
    const patched = MockAssistantMessageComponent.prototype.updateContent;
    const [firstShutdown, finalShutdown] = shutdownHandlers.splice(0);

    firstShutdown!();
    firstShutdown!();
    const assistant = new MockAssistantMessageComponent();
    assistant.updateContent({
      content: [
        { type: "thinking", thinking: "one" },
        { type: "thinking", thinking: "two" },
      ],
    });
    expect(assistant.lastMessage?.content).toEqual([
      { type: "thinking", thinking: "one\n\ntwo" },
    ]);
    expect(visibleThoughtLabel("+ Thought")).not.toBe("+ Thought");
    expect(MockAssistantMessageComponent.prototype.updateContent).toBe(patched);

    finalShutdown!();
    expect(visibleThoughtLabel("+ Thought")).toBe("+ Thought");
    expect(MockAssistantMessageComponent.prototype.updateContent).not.toBe(
      patched,
    );
  });

  test("drops styling again on shutdown", () => {
    startSession(mockTheme());
    expect(visibleThoughtLabel("+ Thought")).not.toBe("+ Thought");
    for (const handler of shutdownHandlers.splice(0)) handler();
    expect(visibleThoughtLabel("+ Thought")).toBe("+ Thought");
    install();
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
