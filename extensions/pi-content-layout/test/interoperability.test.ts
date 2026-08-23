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
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  type EditorComponent,
  type EditorTheme,
  Text,
  type TUI,
} from "@earendil-works/pi-tui";
import { afterEach, describe, expect, test } from "vitest";
import registerFooter from "../../pi-footer-minimal/src/index.ts";
import {
  type InlineIdentifierFeature,
  registerInlineIdentifierFeature,
} from "../../pi-inline-identifier/src/core.ts";
import registerToolMarkers from "../../pi-tool-call-markers/src/index.ts";
import registerThinkingMarkers from "../../pi-tool-call-markers/src/thinking-block-merger.ts";
import contentLayout from "../src/index.ts";

const CSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const CONTROL_RE =
  /\x1b(?:\][^\x07]*(?:\x07|\x1b\\)|_[^\x07]*(?:\x07|\x1b\\))/g;
const stripControls = (text: string) =>
  text.replace(CONTROL_RE, "").replace(CSI_RE, "");

type EditorFactory = (
  tui: TUI,
  editorTheme: EditorTheme,
  keybindings: KeybindingsManager,
) => EditorComponent;

type Handler = (event: unknown, ctx: Record<string, any>) => void;

type Footer = {
  render(width: number): string[];
  dispose(): void;
};

const SURFACE_BG = "\x1b[48;5;22m";

function bgAnsiFor(color: string): string {
  if (color === "userMessageBg") return SURFACE_BG;
  return color === "userMessageBg" ? "\x1b[44m" : "\x1b[40m";
}

const theme = {
  bold: (text: string) => text,
  italic: (text: string) => text,
  fg(color: ThemeColor, text: string) {
    return `${this.getFgAnsi(color)}${text}\x1b[39m`;
  },
  getFgAnsi(color: ThemeColor) {
    const code =
      color === "accent" || color === "borderAccent"
        ? 35
        : color === "error"
          ? 31
          : color === "userMessageText"
            ? 37
            : 90;
    return `\x1b[${code}m`;
  },
  bg(color: string, text: string) {
    return `${bgAnsiFor(color)}${text}\x1b[49m`;
  },
  getBgAnsi: bgAnsiFor,
} as Theme;

function setup(order: "inline-first" | "layout-first") {
  const handlers = new Map<string, Handler[]>();
  const eventBus = new Map<string, Array<(payload: unknown) => void>>();
  let editorFactory: EditorFactory | undefined;
  let footerFactory:
    | ((tui: TUI, theme: Theme, footerData: Record<string, any>) => Footer)
    | undefined;

  const pi = {
    on(event: string, handler: Handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerCommand() {},
    registerMessageRenderer() {},
    getThinkingLevel: () => "off",
    events: {
      emit(channel: string, payload: unknown) {
        for (const listener of eventBus.get(channel) ?? []) listener(payload);
      },
      on(channel: string, listener: (payload: unknown) => void) {
        const list = eventBus.get(channel) ?? [];
        list.push(listener);
        eventBus.set(channel, list);
        return () => {
          const current = eventBus.get(channel) ?? [];
          eventBus.set(
            channel,
            current.filter((candidate) => candidate !== listener),
          );
        };
      },
    },
  } as unknown as ExtensionAPI;

  const inlineFeature: InlineIdentifierFeature = {
    kind: "skill",
    triggerCharacter: "@",
    listDefinitions: () => [
      { kind: "skill", name: "x", token: "@x", description: "test" },
    ],
    matchAutocomplete: () => undefined,
    findReferences: () => [],
    colorizeLine: (line) => line.replace("@x", "\x1b[35m@x\x1b[39m"),
    transform: () => ({ action: "continue" }),
  };

  if (order === "inline-first") {
    registerInlineIdentifierFeature(pi, inlineFeature);
    contentLayout(pi);
  } else {
    contentLayout(pi);
    registerInlineIdentifierFeature(pi, inlineFeature);
  }
  registerFooter(pi);
  registerToolMarkers(pi);
  registerThinkingMarkers(pi);

  const context = {
    mode: "tui",
    model: {
      id: "model",
      name: "model",
      provider: "provider",
      reasoning: false,
      contextWindow: 262_000,
    },
    sessionManager: {
      getCwd: () => "/workspace/project",
      getSessionName: () => undefined,
      getEntries: () => [],
    },
    getContextUsage: () => ({ percent: 10, contextWindow: 262_000 }),
    ui: {
      theme,
      getEditorText: () => "@x",
      addAutocompleteProvider() {},
      getEditorComponent: () => editorFactory,
      setEditorComponent(factory: EditorFactory | undefined) {
        editorFactory = factory;
      },
      setFooter(factory: typeof footerFactory) {
        footerFactory = factory;
      },
      setToolsExpanded() {},
      setWorkingVisible() {},
      notify() {},
    },
  };

  const fire = (event: string) => {
    for (const handler of handlers.get(event) ?? []) handler({}, context);
  };
  fire("session_start");

  return {
    context,
    fire,
    get editorFactory() {
      return editorFactory;
    },
    get footerFactory() {
      return footerFactory;
    },
  };
}

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function createSettledReadRow(): ToolExecutionComponent {
  const definition = {
    name: "read",
    label: "read",
    description: "test read",
    parameters: { type: "object", properties: {} },
    execute() {
      throw new Error("not executed");
    },
    renderCall() {
      return new Text("read src/file.ts", 0, 0);
    },
    renderResult() {
      return new Text("one\ntwo", 0, 0);
    },
  };
  const row = new ToolExecutionComponent(
    "read",
    "read-1",
    { path: "src/file.ts" },
    {},
    definition as never,
    { requestRender() {} } as never,
    process.cwd(),
  );
  row.updateResult(
    {
      content: [{ type: "text", text: "one\ntwo" }],
      details: {},
      isError: false,
    },
    false,
  );
  return row;
}

describe.each(["inline-first", "layout-first"] as const)(
  "combined visual extensions (%s)",
  (order) => {
    test("compose without duplicate inset or lost editor decoration", () => {
      initTheme("dark");
      const harness = setup(order);
      cleanups.push(() => harness.fire("session_shutdown"));

      const editor = harness.editorFactory?.(
        { terminal: { rows: 24 }, requestRender() {} } as unknown as TUI,
        { borderColor: (text: string) => text, selectList: {} } as EditorTheme,
        {} as KeybindingsManager,
      );
      expect(editor).toBeDefined();
      editor?.setPaddingX?.(1);
      editor?.setText("@x");
      const editorLine = editor
        ?.render(50)
        .find((line) => stripControls(line).includes("@x"));
      expect(stripControls(editorLine ?? "")).toMatch(/^  @x/);
      expect(stripControls(editorLine ?? "")).not.toContain("▎");
      expect(editorLine).toContain("\x1b[35m@x\x1b[39m");
      expect(editorLine).toContain(
        `\x1b[35m@x\x1b[39m${theme.getFgAnsi("userMessageText")}`,
      );
      expect(editorLine).toContain(SURFACE_BG);

      const thinkingMessage = {
        role: "assistant",
        content: [{ type: "thinking", thinking: "work" }],
        stopReason: "stop",
      };
      const assistant = new AssistantMessageComponent(
        thinkingMessage as never,
        true,
      );
      (
        assistant.updateContent as unknown as (
          message: unknown,
          isStreaming: boolean,
        ) => void
      )(thinkingMessage, true);
      const thinkingLine = assistant
        .render(50)
        .find((line) => stripControls(line).includes("Thinking"));
      expect(stripControls(thinkingLine ?? "")).toContain("  ⠋ Thinking…");

      const chat = new Container();
      chat.addChild(createSettledReadRow());
      const toolLine = chat
        .render(50)
        .map(stripControls)
        .find((line) => line.includes("%"));
      expect(toolLine).toMatch(/^  %/);
      expect(toolLine).not.toMatch(/^    %/);

      const footer = harness.footerFactory?.(
        { requestRender() {} } as unknown as TUI,
        theme,
        {
          getExtensionStatuses: () => new Map(),
          getGitBranch: () => "main",
          getAvailableProviderCount: () => 1,
          onBranchChange: () => () => {},
        },
      );
      const footerLines = footer?.render(50) ?? [];
      expect(footerLines).toHaveLength(2);
      expect(footerLines[0]).toBe("");
      const footerLine = footerLines[1];
      expect(footerLine?.startsWith("  ")).toBe(true);
      expect(footerLine?.endsWith("  ")).toBe(true);
      footer?.dispose();
    });
  },
);
