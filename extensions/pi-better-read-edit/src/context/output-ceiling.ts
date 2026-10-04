/**
 * Output ceiling — bound what one tool result can put in the model's context.
 *
 * Measured over 60 vault sessions (20.5M chars of tool output): 7.7% of results
 * exceeded 8k chars, and the top 5% of results held 56% of all characters. The
 * worst single results were `web_search` at 208k chars and a bare `ls` of a
 * 1,804-entry directory at 51,295 chars.
 *
 * `read` and `edit` are deliberately excluded. This package's read tool
 * authorizes an edit by the lines it displayed, so truncating a read result
 * would either authorize lines the model never saw or reject a valid edit.
 *
 * Nested calls (those carrying `parentToolCallId`, such as a codemode script's
 * `tools.bash`) are left alone: the sandbox is where large output is meant to be
 * processed, and it can already receive up to 1 MiB.
 */
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ToolResultEvent,
  ToolResultEventResult,
} from "@earendil-works/pi-coding-agent";

type ContentPart = ToolResultEvent["content"][number];

export const DEFAULT_OUTPUT_BUDGET = 10_000;
const HEAD_SHARE = 0.6;

/** Tools whose full output can be re-obtained through a bounded re-query. */
export function isCappedTool(toolName: string): boolean {
  return (
    toolName === "bash" ||
    toolName === "web_search" ||
    toolName === "fetch_content" ||
    toolName.startsWith("mcp")
  );
}

export function recoveryHint(toolName: string, fullPath?: string): string {
  const where = fullPath ? ` Full output: ${fullPath}` : "";
  switch (toolName) {
    case "bash":
      return `Re-run with a filter (rg -c, wc -l, head, a narrower path) or inside codemode, where tools.bash receives up to 1 MiB and only your answer returns.${where}`;
    case "web_search":
      return `Re-query more narrowly, or pull the stored results with get_search_content using the responseId in the tail.${where}`;
    case "fetch_content":
      return `Use get_search_content with the responseId, or fetch a narrower URL.${where}`;
    default:
      return `Re-query with a tighter filter, or process it inside codemode and return only the answer.${where}`;
  }
}

/**
 * Keep the head and the tail, and replace the middle with a marker naming the
 * recovery path. Returns the input untouched when it is already within budget.
 */
export function applyCeiling(
  text: string,
  budget: number,
  recovery: string,
): { text: string; truncated: boolean } {
  if (text.length <= budget) return { text, truncated: false };
  const headSize = Math.floor(budget * HEAD_SHARE);
  const tailSize = budget - headSize;
  const dropped = text.length - headSize - tailSize;
  const marker =
    `\n\n… [ceiling: ${text.split("\n").length.toLocaleString()} lines / ` +
    `${text.length.toLocaleString()} chars total, ${dropped.toLocaleString()} omitted ` +
    `from the middle] …\n${recovery}\n\n`;
  return {
    text: text.slice(0, headSize) + marker + text.slice(-tailSize),
    truncated: true,
  };
}

/**
 * Bash can hide its own error behind `2>/dev/null`, so an empty or failed result
 * is not evidence that the command succeeded.
 */
export function stderrNote(
  command: string,
  isError: boolean,
  textLength: number,
): string {
  if (!command.includes("2>/dev/null")) return "";
  if (!isError && textLength > 200) return "";
  return "\n\n[stderr was suppressed by 2>/dev/null — re-run without it before concluding anything]";
}

async function writeFullOutput(text: string): Promise<string | undefined> {
  try {
    const digest = createHash("sha1").update(text).digest("hex").slice(0, 16);
    const path = join(tmpdir(), `pi-ceiling-${digest}.txt`);
    await writeFile(path, text, "utf8");
    return path;
  } catch {
    return undefined;
  }
}

export default function registerOutputCeiling(pi: ExtensionAPI): void {
  pi.on(
    "tool_result",
    async (event: ToolResultEvent): Promise<ToolResultEventResult | void> => {
      if (event.parentToolCallId) return;
      if (!isCappedTool(event.toolName)) return;

      // A for-of narrows the union; Array.filter does not.
      const textParts: string[] = [];
      const otherParts: ContentPart[] = [];
      for (const part of event.content) {
        if (part.type === "text") textParts.push(part.text);
        else otherParts.push(part);
      }
      const text = textParts.join("\n");

      const input = event.input as { command?: unknown };
      const command = typeof input.command === "string" ? input.command : "";
      const suppressed =
        event.toolName === "bash"
          ? stderrNote(command, event.isError, text.length)
          : "";

      if (text.length <= DEFAULT_OUTPUT_BUDGET) {
        if (!suppressed) return;
        return {
          content: [
            { type: "text" as const, text: text + suppressed },
            ...otherParts,
          ],
        };
      }

      const fullPath = await writeFullOutput(text);
      const { text: capped } = applyCeiling(
        text,
        DEFAULT_OUTPUT_BUDGET,
        recoveryHint(event.toolName, fullPath),
      );
      const result: ToolResultEventResult = {
        content: [
          { type: "text" as const, text: capped + suppressed },
          ...otherParts,
        ],
      };
      // Replacing `content` without carrying `structuredContent` drops it for
      // codemode scripts, which receive the structured value instead of text.
      if (event.structuredContent !== undefined) {
        result.structuredContent = event.structuredContent;
      }
      return result;
    },
  );
}
