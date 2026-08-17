/**
 * Capture query tools: network requests and console output recorded by the
 * daemon on the current tab since attach.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { request } from "../core/client.ts";
import { textResult } from "./shared.ts";

interface NetworkRecordOut {
  seq: number;
  requestId: string;
  url: string;
  method: string;
  resourceType: string;
  status?: number;
  failed?: string;
  time: number;
  responseBody?: string;
}

interface ConsoleRecordOut {
  seq: number;
  level: string;
  text: string;
  time: number;
}

export function registerCaptureTools(pi: ExtensionAPI) {
  pi.registerTool({
    name: "browser_network_requests",
    label: "Browser Network Requests",
    description:
      "Network requests captured on the current tab since attach. Filter by URL substring, method, or status range; pass sinceSeq from a previous nextCursor to see only what an action caused. Response bodies are opt-in via includeResponseBodies and capped at 20k chars each. Never extract credentials from bodies into the transcript.",
    promptSnippet: "List network requests captured on the current tab",
    promptGuidelines: [
      "Use includeResponseBodies only when needed; bodies are unredacted page data.",
    ],
    parameters: Type.Object(
      {
        urlPattern: Type.Optional(
          Type.String({ description: "URL substring filter" }),
        ),
        method: Type.Optional(
          Type.String({ description: "HTTP method filter, e.g. POST" }),
        ),
        minStatus: Type.Optional(
          Type.Number({ description: "Minimum HTTP status (inclusive)" }),
        ),
        maxStatus: Type.Optional(
          Type.Number({ description: "Maximum HTTP status (inclusive)" }),
        ),
        sinceSeq: Type.Optional(
          Type.Number({
            description: "Only records after this sequence number",
          }),
        ),
        limit: Type.Optional(
          Type.Number({
            description: "Max records, newest first within cap (default 50)",
          }),
        ),
        includeResponseBodies: Type.Optional(
          Type.Boolean({
            description: "Fetch response bodies (capped, slower)",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    async execute(
      _toolCallId,
      params: {
        urlPattern?: string;
        method?: string;
        minStatus?: number;
        maxStatus?: number;
        sinceSeq?: number;
        limit?: number;
        includeResponseBodies?: boolean;
      },
    ) {
      const records = await request<NetworkRecordOut[]>("networkQuery", params);
      if (records.length === 0)
        return textResult("no matching requests captured");
      return textResult(
        records
          .map((r) => {
            const status =
              r.status ?? (r.failed ? `failed: ${r.failed}` : "pending");
            const base = `#${r.seq} ${r.method} ${status} ${r.resourceType} ${r.url}`;
            return r.responseBody ? `${base}\n  body: ${r.responseBody}` : base;
          })
          .join("\n"),
      );
    },
  });

  pi.registerTool({
    name: "browser_console",
    label: "Browser Console",
    description:
      "Console output and uncaught exceptions from the current tab since attach. Filter by level (error, warning, info, log, debug); pass sinceSeq from a previous nextCursor to see only new entries. Diagnostic — reach for it when an action had no visible effect.",
    promptSnippet: "Read console output and JS errors from the current tab",
    parameters: Type.Object(
      {
        levels: Type.Optional(
          Type.Array(Type.String(), {
            description: 'Levels to include, e.g. ["error", "warning"]',
          }),
        ),
        sinceSeq: Type.Optional(
          Type.Number({
            description: "Only entries after this sequence number",
          }),
        ),
        limit: Type.Optional(
          Type.Number({ description: "Max entries (default 50)" }),
        ),
      },
      { additionalProperties: false },
    ),
    async execute(
      _toolCallId,
      params: { levels?: string[]; sinceSeq?: number; limit?: number },
    ) {
      const { records, nextCursor } = await request<{
        records: ConsoleRecordOut[];
        nextCursor: number;
      }>("consoleQuery", params);
      const body =
        records.length === 0
          ? "no console entries"
          : records.map((r) => `#${r.seq} [${r.level}] ${r.text}`).join("\n");
      return textResult(`${body}\n\nnextCursor: ${nextCursor}`);
    },
  });
}
