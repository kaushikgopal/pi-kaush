import type {
  ExtensionAPI,
  MessageRenderer,
  Theme,
  ThemeColor,
} from "@earendil-works/pi-coding-agent";
import {
  CustomMessageComponent,
  initTheme,
} from "@earendil-works/pi-coding-agent";
import { Container, Text, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { runChatContainerHooks } from "../src/container-hooks.ts";
import contentLayout from "../src/index.ts";
import {
  interceptIntercomMessages,
  renderIntercomMessage,
} from "../src/intercom-message.ts";

const CSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const stripAnsi = (text: string) => text.replace(CSI_RE, "");

const FG_CODES: Record<string, number> = {
  muted: 94,
  text: 97,
  customMessageLabel: 33,
};

const theme = {
  fg(color: ThemeColor, text: string) {
    return `\x1b[${FG_CODES[color] ?? 37}m${text}\x1b[39m`;
  },
} as Theme;

type EditorFactory = () => undefined;

type Handler = (event: unknown, ctx: TestContext) => void;

type TestContext = {
  mode: "tui";
  ui: {
    theme: Theme;
    getEditorComponent(): EditorFactory | undefined;
    setEditorComponent(factory: EditorFactory | undefined): void;
  };
};

const details = {
  from: { id: "01a027b8-559f-7af7", name: "subagent-chat", cwd: "/tmp/aikado" },
  message: {
    content: {
      text: "Detailed Atomic audit for your hashline extension is attached.",
      attachments: [{ name: "audit.md" }],
    },
  },
  replyCommand: 'intercom({ action: "reply", message: "..." })',
};

const message = {
  role: "custom" as const,
  customType: "intercom_message",
  content: "**From subagent-chat** ( /tmp/aikado)",
  display: true,
  details,
  timestamp: 1,
};

// Stands in for pi-intercom's InlineMessageComponent: a renderer this package
// did not register, so Pi's first-registration-wins lookup can hand the
// message to it while this package's box stays shadowed.
const foreignRenderer: MessageRenderer = () =>
  new Text(theme.fg("text", "FOREIGN BOX"), 0, 0);

function createHarness() {
  const handlers = new Map<string, Handler>();
  const renderers = new Map<string, MessageRenderer>();
  let editorFactory: EditorFactory | undefined;
  const context: TestContext = {
    mode: "tui",
    ui: {
      theme,
      getEditorComponent: () => editorFactory,
      setEditorComponent(factory) {
        editorFactory = factory;
      },
    },
  };

  contentLayout({
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
    },
    registerMessageRenderer(customType: string, renderer: MessageRenderer) {
      renderers.set(customType, renderer);
    },
  } as unknown as ExtensionAPI);

  return {
    context,
    renderers,
    fire(event: string) {
      handlers.get(event)?.({}, context);
    },
  };
}

const activeHarnesses: ReturnType<typeof createHarness>[] = [];

function sessionHarness() {
  const harness = createHarness();
  activeHarnesses.push(harness);
  harness.fire("session_start");
  return harness;
}

function chatWith(host: CustomMessageComponent): Container {
  const chat = new Container();
  chat.addChild(host);
  return chat;
}

// Pi's container render runs the registered hooks around the child render; the
// test drives the same seam directly, because a bare Container's prototype is
// not the one this package patches and pi-tui resolves to a second copy under
// vitest.
function render(chat: Container, width = 40, strip = stripAnsi): string {
  const restore = runChatContainerHooks(chat, chat.children, width);
  try {
    return chat.render(width).map(strip).join("\n");
  } finally {
    restore();
  }
}

function intercomBoxes(payload: unknown, expanded: boolean) {
  const harness = sessionHarness();
  const registered = harness.renderers.get("intercom_message");
  if (!registered) throw new Error("expected registered intercom renderer");
  const input = { ...message, details: payload };
  const component = registered(input, { expanded, outputPad: 1 }, theme);
  if (!component) throw new Error("expected registered intercom box");
  const host = new CustomMessageComponent(input, foreignRenderer);
  host.setExpanded(expanded);
  const chat = chatWith(host);
  return {
    render(width = 100) {
      return [
        component.render(width).join("\n"),
        render(chat, width, (text) => text),
      ];
    },
  };
}

beforeEach(() => {
  initTheme("dark");
});

afterEach(() => {
  for (const harness of activeHarnesses.splice(0)) {
    harness.fire("session_shutdown");
  }
});

describe("intercom message interception", () => {
  const clean = {
    from: { name: "peer1234", id: "peer12345678", cwd: "/repo" },
    replyCommand: "/reply",
    message: {
      replyTo: "12345678-more",
      content: {
        text: "helloworld\nnext",
        attachments: [{ name: "audit.md" }],
      },
    },
  };
  const attack = (text: string) =>
    `\x1b[2J\x9b2J\x1b]0;spoof\x07\x1b[31m\x1b]8;;file:///tmp/probe\x1b\\${text}\x1b]8;;\x1b\\\x1b[0m`;

  test.each([
    ["body override", { ...clean, bodyText: `hello${attack("world")}\nnext` }],
    [
      "content body",
      {
        ...clean,
        message: {
          ...clean.message,
          content: {
            ...clean.message.content,
            text: `hello${attack("world")}\nnext`,
          },
        },
      },
    ],
    [
      "sender name",
      { ...clean, from: { ...clean.from, name: attack("peer1234") } },
    ],
    [
      "sender id",
      {
        ...clean,
        from: { ...clean.from, name: "", id: attack("peer12345678") },
      },
    ],
    ["cwd", { ...clean, from: { ...clean.from, cwd: attack("/repo") } }],
    ["reply command", { ...clean, replyCommand: attack("/reply") }],
    [
      "reply target",
      {
        ...clean,
        message: { ...clean.message, replyTo: attack("12345678-more") },
      },
    ],
    [
      "attachment name",
      {
        ...clean,
        message: {
          ...clean.message,
          content: {
            ...clean.message.content,
            attachments: [{ name: attack("audit.md") }],
          },
        },
      },
    ],
  ])(
    "keeps external %s controls out of both intercom routes",
    (_field, payload) => {
      for (const expanded of [false, true]) {
        const boxes = intercomBoxes(payload, expanded);
        for (const width of [11, 100]) {
          for (const raw of boxes.render(width)) {
            // Allow our fixture's colors and truncateToWidth's reset, not
            // arbitrary SGR or terminal commands from the message.
            const output = raw.replace(/\x1b\[(?:0|33|94|39)m/g, "");
            expect(output).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/);
            const lines = output.split("\n").filter(Boolean);
            if (width === 11) {
              expect(lines).toEqual(["  From: p  "]);
              continue;
            }
            expect(raw).toContain("\x1b[33m╭");
            expect(raw).toContain("\x1b[94mhelloworld");
            expect(lines[0]).toContain("From: peer1234 (/repo)");
            expect(
              lines
                .filter((line) => line.includes("│"))
                .map((line) => line.slice(4, -4).trimEnd()),
            ).toEqual(
              expanded
                ? [
                    "helloworld",
                    "next",
                    "",
                    "To reply: /reply",
                    "",
                    "Attachment: audit.md",
                    "",
                    "Reply to 12345678",
                  ]
                : [
                    "helloworld next",
                    "To reply: /reply · 1 attachment · Reply to 12345678 · Ctrl+O to expand",
                  ],
            );
          }
        }
      }
    },
  );

  test("keeps body line feeds but flattens other external intercom controls", () => {
    const payload = {
      from: { name: "pe\ner", cwd: "/re\tpo" },
      bodyText: "one\x00\ttwo\nthree\r\b\x7ffour\x80\x9fend",
      replyCommand: "/re\nply",
      message: {
        replyTo: "ab\ncd\refgh",
        content: { attachments: [{ name: "au\vdit\f.md" }] },
      },
    };
    for (const expanded of [false, true]) {
      for (const raw of intercomBoxes(payload, expanded).render()) {
        const output = raw.replace(/\x1b\[(?:33|94|39)m/g, "");
        expect(output).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/);
        const lines = output.split("\n");
        expect(lines.find((line) => line.includes("╭"))).toContain(
          "From: pe er (/re po)",
        );
        expect(
          lines
            .filter((line) => line.includes("│"))
            .map((line) => line.slice(4, -4).trimEnd()),
        ).toEqual(
          expanded
            ? [
                "one  two",
                "three   four  end",
                "",
                "To reply: /re ply",
                "",
                "Attachment: au dit .md",
                "",
                "Reply to ab cd ef",
              ]
            : [
                "one two three four end",
                "To reply: /re ply · 1 attachment · Reply to ab cd ef · Ctrl+O to expand",
              ],
        );
      }
    }
  });

  test("sanitizes changed intercom metadata without freezing live details", () => {
    for (const expanded of [false, true]) {
      const payload = structuredClone(clean);
      const boxes = intercomBoxes(payload, expanded);
      boxes.render();
      payload.from.name = attack("renamed");
      payload.from.cwd = attack("/changed");
      payload.replyCommand = attack("/changed");
      payload.message.replyTo = attack("changed12345");
      payload.message.content.attachments = [{ name: attack("changed.md") }];
      for (const raw of boxes.render()) {
        const output = raw.replace(/\x1b\[(?:33|94|39)m/g, "");
        expect(output).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/);
        const lines = output.split("\n");
        expect(lines.find((line) => line.includes("╭"))).toContain(
          "From: renamed (/changed)",
        );
        expect(
          lines
            .filter((line) => line.includes("│"))
            .map((line) => line.slice(4, -4).trimEnd()),
        ).toEqual(
          expanded
            ? [
                "helloworld",
                "next",
                "",
                "To reply: /changed",
                "",
                "Attachment: changed.md",
                "",
                "Reply to changed1",
              ]
            : [
                "helloworld next",
                "To reply: /changed · 1 attachment · Reply to changed1 · Ctrl+O to expand",
              ],
        );
      }
    }
  });

  test("restyles a box Pi built with another extension's renderer", () => {
    sessionHarness();
    const chat = chatWith(new CustomMessageComponent(message, foreignRenderer));
    const lines = render(chat).split("\n");
    const frame = lines.find((line) => line.includes("╭"));

    expect(lines.join("\n")).not.toContain("FOREIGN BOX");
    // The frame lands on the marker column and carries the sender name.
    expect(frame?.startsWith("  ╭")).toBe(true);
    expect(frame).toContain("From: subagent-chat");
    // Collapsed box: attachment details wait for the expand toggle.
    expect(lines.join("\n")).not.toContain("Attachment: audit.md");
  });

  test("restores the host's own render after the pass", () => {
    sessionHarness();
    const host = new CustomMessageComponent(message, foreignRenderer);
    const chat = chatWith(host);

    const first = render(chat);
    expect(Object.prototype.hasOwnProperty.call(host, "render")).toBe(false);
    expect(render(chat)).toBe(first);
  });

  test("follows the host's expansion state", () => {
    sessionHarness();
    const host = new CustomMessageComponent(message, foreignRenderer);
    const chat = chatWith(host);

    expect(render(chat)).not.toContain("audit.md");
    host.setExpanded(true);
    expect(render(chat)).toContain("Attachment: audit.md");
  });

  test("falls back to the render Pi built when the payload is malformed", () => {
    sessionHarness();
    const host = new CustomMessageComponent(
      { ...message, details: {} },
      foreignRenderer,
    );

    expect(render(chatWith(host))).toContain("FOREIGN BOX");
  });

  test.each<[string, unknown]>([
    ["sender object", { bodyText: "Body", from: 123 }],
    ["sender array", { bodyText: "Body", from: [] }],
    ["null sender", { bodyText: "Body", from: null }],
    ["sender id", { bodyText: "Body", from: { id: 123 } }],
    ["sender name", { bodyText: "Body", from: { name: 123 } }],
    ["sender cwd", { bodyText: "Body", from: { cwd: 123 } }],
    ["reply command", { bodyText: "Body", replyCommand: 123 }],
    [
      "null body override",
      { bodyText: null, message: { content: { text: "Body" } } },
    ],
    ["message object", { bodyText: "Body", message: 123 }],
    ["message array", { bodyText: "Body", message: [] }],
    ["null message", { bodyText: "Body", message: null }],
    ["reply target", { bodyText: "Body", message: { replyTo: 123 } }],
    ["reply flag", { bodyText: "Body", message: { expectsReply: "false" } }],
    ["content object", { bodyText: "Body", message: { content: 123 } }],
    ["content array", { bodyText: "Body", message: { content: [] } }],
    ["null content", { bodyText: "Body", message: { content: null } }],
    [
      "shadowed content text",
      { bodyText: "Body", message: { content: { text: 123 } } },
    ],
    [
      "attachment collection",
      {
        bodyText: "Body",
        message: { content: { attachments: { length: 1 } } },
      },
    ],
    [
      "attachment string",
      { bodyText: "Body", message: { content: { attachments: "file" } } },
    ],
    [
      "null attachments",
      { bodyText: "Body", message: { content: { attachments: null } } },
    ],
    [
      "null attachment",
      { bodyText: "Body", message: { content: { attachments: [null] } } },
    ],
    [
      "scalar attachment",
      { bodyText: "Body", message: { content: { attachments: [123] } } },
    ],
    [
      "array attachment",
      { bodyText: "Body", message: { content: { attachments: [[]] } } },
    ],
    [
      "sparse attachments",
      { bodyText: "Body", message: { content: { attachments: Array(1) } } },
    ],
    [
      "attachment name",
      {
        bodyText: "Body",
        message: { content: { attachments: [{ name: 123 }] } },
      },
    ],
  ])("uses the existing host fallback for malformed %s", (_name, malformed) => {
    const harness = sessionHarness();
    const registered = harness.renderers.get("intercom_message");
    if (!registered) throw new Error("expected registered intercom renderer");

    for (const expanded of [false, true]) {
      expect(renderIntercomMessage(malformed, expanded, theme)).toBeUndefined();
      for (const renderer of [registered, foreignRenderer]) {
        const host = new CustomMessageComponent(
          { ...message, content: "Native fallback", details: malformed },
          renderer,
        );
        host.setExpanded(expanded);
        expect(
          render(chatWith(host), 60)
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean),
        ).toEqual(
          renderer === registered
            ? ["[intercom_message]", "Native fallback"]
            : ["FOREIGN BOX"],
        );
      }
    }
  });

  test("stops intercepting after session shutdown", () => {
    const harness = sessionHarness();
    const chat = chatWith(new CustomMessageComponent(message, foreignRenderer));

    expect(render(chat)).not.toContain("FOREIGN BOX");
    harness.fire("session_shutdown");
    expect(render(chat)).toContain("FOREIGN BOX");
  });

  test("keeps the frame on the transcript columns", () => {
    sessionHarness();
    const chat = chatWith(new CustomMessageComponent(message, foreignRenderer));
    const lines = render(chat).split("\n");
    const body = lines.find((line) => line.includes("Detailed Atomic audit"));

    // Frame border sits on the tool-marker column; text starts two columns in.
    expect(lines.every((line) => visibleWidth(line) <= 40)).toBe(true);
    expect(body?.startsWith("  │ Detailed Atomic audit")).toBe(true);
  });
  test("keeps Pi's leading spacer above the intercepted frame", () => {
    sessionHarness();
    const chat = chatWith(new CustomMessageComponent(message, foreignRenderer));

    const lines = render(chat).split("\n");
    // Pi's CustomMessageComponent renders a Spacer(1) ahead of every custom
    // box; the swap bypasses the host's own render, so it must reproduce
    // that blank line of separation from the entry above.
    expect(lines[0]).toBe("");
    expect(lines[1]?.startsWith("  ╭")).toBe(true);
  });
});

describe("interception contract", () => {
  const ownRenderer: MessageRenderer = (customMessage, options, activeTheme) =>
    renderIntercomMessage(customMessage.details, options.expanded, activeTheme);

  function hostWith(renderer: unknown, customType: string) {
    return {
      message: { customType, details },
      customRenderer: renderer,
      _expanded: false,
      render: (_width: number) => ["HOST ROW"],
    };
  }

  test("ignores a host whose renderer is this package's own", () => {
    const host = hostWith(ownRenderer, "intercom_message");
    expect(
      interceptIntercomMessages([host], theme, ownRenderer),
    ).toBeUndefined();
    expect(host.render(40)).toEqual(["HOST ROW"]);
  });

  test("ignores hosts that are not intercom messages", () => {
    const host = hostWith(foreignRenderer, "other_message");
    expect(
      interceptIntercomMessages([host], theme, ownRenderer),
    ).toBeUndefined();
  });

  test("is inert without a theme", () => {
    const host = hostWith(foreignRenderer, "intercom_message");
    expect(
      interceptIntercomMessages([host], undefined, ownRenderer),
    ).toBeUndefined();
  });

  test("compares against the renderer this package registers", () => {
    const harness = createHarness();
    activeHarnesses.push(harness);
    const registered = harness.renderers.get("intercom_message");
    expect(registered).toBeDefined();

    // A host rendered by the registered renderer already wears this package's
    // box, so the hook must leave it alone.
    const host = hostWith(registered, "intercom_message");
    expect(
      interceptIntercomMessages([host], theme, registered),
    ).toBeUndefined();
  });
});
