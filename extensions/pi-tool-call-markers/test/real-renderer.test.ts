import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  AssistantMessageComponent,
  createBashToolDefinition,
  initTheme,
  ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import { Box, Container, Text } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import toolCallMarkers from "../src/index.ts";

const ANSI_RE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
const sessionHandlers: Array<(event: unknown, ctx: unknown) => void> = [];
const shutdownHandlers: Array<() => void> = [];

initTheme("dark");

const extensionTheme = {
  bold: (text: string) => text,
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
};

function install(): void {
  toolCallMarkers({
    on(event: string, handler: (event: unknown, ctx: unknown) => void) {
      if (event === "session_start") sessionHandlers.push(handler);
      if (event === "session_shutdown")
        shutdownHandlers.push(handler as () => void);
    },
  } as ExtensionAPI);
  for (const handler of sessionHandlers) {
    handler({}, { ui: { theme: extensionTheme, setToolsExpanded() {} } });
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

// Mirrors pi-mcp-adapter's compact mode: renderShell "self", the call
// component stashes its title in renderer state and disappears once settled,
// and the result renders its own one-line preview.
function createMcpRow(
  toolCallId: string,
  args: Record<string, unknown>,
  toolName = "glean_search",
): ToolExecutionComponent {
  const definition = {
    name: toolName,
    label: "MCP: glean_search",
    description: "test self-rendered MCP row",
    parameters: { type: "object", properties: {} },
    renderShell: "self",
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
  test("collapses a successful singleton to its call and outcome", () => {
    const chat = new Container();
    const row = createBashRow("npm test");
    chat.addChild(row);
    settle(row, "all tests passed");

    const output = renderPlain(chat);
    expect(output).toContain("⚙️ $ npm test → done");
    expect(output).not.toContain("all tests passed");
  });

  test("preserves a singleton outcome after adding the gear at narrow widths", () => {
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
    expect(rawLine!.slice(0, rawLine!.indexOf("→"))).not.toContain("\x1b[0m");
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
      "⚙️ $ printf one · printf two · printf three · … → done",
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
      "⚙️ $ sleep 1 · printf finished (timeout 30s) → done",
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

  test("caps a live row to one line with elapsed inside the background", () => {
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

    // The elapsed tail must sit inside the tool background, which the Box
    // paints edge to edge after composition; the final reset closes the line.
    const tailIndex = header.indexOf("2.0s");
    const finalReset = header.lastIndexOf("\x1b[0m");
    expect(tailIndex).toBeGreaterThan(-1);
    expect(finalReset).toBeGreaterThan(tailIndex);
    expect(header.slice(finalReset + "\x1b[0m".length).trim()).toBe("");
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

    // spacer + top padding + header + bottom padding at every stage
    expect(liveLines).toHaveLength(4);
    expect(settledLines).toHaveLength(4);
  });

  test("merges real rows as a quiet-turn call appears without settlement reflow", () => {
    const chat = new Container();
    const first = createBashRow("npm test");
    chat.addChild(first);
    settle(first, "tests passed");
    const singletonHeight = chat.render(100).length;
    expect(renderPlain(chat)).toContain("⚙️ $ npm test → done");

    chat.addChild(new AssistantMessageComponent());
    const second = createBashRow("npm run lint");
    chat.addChild(second);
    const liveHeight = chat.render(100).length;
    expect(liveHeight).toBeGreaterThanOrEqual(singletonHeight);
    expect(renderPlain(chat).match(/⚙️/g)).toHaveLength(1);
    expect(renderPlain(chat)).toContain("• npm run lint");

    settle(second, "lint passed");
    const output = renderPlain(chat);
    expect(chat.render(100)).toHaveLength(liveHeight);
    expect(output.match(/⚙️/g)).toHaveLength(1);
    expect(output).toContain("• npm test → done");
    expect(output).toContain("• npm run lint → done");
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
    expect(output.match(/⚙️/g)).toHaveLength(1);
    expect(output).toContain("• npm test → done");
    expect(output).toContain("• npm run lint → done");
    expect(output).not.toContain("tests passed");
    expect(output).not.toContain("lint passed");
  });

  test("collapses a settled self-rendered MCP row to call and outcome", () => {
    const chat = new Container();
    const row = createMcpRow("mcp-1", { query: "vibecheck" });
    chat.addChild(row);
    settle(row, "# Search Results (1 found)\n\n## 1. vibecheck");

    const output = renderPlain(chat);
    expect(output).toContain('⚙️ glean_search {"query":"vibecheck"} → done');
    expect(output.split("\n")).toHaveLength(1);
    expect(output).not.toContain("Search Results");
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

  test("collapses a failed self-rendered MCP row to an error line", () => {
    const chat = new Container();
    const row = createMcpRow("mcp-3", { query: "vibecheck" });
    chat.addChild(row);
    settle(row, "Error: Security violation: 403\n\nlots of detail", true);

    const output = renderPlain(chat);
    expect(output.split("\n")).toHaveLength(1);
    expect(output).toContain(
      'glean_search {"query":"vibecheck"} → Error: Security violation: 403',
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

  test("pins a live self-rendered MCP row to its settling line", () => {
    const chat = new Container();
    const row = createMcpRow("mcp-live", { query: "vibecheck", num: 1 });
    chat.addChild(row);
    row.markExecutionStarted();

    const live = renderPlain(chat);
    expect(live.split("\n")).toHaveLength(1);
    expect(live).toContain('glean_search {"query":"vibecheck","num":1}');
    expect(live).toContain("…");
    expect(live).not.toContain('"num": 1');

    settle(row, "results");
    const settled = renderPlain(chat);
    expect(settled.split("\n")).toHaveLength(1);
    expect(settled).toContain(
      'glean_search {"query":"vibecheck","num":1} → done',
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
      'glean_search {"query":"vibecheck","num_results":1} → done',
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

  test("wraps collapsed self-rendered rows in a background box", () => {
    const chat = new Container();
    const row = createMcpRow("mcp-box", { query: "x" });
    chat.addChild(row);
    settle(row, "ok");

    const container = (
      row as unknown as { selfRenderContainer: { children: unknown[] } }
    ).selfRenderContainer;
    expect(container.children[0]).toBeInstanceOf(Box);
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
    expect(output).toContain('glean_search {"query":"alpha"}');
    expect(output).toContain('glean_search {"query":"beta"}');
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
    expect(output).toContain('glean_search {"query":"alpha"}');
    expect(output).toContain('glean_search {"query":"beta"}');
    expect(output).toContain("…");
    expect(output).not.toContain("→ done");

    settle(first, "alpha results");
    settle(second, "beta results");
    const settled = renderPlain(chat);
    expect(settled).toContain('glean_search {"query":"alpha"}');
    expect(settled).toContain('glean_search {"query":"beta"}');
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
    expect(output.match(/⚙️/g)).toHaveLength(2);
    expect(output).toContain('glean_search {"query":"x"} → done');
    expect(output).toContain(
      'glean_search {"query":"y"} → Error: not connected to server "glean"',
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
    expect(output.match(/⚙️/g)).toHaveLength(1);
    expect(output).toContain('• glean_search {"query":"alpha"}');
    expect(output).toContain('• glean_search {"query":"beta"}');
  });

  test("keeps a call-label prefix when the error line is long", () => {
    for (const width of [17, 18, 60]) {
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
      expect(output).toContain("gle");
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
    expect(output).toContain('glean_search {"query":"x"} → Error: boom');
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
    expect(output).toContain('glean_search @ glean {"query":"x"} → done');
  });

  test("does not flatten non-proxy tools that take a tool argument", () => {
    const chat = new Container();
    const row = createMcpRow("mcp-weird", { tool: "hammer" }, "some_tool");
    chat.addChild(row);
    settle(row, "ok");

    const output = renderPlain(chat);
    expect(output).toContain('some_tool {"tool":"hammer"} → done');
  });
});
