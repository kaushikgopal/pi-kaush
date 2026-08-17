/**
 * Mutation-side tools: click, fill, key, scroll, upload, wait_for.
 * Mutations append a "Page changes" diff as landing confirmation.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { isAbsolute } from "node:path";
import { resolveRef, type BuiltRef } from "../core/ax-snapshot.ts";
import { cdpFor, getPage } from "../core/connection.ts";
import {
  click,
  fill,
  keyNames,
  pressKey,
  scroll,
  setFiles,
} from "../core/interact.ts";
import { delay, textResult, withMutationDiff } from "./shared.ts";

const requireRef = (id: string): BuiltRef => {
  const entry = resolveRef(id);
  if (!entry)
    throw new Error(
      `unknown ref "${id}" — run browser_snapshot first to get fresh refs`,
    );
  return entry;
};

export function registerInteractionTools(pi: ExtensionAPI) {
  pi.registerTool({
    name: "browser_click",
    label: "Browser Click",
    description:
      "Click an element by its [eN] ref from browser_snapshot. Compositor-level: works through iframes and shadow DOM. The ref re-resolves position at click time; a stale-ref error means re-snapshot. Returns a Page-changes diff as confirmation.",
    promptSnippet: "Click an element by its snapshot ref",
    parameters: Type.Object(
      {
        ref: Type.String({
          description: "Ref id from browser_snapshot, e.g. e12",
        }),
      },
      { additionalProperties: false },
    ),
    async execute(_toolCallId, params: { ref: string }) {
      const entry = requireRef(params.ref);
      const page = await getPage();
      const client = await cdpFor(page);
      return textResult(
        await withMutationDiff(client, async () => {
          await click(client, entry.backendNodeId);
          return `clicked [${params.ref}] ${entry.role}${entry.name ? ` "${entry.name}"` : ""}`;
        }),
      );
    },
  });

  pi.registerTool({
    name: "browser_fill",
    label: "Browser Fill",
    description:
      "Set an input, textarea, or contenteditable to a value via the native setter with bubbling input/change events — React/Vue controlled inputs keep the write. Returns the value the element actually kept, plus a Page-changes diff.",
    promptSnippet: "Set a field's value by its snapshot ref",
    parameters: Type.Object(
      {
        ref: Type.String({
          description: "Ref id from browser_snapshot, e.g. e7",
        }),
        value: Type.String({ description: "Value to write into the element" }),
      },
      { additionalProperties: false },
    ),
    async execute(_toolCallId, params: { ref: string; value: string }) {
      const entry = requireRef(params.ref);
      const page = await getPage();
      const client = await cdpFor(page);
      return textResult(
        await withMutationDiff(client, async () => {
          const kept = await fill(client, entry.backendNodeId, params.value);
          return kept === params.value
            ? `filled [${params.ref}] ${entry.role}${entry.name ? ` "${entry.name}"` : ""}`
            : `filled [${params.ref}] but the element kept a different value: ${JSON.stringify(kept)}`;
        }),
      );
    },
  });

  pi.registerTool({
    name: "browser_press_key",
    label: "Browser Press Key",
    description: `Press a key with optional modifiers. Known keys: ${keyNames().join(", ")}. Modifiers are a bitfield: 1 Alt, 2 Ctrl, 4 Meta/Cmd, 8 Shift (e.g. 10 = Ctrl+Shift).`,
    promptSnippet: "Press a key with optional modifiers",
    parameters: Type.Object(
      {
        key: Type.String({
          description: "Key name (Enter, Tab, Escape, …) or a single character",
        }),
        modifiers: Type.Optional(
          Type.Number({
            description: "Bitfield: 1 Alt, 2 Ctrl, 4 Meta, 8 Shift",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    async execute(_toolCallId, params: { key: string; modifiers?: number }) {
      const page = await getPage();
      const client = await cdpFor(page);
      return textResult(
        await withMutationDiff(client, async () => {
          await pressKey(client, params.key, params.modifiers ?? 0);
          return `pressed ${params.key}${params.modifiers ? ` (+modifiers ${params.modifiers})` : ""}`;
        }),
      );
    },
  });

  pi.registerTool({
    name: "browser_scroll",
    label: "Browser Scroll",
    description:
      "Scroll by a delta (W3C wheel convention: positive deltaY = down). At a ref's position when given, else the viewport center.",
    promptSnippet: "Scroll the page by a delta",
    parameters: Type.Object(
      {
        deltaY: Type.Optional(
          Type.Number({
            description: "Vertical delta, positive = down (default 600)",
          }),
        ),
        deltaX: Type.Optional(
          Type.Number({ description: "Horizontal delta, positive = right" }),
        ),
        ref: Type.Optional(
          Type.String({
            description:
              "Scroll at this ref's position instead of viewport center",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    async execute(
      _toolCallId,
      params: { deltaY?: number; deltaX?: number; ref?: string },
    ) {
      const page = await getPage();
      const client = await cdpFor(page);
      let point: { x: number; y: number };
      if (params.ref) {
        const entry = requireRef(params.ref);
        const { resolvePoint } = await import("../core/interact.ts");
        point = await resolvePoint(client, entry.backendNodeId);
      } else {
        point = await page.evaluate(() => ({
          x: Math.floor(innerWidth / 2),
          y: Math.floor(innerHeight / 2),
        }));
      }
      const deltaX = params.deltaX ?? 0;
      const deltaY = params.deltaY ?? 600;
      return textResult(
        await withMutationDiff(client, async () => {
          await scroll(client, point.x, point.y, deltaX, deltaY);
          return `scrolled (${deltaX}, ${deltaY})`;
        }),
      );
    },
  });

  pi.registerTool({
    name: "browser_upload_file",
    label: "Browser Upload File",
    description:
      "Set files on a file input by its [eN] ref. Files must be absolute paths on this machine.",
    promptSnippet: "Set files on a file input",
    parameters: Type.Object(
      {
        ref: Type.String({
          description: "Ref id of the file input from browser_snapshot",
        }),
        files: Type.Array(Type.String(), {
          description: "Absolute file paths to set",
        }),
      },
      { additionalProperties: false },
    ),
    async execute(_toolCallId, params: { ref: string; files: string[] }) {
      const entry = requireRef(params.ref);
      for (const file of params.files) {
        if (!isAbsolute(file))
          throw new Error(`file path must be absolute: ${file}`);
      }
      const page = await getPage();
      const client = await cdpFor(page);
      return textResult(
        await withMutationDiff(client, async () => {
          await setFiles(client, entry.backendNodeId, params.files);
          return `set ${params.files.length} file(s) on [${params.ref}] ${entry.name ? `"${entry.name}"` : entry.role}`;
        }),
      );
    },
  });

  pi.registerTool({
    name: "browser_wait_for",
    label: "Browser Wait For",
    description:
      "Wait until a CSS selector appears (or disappears with gone:true), or text shows up in the page. Prefer this over fixed sleeps after actions that load content.",
    promptSnippet: "Wait for a selector or text to appear/disappear",
    parameters: Type.Object(
      {
        selector: Type.Optional(
          Type.String({ description: "CSS selector to wait for" }),
        ),
        text: Type.Optional(
          Type.String({ description: "Text to wait for in the page body" }),
        ),
        gone: Type.Optional(
          Type.Boolean({ description: "Wait until the condition is false" }),
        ),
        timeoutMs: Type.Optional(
          Type.Number({ description: "Timeout in ms (default 10000)" }),
        ),
      },
      { additionalProperties: false },
    ),
    async execute(
      _toolCallId,
      params: {
        selector?: string;
        text?: string;
        gone?: boolean;
        timeoutMs?: number;
      },
    ) {
      if (!params.selector && !params.text)
        throw new Error("pass selector or text");
      const page = await getPage();
      const gone = params.gone ?? false;
      const timeoutMs = params.timeoutMs ?? 10_000;
      const deadline = Date.now() + timeoutMs;
      const condition = params.selector
        ? `selector ${params.selector}`
        : `text ${JSON.stringify(params.text)}`;
      while (Date.now() < deadline) {
        const found = await page.evaluate(
          (sel, txt) => {
            if (sel) return !!document.querySelector(sel);
            if (txt) return (document.body?.innerText ?? "").includes(txt);
            return false;
          },
          params.selector,
          params.text,
        );
        if (found !== gone)
          return textResult(
            `condition met: ${condition}${gone ? " gone" : ""}`,
          );
        await delay(250);
      }
      throw new Error(
        `timed out after ${timeoutMs}ms waiting for ${condition}${gone ? " to disappear" : ""}`,
      );
    },
  });
}
