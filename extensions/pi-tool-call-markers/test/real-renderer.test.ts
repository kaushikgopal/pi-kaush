import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  initTheme,
  ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
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
});
