import type {
  ExtensionAPI,
  KeybindingsManager,
  Theme,
  ThemeColor,
} from "@earendil-works/pi-coding-agent";
import {
  AssistantMessageComponent,
  initTheme,
  ToolExecutionComponent,
  UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import type { EditorComponent, EditorTheme, TUI } from "@earendil-works/pi-tui";
import { Container, Loader, Text, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  chatContainerHooks,
  runChatContainerHooks,
} from "../src/container-hooks.ts";
import contentLayout from "../src/index.ts";
import { ACTIVE_SIDE_PADDING, OUTER_INSET } from "../src/render.ts";

const CSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const CONTROL_RE =
  /\x1b(?:\][^\x07]*(?:\x07|\x1b\\)|_[^\x07]*(?:\x07|\x1b\\))/g;
const stripControls = (text: string) =>
  text.replace(CONTROL_RE, "").replace(CSI_RE, "");

const SURFACE_BG = "\x1b[48;5;22m";

function bgAnsiFor(color: string): string {
  if (color === "userMessageBg") return SURFACE_BG;
  return color === "userMessageBg" ? "\x1b[44m" : "\x1b[40m";
}

const FG_CODES: Record<string, number> = {
  accent: 35,
  borderAccent: 35,
  bashMode: 32,
  error: 31,
  warning: 33,
  dim: 90,
  muted: 90,
  userMessageText: 37,
};

const theme = {
  fg(color: ThemeColor, text: string) {
    return `${this.getFgAnsi(color)}${text}\x1b[39m`;
  },
  getFgAnsi(color: ThemeColor) {
    return `\x1b[${FG_CODES[color] ?? 90}m`;
  },
  bg(color: string, text: string) {
    return `${bgAnsiFor(color)}${text}\x1b[49m`;
  },
  getBgAnsi: bgAnsiFor,
} as Theme;

type EditorFactory = (
  tui: TUI,
  editorTheme: EditorTheme,
  keybindings: KeybindingsManager,
) => EditorComponent;

type Handler = (event: unknown, ctx: TestContext) => void;

type TestContext = {
  mode: "tui";
  ui: {
    theme: Theme;
    getEditorComponent(): EditorFactory | undefined;
    setEditorComponent(factory: EditorFactory | undefined): void;
  };
};

class TestEditor implements EditorComponent {
  borderColor = (text: string) => text;
  paddingX = 0;
  text = "";
  handled: string[] = [];
  invalidations = 0;

  render(width: number): string[] {
    const border = this.borderColor("─").repeat(width);
    const content = " ".repeat(this.paddingX) + this.text;
    const line = content + " ".repeat(Math.max(0, width - content.length));
    return [border, line, border];
  }
  invalidate(): void {
    this.invalidations++;
  }
  getText(): string {
    return this.text;
  }
  setText(text: string): void {
    this.text = text;
  }
  handleInput(data: string): void {
    this.handled.push(data);
  }
}

function createHarness(previous?: EditorFactory) {
  const handlers = new Map<string, Handler>();
  let currentFactory = previous;
  const context: TestContext = {
    mode: "tui",
    ui: {
      theme,
      getEditorComponent: () => currentFactory,
      setEditorComponent(factory) {
        currentFactory = factory;
      },
    },
  };

  contentLayout({
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
    },
    registerMessageRenderer() {},
  } as unknown as ExtensionAPI);

  return {
    context,
    fire(event: string) {
      handlers.get(event)?.({}, context);
    },
    get factory() {
      return currentFactory;
    },
    set factory(factory: EditorFactory | undefined) {
      currentFactory = factory;
    },
  };
}

const activeHarnesses: ReturnType<typeof createHarness>[] = [];

beforeEach(() => {
  initTheme("dark");
});

afterEach(() => {
  for (const harness of activeHarnesses.splice(0)) {
    harness.fire("session_shutdown");
  }
});

describe("editor factory composition", () => {
  test("wraps the previous editor render while forwarding its behavior", () => {
    const target = new TestEditor();
    target.text = "hello";
    const previous: EditorFactory = () => target;
    const harness = createHarness(previous);
    activeHarnesses.push(harness);

    harness.fire("session_start");
    expect(harness.factory).not.toBe(previous);
    const editor = harness.factory?.(
      {} as TUI,
      {} as EditorTheme,
      {} as KeybindingsManager,
    );
    expect(editor).toBeDefined();

    editor?.handleInput("x");
    editor?.setText("changed");
    editor?.invalidate();
    expect(target.handled).toEqual(["x"]);
    expect(target.getText()).toBe("changed");
    expect(target.invalidations).toBe(1);

    const lines = editor?.render(30) ?? [];
    expect(lines).toHaveLength(3);
    expect(stripControls(lines[0] ?? "")).toMatch(/^\s+$/);
    expect(stripControls(lines[1] ?? "")).toMatch(/^ changed/);
    expect(stripControls(lines[2] ?? "")).toMatch(/^\s+$/);
    expect(lines.every((line) => visibleWidth(line) === 30)).toBe(true);
    expect(lines.every((line) => line.includes(SURFACE_BG))).toBe(true);
    expect(lines[1]).toContain(`${theme.getFgAnsi("userMessageText")}changed`);
    expect(stripControls(lines.join("\n"))).not.toContain("▎");

    harness.fire("session_shutdown");
    activeHarnesses.pop();
    expect(harness.factory).toBe(previous);
  });

  test("creates Pi's CustomEditor when no previous factory exists", () => {
    const harness = createHarness();
    activeHarnesses.push(harness);
    harness.fire("session_start");

    const editor = harness.factory?.(
      { terminal: { rows: 24 }, requestRender() {} } as unknown as TUI,
      {
        borderColor: (text: string) => text,
        selectList: {},
      } as EditorTheme,
      {} as KeybindingsManager,
    );
    expect(editor).toBeDefined();
    expect("actionHandlers" in (editor ?? {})).toBe(true);
    expect(editor?.render(30).every((line) => visibleWidth(line) === 30)).toBe(
      true,
    );
  });

  test("preserves real editor input, cursor, multiline, paste, and submission", () => {
    const harness = createHarness();
    activeHarnesses.push(harness);
    harness.fire("session_start");

    const keybindings = {
      matches(data: string, action: string) {
        return (
          (data === "\x1b[D" && action === "tui.editor.cursorLeft") ||
          (data === "\x1b[C" && action === "tui.editor.cursorRight") ||
          (data === "\r" && action === "tui.input.submit")
        );
      },
      getKeys: () => [] as string[],
    } as unknown as KeybindingsManager;
    const editor = harness.factory?.(
      { terminal: { rows: 24 }, requestRender() {} } as unknown as TUI,
      {
        borderColor: (text: string) => text,
        selectList: {},
      } as EditorTheme,
      keybindings,
    );
    expect(editor).toBeDefined();

    editor?.handleInput("hello world");
    expect(editor?.getText()).toBe("hello world");

    for (let i = 0; i < 5; i++) editor?.handleInput("\x1b[D");
    editor?.handleInput("X");
    expect(editor?.getText()).toBe("hello Xworld");

    editor?.handleInput("\n");
    expect(editor?.getText()).toBe("hello X\nworld");

    editor?.handleInput("\x1b[200~PASTED\x1b[201~");
    expect(editor?.getText()).toContain("PASTED");

    let submitted: string | undefined;
    if (editor) {
      (editor as { onSubmit?: (text: string) => void }).onSubmit = (text) => {
        submitted = text;
      };
    }
    editor?.handleInput("\r");
    // Pi's editor clears its state on submit; the handler receives the text.
    expect(submitted).toBe("hello X\nPASTEDworld");

    const lines = editor?.render(30) ?? [];
    expect(lines.every((line) => visibleWidth(line) === 30)).toBe(true);
  });

  test("observes editor prototype decorators installed after its factory", () => {
    const target = new TestEditor();
    target.text = "before";
    const harness = createHarness(() => target);
    activeHarnesses.push(harness);
    harness.fire("session_start");
    const editor = harness.factory?.(
      {} as TUI,
      {} as EditorTheme,
      {} as KeybindingsManager,
    );
    const original = TestEditor.prototype.render;
    TestEditor.prototype.render = function decoratedRender(width: number) {
      return original
        .call(this, width)
        .map((line) => line.replace("before", "after"));
    };
    try {
      expect(stripControls(editor?.render(30).join("\n") ?? "")).toContain(
        "after",
      );
    } finally {
      TestEditor.prototype.render = original;
    }
  });

  test("does not overwrite a later editor owner during shutdown", () => {
    const previous: EditorFactory = () => new TestEditor();
    const later: EditorFactory = () => new TestEditor();
    const harness = createHarness(previous);
    activeHarnesses.push(harness);

    harness.fire("session_start");
    harness.factory = later;
    harness.fire("session_shutdown");
    activeHarnesses.pop();
    expect(harness.factory).toBe(later);
  });
});

describe("native transcript adapters", () => {
  test("insets assistant rows and gives submitted user rows a darker rail block", () => {
    const harness = createHarness(() => new TestEditor());
    activeHarnesses.push(harness);
    harness.fire("session_start");

    const assistant = new AssistantMessageComponent({
      role: "assistant",
      content: [{ type: "text", text: "hello from assistant" }],
      stopReason: "stop",
    } as never);
    const assistantLines = assistant.render(40);
    const firstAssistantContent = assistantLines.find((line) =>
      stripControls(line).includes("hello from assistant"),
    );
    expect(firstAssistantContent).toBeDefined();
    expect(
      stripControls(firstAssistantContent ?? "").startsWith("  hello"),
    ).toBe(true);
    expect(assistantLines.every((line) => visibleWidth(line) === 40)).toBe(
      true,
    );

    const HostContainer = Object.getPrototypeOf(
      AssistantMessageComponent.prototype,
    ).constructor as typeof Container;
    const chat = new HostContainer();
    chat.addChild(assistant);
    chat.addChild(new Text(theme.fg("muted", "Reloaded keybindings"), 1, 0));
    const statusLine = chat
      .render(40)
      .find((line) => stripControls(line).includes("Reloaded keybindings"));
    expect(stripControls(statusLine ?? "")).toMatch(/^  Reloaded keybindings/);

    const user = new UserMessageComponent("hello from user");
    const userLines = user.render(40);
    expect(userLines).toHaveLength(3);
    expect(userLines.every((line) => visibleWidth(line) === 40)).toBe(true);
    expect(stripControls(userLines[1] ?? "")).toContain("  ▎  hello from user");
    expect(userLines.every((line) => line.includes(SURFACE_BG))).toBe(true);
    expect(userLines[1]).toContain(`\x1b[35m▎\x1b[39m${SURFACE_BG}`);
  });

  test("status, assistant, rail, and editor text share the outer inset column", () => {
    const target = new TestEditor();
    target.paddingX = 1; // mirrors Pi's editorPaddingX: 1 setting
    const harness = createHarness(() => target);
    activeHarnesses.push(harness);
    harness.fire("session_start");

    const width = 40;
    const columnOf = (line: string | undefined, needle: string) =>
      stripControls(line ?? "").indexOf(needle);

    const assistant = new AssistantMessageComponent({
      role: "assistant",
      content: [{ type: "text", text: "column probe" }],
      stopReason: "stop",
    } as never);
    const assistantLine = assistant
      .render(width)
      .find((line) => stripControls(line).includes("column probe"));
    expect(columnOf(assistantLine, "column probe")).toBe(OUTER_INSET);

    const HostContainer = Object.getPrototypeOf(
      AssistantMessageComponent.prototype,
    ).constructor as typeof Container;
    const chat = new HostContainer();
    chat.addChild(assistant);
    chat.addChild(new Text(theme.fg("muted", "Reloaded keybindings"), 1, 0));
    const statusLine = chat
      .render(width)
      .find((line) => stripControls(line).includes("Reloaded keybindings"));
    expect(columnOf(statusLine, "Reloaded keybindings")).toBe(OUTER_INSET);

    const user = new UserMessageComponent("submitted probe");
    const railLine = user
      .render(width)
      .find((line) => stripControls(line).includes("submitted probe"));
    expect(columnOf(railLine, "▎")).toBe(OUTER_INSET);
    expect(columnOf(railLine, "submitted probe")).toBe(OUTER_INSET + 3);

    const editor = harness.factory?.(
      {} as TUI,
      {} as EditorTheme,
      {} as KeybindingsManager,
    );
    editor?.setText("editor probe");
    const editorLine = editor
      ?.render(width)
      .find((line) => stripControls(line).includes("editor probe"));
    expect(ACTIVE_SIDE_PADDING + target.paddingX).toBe(OUTER_INSET);
    expect(columnOf(editorLine, "editor probe")).toBe(OUTER_INSET);
  });

  test("aligns status indicators with the chat content inset", () => {
    vi.useFakeTimers();
    const harness = createHarness(() => new TestEditor());
    activeHarnesses.push(harness);
    harness.fire("session_start");

    const width = 40;
    const columnOf = (line: string | undefined, needle: string) =>
      stripControls(line ?? "").indexOf(needle);

    const ui = { requestRender() {} } as unknown as TUI;

    // StatusIndicator subclasses Loader and tags the instance with a kind.
    const working = new Loader(
      ui,
      (spinner) => spinner,
      (text) => text,
      "Working...",
    );
    (working as unknown as { kind?: string }).kind = "working";
    const workingLine = working
      .render(width)
      .find((line) => stripControls(line).includes("Working..."));
    // The spinner frame (2 columns) follows the inset, like chat content.
    expect(columnOf(workingLine, "⠋")).toBe(OUTER_INSET);
    expect(columnOf(workingLine, "Working...")).toBe(OUTER_INSET + 2);
    working.stop();

    // Bare loaders (e.g. inside tool execution boxes) keep native layout.
    const bare = new Loader(
      ui,
      (spinner) => spinner,
      (text) => text,
      "Running...",
    );
    const bareLine = bare
      .render(width)
      .find((line) => stripControls(line).includes("Running..."));
    expect(columnOf(bareLine, "⠋")).toBe(1);
    bare.stop();
    vi.useRealTimers();
  });

  test("keeps system rows inset when an outer grouping wrapper composes through hooks", () => {
    const harness = createHarness(() => new TestEditor());
    activeHarnesses.push(harness);
    harness.fire("session_start");

    const HostContainer = Object.getPrototypeOf(
      AssistantMessageComponent.prototype,
    ).constructor as typeof Container;
    type Row = { children?: Array<{ render(width: number): string[] }> };
    const proto = HostContainer.prototype as unknown as Row & {
      render(width: number): string[];
    };
    const inner = proto.render;
    // Mirrors pi-tool-call-markers' grouping wrapper: it renders children
    // directly and composes with other container concerns only via hooks.
    proto.render = function renderLikeGrouping(this: Row, width: number) {
      const restore = runChatContainerHooks(this, this.children, width);
      try {
        const lines: string[] = [];
        for (const child of this.children ?? [])
          lines.push(...child.render(width));
        return lines;
      } finally {
        restore();
      }
    };
    try {
      const chat = new HostContainer();
      chat.addChild(
        new AssistantMessageComponent({
          role: "assistant",
          content: [{ type: "text", text: "grouping neighbor" }],
          stopReason: "stop",
        } as never),
      );
      chat.addChild(new Text(theme.fg("muted", "Reloaded keybindings"), 1, 0));
      const statusLine = chat
        .render(40)
        .find((line) => stripControls(line).includes("Reloaded keybindings"));
      expect(stripControls(statusLine ?? "")).toMatch(
        /^  Reloaded keybindings/,
      );
    } finally {
      proto.render = inner;
    }
  });

  test("unregisters its chat container hook on shutdown", () => {
    const harness = createHarness(() => new TestEditor());
    activeHarnesses.push(harness);
    expect(chatContainerHooks().size).toBe(0);
    harness.fire("session_start");
    expect(chatContainerHooks().size).toBe(1);
    harness.fire("session_shutdown");
    activeHarnesses.pop();
    expect(chatContainerHooks().size).toBe(0);
  });

  test("leaves tool execution rows byte-identical to Pi's own rendering", () => {
    const harness = createHarness(() => new TestEditor());
    activeHarnesses.push(harness);

    // Tool rows are pi-tool-call-markers' domain; installing the surface
    // layout must not reshape, inset, or paint them in any way.
    const definition = {
      name: "bash",
      label: "bash",
      description: "boundary test row",
      parameters: { type: "object", properties: {} },
      execute() {
        throw new Error("not executed");
      },
      renderCall() {
        return new Text("$ npm test", 0, 0);
      },
      renderResult(result: {
        content: Array<{ type: string; text?: string }>;
      }) {
        const detail = result.content.find((c) => c.type === "text")?.text;
        return new Text(String(detail), 0, 0);
      },
    };
    const row = new ToolExecutionComponent(
      "bash",
      "boundary-1",
      { command: "npm test" },
      {},
      definition as never,
      { requestRender() {} } as never,
      process.cwd(),
    );
    const native = row.render(50);

    harness.fire("session_start");
    const installed = row.render(50);
    expect(installed).toEqual(native);
    expect(installed.join("\n")).not.toContain(SURFACE_BG);
  });

  test("restores native message renderers on shutdown", () => {
    const assistantRender = AssistantMessageComponent.prototype.render;
    const userRender = UserMessageComponent.prototype.render;
    const containerPrototype = Object.getPrototypeOf(
      AssistantMessageComponent.prototype,
    ) as { render: unknown };
    const containerRender = containerPrototype.render;
    const loaderRender = Loader.prototype.render;
    const harness = createHarness(() => new TestEditor());

    harness.fire("session_start");
    expect(AssistantMessageComponent.prototype.render).not.toBe(
      assistantRender,
    );
    expect(UserMessageComponent.prototype.render).not.toBe(userRender);
    expect(containerPrototype.render).not.toBe(containerRender);
    expect(Loader.prototype.render).not.toBe(loaderRender);

    harness.fire("session_shutdown");
    expect(AssistantMessageComponent.prototype.render).toBe(assistantRender);
    expect(UserMessageComponent.prototype.render).toBe(userRender);
    expect(containerPrototype.render).toBe(containerRender);
    expect(Loader.prototype.render).toBe(loaderRender);
  });
});
