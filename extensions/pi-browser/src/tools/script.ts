/**
 * browser_run_script — bounded escape hatch, executed daemon-side with
 * { page, client, params } bindings. Scripts land on disk first, so they are
 * reviewable and re-runnable. Full code execution, not a sandbox.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { request } from "../core/client.ts";
import { textResult } from "./shared.ts";

const MAX_RESULT_CHARS = 50_000;

export function registerScriptTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: "browser_run_script",
    label: "Browser Run Script",
    description:
      "Run a reviewed script file with { page, client, params } bindings (puppeteer page, raw CDP client, caller params, full Node access, daemon-side). Use for multi-step authenticated workflows — e.g. read an httpOnly cookie and call an API in scope, returning only aggregates so tokens never enter the transcript. REVIEW THE SCRIPT BEFORE RUNNING: this is full code execution with the page's live session, not a sandbox. Path must be absolute and under the OS temp dir, cwd, or PI_BROWSER_SCRIPT_DIR. The script exports default async function(ctx) and returns a JSON-serializable value.",
    promptSnippet: "Run a reviewed script with page + raw CDP bindings",
    promptGuidelines: [
      "Never extract tokens, cookies, or credentials into the script's return value; use them in scope and return aggregates only.",
    ],
    parameters: Type.Object(
      {
        path: Type.String({
          description:
            "Absolute path to the script (.js/.mjs/.ts), under tmpdir, cwd, or PI_BROWSER_SCRIPT_DIR",
        }),
        params: Type.Optional(
          Type.Any({
            description:
              "Caller params passed through to the script as ctx.params",
          }),
        ),
        timeoutMs: Type.Optional(
          Type.Number({
            description: "Timeout in ms (default 60000, max 600000)",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    async execute(
      _toolCallId,
      params: { path: string; params?: unknown; timeoutMs?: number },
    ) {
      const timeoutMs = Math.min(params.timeoutMs ?? 60_000, 600_000);
      const result: unknown = await request(
        "runScript",
        { path: params.path, params: params.params, timeoutMs },
        timeoutMs + 15_000,
      );
      let text: string;
      try {
        text = JSON.stringify(result, null, 2) ?? String(result);
      } catch {
        text = String(result);
      }
      if (text.length > MAX_RESULT_CHARS) {
        text = `${text.slice(0, MAX_RESULT_CHARS)}\n… truncated at ${MAX_RESULT_CHARS} chars`;
      }
      return textResult(text);
    },
  });
}
