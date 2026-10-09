import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { ChildMessage } from "./_child-events.ts";
import { isPlainRecord } from "./_parse.ts";

export const SUBAGENT_YIELD_TOOL_NAME = "yield";

export type SubagentYieldStatus = "completed" | "blocked" | "failed";

export interface SubagentYieldDetails {
  status: SubagentYieldStatus;
  result: string;
  artifacts?: string[];
}

const YIELD_STATUSES = new Set<SubagentYieldStatus>([
  "completed",
  "blocked",
  "failed",
]);
const MAX_YIELD_ARTIFACTS = 20;
const MAX_YIELD_ARTIFACT_LENGTH = 4096;

export interface SubagentYieldTarget {
  output: string;
  stopReason?: string;
  errorMessage?: string;
  yieldStatus?: SubagentYieldStatus;
  yieldArtifacts?: string[];
}

export function includeSubagentYieldTool(tools: readonly string[]): string[] {
  return [...new Set([...tools, SUBAGENT_YIELD_TOOL_NAME])];
}

/** Structured yield carried by a `yield` tool result; undefined for any other or malformed message. */
export function subagentYieldFromMessage(
  message: ChildMessage | undefined,
): SubagentYieldDetails | undefined {
  if (
    message?.role !== "toolResult" ||
    message.toolName !== SUBAGENT_YIELD_TOOL_NAME ||
    !isPlainRecord(message.details)
  )
    return undefined;

  const details = message.details;
  const status = details.status;
  if (
    !YIELD_STATUSES.has(status as SubagentYieldStatus) ||
    typeof details.result !== "string"
  ) {
    return undefined;
  }
  if (
    details.artifacts !== undefined &&
    (!Array.isArray(details.artifacts) ||
      details.artifacts.length > MAX_YIELD_ARTIFACTS ||
      details.artifacts.some(
        (artifact) =>
          typeof artifact !== "string" ||
          artifact.length > MAX_YIELD_ARTIFACT_LENGTH,
      ))
  ) {
    return undefined;
  }
  const artifacts = details.artifacts as string[] | undefined;
  return {
    status: status as SubagentYieldStatus,
    result: details.result,
    ...(artifacts ? { artifacts } : {}),
  };
}

export function applySubagentYield(
  target: SubagentYieldTarget,
  message: ChildMessage,
): boolean {
  const yielded = subagentYieldFromMessage(message);
  if (!yielded) return false;
  target.output = yielded.result;
  target.yieldStatus = yielded.status;
  if (yielded.artifacts) target.yieldArtifacts = yielded.artifacts;
  target.stopReason = yielded.status === "completed" ? "end" : yielded.status;
  if (yielded.status === "completed") delete target.errorMessage;
  else target.errorMessage = yielded.result;
  return true;
}

/** Who the yield ends: a one-shot delegated task or one assignment of a reusable managed worker. */
export type SubagentYieldScope = "delegatedTask" | "managedAssignment";

const YIELD_TOOL_COPY: Record<
  SubagentYieldScope,
  {
    readonly description: string;
    readonly promptSnippet: string;
    readonly promptGuidelines: readonly string[];
    readonly statusDescription: string;
    readonly resultDescription: string;
    readonly resultText: string;
  }
> = {
  delegatedTask: {
    description:
      "Return the delegated task's final structured result and stop immediately. Use exactly once as the final action.",
    promptSnippet:
      "Yield a final structured delegated-task result and terminate",
    promptGuidelines: [
      "Use yield exactly once as your final action after delegated work is complete or cannot continue.",
      "Set status to completed only when the requested work is complete; use blocked when external input or access is required, and failed when the work could not be completed.",
      "Put the complete concise handoff in result and include only useful artifact paths.",
    ],
    statusDescription: "Outcome of the delegated task",
    resultDescription: "Complete concise result returned to the parent agent",
    resultText: "Yielded delegated task",
  },
  managedAssignment: {
    description:
      "Return the current managed assignment's structured result. Ends this assignment only; the worker stays available for later assignments.",
    promptSnippet: "Yield the current managed assignment's structured result",
    promptGuidelines: [
      "Use yield exactly once per managed assignment, as the final action for that assignment.",
      "Set status to completed only when the assignment is complete; use blocked when external input or access is required, and failed when it could not be completed.",
      "Put the complete concise handoff in result and include only useful artifact paths.",
    ],
    statusDescription: "Outcome of the current assignment",
    resultDescription: "Complete concise result for the parent agent",
    resultText: "Yielded managed assignment",
  },
};

export function registerSubagentYield(
  pi: ExtensionAPI,
  scope: SubagentYieldScope = "delegatedTask",
): void {
  const copy = YIELD_TOOL_COPY[scope];
  pi.registerTool({
    name: SUBAGENT_YIELD_TOOL_NAME,
    label: "Yield",
    description: copy.description,
    promptSnippet: copy.promptSnippet,
    promptGuidelines: [...copy.promptGuidelines],
    parameters: Type.Object({
      status: StringEnum(["completed", "blocked", "failed"] as const, {
        description: copy.statusDescription,
      }),
      result: Type.String({
        description: copy.resultDescription,
      }),
      artifacts: Type.Optional(
        Type.Array(Type.String({ maxLength: MAX_YIELD_ARTIFACT_LENGTH }), {
          description: "Optional paths to useful files or artifacts",
          maxItems: MAX_YIELD_ARTIFACTS,
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      const details: SubagentYieldDetails = {
        status: params.status,
        result: params.result,
        ...(params.artifacts ? { artifacts: params.artifacts } : {}),
      };
      return {
        content: [
          { type: "text", text: `${copy.resultText}: ${params.status}` },
        ],
        details,
        terminate: true,
      };
    },
  });
}
