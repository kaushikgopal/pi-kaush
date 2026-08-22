import { beforeEach, expect, test, vi } from "vitest";

import type { InlineIdentifierFeature } from "../src/core.ts";

const tuiMock = vi.hoisted(() => {
  class FakeEditorA {
    constructor(private readonly lines: string[]) {}
    render(_width: number): string[] {
      return this.lines;
    }
  }
  class FakeHostEditor {
    constructor(protected readonly lines: string[]) {}
    render(_width: number): string[] {
      return this.lines;
    }
  }
  class FakeEditorB extends FakeHostEditor {
    override render(width: number): string[] {
      return [...super.render(width), "/added-by-custom"];
    }
  }
  return {
    FakeEditorA,
    FakeEditorB,
    FakeHostEditor,
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

const decorationStateKey = Symbol.for(
  "kg.pi.inlineIdentifier.decorationState.v1",
);

beforeEach(() => {
  tuiMock.FakeEditorA.prototype.render = tuiMock.renderA;
  tuiMock.FakeEditorB.prototype.render = tuiMock.renderB;
  Object.setPrototypeOf(
    tuiMock.FakeEditorB.prototype,
    tuiMock.FakeHostEditor.prototype,
  );
  delete (globalThis as Record<symbol, unknown>)[decorationStateKey];
});

function startSession(feature: InlineIdentifierFeature): void {
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
}

function feature(
  colorizeLine: InlineIdentifierFeature["colorizeLine"] = (line) => line,
): InlineIdentifierFeature {
  return {
    kind: "skill",
    triggerCharacter: "/",
    listDefinitions: () => [],
    matchAutocomplete: () => undefined,
    findReferences: () => [],
    colorizeLine,
    transform: () => ({ action: "continue" }),
  };
}

test("patches both editor prototypes across distinct pi-tui instances", () => {
  expect(
    tuiMock.FakeEditorA.prototype.isPrototypeOf(tuiMock.FakeEditorB.prototype),
  ).toBe(false);

  startSession(feature());

  expect(tuiMock.FakeEditorA.prototype.render).not.toBe(tuiMock.renderA);
  expect(tuiMock.FakeEditorB.prototype.render).not.toBe(tuiMock.renderB);
});

test("decorates an inherited CustomEditor render override exactly once", () => {
  Object.setPrototypeOf(
    tuiMock.FakeEditorB.prototype,
    tuiMock.FakeEditorA.prototype,
  );
  const colorizeLine = vi.fn((line: string) =>
    line.replace("/added-by-custom", "\x1b[32m/added-by-custom\x1b[39m"),
  );

  expect(
    tuiMock.FakeEditorA.prototype.isPrototypeOf(tuiMock.FakeEditorB.prototype),
  ).toBe(true);
  expect(
    Object.prototype.hasOwnProperty.call(
      tuiMock.FakeEditorB.prototype,
      "render",
    ),
  ).toBe(true);

  startSession(feature(colorizeLine));

  expect(tuiMock.FakeEditorA.prototype.render).not.toBe(tuiMock.renderA);
  expect(tuiMock.FakeEditorB.prototype.render).not.toBe(tuiMock.renderB);
  expect(new tuiMock.FakeEditorB([]).render(80)).toEqual([
    "\x1b[32m/added-by-custom\x1b[39m",
  ]);
  expect(colorizeLine).toHaveBeenCalledTimes(1);
});
