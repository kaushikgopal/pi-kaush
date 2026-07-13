import { describe, expect, test, vi } from "vitest";
import piExpandDoublePaste from "../src/index.ts";
import { BRACKETED_PASTE_END, BRACKETED_PASTE_START } from "../src/paste.ts";

type Handler = (event: unknown, context: any) => void;

function setup() {
  const handlers = new Map<string, Handler>();
  const pi = {
    on: vi.fn((event: string, handler: Handler) =>
      handlers.set(event, handler),
    ),
  };
  piExpandDoublePaste(pi as any);
  return { handlers, pi };
}

describe("extension lifecycle", () => {
  test("registers a terminal listener only in TUI mode", () => {
    const { handlers } = setup();
    const onTerminalInput = vi.fn(() => vi.fn());
    const ui = {
      onTerminalInput,
      getEditorText: vi.fn(),
      setEditorText: vi.fn(),
      notify: vi.fn(),
    };

    handlers.get("session_start")?.({}, { mode: "print", ui });
    expect(onTerminalInput).not.toHaveBeenCalled();

    handlers.get("session_start")?.({}, { mode: "tui", ui });
    expect(onTerminalInput).toHaveBeenCalledTimes(1);
    expect(onTerminalInput).toHaveBeenCalledWith(expect.any(Function));
  });

  test("unsubscribes on shutdown and before re-registering", () => {
    const { handlers } = setup();
    const firstUnsubscribe = vi.fn();
    const secondUnsubscribe = vi.fn();
    const onTerminalInput = vi
      .fn<() => () => void>()
      .mockReturnValueOnce(firstUnsubscribe)
      .mockReturnValueOnce(secondUnsubscribe);
    const ui = {
      onTerminalInput,
      getEditorText: vi.fn(),
      setEditorText: vi.fn(),
      notify: vi.fn(),
    };

    handlers.get("session_start")?.({}, { mode: "tui", ui });
    handlers.get("session_start")?.({}, { mode: "tui", ui });
    expect(firstUnsubscribe).toHaveBeenCalledTimes(1);

    handlers.get("session_shutdown")?.({}, { mode: "tui", ui });
    expect(secondUnsubscribe).toHaveBeenCalledTimes(1);
  });

  test("notifies after expanding a matching second paste", async () => {
    const { handlers } = setup();
    let terminalInput:
      | ((data: string) => { consume?: boolean } | undefined)
      | undefined;
    let editorText = "";
    const notify = vi.fn();
    const ui = {
      onTerminalInput: vi.fn((handler) => {
        terminalInput = handler;
        return vi.fn();
      }),
      getEditorText: vi.fn(() => editorText),
      setEditorText: vi.fn((text: string) => {
        editorText = text;
      }),
      notify,
    };
    const content = Array.from(
      { length: 11 },
      (_, index) => `line ${index + 1}`,
    ).join("\n");
    const paste = `${BRACKETED_PASTE_START}${content}${BRACKETED_PASTE_END}`;

    handlers.get("session_start")?.({}, { mode: "tui", ui });
    expect(terminalInput?.(paste)).toBeUndefined();
    editorText = content;
    await Promise.resolve();

    expect(terminalInput?.(paste)).toEqual({ consume: true });
    expect(notify).toHaveBeenCalledWith("Paste expanded.", "info");
  });
});
