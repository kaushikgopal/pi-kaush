/**
 * browser_run_script — bounded escape hatch for workflows the dedicated tools
 * can't express (multi-step loops, httpOnly cookie + in-scope API calls that
 * must never return tokens to the transcript). Scripts land on disk first, so
 * they are reviewable and re-runnable. Full code execution, not a sandbox.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { isAbsolute, resolve, sep } from "node:path";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { cdpFor, getPage } from "../core/connection.ts";
import { delay, textResult } from "./shared.ts";

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_RESULT_CHARS = 50_000;

const allowedRoots = (): string[] => {
  const roots = [tmpdir(), process.cwd()];
  const extra = process.env["PI_BROWSER_SCRIPT_DIR"];
  if (extra) roots.push(extra);
  return roots.map((r) => resolve(r));
};

const assertAllowed = async (path: string): Promise<string> => {
  if (!isAbsolute(path))
    throw new Error(`script path must be absolute: ${path}`);
  const real = await realpath(path).catch(() => {
    throw new Error(`script not found: ${path}`);
  });
  if (
    !allowedRoots().some((root) => real === root || real.startsWith(root + sep))
  ) {
    throw new Error(
      `script must live under ${allowedRoots().join(", ")} — or PI_BROWSER_SCRIPT_DIR: ${path}`,
    );
  }
  return real;
};

export function registerScriptTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: "browser_run_script",
    label: "Browser Run Script",
    description:
      "Run a reviewed script file in the pi process with { page, client, params } bindings (puppeteer page, raw CDP client, caller params, full Node access). Use for multi-step authenticated workflows — e.g. read an httpOnly cookie and call an API in scope, returning only aggregates so tokens never enter the transcript. REVIEW THE SCRIPT BEFORE RUNNING: this is full code execution with the page's live session, not a sandbox. Path must be absolute and under the OS temp dir, cwd, or PI_BROWSER_SCRIPT_DIR. The script exports default async function(ctx) and returns a JSON-serializable value.",
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
      const real = await assertAllowed(params.path);
      const page = await getPage();
      const client = await cdpFor(page);
      const timeoutMs = Math.min(
        params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        MAX_TIMEOUT_MS,
      );
      const mod = (await import(pathToFileURL(real).href)) as {
        default?: unknown;
      };
      if (typeof mod.default !== "function") {
        throw new Error("script must export default async function(ctx)");
      }
      const result: unknown = await Promise.race([
        (
          mod.default as (ctx: {
            page: unknown;
            client: unknown;
            params: unknown;
          }) => Promise<unknown>
        )({
          page,
          client,
          params: params.params,
        }),
        delay(timeoutMs).then(() => {
          throw new Error(`script timed out after ${timeoutMs}ms`);
        }),
      ]);
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
