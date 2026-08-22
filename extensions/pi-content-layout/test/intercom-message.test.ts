import type {
  ExtensionAPI,
  MessageRenderer,
  Theme,
  ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import contentLayout from "../src/index.ts";
import { renderIntercomMessage } from "../src/intercom-message.ts";
import { OUTER_INSET } from "../src/render.ts";

const CSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const stripAnsi = (text: string) => text.replace(CSI_RE, "");

const FG_CODES: Record<string, number> = {
  muted: 94,
  text: 97,
  bashMode: 32,
  mdHeading: 33,
};

const theme = {
  fg(color: ThemeColor, text: string) {
    return `\x1b[${FG_CODES[color] ?? 37}m${text}\x1b[39m`;
  },
} as Theme;

const details: {
  from: { id: string; name: string; cwd: string };
  message: {
    replyTo?: string;
    expectsReply?: boolean;
    content: { text: string; attachments?: { name: string }[] };
  };
  replyCommand?: string;
} = {
  from: { id: "01a027b8-559f-7af7", name: "subagent-chat", cwd: "/tmp/aikado" },
  message: {
    content: {
      text: "Detailed Atomic audit for your hashline extension is attached.",
      attachments: [{ name: "audit.md" }],
    },
  },
  replyCommand: "/intercom reply subagent-chat",
};

function render(
  overrides: Partial<typeof details> = {},
  options: { expanded?: boolean; width?: number } = {},
) {
  const component = renderIntercomMessage(
    { ...details, ...overrides },
    options.expanded ?? false,
    theme,
  );
  if (!component) throw new Error("expected a component");
  return component.render(options.width ?? 40).map(stripAnsi);
}

describe("intercom message frame", () => {
  test("aligns the frame with the marker column and text with the text column", () => {
    const lines = render();
    const width = 40;

    expect(lines.every((line) => visibleWidth(line) === width)).toBe(true);

    // Border lands on the tool-marker column (contentInset); title and body
    // text land two columns inside it, where tool summaries and the Thought
    // label put their text.
    const borderColumn = OUTER_INSET;
    const textColumn = OUTER_INSET + 2;
    expect(lines[0]?.indexOf("╭")).toBe(borderColumn);
    expect(lines[0]?.indexOf("From:")).toBe(textColumn);
    expect(lines.at(-1)?.indexOf("╰")).toBe(borderColumn);
    for (const line of lines.slice(1, -1)) {
      expect(line.indexOf("│")).toBe(borderColumn);
      expect(line.lastIndexOf("│")).toBe(width - OUTER_INSET - 1);
    }
    expect(lines[1]?.indexOf("Detailed Atomic audit")).toBe(textColumn);
    expect(lines[2]?.indexOf("To reply:")).toBe(textColumn);
  });

  test("paints the frame bash green, the body muted, and the name orange", () => {
    const component = renderIntercomMessage(details, false, theme);
    const lines = component?.render(100) ?? [];

    // The frame uses the bashMode token, like the rules around `!` blocks.
    expect(lines[0]).toContain("\x1b[32m╭");
    expect(lines.at(-1)).toContain("\x1b[32m╰");
    for (const line of lines.slice(1, -1)) {
      expect(line).toContain("\x1b[32m│");
    }

    // Title: "From: " muted, sender name in the mdHeading orange, cwd
    // suffix muted again.
    expect(lines[0]).toContain("\x1b[94mFrom: \x1b[39m");
    expect(lines[0]).toContain("\x1b[33msubagent-chat\x1b[39m");
    expect(lines[0]).toContain("\x1b[94m (/tmp/aikado)\x1b[39m");

    // Body preview and meta line are muted, not default text or dim.
    expect(lines[1]).toContain("\x1b[94mDetailed Atomic audit");
    expect(lines[2]).toContain("\x1b[94mTo reply:");
  });

  test("keeps the expand hint out of the title and inside the meta line", () => {
    // Wide enough that the meta line is not truncated.
    const lines = render({}, { width: 100 });
    expect(lines[0]).not.toContain("Ctrl+O");
    expect(lines[2]).toContain("Ctrl+O to expand");
    expect(lines[2]).toContain("1 attachment");
  });

  test("collapses the body to a single squashed preview line", () => {
    const lines = render({
      message: {
        content: { text: "line one\n\nline two   with   spaces" },
      },
    });
    expect(lines).toHaveLength(4);
    expect(lines[1]).toContain("line one line two with spaces");
  });

  test("expands to the wrapped body with attachment and reply sections", () => {
    const lines = render({}, { expanded: true, width: 30 });
    expect(lines.some((line) => line.includes("Detailed Atomic"))).toBe(true);
    expect(lines.some((line) => line.includes("Attachment: audit.md"))).toBe(
      true,
    );
    expect(lines.some((line) => line.includes("To reply:"))).toBe(true);
    expect(lines.some((line) => line.includes("Ctrl+O"))).toBe(false);
    expect(lines.every((line) => visibleWidth(line) === 30)).toBe(true);
  });

  test("truncates an overlong title instead of overflowing", () => {
    const lines = render(
      {
        from: {
          id: "x",
          name: "a-very-long-session-name",
          cwd: "/tmp/deep/path",
        },
      },
      { width: 24 },
    );
    expect(lines.every((line) => visibleWidth(line) === 24)).toBe(true);
    expect(lines[0]).toContain("─");
    expect(lines[0]).toContain("╮");
  });

  test("degrades to a plain line at pathological widths", () => {
    const component = renderIntercomMessage(details, false, theme);
    const lines = component?.render(11).map(stripAnsi);
    expect(lines).toHaveLength(1);
    expect(lines?.[0]).toContain("From:");
    expect(visibleWidth(lines?.[0] ?? "")).toBe(11);
  });

  test("keeps framing at the smallest roomy width", () => {
    const lines = render({}, { width: 12 });
    expect(lines[0]?.indexOf("╭")).toBe(OUTER_INSET);
    expect(lines.every((line) => visibleWidth(line) === 12)).toBe(true);
  });

  test("the extension registers an intercom_message renderer", () => {
    const renderers = new Map<string, MessageRenderer>();
    contentLayout({
      on() {},
      registerMessageRenderer(customType: string, renderer: MessageRenderer) {
        renderers.set(customType, renderer);
      },
    } as unknown as ExtensionAPI);

    const renderer = renderers.get("intercom_message");
    expect(renderer).toBeDefined();
    const component = renderer?.(
      { details } as Parameters<MessageRenderer>[0],
      { expanded: false } as Parameters<MessageRenderer>[1],
      theme,
    );
    expect(component).toBeDefined();
    expect(stripAnsi(component?.render(40)[0] ?? "")).toContain("From:");
  });

  test("returns undefined for malformed payloads so Pi falls back", () => {
    expect(renderIntercomMessage(undefined, false, theme)).toBeUndefined();
    expect(renderIntercomMessage({}, false, theme)).toBeUndefined();
    expect(
      renderIntercomMessage({ message: { content: {} } }, false, theme),
    ).toBeUndefined();
  });
});
