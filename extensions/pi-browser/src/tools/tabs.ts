/**
 * Tab lifecycle tools, proxied through the daemon. Only pi-browser-owned
 * tabs can be switched or closed; the user's own tabs are visible read-only
 * under scope:"all".
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { request } from "../core/client.ts";
import { textResult } from "./shared.ts";

interface ListedPage {
  index: number;
  url: string;
  title: string;
  owned: boolean;
  active: boolean;
}

export function registerTabTools(pi: ExtensionAPI) {
  pi.registerTool({
    name: "browser_navigate",
    label: "Browser Navigate",
    description:
      "Navigate the current owned tab to a URL. Connects lazily to the user's running browser (via the pi-browser daemon) on first use. Returns the final URL and title.",
    promptSnippet: "Go to a URL in the current browser tab",
    parameters: Type.Object(
      {
        url: Type.String({
          description: "Full URL to navigate to, e.g. https://example.com",
        }),
      },
      { additionalProperties: false },
    ),
    async execute(_toolCallId, params: { url: string }) {
      return textResult(await request("goto", { url: params.url }));
    },
  });

  pi.registerTool({
    name: "browser_tabs",
    label: "Browser Tabs",
    description:
      "List browser tabs. Default scope owned (tabs pi-browser opened). scope all also shows the user's own tabs read-only — they cannot be switched to or closed.",
    promptSnippet: "List open browser tabs",
    parameters: Type.Object(
      {
        scope: Type.Optional(
          Type.Union([Type.Literal("owned"), Type.Literal("all")]),
        ),
      },
      { additionalProperties: false },
    ),
    async execute(_toolCallId, params: { scope?: "owned" | "all" }) {
      const pages = await request<ListedPage[]>("listPages");
      const shown =
        params.scope === "all" ? pages : pages.filter((p) => p.owned);
      if (shown.length === 0)
        return textResult(
          "no owned tabs — browser_new_tab or any tool opens one",
        );
      return textResult(
        shown
          .map(
            (p) =>
              `${p.active ? "*" : " "} ${p.index}: ${p.title ? `${p.title} — ` : ""}${p.url}${p.owned ? "" : " (not owned, read-only)"}`,
          )
          .join("\n"),
      );
    },
  });

  pi.registerTool({
    name: "browser_new_tab",
    label: "Browser New Tab",
    description:
      "Open a new owned tab (optionally at a URL) and make it current.",
    promptSnippet: "Open a new browser tab",
    parameters: Type.Object(
      {
        url: Type.Optional(
          Type.String({ description: "URL to open in the new tab" }),
        ),
      },
      { additionalProperties: false },
    ),
    async execute(_toolCallId, params: { url?: string }) {
      return textResult(
        await request("newPage", params.url ? { url: params.url } : {}),
      );
    },
  });

  pi.registerTool({
    name: "browser_switch_tab",
    label: "Browser Switch Tab",
    description:
      "Make another owned tab current (by index from browser_tabs, or a URL substring). Owned tabs only. Does not change browser focus; human handoff can still raise the tab via page.bringToFront() in script scope.",
    promptSnippet: "Switch to another owned tab",
    parameters: Type.Object(
      {
        index: Type.Optional(
          Type.Number({ description: "Tab index from browser_tabs" }),
        ),
        url: Type.Optional(
          Type.String({ description: "URL substring to match" }),
        ),
      },
      { additionalProperties: false },
    ),
    async execute(_toolCallId, params: { index?: number; url?: string }) {
      if (params.index === undefined && params.url === undefined)
        throw new Error("pass index or url");
      return textResult(await request("switchPage", params));
    },
  });

  pi.registerTool({
    name: "browser_close_tab",
    label: "Browser Close Tab",
    description:
      "Close an owned tab (default: the current one). Refuses to close the user's own tabs.",
    promptSnippet: "Close an owned browser tab",
    parameters: Type.Object(
      {
        index: Type.Optional(
          Type.Number({ description: "Tab index from browser_tabs" }),
        ),
        url: Type.Optional(
          Type.String({ description: "URL substring to match" }),
        ),
      },
      { additionalProperties: false },
    ),
    async execute(_toolCallId, params: { index?: number; url?: string }) {
      const result =
        params.index === undefined && params.url === undefined
          ? await request<{ closed: string }>("closeCurrent")
          : await request<{ closed: string }>("closePage", params);
      return textResult(`closed tab: ${result.closed}`);
    },
  });
}
