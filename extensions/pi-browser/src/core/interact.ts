/**
 * Compositor-level interaction through raw CDP: clicks land where the element
 * currently is (re-resolved per action), fills go through the native setter so
 * React/Vue controlled inputs keep the value.
 */

import type { CDPSession } from "puppeteer-core";

export const STALE_REF_ERROR =
  "ref is stale or hidden — re-run browser_snapshot for fresh refs";

const isMissingNode = (error: unknown): boolean =>
  error instanceof Error &&
  /No node with given id|Could not find node|No backend node|Cannot find object/.test(
    error.message,
  );

export const resolvePoint = async (
  client: CDPSession,
  backendNodeId: number,
): Promise<{ x: number; y: number }> => {
  try {
    await client
      .send("DOM.scrollIntoViewIfNeeded", { backendNodeId })
      .catch(() => {});
    const { quads } = await client.send("DOM.getContentQuads", {
      backendNodeId,
    });
    const quad = quads[0];
    if (!quad || quad.length < 8) throw new Error(STALE_REF_ERROR);
    const x =
      ((quad[0] ?? 0) + (quad[2] ?? 0) + (quad[4] ?? 0) + (quad[6] ?? 0)) / 4;
    const y =
      ((quad[1] ?? 0) + (quad[3] ?? 0) + (quad[5] ?? 0) + (quad[7] ?? 0)) / 4;
    return { x, y };
  } catch (error) {
    if (isMissingNode(error)) throw new Error(STALE_REF_ERROR);
    throw error;
  }
};

export const click = async (
  client: CDPSession,
  backendNodeId: number,
): Promise<void> => {
  const { x, y } = await resolvePoint(client, backendNodeId);
  await client.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
};

const FILL_DECLARATION = `function (value) {
  const el = this;
  if (!(el instanceof HTMLElement)) throw new Error("ref target is not an element");
  el.focus();
  if (el.isContentEditable) {
    el.textContent = value;
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
    return el.textContent;
  }
  if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement)) {
    throw new Error("ref target is not an input, textarea, or contenteditable: " + el.tagName);
  }
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const desc = Object.getOwnPropertyDescriptor(proto, "value");
  if (desc && desc.set) desc.set.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return el.value;
}`;

/** Framework-safe write; returns the value the element actually kept. */
export const fill = async (
  client: CDPSession,
  backendNodeId: number,
  value: string,
): Promise<string> => {
  let objectId: string;
  try {
    const { object } = await client.send("DOM.resolveNode", { backendNodeId });
    objectId = object.objectId ?? "";
  } catch (error) {
    if (isMissingNode(error)) throw new Error(STALE_REF_ERROR);
    throw error;
  }
  const { result, exceptionDetails } = await client.send(
    "Runtime.callFunctionOn",
    {
      objectId,
      functionDeclaration: FILL_DECLARATION,
      arguments: [{ value }],
      returnByValue: true,
    },
  );
  if (exceptionDetails) {
    const message =
      exceptionDetails.exception?.description ?? exceptionDetails.text;
    throw new Error(`fill failed: ${message}`);
  }
  const written = (result as { value?: unknown }).value;
  return typeof written === "string" ? written : value;
};

interface KeyDef {
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  text?: string | undefined;
}

const KEYS: Record<string, KeyDef> = {
  Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
  Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  Backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
  Delete: { key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
  ArrowRight: {
    key: "ArrowRight",
    code: "ArrowRight",
    windowsVirtualKeyCode: 39,
  },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
  Home: { key: "Home", code: "Home", windowsVirtualKeyCode: 36 },
  End: { key: "End", code: "End", windowsVirtualKeyCode: 35 },
  PageUp: { key: "PageUp", code: "PageUp", windowsVirtualKeyCode: 33 },
  PageDown: { key: "PageDown", code: "PageDown", windowsVirtualKeyCode: 34 },
  Space: { key: " ", code: "Space", windowsVirtualKeyCode: 32, text: " " },
};

export const keyNames = (): string[] => [
  ...Object.keys(KEYS),
  "(single character)",
];

/** CDP modifier bitfield: 1 Alt, 2 Ctrl, 4 Meta/Cmd, 8 Shift. */
export const pressKey = async (
  client: CDPSession,
  keyName: string,
  modifiers = 0,
): Promise<void> => {
  let def = KEYS[keyName];
  if (!def && keyName.length === 1) {
    const upper = keyName.toUpperCase();
    def = {
      key: keyName,
      code: /[A-Z]/.test(upper) ? `Key${upper}` : `Digit${keyName}`,
      windowsVirtualKeyCode: upper.charCodeAt(0),
      text: modifiers & 6 ? undefined : keyName, // no text when Ctrl/Alt/Meta held
    };
  }
  if (!def)
    throw new Error(
      `unknown key "${keyName}" — known: ${keyNames().join(", ")}`,
    );
  await client.send("Input.dispatchKeyEvent", {
    type: def.text ? "keyDown" : "rawKeyDown",
    key: def.key,
    code: def.code,
    windowsVirtualKeyCode: def.windowsVirtualKeyCode,
    ...(def.text ? { text: def.text } : {}),
    modifiers,
  });
  await client.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: def.key,
    code: def.code,
    windowsVirtualKeyCode: def.windowsVirtualKeyCode,
    modifiers,
  });
};

export const scroll = async (
  client: CDPSession,
  x: number,
  y: number,
  deltaX: number,
  deltaY: number,
): Promise<void> => {
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x,
    y,
    deltaX,
    deltaY,
  });
};

export const setFiles = async (
  client: CDPSession,
  backendNodeId: number,
  files: string[],
): Promise<void> => {
  try {
    await client.send("DOM.setFileInputFiles", { backendNodeId, files });
  } catch (error) {
    if (isMissingNode(error)) throw new Error(STALE_REF_ERROR);
    throw error;
  }
};
