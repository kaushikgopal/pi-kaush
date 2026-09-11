import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
	HARD_MAX_CHILDREN_PER_CALL,
	HARD_MAX_CHILD_EXECUTION_MS,
	HARD_MAX_CONCURRENCY_PER_SESSION,
	HARD_MAX_DELEGATION_DEPTH,
	loadSubagentLimits,
	parseSubagentLimits,
} from "../src/_limits";

const limitsPath = join(import.meta.dirname, "../src/limits.json");

describe("subagent limits", () => {
	test("loads bounded concurrent defaults", () => {
		const limits = loadSubagentLimits(limitsPath);

		expect(limits).toEqual({
			version: 1,
			maxDepth: 2,
			maxChildrenPerCall: 5,
			maxConcurrency: 5,
			maxRuntimeMs: 7_200_000,
			maxInactivityMs: 900_000,
			persistChildSessions: true,
		});
		expect(HARD_MAX_DELEGATION_DEPTH).toBe(2);
		expect(HARD_MAX_CHILDREN_PER_CALL).toBe(5);
		expect(HARD_MAX_CONCURRENCY_PER_SESSION).toBe(5);
	});

	test("allows configuration to lower but not exceed the hard ceilings", () => {
		expect(
			parseSubagentLimits({
				version: 1,
				maxDepth: 1,
				maxChildrenPerCall: 3,
				maxConcurrency: 2,
				maxRuntimeMs: 0,
				maxInactivityMs: 60_000,
			}),
		).toEqual({
			version: 1,
			maxDepth: 1,
			maxChildrenPerCall: 3,
			maxConcurrency: 2,
			maxRuntimeMs: 0,
			maxInactivityMs: 60_000,
			persistChildSessions: true,
		});

		expect(() =>
			parseSubagentLimits({
				version: 1,
				maxDepth: 3,
				maxChildrenPerCall: 5,
				maxConcurrency: 5,
			}),
		).toThrow("maxDepth");
		expect(() =>
			parseSubagentLimits({
				version: 1,
				maxDepth: 2,
				maxChildrenPerCall: 6,
				maxConcurrency: 5,
			}),
		).toThrow("maxChildrenPerCall");
		expect(() =>
			parseSubagentLimits({
				version: 1,
				maxDepth: 2,
				maxChildrenPerCall: 3,
				maxConcurrency: 6,
			}),
		).toThrow("maxConcurrency");
		expect(() =>
			parseSubagentLimits({
				version: 1,
				maxDepth: 2,
				maxChildrenPerCall: 5,
				maxConcurrency: 5,
				maxRuntimeMs: HARD_MAX_CHILD_EXECUTION_MS + 1,
				maxInactivityMs: 0,
			}),
		).toThrow("maxRuntimeMs");
	});

	test("persists child sessions by default and validates the override", () => {
		expect(
			parseSubagentLimits({
				version: 1,
				maxDepth: 2,
				maxChildrenPerCall: 5,
				maxConcurrency: 5,
				maxRuntimeMs: 0,
				maxInactivityMs: 0,
				persistChildSessions: false,
			}),
		).toMatchObject({ persistChildSessions: false });

		expect(() =>
			parseSubagentLimits({
				version: 1,
				maxDepth: 2,
				maxChildrenPerCall: 5,
				maxConcurrency: 5,
				maxRuntimeMs: 0,
				maxInactivityMs: 0,
				persistChildSessions: "yes",
			}),
		).toThrow("persistChildSessions");
	});

	test("accepts the former maxChildrenPerSession key as a configuration fallback", () => {
		expect(
			parseSubagentLimits({
				version: 1,
				maxDepth: 2,
				maxChildrenPerSession: 4,
				maxConcurrency: 3,
				maxRuntimeMs: 0,
				maxInactivityMs: 0,
			}),
		).toMatchObject({ maxChildrenPerCall: 4, maxConcurrency: 3 });
	});
});
