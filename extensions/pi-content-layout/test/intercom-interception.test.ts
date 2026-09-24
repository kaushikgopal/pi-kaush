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
function render(chat: Container, width = 40): string {
  const restore = runChatContainerHooks(chat, chat.children, width);
  try {
    return chat.render(width).map(stripAnsi).join("\n");
  } finally {
    restore();
  }
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
