import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  AssistantMessageComponent,
  BashExecutionComponent,
  createBashToolDefinition,
  initTheme,
  ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import {
  Box,
  Container,
  Text,
  type TUI,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { PROMPT_RAIL, PROMPT_SURFACE_BG } from "../src/bash-block.ts";

// Captured at module load, before any beforeEach install patches it.
const NATIVE_BASH_RENDER = BashExecutionComponent.prototype.render;
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  type ChatContainerHook,
  chatContainerHooks,
} from "../src/container-hooks.ts";
import contentLayout from "../../pi-content-layout/src/index.ts";
import toolCallMarkers from "../src/index.ts";
import registerThinkingMarkers from "../src/thinking-block-merger.ts";

const ANSI_RE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
const sessionHandlers: Array<(event: unknown, ctx: unknown) => void> = [];
const shutdownHandlers: Array<() => void> = [];

initTheme("dark");

const extensionTheme = {
  bold: (text: string) => text,
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  // The Thought-label color now comes from the mdHeading token; cobalt2's
  // value (#ffb86c) keeps the existing assertions stable.
  getFgAnsi: (color: string) =>
    color === "mdHeading" ? "\x1b[38;2;255;184;108m" : "\x1b[39m",
};

function install(): void {
  const api = {
    on(event: string, handler: (event: unknown, ctx: unknown) => void) {
      if (event === "session_start") sessionHandlers.push(handler);
      if (event === "session_shutdown")
        shutdownHandlers.push(handler as () => void);
    },
  } as ExtensionAPI;
  toolCallMarkers(api);
  registerThinkingMarkers(api);
  for (const handler of sessionHandlers) {
    handler(
      {},
      { mode: "tui", ui: { theme: extensionTheme, setToolsExpanded() {} } },
    );
  }
}

function createNativeBashRow(
  command: string,
  timeout?: number,
): ToolExecutionComponent {
  return new ToolExecutionComponent(
    "bash",
    `native-bash-${command}`,
    { command, timeout },
    {},
    createBashToolDefinition(process.cwd()),
    { requestRender() {} } as never,
    process.cwd(),
  );
}

function createBashRow(label: string): ToolExecutionComponent {
  const definition = {
    name: "bash",
    label: "bash",
    description: "test bash renderer",
    parameters: { type: "object", properties: {} },
    execute() {
      throw new Error("not executed");
    },
    renderCall() {
      return new Text(`$ ${label}`, 0, 0);
    },
    renderResult(
      result: { content: Array<{ type: string; text?: string }> },
      options: { expanded: boolean },
    ) {
      const detail = result.content.find(
        (content) => content.type === "text",
      )?.text;
      return new Text(
        options.expanded ? `FULL ${detail}` : String(detail),
        0,
        0,
      );
    },
  };
  return new ToolExecutionComponent(
    "bash",
    `bash-${label}`,
    { command: label },
    {},
    definition as never,
    { requestRender() {} } as never,
    process.cwd(),
  );
}

class EmptyComponent {
  render(): string[] {
    return [];
  }
  invalidate(): void {}
}

type FakeRenderContext = {
  isPartial?: boolean;
  expanded?: boolean;
  isError?: boolean;
  state?: Record<string, unknown>;
};

// Imitates the adapter's self-shell lifecycle only: renderShell "self", the
// call component stashes a title in renderer state and disappears once
// settled, and the result renders its own one-line preview. It does not model
// adapter dispatch, so proxy-label tests assert on call shapes, not on which
// operation the adapter would have picked.
function createMcpRow(
  toolCallId: string,
  args: Record<string, unknown>,
  toolName = "glean_search",
  renderShell: "self" | "default" = "self",
): ToolExecutionComponent {
  const definition = {
    name: toolName,
    label: "MCP: glean_search",
    description: "test self-rendered MCP row",
    parameters: { type: "object", properties: {} },
    renderShell,
    execute() {
      throw new Error("not executed");
    },
    renderCall(
      callArgs: unknown,
      _theme: unknown,
      context?: FakeRenderContext,
    ) {
      const title = `${toolName} ${JSON.stringify(callArgs)}`;
      if (context?.state) context.state.compactTitle = title;
      if (
        context &&
        context.isPartial === false &&
        context.expanded !== true &&
        context.isError !== true
      ) {
        return new EmptyComponent();
      }
      // Live calls render the title plus multi-line pretty JSON, like the adapter.
      return new Text(`${title}\n${JSON.stringify(callArgs, null, 2)}`, 0, 0);
    },
    renderResult(
      result: { content: Array<{ type: string; text?: string }> },
      options: { expanded: boolean },
      _theme: unknown,
      context?: FakeRenderContext,
    ) {
      const detail =
        result.content.find((content) => content.type === "text")?.text ?? "";
      const title = String(context?.state?.compactTitle ?? "mcp");
      return new Text(
        options.expanded
          ? `FULL ${detail}`
          : `${title} → ${detail.split("\n")[0]} … (Ctrl+O to expand)`,
        0,
        0,
      );
    },
  };
  return new ToolExecutionComponent(
    toolName,
    toolCallId,
    args,
    {},
    definition as never,
    { requestRender() {} } as never,
    process.cwd(),
  );
}

// Mirrors Pi's formatReadCall: a bold tool title, an accent path wrapped in
// an OSC 8 hyperlink (`ESC]8;;url ESC\ <path> ESC]8;; ESC\`), a warning
// line range, and a dim expand hint. `terminator` lets tests exercise BEL
// (\x07) as well as ST (ESC\) terminated hyperlinks.
function createReadRow(
  path: string,
  terminator = "\x1b\\",
): ToolExecutionComponent {
  const definition = {
    name: "read",
    label: "read",
    description: "test read renderer",
    parameters: { type: "object", properties: {} },
    execute() {
      throw new Error("not executed");
    },
    renderCall() {
      return new Text(
        `\x1b[1mread\x1b[0m \x1b]8;;file:///${path}${terminator}\x1b[35m${path}\x1b[0m\x1b]8;;${terminator}\x1b[33m:1-400\x1b[0m\x1b[2m (Ctrl+O to expand)\x1b[0m`,
        0,
        0,
      );
    },
    renderResult(
      result: { content: Array<{ type: string; text?: string }> },
      options: { expanded: boolean },
    ) {
      const detail = result.content.find(
        (content) => content.type === "text",
      )?.text;
      return new Text(
        options.expanded ? `FULL ${detail}` : String(detail),
        0,
        0,
      );
    },
  };
  return new ToolExecutionComponent(
    "read",
    `read-${path}`,
    { path, offset: 1, limit: 400 },
    {},
    definition as never,
    { requestRender() {} } as never,
    process.cwd(),
  );
}

function settle(
  row: ToolExecutionComponent,
  output: string,
  isError = false,
): void {
  row.updateResult(
    {
      content: [{ type: "text", text: output }],
      details: {},
      isError,
    },
    false,
  );
}

function renderPlain(container: Container, width = 100): string {
  return container
    .render(width)
    .map((line) => line.replace(ANSI_RE, "").trimEnd())
    .filter((line) => line.trim())
    .join("\n");
}

beforeEach(() => {
  sessionHandlers.length = 0;
  shutdownHandlers.length = 0;
  install();
});

afterEach(() => {
  for (const handler of shutdownHandlers.splice(0)) handler();
});

describe("tool-call-markers with Pi's real renderer", () => {
  test("renders hidden thought labels non-italic in the experiment color", () => {
    const message = (stopReason?: string) =>
      ({
        role: "assistant",
        content: [{ type: "thinking", thinking: "ponder" }],
        stopReason,
      }) as never;

    const assistant = new AssistantMessageComponent(message("stop"), true);
    // Older pinned typings declare updateContent(message); the streaming
    // flag exists at runtime on current Pi.
    const updateContent = assistant.updateContent.bind(assistant) as (
      message: unknown,
      streaming?: boolean,
    ) => void;
    updateContent(message(), true);
    updateContent(message("stop"), false);

    const line = assistant
      .render(40)
      .find((candidate) => candidate.includes("Thought"));
    expect(line).toBeDefined();
    // The label Text node is swapped for a self-styled one: italic-off plus
    // the experiment color, with no italic-on anywhere on the line.
    expect(line).toContain("\x1b[23m\x1b[38;2;255;184;108m+ Thought");
    expect(line).not.toContain("\x1b[3m");
  });

  test("collapses a successful singleton to its call and outcome", () => {
    const chat = new Container();
    const row = createBashRow("npm test");
    chat.addChild(row);
    settle(row, "all tests passed");

    const output = renderPlain(chat);
    expect(output).toContain("% $: npm test → done");
    expect(output).not.toContain("all tests passed");
  });

  test("preserves a singleton outcome beside the marker at narrow widths", () => {
    const chat = new Container();
    const row = createBashRow("a-command-with-a-very-long-target");
    chat.addChild(row);
    settle(row, "done");

    const output = renderPlain(chat, 30);
    expect(output).toContain("→ done");
    expect(output).not.toMatch(/→ do$/);
    expect(output.split("\n").every((line) => line.length <= 30)).toBe(true);
    const rawLine = chat
      .render(30)
      .find((line) => line.replace(ANSI_RE, "").includes("→"));
    expect(rawLine).toBeDefined();
  });

  test("compacts a settled multiline command and restores it when expanded", () => {
    const chat = new Container();
    const command = [
      "printf one",
      "printf two",
      "printf three",
      "printf four",
    ].join("\n");
    const row = createNativeBashRow(command);
    chat.addChild(row);
    settle(row, "command output");

    const collapsed = renderPlain(chat);
    expect(collapsed).toContain(
      "% $: printf one · printf two · printf three · … → done",
    );
    expect(collapsed.split("\n")).toHaveLength(1);
    expect(collapsed).not.toContain("printf four");
    expect(collapsed).not.toContain("command output");

    row.setExpanded(true);
    const expanded = renderPlain(chat);
    for (const line of command.split("\n")) expect(expanded).toContain(line);
    expect(expanded).toContain("command output");
  });

  test("keeps a multiline timeout command on one line after settlement", () => {
    const chat = new Container();
    const row = createNativeBashRow("sleep 1\nprintf finished", 30);
    chat.addChild(row);

    row.updateResult(
      {
        content: [{ type: "text", text: "partial output" }],
        details: {},
        isError: false,
      },
      true,
    );
    const liveHeight = chat.render(100).length;
    expect(renderPlain(chat).split("\n")).toHaveLength(1);

    settle(row, "finished");
    const settled = renderPlain(chat);
    expect(chat.render(100)).toHaveLength(liveHeight);
    expect(settled).toContain(
      "% $: sleep 1 · printf finished (timeout 30s) → done",
    );
    expect(settled.split("\n")).toHaveLength(1);
  });

  test("keeps a failed singleton collapsed until Pi expands it", () => {
    const chat = new Container();
    const row = createBashRow("npm test");
    chat.addChild(row);
    settle(row, "test failure", true);

    expect(renderPlain(chat)).toContain("test failure");
    expect(renderPlain(chat)).not.toContain("FULL test failure");

    row.setExpanded(true);
    expect(renderPlain(chat)).toContain("FULL test failure");
  });

  test("caps a live row to one unboxed line with elapsed metadata", () => {
    const chat = new Container();
    const row = createBashRow(
      "npm run a-very-long-command-that-keeps-going-for-a-while",
    );
    (
      row as unknown as { rendererState: { startedAt?: number } }
    ).rendererState.startedAt = Date.now() - 2000;
    chat.addChild(row);
    row.updateResult(
      {
        content: [{ type: "text", text: "partial output line" }],
        details: {},
        isError: false,
      },
      true,
    );

    const lines = chat.render(50);
    const visible = lines.filter((line) => line.replace(ANSI_RE, "").trim());
    expect(visible).toHaveLength(1);

    const header = visible[0]!;
    const plain = header.replace(ANSI_RE, "");
    expect(plain).toContain("… · 2.0s");
    expect(plain).not.toContain("partial output line");
    expect(plain.trimEnd().length).toBeLessThanOrEqual(50);

    expect(header.indexOf("2.0s")).toBeGreaterThan(-1);
    expect(header).not.toMatch(/\x1b\[(?:4[0-7]|48;)/);
  });

  test("keeps live and settled blocks at the same padded height", () => {
    const make = () => {
      const chat = new Container();
      const row = createBashRow("npm test");
      chat.addChild(row);
      return { chat, row };
    };

    const live = make();
    live.row.updateResult(
      {
        content: [{ type: "text", text: "streaming output" }],
        details: {},
        isError: false,
      },
      true,
    );
    const liveLines = live.chat.render(60);

    const settled = make();
    settle(settled.row, "all tests passed");
    const settledLines = settled.chat.render(60);

    // One native inter-block spacer plus one unboxed marker line.
    expect(liveLines).toHaveLength(2);
    expect(settledLines).toHaveLength(2);
  });

  test("merges real rows as a quiet-turn call appears without settlement reflow", () => {
    const chat = new Container();
    const first = createBashRow("npm test");
    chat.addChild(first);
    settle(first, "tests passed");
    const singletonHeight = chat.render(100).length;
    expect(renderPlain(chat)).toContain("% $: npm test → done");

    chat.addChild(new AssistantMessageComponent());
    const second = createBashRow("npm run lint");
    chat.addChild(second);
    const liveHeight = chat.render(100).length;
    expect(liveHeight).toBeGreaterThanOrEqual(singletonHeight);
    expect(renderPlain(chat).match(/%/g)).toHaveLength(1);
    expect(renderPlain(chat).match(/•/g)).toHaveLength(2);
    expect(renderPlain(chat)).toContain("• $: npm run lint");

    settle(second, "lint passed");
    const output = renderPlain(chat);
    expect(chat.render(100)).toHaveLength(liveHeight);
    expect(output.match(/%/g)).toHaveLength(1);
    expect(output.match(/•/g)).toHaveLength(2);
    expect(output).toContain("• $: npm test → done");
    expect(output).toContain("• $: npm run lint → done");
  });

  test("groups real settled rows with one-line outcome bullets", () => {
    const chat = new Container();
    const first = createBashRow("npm test");
    const second = createBashRow("npm run lint");
    chat.addChild(first);
    chat.addChild(second);
    settle(first, "tests passed");
    settle(second, "lint passed");

    const output = renderPlain(chat, 36);
    expect(output.match(/%/g)).toHaveLength(1);
    expect(output.match(/•/g)).toHaveLength(2);
    expect(output).toContain("• $: npm test → done");
    expect(output).toContain("• $: npm run lint → done");
    expect(output).not.toContain("tests passed");
    expect(output).not.toContain("lint passed");
  });

  test("runs chat container hooks during grouped renders and restores after", () => {
    const chat = new Container();
    const first = createBashRow("npm test");
    const second = createBashRow("npm run lint");
    chat.addChild(first);
    chat.addChild(second);
    settle(first, "tests passed");
    settle(second, "lint passed");

    const calls: Array<{ container: object; width: number }> = [];
    let restores = 0;
    const hook: ChatContainerHook = (container, _children, width) => {
      calls.push({ container, width });
      return () => {
        restores += 1;
      };
    };
    chatContainerHooks().add(hook);
    try {
      const output = renderPlain(chat);
      expect(output.match(/%/g)).toHaveLength(1);
      expect(output.match(/•/g)).toHaveLength(2);
      expect(output).toContain("• $: npm test → done");
      expect(calls).toEqual([{ container: chat, width: 100 }]);
      expect(restores).toBe(1);
    } finally {
      chatContainerHooks().delete(hook);
    }
  });

  test("a failing chat container hook does not break grouping", () => {
    const chat = new Container();
    const first = createBashRow("npm test");
    const second = createBashRow("npm run lint");
    chat.addChild(first);
    chat.addChild(second);
    settle(first, "tests passed");
    settle(second, "lint passed");

    const badHook: ChatContainerHook = () => {
      throw new Error("boom");
    };
    chatContainerHooks().add(badHook);
    try {
      const output = renderPlain(chat);
      expect(output.match(/%/g)).toHaveLength(1);
      expect(output.match(/•/g)).toHaveLength(2);
      expect(output).toContain("• $: npm test → done");
    } finally {
      chatContainerHooks().delete(badHook);
    }
  });

  test("truncation ellipsis inherits the row tone", () => {
    const codes: Record<string, number> = { muted: 90, error: 31 };
    const ansiTheme = {
      bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
      fg: (color: string, text: string) =>
        `\x1b[${codes[color] ?? 37}m${text}\x1b[0m`,
      bg: (_color: string, text: string) => text,
    };
    for (const handler of sessionHandlers) {
      handler({}, { ui: { theme: ansiTheme, setToolsExpanded() {} } });
    }
    try {
      const settledChat = new Container();
      const settled = createBashRow(
        "a-command-with-a-very-long-target-and-more",
      );
      settledChat.addChild(settled);
      settle(settled, "ok");
      const settledOutput = settledChat.render(48).join("\n");
      expect(settledOutput).toContain("\x1b[90m…");
      expect(settledOutput).not.toContain("\x1b[31m");

      const failedChat = new Container();
      const failed = createBashRow("another-command-with-a-very-long-target");
      failedChat.addChild(failed);
      settle(failed, "boom", true);
      const failedOutput = failedChat.render(48).join("\n");
      expect(failedOutput).toContain("\x1b[31m…");
      expect(failedOutput).not.toContain("\x1b[90m…");
    } finally {
      for (const handler of sessionHandlers) {
        handler({}, { ui: { theme: extensionTheme, setToolsExpanded() {} } });
      }
    }
  });

  test("respects an empty self-rendered tool that opts out of display", () => {
    const definition = {
      name: "silent_self",
      label: "Silent",
      description: "renders no transcript row",
      parameters: { type: "object", properties: {} },
      renderShell: "self" as const,
      execute() {
        throw new Error("not executed");
      },
      renderCall() {
        return new EmptyComponent();
      },
      renderResult() {
        return new EmptyComponent();
      },
    };
    const row = new ToolExecutionComponent(
      "silent_self",
      "silent-1",
      {},
      {},
      definition as never,
      { requestRender() {} } as never,
      process.cwd(),
    );
    const chat = new Container();
    chat.addChild(row);
    settle(row, "hidden result");

    expect(renderPlain(chat)).toBe("");
  });

  test("collapses a settled self-rendered MCP row to call and outcome", () => {
    const chat = new Container();
    const row = createMcpRow("mcp-1", { query: "vibecheck" });
    chat.addChild(row);
    settle(row, "# Search Results (1 found)\n\n## 1. vibecheck");

    const output = renderPlain(chat);
    expect(output).toContain('% glean_search: {"query":"vibecheck"} → done');
    expect(output.split("\n")).toHaveLength(1);
    expect(output).not.toContain("Search Results");
  });

  test("shows the diff stat and block for a singleton self-rendered edit row", () => {
    const chat = new Container();
    const row = createMcpRow("mcp-edit-1", { path: "a.ts" }, "edit", "self");
    chat.addChild(row);
    row.updateResult(
      {
        content: [{ type: "text", text: "edited a.ts" }],
        details: { diff: "+new\n-old" },
        isError: false,
      },
      false,
    );

    const output = renderPlain(chat);
    // Edit rows label by path like Pi's native call line, keep the summary
    // line, and surface the change as a +a/-b stat plus a bounded diff block.
    expect(output).toContain("edit: a.ts → +1/-1");
    expect(output).toContain("  +new");
    expect(output).toContain("  -old");
    expect(output).not.toContain("edited a.ts");
  });

  test("shows diff blocks for grouped self-rendered edit rows", () => {
    const chat = new Container();
    const rows = ["a.ts", "b.ts"].map((path) =>
      createMcpRow(`mcp-edit-${path}`, { path }, "edit", "self"),
    );
    for (const row of rows) chat.addChild(row);
    for (const row of rows) {
      row.updateResult(
        {
          content: [{ type: "text", text: "edited" }],
          details: { diff: "+x\n-y" },
          isError: false,
        },
        false,
      );
    }

    const output = renderPlain(chat);
    expect(output).toContain("% edit");
    expect(output).toContain("• a.ts → +1/-1");
    expect(output).toContain("• b.ts → +1/-1");
    expect(output).toContain("  +x");
    expect(output).toContain("  -y");
    expect(output).not.toContain("edited");
  });

  test("restores a self-rendered MCP row when expanded", () => {
    const chat = new Container();
    const row = createMcpRow("mcp-2", { query: "vibecheck" });
    chat.addChild(row);
    settle(row, "result body");

    row.setExpanded(true);
    const expanded = renderPlain(chat);
    expect(expanded).toContain("FULL result body");
  });

  test("preserves a read path wrapped in an OSC 8 hyperlink", () => {
    const chat = new Container();
    const row = createReadRow("tools/kb_mcp/README.md");
    chat.addChild(row);
    settle(row, "alpha\nbeta\ngamma\n");

    const output = renderPlain(chat);
    expect(output).toContain("% read: tools/kb_mcp/README.md:1-400 → 3 lines");
    expect(output).not.toContain("% read: :1-400");
    expect(output).not.toMatch(/\x1b\]/);
  });

  test("preserves a read path wrapped in a BEL-terminated hyperlink", () => {
    const chat = new Container();
    const row = createReadRow("package.json", "\x07");
    chat.addChild(row);
    settle(row, "one\ntwo\n");

    const output = renderPlain(chat);
    expect(output).toContain("% read: package.json:1-400 → 2 lines");
    expect(output).not.toContain("% read: :1-400");
  });

  test("caps a long edit diff block with a folded tail", () => {
    const chat = new Container();
    const row = createMcpRow(
      "mcp-edit-long",
      { path: "big.ts" },
      "edit",
      "self",
    );
    chat.addChild(row);
    const diff = Array.from(
      { length: 15 },
      (_, index) => `+${index + 1} added line ${index}`,
    ).join("\n");
    row.updateResult(
      {
        content: [{ type: "text", text: "edited" }],
        details: { diff },
        isError: false,
      },
      false,
    );

    const output = renderPlain(chat);
    expect(output).toContain("  +1 added line 0");
    expect(output).toContain("  ... +3 more");
    expect(output).not.toContain("added line 12");
  });

  test("collapses a failed self-rendered MCP row to an error line", () => {
    const chat = new Container();
    const row = createMcpRow("mcp-3", { query: "vibecheck" });
    chat.addChild(row);
    settle(row, "Error: Security violation: 403\n\nlots of detail", true);

    const output = renderPlain(chat);
    expect(output.split("\n")).toHaveLength(1);
    expect(output).toContain(
      'glean_search: {"query":"vibecheck"} → Error: Security violation: 403',
    );
    expect(output).not.toContain("lots of detail");
  });

  test("treats MCP details.error results as failures despite isError false", () => {
    const chat = new Container();
    const row = createMcpRow("mcp-404", { tool: "glean_nope" }, "mcp");
    chat.addChild(row);
    row.updateResult(
      {
        content: [{ type: "text", text: 'Tool "glean_nope" not found.' }],
        details: { mode: "call", error: "tool_not_found" },
        isError: false,
      },
      false,
    );

    const output = renderPlain(chat);
    expect(output).toContain('glean_nope → Tool "glean_nope" not found.');
    expect(output).not.toContain("→ done");
  });

  test.each([
    "server_not_found",
    "server_disabled",
    "server_backoff",
    "server_not_connected",
    "init_failed",
    "init_timeout",
    "not_initialized",
    "server_unavailable",
    "not_connected",
    "timeout",
    "script_error",
    "missing_server",
    "missing_input",
    "oauth_not_supported",
    "auth_start_failed",
    "not_authenticated",
    "auth_complete_failed",
    "query_too_long",
    "unsafe_pattern",
    "invalid_pattern",
    "empty_query",
  ])(
    "treats details.error code %s as a failure despite isError false",
    (code) => {
      const chat = new Container();
      const row = createMcpRow(
        `mcp-fail-${code}`,
        { tool: "glean_search" },
        "mcp",
      );
      chat.addChild(row);
      row.updateResult(
        {
          content: [
            {
              type: "text",
              text: `mcp: ${code}: operation failed\nmore detail`,
            },
          ],
          details: { mode: "call", error: code },
          isError: false,
        },
        false,
      );

      const output = renderPlain(chat);
      expect(output.split("\n")).toHaveLength(1);
      expect(output).toContain(`mcp: ${code}: operation failed`);
      expect(output).not.toContain("more detail");
      expect(output).not.toContain("→ done");
    },
  );

  test("does not collapse default-shell script failures as successes", () => {
    const chat = new Container();
    // mcpScript registers without renderShell, so it uses the default shell.
    const row = createMcpRow(
      "mcpscript-timeout",
      { code: "tools.call()" },
      "mcpScript",
      "default",
    );
    chat.addChild(row);
    row.updateResult(
      {
        content: [{ type: "text", text: "Error: script timed out after 30s" }],
        details: { mode: "script", error: "timeout" },
        isError: false,
      },
      false,
    );

    const output = renderPlain(chat);
    expect(output).toContain("Error: script timed out after 30s");
    expect(output).not.toContain("→ done");
  });

  test("pins a live self-rendered MCP row to its settling line", () => {
    const chat = new Container();
    const row = createMcpRow("mcp-live", { query: "vibecheck", num: 1 });
    chat.addChild(row);
    row.markExecutionStarted();

    const live = renderPlain(chat);
    expect(live.split("\n")).toHaveLength(1);
    expect(live).toContain('glean_search: {"query":"vibecheck","num":1}');
    expect(live).toContain("…");
    expect(live).not.toContain('"num": 1');

    settle(row, "results");
    const settled = renderPlain(chat);
    expect(settled.split("\n")).toHaveLength(1);
    expect(settled).toContain(
      'glean_search: {"query":"vibecheck","num":1} → done',
    );
  });

  test("squashes string-encoded proxy arguments without escaping", () => {
    const chat = new Container();
    const row = createMcpRow(
      "mcp-proxy",
      {
        tool: "glean_search",
        args: '{"query": "vibecheck", "num_results": 1}',
      },
      "mcp",
    );
    chat.addChild(row);
    settle(row, "results");

    const output = renderPlain(chat);
    expect(output).toContain(
      'glean_search: {"query":"vibecheck","num_results":1} → done',
    );
    expect(output).not.toContain('\\"');
  });

  test("flattens malformed multiline proxy arguments to one line", () => {
    const chat = new Container();
    const row = createMcpRow(
      "mcp-malformed",
      {
        tool: "glean_search",
        args: '{\n  "query": "vibecheck",\n  "broken":\n}',
      },
      "mcp",
    );
    chat.addChild(row);
    row.markExecutionStarted();

    const live = renderPlain(chat);
    expect(live.split("\n")).toHaveLength(1);
    expect(live).toContain('"query"');

    settle(row, "Error: malformed JSON\nmore detail", true);
    const settled = renderPlain(chat);
    expect(settled.split("\n")).toHaveLength(1);
    expect(settled).toContain('"query"');
    expect(settled).toContain("Error: malformed JSON");
    expect(settled).not.toContain("more detail");
  });

  test("keeps collapsed self-rendered rows unboxed", () => {
    const chat = new Container();
    const row = createMcpRow("mcp-box", { query: "x" });
    chat.addChild(row);
    settle(row, "ok");

    const container = (
      row as unknown as { selfRenderContainer: { children: unknown[] } }
    ).selfRenderContainer;
    expect(container.children[0]).not.toBeInstanceOf(Box);
    const rendered = chat.render(100).join("\n");
    expect(rendered).not.toMatch(/\x1b\[(?:4[0-7]|48;)/);
  });

  test("groups adjacent settled MCP rows with real call summaries", () => {
    const chat = new Container();
    const first = createMcpRow("mcp-4", { query: "alpha" });
    const second = createMcpRow("mcp-5", { query: "beta" });
    chat.addChild(first);
    chat.addChild(second);
    settle(first, "alpha results");
    settle(second, "beta results");

    const output = renderPlain(chat);
    expect(output).not.toContain("(details omitted)");
    expect(output).toContain("% glean_search");
    expect(output).toContain('• {"query":"alpha"}');
    expect(output).toContain('• {"query":"beta"}');
    expect(output).toContain("→ done");
    expect(output).not.toContain("alpha results");
  });

  test("groups live self-rendered rows with args and pending tails", () => {
    const chat = new Container();
    const first = createMcpRow("mcp-l1", { query: "alpha" });
    const second = createMcpRow("mcp-l2", { query: "beta" });
    chat.addChild(first);
    chat.addChild(second);
    first.markExecutionStarted();
    second.markExecutionStarted();

    const output = renderPlain(chat);
    expect(output).toContain('• {"query":"alpha"}');
    expect(output).toContain('• {"query":"beta"}');
    expect(output).toContain("…");
    expect(output).not.toContain("→ done");

    settle(first, "alpha results");
    settle(second, "beta results");
    const settled = renderPlain(chat);
    expect(settled).toContain('• {"query":"alpha"}');
    expect(settled).toContain('• {"query":"beta"}');
    expect(settled).toContain("→ done");
  });

  test("keeps failed self rows out of success groups", () => {
    const chat = new Container();
    const ok = createMcpRow("mcp-ok", { query: "x" });
    const failed = createMcpRow("mcp-bad", { query: "y" });
    chat.addChild(ok);
    chat.addChild(failed);
    settle(ok, "fine");
    failed.updateResult(
      {
        content: [
          { type: "text", text: 'Error: not connected to server "glean"' },
        ],
        details: { mode: "call", error: "server_not_connected" },
        isError: false,
      },
      false,
    );

    const output = renderPlain(chat);
    expect(output.match(/%/g)).toHaveLength(2);
    expect(output).toContain('glean_search: {"query":"x"} → done');
    expect(output).toContain(
      'glean_search: {"query":"y"} → Error: not connected to server "glean"',
    );
  });

  test("groups self-rendered rows that painted live individually", () => {
    const chat = new Container();
    const first = createMcpRow("mcp-s1", { query: "alpha" });
    chat.addChild(first);
    first.markExecutionStarted();
    renderPlain(chat); // first row paints individually while live

    const second = createMcpRow("mcp-s2", { query: "beta" });
    chat.addChild(second);
    second.markExecutionStarted();

    const output = renderPlain(chat);
    expect(output.match(/%/g)).toHaveLength(1);
    expect(output.match(/•/g)).toHaveLength(2);
    expect(output).toContain('• {"query":"alpha"}');
    expect(output).toContain('• {"query":"beta"}');
  });

  test("keeps a literal call-label prefix when the error line is long", () => {
    for (const width of [8, 9, 10, 11, 17, 18, 60]) {
      const chat = new Container();
      const row = createMcpRow("mcp-long-err", { query: "boom" });
      chat.addChild(row);
      settle(
        row,
        'Tool "glean_no_such_tool" not found. Server "glean" has: glean_chat, glean_code_search, glean_employee_search',
        true,
      );

      const output = renderPlain(chat, width);
      expect(output.split("\n")).toHaveLength(1);
      expect(output).not.toBe("…");
      // The call label keeps at least one literal character (never just the
      // ellipsis) and the error tail keeps its arrow even at tiny widths;
      // only tail text beyond the budget gets cut.
      expect(output.match(/^\s*%\s+(\S)/)?.[1]).toBe("g");
      expect(output).toContain("→");
      expect(output).not.toContain("glean_employee_search");
      expect(output.length).toBeLessThanOrEqual(width);
    }
  });

  test("does not ellipsize an untruncated failure line", () => {
    const chat = new Container();
    const row = createMcpRow("mcp-short-err", { query: "x" });
    chat.addChild(row);
    settle(row, "Error: boom", true);

    const output = renderPlain(chat, 60);
    expect(output.split("\n")).toHaveLength(1);
    expect(output).toContain('glean_search: {"query":"x"} → Error: boom');
    expect(output).not.toMatch(/…$/);
  });

  test.each([
    "auth_required",
    "approval_required",
    "approval_denied",
    "url_elicitation_required",
    "aborted",
    "no_instructions",
  ])(
    "does not treat informational details.error code %s as a failure",
    (code) => {
      const chat = new Container();
      const row = createMcpRow("mcp-info", { search: "vibecheck" }, "mcp");
      chat.addChild(row);
      row.updateResult(
        {
          content: [{ type: "text", text: `${code}: guidance message` }],
          details: { mode: "list", error: code },
          isError: false,
        },
        false,
      );

      const output = renderPlain(chat);
      expect(output).toContain("→ done");
      expect(output).not.toContain(`${code}: guidance message`);
    },
  );

  test("keeps pagination args in proxy search labels", () => {
    const chat = new Container();
    const row = createMcpRow(
      "mcp-search",
      { search: "vibecheck", limit: 20, offset: 40 },
      "mcp",
    );
    chat.addChild(row);
    settle(row, "results");

    const output = renderPlain(chat);
    expect(output).toContain(
      'mcp: search vibecheck {"limit":20,"offset":40} → done',
    );
  });

  test("names proxy auth actions instead of mislabeling them as list", () => {
    const chat = new Container();
    const row = createMcpRow(
      "mcp-auth",
      { action: "auth-start", server: "glean" },
      "mcp",
    );
    chat.addChild(row);
    settle(row, "ok");

    const output = renderPlain(chat);
    expect(output).toContain("mcp: auth-start @ glean → done");
  });

  test("labels server-only proxy calls as list", () => {
    const chat = new Container();
    const row = createMcpRow("mcp-list", { server: "glean" }, "mcp");
    chat.addChild(row);
    settle(row, "ok");

    const output = renderPlain(chat);
    expect(output).toContain("mcp: list glean → done");
  });

  test("shows a server arg raw for modes the adapter does not scope", () => {
    const chat = new Container();
    const row = createMcpRow(
      "mcp-describe-srv",
      { describe: "glean_search", server: "glean" },
      "mcp",
    );
    chat.addChild(row);
    settle(row, "details");

    const output = renderPlain(chat);
    expect(output).toContain(
      'mcp: describe glean_search {"server":"glean"} → done',
    );
    expect(output).not.toContain("@ glean");
  });

  test("includes the server in proxy call labels", () => {
    const chat = new Container();
    const row = createMcpRow(
      "mcp-srv",
      { tool: "glean_search", server: "glean", args: '{"query": "x"}' },
      "mcp",
    );
    chat.addChild(row);
    settle(row, "ok");

    const output = renderPlain(chat);
    expect(output).toContain('glean_search: @ glean {"query":"x"} → done');
  });

  test.each([
    [
      { tool: "glean_search", args: '{"query": "x"}' },
      'glean_search: {"query":"x"}',
    ],
    [{ connect: "glean" }, "mcp: connect glean"],
    [{ describe: "glean_search" }, "mcp: describe glean_search"],
    [{ instructions: "user" }, "mcp: instructions user"],
    [
      { search: "vibecheck", limit: 20, offset: 40 },
      'mcp: search vibecheck {"limit":20,"offset":40}',
    ],
    [{ action: "auth-start", server: "glean" }, "mcp: auth-start @ glean"],
    [
      {
        action: "auth-complete",
        server: "glean",
        args: '{"redirectUrl":"https://auth.example/cb"}',
      },
      'mcp: auth-complete @ glean {"redirectUrl":"https://auth.example/cb"}',
    ],
    [{ action: "ui-messages" }, "mcp: ui-messages"],
    [{ server: "glean" }, "mcp: list glean"],
    [{}, "mcp: status"],
  ])("labels unambiguous proxy shape %j as %s", (args, label) => {
    const chat = new Container();
    const row = createMcpRow(`mcp-mode-${JSON.stringify(args)}`, args, "mcp");
    chat.addChild(row);
    settle(row, "ok");

    const output = renderPlain(chat);
    expect(output).toContain(`${label} → done`);
  });

  test.each([
    [
      { action: "auth-start", tool: "hammer" },
      ["mcp auth-start @", 'hammer {"'],
    ],
    [
      { connect: "glean", search: "vibecheck" },
      ["mcp: connect glean", "mcp search vibecheck"],
    ],
    [{ tool: "", search: "vibecheck" }, ["mcp search vibecheck", "mcp list"]],
    [{ tool: "" }, ["mcp: tool", "mcp list"]],
    [{ action: "mystery" }, ["mcp: mystery", "mcp list"]],
  ])(
    "renders ambiguous proxy shape %j as its complete args",
    (args, forbidden) => {
      const chat = new Container();
      const row = createMcpRow(
        `mcp-ambig-${JSON.stringify(args)}`,
        args,
        "mcp",
      );
      chat.addChild(row);
      settle(row, "ok");

      const output = renderPlain(chat);
      // Every selector survives in the raw compact shape; no single operation
      // is claimed on the label.
      expect(output).toContain(`mcp: ${JSON.stringify(args)} → done`);
      for (const needle of forbidden) expect(output).not.toContain(needle);
    },
  );

  test("treats an empty search as a present search rather than a list", () => {
    const chat = new Container();
    const row = createMcpRow(
      "mcp-empty-search",
      { search: "", server: "glean" },
      "mcp",
    );
    chat.addChild(row);
    settle(row, "ok");

    const output = renderPlain(chat);
    expect(output).toContain("mcp: search @ glean → done");
    expect(output).not.toContain("mcp list");
  });

  test("does not flatten non-proxy tools that take a tool argument", () => {
    const chat = new Container();
    const row = createMcpRow("mcp-weird", { tool: "hammer" }, "some_tool");
    chat.addChild(row);
    settle(row, "ok");

    const output = renderPlain(chat);
    expect(output).toContain('some_tool: {"tool":"hammer"} → done');
  });
});

describe("user bash blocks", () => {
  const codes: Record<string, number> = {
    accent: 35,
    bashMode: 32,
    error: 31,
    warning: 33,
    dim: 90,
  };
  const ansiTheme = {
    bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
    fg: (color: string, text: string) =>
      `\x1b[${codes[color] ?? 37}m${text}\x1b[0m`,
    bg: (_color: string, text: string) => text,
  };
  const stripControls = (text: string) =>
    text.replace(ANSI_RE, "").replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "");

  function withTheme(fn: () => void): void {
    for (const handler of sessionHandlers) {
      handler({}, { ui: { theme: ansiTheme, setToolsExpanded() {} } });
    }
    try {
      fn();
    } finally {
      for (const handler of sessionHandlers) {
        handler({}, { ui: { theme: extensionTheme, setToolsExpanded() {} } });
      }
    }
  }

  function createBashBlock(command: string): BashExecutionComponent {
    return new BashExecutionComponent(command, { requestRender() {} } as TUI);
  }

  test("restyles a user bash block as a prompt-style rail block", () => {
    withTheme(() => {
      const bash = createBashBlock("ls ~/matrxi");
      bash.appendOutput("ls: /Users/kg/matrxi: No such file or directory\n");
      bash.setComplete(1, false);

      const lines = bash.render(40);
      expect(stripControls(lines.join("\n"))).not.toContain("─");
      expect(stripControls(lines[0] ?? "")).toMatch(/^\s*$/);
      expect(lines[0]).not.toContain(PROMPT_SURFACE_BG);
      expect(lines.every((line) => visibleWidth(line) === 40)).toBe(true);

      const commandLine = lines.find((line) =>
        stripControls(line).includes("$ ls ~/matrxi"),
      );
      expect(commandLine).toBeDefined();
      // A failed exit recolors the rail red, like the (exit 1) status text.
      expect(commandLine).toContain(
        `\x1b[31m${PROMPT_RAIL}\x1b[0m${PROMPT_SURFACE_BG}`,
      );
      expect(stripControls(commandLine ?? "")).toContain(
        `${PROMPT_RAIL}  $ ls ~/matrxi`,
      );
      const outputLine = lines.find((line) =>
        stripControls(line).includes("No such"),
      );
      expect(outputLine).toContain(PROMPT_SURFACE_BG);

      bash.setComplete(0, false);
      const successLines = bash.render(40);
      const successCommand = successLines.find((line) =>
        stripControls(line).includes("$ ls ~/matrxi"),
      );
      expect(successCommand).toContain(
        `\x1b[32m${PROMPT_RAIL}\x1b[0m${PROMPT_SURFACE_BG}`,
      );
    });
  });

  test("falls back to the native shell on very narrow widths", () => {
    withTheme(() => {
      const bash = createBashBlock("ls");
      bash.setComplete(0, false);
      const lines = bash.render(4);
      expect(lines.length).toBeGreaterThan(0);
      expect(stripControls(lines.join("\n"))).not.toContain(PROMPT_RAIL);
    });
  });

  test("keeps the bash decoration until the final owner shuts down", () => {
    const localStarts: Array<(event: unknown, ctx: unknown) => void> = [];
    const localShutdowns: Array<() => void> = [];
    toolCallMarkers({
      on(event: string, handler: (event: unknown, ctx: unknown) => void) {
        if (event === "session_start") localStarts.push(handler);
        if (event === "session_shutdown")
          localShutdowns.push(handler as () => void);
      },
    } as ExtensionAPI);
    for (const handler of localStarts) {
      handler({}, { ui: { theme: extensionTheme, setToolsExpanded() {} } });
    }
    const firstOwnerShutdown = shutdownHandlers.shift()!;
    const finalOwnerShutdown = localShutdowns[0]!;

    firstOwnerShutdown();
    firstOwnerShutdown();
    expect(BashExecutionComponent.prototype.render).not.toBe(
      NATIVE_BASH_RENDER,
    );
    const active = createBashBlock("ls");
    active.setComplete(0, false);
    expect(active.render(40).join("\n")).toContain(PROMPT_RAIL);

    finalOwnerShutdown();
    expect(BashExecutionComponent.prototype.render).toBe(NATIVE_BASH_RENDER);
  });

  test("installs and restores the bash block renderer with the session", () => {
    // beforeEach install fired session_start with the pass-through theme.
    expect(BashExecutionComponent.prototype.render).not.toBe(
      NATIVE_BASH_RENDER,
    );
    for (const handler of shutdownHandlers.splice(0)) handler();
    expect(BashExecutionComponent.prototype.render).toBe(NATIVE_BASH_RENDER);
  });
});

describe("composition with pi-content-layout", () => {
  type PiHandler = (event: unknown, ctx: unknown) => void;

  function installBoth(layoutFirst: boolean): {
    fireShutdown: () => void;
    shutdownNext: () => void;
  } {
    const starts: PiHandler[] = [];
    const shutdowns: PiHandler[] = [];
    const pi = {
      on(event: string, handler: PiHandler) {
        if (event === "session_start") starts.push(handler);
        if (event === "session_shutdown") shutdowns.push(handler);
      },
      registerMessageRenderer() {},
    } as unknown as ExtensionAPI;
    const ctx = {
      mode: "tui",
      ui: {
        theme: extensionTheme,
        setToolsExpanded() {},
        getEditorComponent: () => undefined,
        setEditorComponent() {},
      },
    };
    const fireStart = () => {
      for (const handler of starts) handler({}, ctx);
    };
    const fireShutdown = () => {
      for (const handler of shutdowns.splice(0)) handler({}, ctx);
    };
    const shutdownNext = () => {
      shutdowns.shift()?.({}, ctx);
    };
    // Retire the beforeEach install so this helper owns the full lifecycle.
    for (const handler of shutdownHandlers.splice(0)) handler();
    if (layoutFirst) {
      contentLayout(pi);
      fireStart();
      toolCallMarkers(pi);
      fireStart();
    } else {
      toolCallMarkers(pi);
      contentLayout(pi);
      fireStart();
    }
    return { fireShutdown, shutdownNext };
  }

  function buildTranscript(): Container {
    const chat = new Container();
    chat.addChild(
      new AssistantMessageComponent({
        role: "assistant",
        content: [{ type: "text", text: "neighbor" }],
        stopReason: "stop",
      } as never),
    );
    chat.addChild(new Text("Reloaded keybindings", 1, 0));
    const first = createBashRow("npm test");
    const second = createBashRow("npm run lint");
    chat.addChild(first);
    chat.addChild(second);
    settle(first, "tests passed");
    settle(second, "lint passed");
    return chat;
  }

  function expectGroupedAndInset(output: string): void {
    expect(output.match(/%/g)).toHaveLength(1);
    expect(output.match(/•/g)).toHaveLength(2);
    expect(output).toContain("• $: npm test → done");
    expect(output).toContain("• $: npm run lint → done");
    expect(output).toMatch(/^ {2}Reloaded keybindings/m);
  }

  test("grouping and the system-text inset compose when markers installs first", () => {
    const { fireShutdown } = installBoth(false);
    try {
      expectGroupedAndInset(renderPlain(buildTranscript()));
    } finally {
      fireShutdown();
    }
  });

  test("grouping and the system-text inset compose when content-layout installs first", () => {
    const { fireShutdown } = installBoth(true);
    try {
      expectGroupedAndInset(renderPlain(buildTranscript()));
    } finally {
      fireShutdown();
    }
  });

  test("grouping stops when markers shuts down before content-layout", () => {
    const { fireShutdown, shutdownNext } = installBoth(false);
    try {
      // Markers' shutdown runs first: the grouping wrapper is shadowed by
      // content-layout and cannot be uninstalled, so it must go inert.
      shutdownNext();
      const output = renderPlain(buildTranscript());
      expect(output).not.toContain("% $");
      expect(output).not.toContain("• npm test");

      // Content-layout's shutdown then restores the wrapper it captured —
      // the now-inert grouping wrapper — so system text loses its inset too.
      shutdownNext();
      const restored = renderPlain(buildTranscript());
      expect(restored).not.toContain("% $");
      expect(restored).not.toMatch(/^ {2}Reloaded keybindings/m);
      expect(restored).toMatch(/^ Reloaded keybindings/m);
    } finally {
      fireShutdown();
    }
  });
});
