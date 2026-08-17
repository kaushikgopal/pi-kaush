/**
 * Read-side tools: snapshot (default page read), evaluate (surgical JS),
 * screenshot (visual verification only). All proxied through the daemon.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { takeSnapshot } from "../core/ax-snapshot.ts";
import { cdp, evaluate, request } from "../core/client.ts";
import { textResult } from "./shared.ts";

const MAX_EVAL_CHARS = 50_000;

export function registerReadTools(pi: ExtensionAPI) {
  pi.registerTool({
    name: "browser_snapshot",
    label: "Browser Snapshot",
    description:
      "Read the current page as a compact accessibility outline. Interactive elements carry [eN] refs for browser_click/browser_fill/browser_upload_file. Refs re-resolve at action time but go stale after navigation — re-snapshot then. Never screenshot to find a click target; use this.",
    promptSnippet: "Read the page structure with actionable [eN] refs",
    parameters: Type.Object(
      {
        maxLines: Type.Optional(
          Type.Number({ description: "Cap outline length (default 400)" }),
        ),
      },
      { additionalProperties: false },
    ),
    async execute(_toolCallId, params: { maxLines?: number }) {
      const outline = await takeSnapshot(cdp(), {
        maxLines: params.maxLines ?? 400,
      });
      return textResult(outline);
    },
  });

  pi.registerTool({
    name: "browser_evaluate",
    label: "Browser Evaluate",
    description:
      "Evaluate a JavaScript expression in the current page and return the JSON-serializable result. The cheapest precise read (element text, attribute, coordinates) and the escape hatch for anything the dedicated tools do not cover. Runs with the page's session; never return credentials or tokens in the result.",
    promptSnippet: "Run JS in the page and return the result",
    promptGuidelines: [
      "Never return cookies, tokens, or credentials from browser_evaluate; use them inside the page (e.g. fetch) and return only aggregates.",
    ],
    parameters: Type.Object(
      {
        expression: Type.String({
          description:
            "JS expression evaluated in page context; the last value is returned",
        }),
      },
      { additionalProperties: false },
    ),
    async execute(_toolCallId, params: { expression: string }) {
      const result: unknown = await evaluate(params.expression);
      let text: string;
      try {
        text = JSON.stringify(result, null, 2) ?? String(result);
      } catch {
        text = String(result);
      }
      if (text.length > MAX_EVAL_CHARS) {
        text = `${text.slice(0, MAX_EVAL_CHARS)}\n… truncated at ${MAX_EVAL_CHARS} chars`;
      }
      return textResult(text);
    },
  });

  pi.registerTool({
    name: "browser_screenshot",
    label: "Browser Screenshot",
    description:
      "Capture the current viewport as PNG. For verifying visual rendering (layout, charts, colors) only — browser_snapshot and browser_evaluate are cheaper and exact for structure and values.",
    promptSnippet: "Capture the current viewport as an image",
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute() {
      const { data } = await cdp().send<{ data: string }>(
        "Page.captureScreenshot",
        {
          format: "png",
          fromSurface: true,
        },
      );
      const current = await request<{ url: string }>("getCurrent");
      return {
        content: [
          { type: "image" as const, data, mimeType: "image/png" },
          { type: "text" as const, text: `screenshot of ${current.url}` },
        ],
        details: { url: current.url },
      };
    },
  });
}
