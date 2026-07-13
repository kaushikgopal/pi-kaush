import { describe, expect, test, vi } from "vitest";
import {
  createDoublePasteHandler,
  type EditorTextApi,
} from "../src/double-paste.ts";
import {
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START,
  normalizePaste,
} from "../src/paste.ts";

const longPaste = (prefix = "line") =>
  Array.from({ length: 11 }, (_, index) => `${prefix} ${index + 1}`).join("\n");
const envelope = (text: string) =>
  `${BRACKETED_PASTE_START}${text}${BRACKETED_PASTE_END}`;

class FakeEditor implements EditorTextApi {
  text = "";
  markerCount = 0;
  setCalls: string[] = [];
  getError = false;
  setError = false;

  getEditorText(): string {
    if (this.getError) throw new Error("get failed");
    return this.text;
  }

  setEditorText(text: string): void {
    if (this.setError) throw new Error("set failed");
    this.text = text;
    this.markerCount = 0;
    this.setCalls.push(text);
  }

  stockPaste(text: string): void {
    this.text += normalizePaste(text);
    this.markerCount += 1;
  }
}

function setup(windowMs = 3_000) {
  const editor = new FakeEditor();
  const scheduled: Array<() => void> = [];
  let now = 1_000;
  const warn = vi.fn<(message: string) => void>();
  const handler = createDoublePasteHandler(editor, {
    now: () => now,
    scheduleAfterInput: (callback) => scheduled.push(callback),
    windowMs,
    warn,
  });

  const flush = () => {
    while (scheduled.length > 0) scheduled.shift()?.();
  };

  const deliver = (text: string) => {
    const result = handler(envelope(text));
    if (!result?.consume) editor.stockPaste(text);
    flush();
    return result;
  };

  return {
    editor,
    flush,
    handler,
    deliver,
    warn,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
  };
}

describe("double paste expansion", () => {
  test("passes the first long paste and consumes the identical second paste", () => {
    const { deliver, editor } = setup();
    const content = longPaste();

    expect(deliver(content)).toBeUndefined();
    expect(editor.markerCount).toBe(1);

    expect(deliver(content)).toEqual({ consume: true });
    expect(editor.text).toBe(content);
    expect(editor.markerCount).toBe(0);
    expect(editor.setCalls).toEqual([content]);
  });

  test("expands all existing markers", () => {
    const { deliver, editor } = setup();
    const first = longPaste("first");
    const second = longPaste("second");

    deliver(first);
    deliver(second);
    expect(editor.markerCount).toBe(2);

    expect(deliver(second)).toEqual({ consume: true });
    expect(editor.text).toBe(first + second);
    expect(editor.markerCount).toBe(0);
  });

  test("passes short and non-matching pastes through unchanged", () => {
    const { deliver, editor } = setup();
    const first = longPaste("first");
    const second = longPaste("second");

    expect(deliver("short")).toBeUndefined();
    expect(deliver(first)).toBeUndefined();
    expect(deliver(second)).toBeUndefined();
    expect(editor.setCalls).toEqual([]);
  });

  test("does not arm when the main editor did not handle the first paste", () => {
    const { handler, flush, editor } = setup();
    const content = longPaste();

    expect(handler(envelope(content))).toBeUndefined();
    flush();
    expect(handler(envelope(content))).toBeUndefined();
    expect(editor.setCalls).toEqual([]);
  });

  test("does not consume after the editor content changes", () => {
    const { deliver, editor } = setup();
    const content = longPaste();

    deliver(content);
    editor.text += " edited";

    expect(deliver(content)).toBeUndefined();
    expect(editor.setCalls).toEqual([]);
  });

  test("does not consume an expired candidate", () => {
    const { deliver, advance, editor } = setup(100);
    const content = longPaste();

    deliver(content);
    advance(101);

    expect(deliver(content)).toBeUndefined();
    expect(editor.setCalls).toEqual([]);
  });

  test("fails open and warns once when expansion cannot write", () => {
    const { deliver, editor, warn } = setup();
    const content = longPaste();

    deliver(content);
    editor.setError = true;

    expect(deliver(content)).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(editor.text).toBe(content + content);
  });
});
