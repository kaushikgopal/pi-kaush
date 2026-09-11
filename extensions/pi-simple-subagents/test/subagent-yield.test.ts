import { describe, expect, test, vi } from "vitest";
vi.mock("@earendil-works/pi-coding-agent", async () => {
	const { createPiCodingAgentMock } = await import("./pi-coding-agent.mock");
	return createPiCodingAgentMock();
});
vi.mock("@earendil-works/pi-ai", async () => {
	const { createPiAiMock } = await import("./pi-mocks");
	return createPiAiMock();
});
vi.mock("@earendil-works/pi-tui", async () => {
	const { createPiTuiMock } = await import("./pi-mocks");
	return createPiTuiMock();
});
vi.mock("typebox", async () => {
	const { createTypeboxMock } = await import("./pi-mocks");
	return createTypeboxMock();
});

const {
	applySubagentYield,
	includeSubagentYieldTool,
	registerSubagentYield,
	subagentYieldFromMessage,
} = await import("../src/_yield");

function yieldMessage(status: "completed" | "blocked" | "failed", result = "finished", artifacts?: string[]) {
	return {
		role: "toolResult",
		toolName: "yield",
		details: { status, result, artifacts },
	};
}

describe("structured subagent yield", () => {
	test("registers a terminating tool with the minimal structured schema", async () => {
		let tool: any;
		registerSubagentYield({ registerTool: (definition: unknown) => (tool = definition) } as any);

		expect(tool.name).toBe("yield");
		expect(tool.parameters.properties.status.enum).toEqual(["completed", "blocked", "failed"]);
		expect(tool.parameters.properties.artifacts.maxItems).toBe(20);

		const result = await tool.execute("call", {
			status: "completed",
			result: "implemented the fix",
			artifacts: ["src/fix.ts"],
		});
		expect(result.terminate).toBe(true);
		expect(result.details).toEqual({
			status: "completed",
			result: "implemented the fix",
			artifacts: ["src/fix.ts"],
		});
	});

	test("applies completed, blocked, and failed outcomes to the parent result", () => {
		const completed = { output: "old", stopReason: "toolUse", errorMessage: "old error" };
		expect(applySubagentYield(completed, yieldMessage("completed", "done", ["result.txt"]))).toBe(true);
		expect(completed).toEqual({
			output: "done",
			stopReason: "end",
			errorMessage: undefined,
			yieldStatus: "completed",
			yieldArtifacts: ["result.txt"],
		});

		for (const status of ["blocked", "failed"] as const) {
			const target = { output: "" };
			expect(applySubagentYield(target, yieldMessage(status, `${status} result`))).toBe(true);
			expect(target).toMatchObject({
				output: `${status} result`,
				stopReason: status,
				errorMessage: `${status} result`,
				yieldStatus: status,
			});
		}
	});

	test("ignores malformed or unrelated tool results", () => {
		expect(subagentYieldFromMessage({ role: "toolResult", toolName: "read", details: {} })).toBeUndefined();
		expect(
			subagentYieldFromMessage({
				role: "toolResult",
				toolName: "yield",
				details: { status: "unknown", result: "bad" },
			}),
		).toBeUndefined();
		expect(subagentYieldFromMessage(yieldMessage("completed", "ok", new Array(21).fill("file")))).toBeUndefined();
	});

	test("adds yield to explicit child tool allowlists without duplicates", () => {
		expect(includeSubagentYieldTool(["read", "edit"])).toEqual(["read", "edit", "yield"]);
		expect(includeSubagentYieldTool(["read", "yield"])).toEqual(["read", "yield"]);
	});
});
