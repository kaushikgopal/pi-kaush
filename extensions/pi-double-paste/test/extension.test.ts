import { describe, expect, test, vi } from "vitest";
import piExpandDoublePaste from "../src/index.ts";

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
});
