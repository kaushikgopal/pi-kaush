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
  rendererState?: { startedAt?: number; endedAt?: number };
  result?: {
    isError: boolean;
    output: string;
    content?: Array<{ type: string }>;
    details?: Record<string, unknown>;
  };
  contentBox = new MockBox();
  contentText = new MockText("");
  selfRenderContainer = new MockContainer();
  callRendererComponent?: MockText;
  imageComponents: unknown[] = [];
  imageSpacers: unknown[] = [];

  constructor(
    public toolName: string,
    label: string,
    private renderShell: "default" | "self" = "default",
  ) {
    super();
    this.toolCallId = `${toolName}-${label}`;
    this.args = { label };
    this.addChild(new MockText(""));
    this.addChild(
      this.renderShell === "self" ? this.selfRenderContainer : this.contentBox,
    );
    this.updateDisplay();
  }

  hasRendererDefinition() {
    return true;
  }

  getRenderShell() {
    return this.renderShell;
  }

  getTextOutput() {
    return this.result?.output ?? "";
  }

  updateDisplay() {
    const container =
      this.renderShell === "self" ? this.selfRenderContainer : this.contentBox;
    container.clear();
    const token = this.toolName === "bash" ? "$" : this.toolName;
    this.callRendererComponent = new MockText(`${token} ${this.args.label}`);
    container.addChild(this.callRendererComponent);
    if (this.result) {
      const detail =
        this.result.isError && this.expanded
          ? `FULL ${this.result.output}`
          : this.result.output;
      container.addChild(new MockText(detail));
    }
  }

  updateResult(
    result: {
      isError: boolean;
      output: string;
      content?: Array<{ type: string }>;
      details?: Record<string, unknown>;
    },
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

const COLLAPSE_PARALLEL_ENV = "PI_TOOL_CALL_MARKERS_COLLAPSE_PARALLEL";
const originalCollapseParallel = process.env[COLLAPSE_PARALLEL_ENV];

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
  renderShell: "default" | "self" = "default",
): MockToolExecutionComponent {
  const row = new MockToolExecutionComponent(toolName, label, renderShell);
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

function reinstallWithCollapseParallel(value: string): void {
  for (const handler of shutdownHandlers.splice(0)) handler();
  sessionHandlers.length = 0;
  process.env[COLLAPSE_PARALLEL_ENV] = value;
  install();
}

beforeEach(() => {
  sessionHandlers.length = 0;
  shutdownHandlers.length = 0;
  delete process.env[COLLAPSE_PARALLEL_ENV];
  install();
});

afterEach(() => {
  for (const handler of shutdownHandlers) handler();
  if (originalCollapseParallel === undefined)
    delete process.env[COLLAPSE_PARALLEL_ENV];
  else process.env[COLLAPSE_PARALLEL_ENV] = originalCollapseParallel;
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

  test("adds compact outcomes to successful singleton rows", () => {
    const chat = new MockContainer();
    chat.addChild(succeeded("bash", "npm test"));
    const boundary = new MockAssistantMessageComponent();
    boundary.addChild(new MockText("Next check."));
    chat.addChild(boundary);
    chat.addChild(succeeded("read", "notes.md"));

    const output = renderPlain(chat);
    expect(output).toContain("⚙️ $ npm test → done");
    expect(output).toContain("⚙️ read notes.md → 1 line");
    expect(output).not.toContain("result:");
  });

  test("does not invent outcomes for unknown tools", () => {
    const chat = new MockContainer();
    chat.addChild(succeeded("custom", "opaque"));

    expect(renderPlain(chat)).toContain("⚙️ custom opaque");
    expect(renderPlain(chat)).not.toContain("→");
  });

  test("uses structured search counts and handles empty results", () => {
    const chat = new MockContainer();
    const matches = new MockToolExecutionComponent("ffgrep", "needle");
    matches.updateResult({
      isError: false,
      output: "src/a.ts\n  1: first\n  2: second\n[page notice]",
      details: { totalMatched: 7 },
    });
    const empty = new MockToolExecutionComponent("fffind", "missing");
    empty.updateResult({
      isError: false,
      output: "No files found matching pattern",
    });
    chat.addChild(matches);
    const boundary = new MockAssistantMessageComponent();
    boundary.addChild(new MockText("Next search."));
    chat.addChild(boundary);
    chat.addChild(empty);

    const output = renderPlain(chat);
    expect(output).toContain("ffgrep needle → 7 results");
    expect(output).toContain("fffind missing → 0 results");
  });

  test("does not count read continuation notices as file lines", () => {
    const chat = new MockContainer();
    const read = new MockToolExecutionComponent("read", "notes.md");
    read.updateResult({
      isError: false,
      output: "only line\n\n[99 more lines in file. Use offset=2 to continue.]",
    });
    chat.addChild(read);

    expect(renderPlain(chat)).toContain("notes.md → 1 line");
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

  test("keeps grouped bullets to one line and preserves result tails", () => {
    const chat = new MockContainer();
    chat.addChild(succeeded("bash", "a-command-with-a-very-long-target"));
    chat.addChild(succeeded("bash", "another-command-with-a-long-target"));

    const lines = chat
      .render(24)
      .map(stripAnsi)
      .filter((line) => line.trim());
    const bullets = lines.filter((line) => line.includes("•"));
    expect(bullets).toHaveLength(2);
    expect(bullets.every((line) => line.endsWith("→ done"))).toBe(true);
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
      /• one\.md → 1 line\n\s*• two\.md → 1 line\n\s*⚙️ write\n\s*• one\.md → written\n\s*• two\.md → written/,
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
      /• first → done\n\s*⚙️ read\n\s*• middle\.md → 1 line\n\s*⚙️ \$\n\s*• last → done/,
    );
  });

  test("groups a live batch before settlement without changing height on success", () => {
    const chat = new MockContainer();
    const first = succeeded("read", "one.md");
    const active = new MockToolExecutionComponent("read", "two.md");
    chat.addChild(first);
    chat.addChild(active);

    const liveHeight = chat.render(100).length;
    const liveOutput = renderPlain(chat);
    expect(liveOutput.match(/⚙️/g)).toHaveLength(1);
    expect(liveOutput).toContain("• one.md → 1 line");
    expect(liveOutput).toContain("• two.md …");

    active.updateResult({ isError: false, output: "result:two.md" });
    const output = renderPlain(chat);
    expect(chat.render(100)).toHaveLength(liveHeight);
    expect(output.match(/⚙️/g)).toHaveLength(1);
    expect(output).toContain("• one.md → 1 line");
    expect(output).toContain("• two.md → 1 line");
  });

  test("keeps a parallel group at the same height while it settles", () => {
    const chat = new MockContainer();
    chat.addChild(succeeded("edit", "one.ts"));
    chat.addChild(succeeded("edit", "two.ts"));
    const active = new MockToolExecutionComponent("edit", "three.ts");
    chat.addChild(active);
    chat.addChild(succeeded("edit", "four.ts"));
    chat.addChild(succeeded("edit", "five.ts"));

    const liveHeight = chat.render(100).length;
    expect(renderPlain(chat).match(/⚙️/g)).toHaveLength(1);

    active.updateResult({ isError: false, output: "result:three.ts" });
    const output = renderPlain(chat);
    expect(chat.render(100)).toHaveLength(liveHeight);
    expect(output.match(/⚙️/g)).toHaveLength(1);
    expect(output).toContain("• one.ts → applied");
    expect(output).toContain("• three.ts → applied");
    expect(output).toContain("• five.ts → applied");
  });

  test("extends a group when a later quiet-turn call appears", () => {
    const chat = new MockContainer();
    chat.addChild(succeeded("edit", "one.ts"));
    chat.addChild(succeeded("edit", "two.ts"));
    chat.addChild(new MockAssistantMessageComponent());
    const active = new MockToolExecutionComponent("edit", "three.ts");
    chat.addChild(active);

    const pendingOutput = renderPlain(chat);
    const pendingHeight = chat.render(100).length;
    expect(pendingOutput.match(/⚙️/g)).toHaveLength(1);
    expect(pendingOutput).toContain("• one.ts");
    expect(pendingOutput).toContain("• two.ts");
    expect(pendingOutput).toContain("• three.ts …");

    active.updateResult({ isError: false, output: "result:three.ts" });
    const settledOutput = renderPlain(chat);
    expect(chat.render(100)).toHaveLength(pendingHeight);
    expect(settledOutput.match(/⚙️/g)).toHaveLength(1);
    expect(settledOutput).toContain("• one.ts");
    expect(settledOutput).toContain("• two.ts");
    expect(settledOutput).toContain("• three.ts → applied");
  });

  test("merges a later live call across an empty assistant message immediately", () => {
    const chat = new MockContainer();
    chat.addChild(succeeded("read", "one.md"));
    const singletonHeight = chat.render(100).length;
    expect(renderPlain(chat)).toContain("⚙️ read one.md → 1 line");

    chat.addChild(new MockAssistantMessageComponent());
    const next = new MockToolExecutionComponent("read", "two.md");
    chat.addChild(next);
    const liveHeight = chat.render(100).length;
    expect(liveHeight).toBeGreaterThanOrEqual(singletonHeight);
    expect(renderPlain(chat).match(/⚙️/g)).toHaveLength(1);

    next.updateResult({ isError: false, output: "result:two.md" });
    const output = renderPlain(chat);
    expect(chat.render(100)).toHaveLength(liveHeight);
    expect(output.match(/⚙️/g)).toHaveLength(1);
    expect(output).toContain("• one.md");
    expect(output).toContain("• two.md");
  });

  test("can keep same-turn parallel calls individual via environment", () => {
    reinstallWithCollapseParallel("0");

    const parallel = new MockContainer();
    parallel.addChild(succeeded("read", "one.md"));
    parallel.addChild(succeeded("read", "two.md"));
    expect(renderPlain(parallel).match(/⚙️/g)).toHaveLength(2);
    expect(renderPlain(parallel)).not.toContain("•");

    const sequential = new MockContainer();
    sequential.addChild(succeeded("read", "one.md"));
    sequential.addChild(new MockAssistantMessageComponent());
    sequential.addChild(succeeded("read", "two.md"));
    expect(renderPlain(sequential).match(/⚙️/g)).toHaveLength(1);
    expect(renderPlain(sequential)).toContain("• one.md");
    expect(renderPlain(sequential)).toContain("• two.md");
  });

  test("merges settled batches across empty assistant messages", () => {
    const chat = new MockContainer();
    chat.addChild(succeeded("read", "one.md"));
    chat.addChild(succeeded("read", "two.md"));
    chat.addChild(new MockAssistantMessageComponent());
    chat.addChild(succeeded("read", "three.md"));
    chat.addChild(succeeded("read", "four.md"));

    const output = renderPlain(chat);
    expect(output.match(/⚙️/g)).toHaveLength(1);
    expect(output).toContain("• one.md");
    expect(output).toContain("• four.md");
  });

  test("keeps visible assistant prose as a grouping boundary", () => {
    const chat = new MockContainer();
    chat.addChild(succeeded("read", "one.md"));
    const assistant = new MockAssistantMessageComponent();
    assistant.addChild(new MockText("I need one more file."));
    chat.addChild(assistant);
    chat.addChild(succeeded("read", "two.md"));

    const output = renderPlain(chat);
    expect(output.match(/⚙️/g)).toHaveLength(2);
    expect(output).toContain("I need one more file.");
  });

  test("waits for pending siblings beyond failed calls", () => {
    const chat = new MockContainer();
    chat.addChild(succeeded("read", "one.md"));
    chat.addChild(succeeded("read", "two.md"));
    const failed = new MockToolExecutionComponent("read", "broken.md");
    failed.updateResult({ isError: true, output: "error detail" });
    chat.addChild(failed);
    chat.addChild(new MockToolExecutionComponent("read", "pending.md"));

    expect(renderPlain(chat).match(/⚙️/g)).toHaveLength(3);
  });

  test("caps in-progress rows to their header line", () => {
    const chat = new MockContainer();
    const partial = new MockToolExecutionComponent("custom", "streaming");
    partial.updateResult({ isError: false, output: "partial progress" }, true);
    chat.addChild(partial);

    const output = renderPlain(chat);
    expect(output).toContain("⚙️ custom streaming …");
    expect(output).not.toContain("partial progress");
  });

  test("shows inline elapsed while running and duration after success", () => {
    const chat = new MockContainer();
    const row = new MockToolExecutionComponent("bash", "npm test");
    row.rendererState = { startedAt: Date.now() - 2000 };
    chat.addChild(row);

    const running = renderPlain(chat);
    expect(running).toContain("⚙️ $ npm test · 2.0s");
    expect(running.match(/⚙️/g)).toHaveLength(1);

    row.rendererState.endedAt = (row.rendererState.startedAt ?? 0) + 2400;
    row.updateResult({ isError: false, output: "ok" });
    const output = renderPlain(chat);
    expect(output).toContain("⚙️ $ npm test → done · 2.4s");
  });

  test("keeps in-progress rows and settled rows at the same height", () => {
    const make = () => {
      const chat = new MockContainer();
      const row = new MockToolExecutionComponent("bash", "npm test");
      chat.addChild(row);
      return { chat, row };
    };

    const running = make();
    const runningHeight = running.chat.render(100).length;

    const settled = make();
    settled.row.updateResult({ isError: false, output: "ok" });
    const settledHeight = settled.chat.render(100).length;
    expect(runningHeight).toBe(settledHeight);
  });

  test("builds self-rendered group summaries from call args, not previews", () => {
    const chat = new MockContainer();
    for (const path of ["one.ts", "two.ts"]) {
      const row = succeeded("edit", path, "self");
      row.callRendererComponent = new MockText(
        `edit ${path}\n@@ diff header\n+large changed line`,
      );
      row.selfRenderContainer.children[0] = row.callRendererComponent;
      row.result!.details = { diff: "+new\n-old" };
      chat.addChild(row);
    }

    const output = renderPlain(chat);
    // Self-rendered tools never adopt the built-in edit diff heuristic.
    expect(output).toContain('• edit {"label":"one.ts"} → done');
    expect(output).toContain('• edit {"label":"two.ts"} → done');
    expect(output).not.toContain("diff header");
    expect(output).not.toContain("large changed line");
  });

  test("preserves singleton self-rendered output", () => {
    const chat = new MockContainer();
    const row = succeeded("edit", "one.ts", "self");
    row.callRendererComponent = new MockText("edit one.ts\n@@ diff header");
    row.selfRenderContainer.children[0] = row.callRendererComponent;
    chat.addChild(row);

    expect(renderPlain(chat)).toContain("diff header");
  });

  test("forces a generic outcome for a self-rendered built-in-named tool", () => {
    const chat = new MockContainer();
    const row = succeeded("edit", "one.ts", "self");
    // Even an edit result carrying diff details stays generic for self shells.
    row.result!.details = { diff: "+new\n-old" };
    chat.addChild(row);

    const output = renderPlain(chat);
    expect(output).toContain('edit {"label":"one.ts"} → done');
    expect(output).not.toContain("+1/-1");
  });

  test("does not collapse image-bearing results", () => {
    const chat = new MockContainer();
    chat.addChild(succeeded("read", "one.md"));
    const image = new MockToolExecutionComponent("read", "image.png");
    image.updateResult({
      isError: false,
      output: "rendered image",
      content: [{ type: "image" }],
    });
    chat.addChild(image);
    chat.addChild(succeeded("read", "two.md"));

    const output = renderPlain(chat);
    expect(output.match(/⚙️/g)).toHaveLength(3);
    expect(output).toContain("rendered image");
  });

  test("keeps failed calls separate and collapsed until expanded", () => {
    const chat = new MockContainer();
    chat.addChild(succeeded("read", "one.md"));
    const failed = new MockToolExecutionComponent("read", "broken.md");
    failed.updateResult({ isError: true, output: "error detail" });
    chat.addChild(failed);

    const output = renderPlain(chat);
    expect(output.match(/⚙️/g)).toHaveLength(2);
    expect(output).toContain("error detail");
    expect(output).not.toContain("FULL error detail");
    expect(failed.expanded).toBe(false);

    failed.setExpanded(true);
    expect(renderPlain(chat)).toContain("FULL error detail");
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
