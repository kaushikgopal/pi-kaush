import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

export const SUBAGENT_YIELD_TOOL_NAME = "yield";

export type SubagentYieldStatus = "completed" | "blocked" | "failed";

export interface SubagentYieldDetails {
	status: SubagentYieldStatus;
	result: string;
	artifacts?: string[];
}

const YIELD_STATUSES = new Set<SubagentYieldStatus>(["completed", "blocked", "failed"]);
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

export function subagentYieldFromMessage(message: unknown): SubagentYieldDetails | undefined {
	if (!message || typeof message !== "object") return undefined;
	const candidate = message as { role?: unknown; toolName?: unknown; details?: unknown };
	if (candidate.role !== "toolResult" || candidate.toolName !== SUBAGENT_YIELD_TOOL_NAME) return undefined;
	if (!candidate.details || typeof candidate.details !== "object") return undefined;

	const details = candidate.details as { status?: unknown; result?: unknown; artifacts?: unknown };
	if (!YIELD_STATUSES.has(details.status as SubagentYieldStatus) || typeof details.result !== "string") {
		return undefined;
	}
	if (
		details.artifacts !== undefined &&
		(!Array.isArray(details.artifacts) ||
			details.artifacts.length > MAX_YIELD_ARTIFACTS ||
			details.artifacts.some(
				(artifact) => typeof artifact !== "string" || artifact.length > MAX_YIELD_ARTIFACT_LENGTH,
			))
	) {
		return undefined;
	}
	return {
		status: details.status as SubagentYieldStatus,
		result: details.result,
		artifacts: details.artifacts as string[] | undefined,
	};
}

export function applySubagentYield(target: SubagentYieldTarget, message: unknown): boolean {
	const yielded = subagentYieldFromMessage(message);
	if (!yielded) return false;
	target.output = yielded.result;
	target.yieldStatus = yielded.status;
	target.yieldArtifacts = yielded.artifacts;
	target.stopReason = yielded.status === "completed" ? "end" : yielded.status;
	target.errorMessage = yielded.status === "completed" ? undefined : yielded.result;
	return true;
}

export function registerSubagentYield(pi: ExtensionAPI): void {
	pi.registerTool({
		name: SUBAGENT_YIELD_TOOL_NAME,
		label: "Yield",
		description:
			"Return the delegated task's final structured result and stop immediately. Use exactly once as the final action.",
		promptSnippet: "Yield a final structured delegated-task result and terminate",
		promptGuidelines: [
			"Use yield exactly once as your final action after delegated work is complete or cannot continue.",
			"Set status to completed only when the requested work is complete; use blocked when external input or access is required, and failed when the work could not be completed.",
			"Put the complete concise handoff in result and include only useful artifact paths.",
		],
		parameters: Type.Object({
			status: StringEnum(["completed", "blocked", "failed"] as const, {
				description: "Outcome of the delegated task",
			}),
			result: Type.String({ description: "Complete concise result returned to the parent agent" }),
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
				artifacts: params.artifacts,
			};
			return {
				content: [{ type: "text", text: `Yielded delegated task: ${params.status}` }],
				details,
				terminate: true,
			};
		},
	});
}
