import { expect, test, vi } from "vitest";

import type { InlineIdentifierFeature } from "../src/core.ts";

// Regression pin for the npm dual-instance scenario: CustomEditor can inherit
// from a host-owned pi-tui copy while this package resolves its peer pi-tui
// from a different path. The two classes below are genuinely distinct (B does
// not extend A), so Editor.prototype.isPrototypeOf(CustomEditor.prototype) is
// false and installEditorRenderPatch must decorate both prototypes.
const tuiMock = vi.hoisted(() => {
  class FakeEditorA {
    constructor(private readonly lines: string[]) {}
    render(_width: number): string[] {
      return this.lines;
    }
  }
  class FakeEditorB {
    constructor(private readonly lines: string[]) {}
    render(_width: number): string[] {
      return this.lines;
    }
  }
  return {
    FakeEditorA,
    FakeEditorB,
    renderA: FakeEditorA.prototype.render,
    renderB: FakeEditorB.prototype.render,
    visibleWidth: (text: string) =>
      text.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "").length,
  };
});

vi.mock("@earendil-works/pi-tui", () => ({
  Editor: tuiMock.FakeEditorA,
  visibleWidth: tuiMock.visibleWidth,
}));
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return { ...original, CustomEditor: tuiMock.FakeEditorB };
});

const { registerInlineIdentifierFeature } = await import("../src/core.ts");

test("patches both editor prototypes across distinct pi-tui instances", () => {
  const handlers = new Map<string, (event: any, context: any) => any>();
  const eventListeners = new Map<string, Set<(data: unknown) => void>>();
  const pi = {
    events: {
      emit(channel: string, data: unknown) {
        for (const listener of eventListeners.get(channel) ?? [])
          listener(data);
      },
      on(channel: string, listener: (data: unknown) => void) {
        const listeners = eventListeners.get(channel) ?? new Set();
        listeners.add(listener);
        eventListeners.set(channel, listeners);
        return () => listeners.delete(listener);
      },
    },
    on(name: string, handler: (event: any, context: any) => any) {
      handlers.set(name, handler);
    },
  };
  const feature: InlineIdentifierFeature = {
    kind: "skill",
    triggerCharacter: "/",
    listDefinitions: () => [],
    matchAutocomplete: () => undefined,
    findReferences: () => [],
    colorizeLine: (line) => line,
    transform: () => ({ action: "continue" }),
  };
  registerInlineIdentifierFeature(pi as never, feature);

  handlers.get("session_start")?.(
    {},
    {
      mode: "tui",
      ui: {
        getEditorText: () => "",
        addAutocompleteProvider() {},
      },
    },
  );

  expect(tuiMock.FakeEditorA.prototype.render).not.toBe(tuiMock.renderA);
  expect(tuiMock.FakeEditorB.prototype.render).not.toBe(tuiMock.renderB);
});
