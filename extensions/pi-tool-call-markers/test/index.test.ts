import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

function stripAnsi(text: string): string {
  return text.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
}

class MockContainer {
  children: Array<{ render(width: number): string[]; invalidate?(): void }> =
    [];

  addChild(component: {
    render(width: number): string[];
    invalidate?(): void;
  }) {
    this.children.push(component);
  }

  removeChild(component: {
    render(width: number): string[];
    invalidate?(): void;
  }) {
    const index = this.children.indexOf(component);
    if (index !== -1) this.children.splice(index, 1);
  }

  clear() {
    this.children = [];
  }

  invalidate() {
    for (const child of this.children) child.invalidate?.();
  }

  render(width: number): string[] {
    return this.children.flatMap((child) => child.render(width));
  }
}

class MockText {
  renderCount = 0;

  constructor(public text: string) {}

  setText(text: string) {
    this.text = text;
  }

  invalidate() {}

  render(width: number): string[] {
    this.renderCount++;
    return this.text.split("\n").map((line) => line.slice(0, width));
  }
}

class MockBox extends MockContainer {
  constructor(_paddingX = 1, _paddingY = 1, _bg?: (text: string) => string) {
    super();
  }

  override render(width: number): string[] {
    return super.render(Math.max(1, width - 1)).map((line) => ` ${line}`);
  }
}

class MockToolExecutionComponent extends MockContainer {
  toolCallId: string;
  args: { label: string };
  expanded = false;
  isPartial = true;
  result?: { isError: boolean; output: string };
  contentBox = new MockBox();
  contentText = new MockText("");
  selfRenderContainer = new MockContainer();
  callRendererComponent?: MockText;
  imageComponents: unknown[] = [];
  imageSpacers: unknown[] = [];

  constructor(
    public toolName: string,
    label: string,
  ) {
    super();
    this.toolCallId = `${toolName}-${label}`;
    this.args = { label };
    this.addChild(new MockText(""));
    this.addChild(this.contentBox);
    this.updateDisplay();
  }

  hasRendererDefinition() {
    return true;
  }

  getRenderShell() {
    return "default" as const;
  }

  getTextOutput() {
    return this.result?.output ?? "";
  }

  updateDisplay() {
    this.contentBox.clear();
    const token = this.toolName === "bash" ? "$" : this.toolName;
    this.callRendererComponent = new MockText(`${token} ${this.args.label}`);
    this.contentBox.addChild(this.callRendererComponent);
    if (this.result) {
      const detail =
        this.result.isError && this.expanded
          ? `FULL ${this.result.output}`
          : this.result.output;
      this.contentBox.addChild(new MockText(detail));
    }
  }

  updateResult(
    result: { isError: boolean; output: string },
    isPartial = false,
  ) {
    this.result = result;
    this.isPartial = isPartial;
    this.updateDisplay();
  }

  setExpanded(expanded: boolean) {
    this.expanded = expanded;
    this.updateDisplay();
  }
}

class MockAssistantMessageComponent extends MockContainer {
  lastMessage?: { content: unknown[] };

  updateContent(message: { content: unknown[] }) {
    this.lastMessage = message;
  }
}

vi.mock("@earendil-works/pi-tui", () => ({
  Box: MockBox,
  Container: MockContainer,
  sliceByColumn(text: string, start: number, width: number) {
    return text.slice(start, start + width);
  },
  truncateToWidth(text: string, width: number, suffix = "") {
    if (text.length <= width) return text;
    return text.slice(0, Math.max(0, width - suffix.length)) + suffix;
  },
  visibleWidth: (text: string) => stripAnsi(text).length,
  wrapTextWithAnsi(text: string, width: number) {
    const lines: string[] = [];
    for (const sourceLine of text.split("\n")) {
      let remaining = sourceLine;
      while (remaining.length > width) {
        lines.push(remaining.slice(0, width));
        remaining = remaining.slice(width);
      }
      lines.push(remaining);
    }
    return lines;
  },
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  AssistantMessageComponent: MockAssistantMessageComponent,
  ToolExecutionComponent: MockToolExecutionComponent,
}));

const { default: toolCallMarkers } = await import("../src/index.ts");

const sessionHandlers: Array<(event: unknown, ctx: unknown) => void> = [];
const shutdownHandlers: Array<() => void> = [];
const theme = {
  bold: (text: string) => text,
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
};

function renderPlain(container: MockContainer): string {
  return container
    .render(100)
    .map(stripAnsi)
    .filter((line) => line.trim())
    .join("\n");
}

function succeeded(
  toolName: string,
  label: string,
): MockToolExecutionComponent {
  const row = new MockToolExecutionComponent(toolName, label);
  row.updateResult({ isError: false, output: `result:${label}` });
  return row;
}

function install(): void {
  toolCallMarkers({
    on(event: string, handler: (event: unknown, ctx: unknown) => void) {
      if (event === "session_start") sessionHandlers.push(handler);
      if (event === "session_shutdown")
        shutdownHandlers.push(handler as () => void);
    },
  } as never);
  for (const handler of sessionHandlers) {
    handler({}, { ui: { theme, setToolsExpanded() {} } });
  }
}

beforeEach(() => {
  sessionHandlers.length = 0;
  shutdownHandlers.length = 0;
  install();
});

afterEach(() => {
  for (const handler of shutdownHandlers) handler();
});

describe("tool-call-markers grouping", () => {
  test("renders adjacent successful calls as one header with bullets", () => {
    const chat = new MockContainer();
    chat.addChild(succeeded("read", "one.md"));
    chat.addChild(succeeded("read", "two.md"));
    chat.addChild(succeeded("read", "three.md"));

    const output = renderPlain(chat);
    expect(output.match(/⚙️/g)).toHaveLength(1);
    expect(output).toContain("⚙️ read");
    expect(output).toContain("• one.md");
    expect(output).toContain("• two.md");
    expect(output).toContain("• three.md");
    expect(output).not.toContain("result:");
  });

  test("reuses the grouped render while the calls are unchanged", () => {
    const chat = new MockContainer();
    const first = succeeded("read", "one.md");
    const second = succeeded("read", "two.md");
    chat.addChild(first);
    chat.addChild(second);

    renderPlain(chat);
    const firstCount = first.callRendererComponent?.renderCount;
    const secondCount = second.callRendererComponent?.renderCount;
    renderPlain(chat);

    expect(first.callRendererComponent?.renderCount).toBe(firstCount);
    expect(second.callRendererComponent?.renderCount).toBe(secondCount);
  });

  test("refreshes a cached group when any row display changes", () => {
    const chat = new MockContainer();
    const first = succeeded("read", "one.md");
    const second = succeeded("read", "two.md");
    chat.addChild(first);
    chat.addChild(second);
    renderPlain(chat);

    second.args.label = "changed.md";
    second.updateDisplay();

    const output = renderPlain(chat);
    expect(output).toContain("• changed.md");
    expect(output).not.toContain("• two.md");
  });

  test("preserves custom and multiline call summaries", () => {
    const chat = new MockContainer();
    for (const label of ["one", "two"]) {
      const row = succeeded("custom", label);
      row.callRendererComponent = new MockText(
        `direct-${label}\n  detail-${label}\n  extra-${label}\n  omitted-${label}`,
      );
      row.contentBox.children[0] = row.callRendererComponent;
      chat.addChild(row);
    }

    const output = renderPlain(chat);
    expect(output).toContain("• direct-one · detail-one · extra-one · …");
    expect(output).toContain("• direct-two · detail-two · extra-two · …");
  });

  test("uses a hanging indent for wrapped bullet summaries", () => {
    const chat = new MockContainer();
    for (const label of ["one", "two"]) {
      const row = succeeded("custom", label);
      row.callRendererComponent = new MockText(
        `custom first-${label}\nsecond-${label}\nthird-${label}`,
      );
      row.contentBox.children[0] = row.callRendererComponent;
      chat.addChild(row);
    }

    const lines = chat
      .render(24)
      .map(stripAnsi)
      .filter((line) => line.trim());
    const bulletIndex = lines.findIndex((line) => line.includes("•"));
    const textColumn = lines[bulletIndex]!.indexOf("first-one");
    expect(textColumn).toBeGreaterThan(0);
    expect(lines[bulletIndex + 1]?.slice(0, textColumn).trim()).toBe("");
    expect(lines[bulletIndex + 1]?.trimStart()).not.toMatch(/^•/);
    expect(lines.every((line) => line.length <= 24)).toBe(true);
  });

  test("groups adjacent successful calls under per-tool bullet lists", () => {
    const chat = new MockContainer();
    chat.addChild(succeeded("read", "one.md"));
    chat.addChild(succeeded("read", "two.md"));
    chat.addChild(succeeded("write", "one.md"));
    chat.addChild(succeeded("write", "two.md"));

    const renderedLines = chat.render(100).map(stripAnsi);
    const output = renderedLines.filter((line) => line.trim()).join("\n");
    expect(output.match(/⚙️/g)).toHaveLength(2);
    expect(output).toContain("⚙️ read");
    expect(output).toMatch(
      /• one\.md\n\s*• two\.md\n\s*⚙️ write\n\s*• one\.md\n\s*• two\.md/,
    );
    const writeHeading = renderedLines.findIndex((line) =>
      line.includes("⚙️ write"),
    );
    expect(renderedLines[writeHeading - 1]?.trim()).toBe("");
  });

  test("preserves call order when a tool name reappears", () => {
    const chat = new MockContainer();
    chat.addChild(succeeded("bash", "first"));
    chat.addChild(succeeded("read", "middle.md"));
    chat.addChild(succeeded("bash", "last"));

    const output = renderPlain(chat);
    expect(output.match(/⚙️/g)).toHaveLength(3);
    expect(output).toContain("⚙️ $");
    expect(output).toMatch(
      /• first\n\s*⚙️ read\n\s*• middle\.md\n\s*⚙️ \$\n\s*• last/,
    );
  });

  test("keeps an active call separate, then merges it after success", () => {
    const chat = new MockContainer();
    const first = succeeded("read", "one.md");
    const active = new MockToolExecutionComponent("read", "two.md");
    chat.addChild(first);
    chat.addChild(active);

    expect(renderPlain(chat).match(/⚙️/g)).toHaveLength(2);

    active.updateResult({ isError: false, output: "result:two.md" });
    const output = renderPlain(chat);
    expect(output.match(/⚙️/g)).toHaveLength(1);
    expect(output).toContain("• one.md");
    expect(output).toContain("• two.md");
  });

  test("keeps failed calls separate and expands their details", () => {
    const chat = new MockContainer();
    chat.addChild(succeeded("read", "one.md"));
    const failed = new MockToolExecutionComponent("read", "broken.md");
    failed.updateResult({ isError: true, output: "error detail" });
    chat.addChild(failed);

    const output = renderPlain(chat);
    expect(output.match(/⚙️/g)).toHaveLength(2);
    expect(output).toContain("FULL error detail");
    expect(failed.expanded).toBe(true);
  });

  test("uses visible content as a group boundary", () => {
    const visibleChat = new MockContainer();
    visibleChat.addChild(succeeded("read", "one.md"));
    visibleChat.addChild(new MockText("Thinking..."));
    visibleChat.addChild(succeeded("read", "two.md"));
    expect(renderPlain(visibleChat).match(/⚙️/g)).toHaveLength(2);

    const hiddenChat = new MockContainer();
    hiddenChat.addChild(succeeded("read", "one.md"));
    hiddenChat.addChild(new MockText("   "));
    hiddenChat.addChild(succeeded("read", "two.md"));
    const output = renderPlain(hiddenChat);
    expect(output.match(/⚙️/g)).toHaveLength(1);
    expect(output).toContain("• one.md");
    expect(output).toContain("• two.md");
  });

  test("restores mixed-tool full blocks when tools are expanded", () => {
    const chat = new MockContainer();
    const first = succeeded("read", "one.md");
    const second = succeeded("write", "two.md");
    chat.addChild(first);
    chat.addChild(second);

    expect(renderPlain(chat).match(/⚙️/g)).toHaveLength(2);
    first.setExpanded(true);
    second.setExpanded(true);

    const output = renderPlain(chat);
    expect(output.match(/⚙️/g)).toHaveLength(2);
    expect(output).toContain("result:one.md");
    expect(output).toContain("result:two.md");
  });
});

describe("tool-call-markers thinking grouping", () => {
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

  test("falls back to the original message when combineAdjacentThinking throws", () => {
    // Uninstall the existing patch so the next install wraps our counting renderer.
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
        // A content getter that breaks combineAdjacentThinking by throwing.
        get content() {
          throw new Error("combine failure");
        },
      };

      // Must not throw; the original renderer should run exactly once with the raw message.
      assistant.updateContent(malformed as never);
      expect(originalCalls).toBe(1);
      expect(assistant.lastMessage).toBe(malformed);
    } finally {
      for (const handler of shutdownHandlers.splice(0)) handler();
      MockAssistantMessageComponent.prototype.updateContent =
        originalUpdateContent;
    }
  });
});
