import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
	formatProfileCandidate,
	formatProfileGuidance,
	loadSubagentProfiles,
	parseSubagentProfiles,
	formatProfileAttemptSummaries,
	formatProfileEligibilityError,
	loadSubagentProfilesCurrent,
} from "../src/_profiles";

	// The schema template lives beside the runtime file outside this repo
	// (canonical: @pi-kaush/pi-model-profiles), so tests run against a
	// checked-in fixture instead of a machine-local file.
	const FIXTURE_YAML = `version: 1
profiles:
  quick:
    description: Fast, low-cost execution for straightforward, low-risk tasks.
    candidates:
      - model: openai-codex/gpt-5.6-luna
        thinkingLevel: minimal
  coder:
    description: Fast, coding-specialized execution for bounded implementation and test tasks.
    candidates:
      - model: openrouter/moonshotai/kimi-k2.7-code
  default:
    description: Default profile for normal bounded engineering work.
    candidates:
      - model: openrouter/z-ai/glm-5.3-flash
  thinker:
    description: High-effort reasoning for ambiguous debugging, design, and complex implementation.
    candidates:
      - model: openrouter/anthropic/claude-opus-4.8
        thinkingLevel: xhigh
  deep-thinker:
    description: Maximum reasoning for rare, high-stakes, or exceptionally difficult tasks.
    candidates:
      - model: openrouter/anthropic/claude-fable-5
        thinkingLevel: xhigh
`;

describe("subagent profiles", () => {
	test("loads the configured profile ladder in stable order", () => {
		const dir = mkdtempSync(join(tmpdir(), "subagent-profiles-order-"));
		try {
			writeFileSync(join(dir, "profiles.yaml"), FIXTURE_YAML, "utf8");
			const config = loadSubagentProfiles(join(dir, "profiles.yaml"));

		expect(Object.keys(config.profiles)).toEqual([
			"quick",
			"coder",
			"default",
			"thinker",
			"deep-thinker",
		]);
		// The template keeps one illustrative candidate per profile.
		expect(config.profiles["quick"].candidates).toHaveLength(1);
		expect(config.profiles["coder"].candidates).toHaveLength(1);
		expect(config.profiles["default"].candidates).toHaveLength(1);
		expect(config.profiles["thinker"].candidates).toHaveLength(1);
		expect(config.profiles["deep-thinker"].candidates).toHaveLength(1);
		expect(formatProfileCandidate(config.profiles["quick"].candidates[0])).toBe(
			"openai-codex/gpt-5.6-luna:minimal",
		);
		expect(formatProfileCandidate(config.profiles["coder"].candidates[0])).toBe(
			"openrouter/moonshotai/kimi-k2.7-code",
		);
		expect(formatProfileCandidate(config.profiles["default"].candidates[0])).toBe(
			"openrouter/z-ai/glm-5.3-flash",
		);
		expect(formatProfileCandidate(config.profiles["thinker"].candidates[0])).toBe(
			"openrouter/anthropic/claude-opus-4.8:xhigh",
		);
		expect(formatProfileCandidate(config.profiles["deep-thinker"].candidates[0])).toBe(
			"openrouter/anthropic/claude-fable-5:xhigh",
		);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("builds concise guidance for the tool schema", () => {
		const dir = mkdtempSync(join(tmpdir(), "subagent-profiles-guidance-"));
		let guidance: string;
		try {
			writeFileSync(join(dir, "profiles.yaml"), FIXTURE_YAML, "utf8");
			guidance = formatProfileGuidance(loadSubagentProfiles(join(dir, "profiles.yaml")));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}

		expect(guidance).toContain("quick: Fast, low-cost execution");
		expect(guidance).toContain("coder: Fast, coding-specialized execution");
		expect(guidance).toContain("default: Default profile");
		expect(guidance).toContain("thinker: High-effort reasoning");
		expect(guidance).toContain("deep-thinker: Maximum reasoning");
		expect(guidance).not.toContain("tank:");
	});

	test("rejects malformed or duplicate profile candidates", () => {
		expect(() =>
			parseSubagentProfiles({
				version: 1,
				profiles: {
					"Bad Name": {
						description: "bad",
						candidates: [{ model: "provider/model" }],
					},
				},
			}),
		).toThrow("lowercase kebab-case");

		expect(() =>
			parseSubagentProfiles({
				version: 1,
				profiles: {
					standard: {
						description: "default",
						candidates: [{ model: "provider/model" }, { model: "provider/model", thinkingLevel: "high" }],
					},
				},
			}),
		).toThrow('repeats model "provider/model"');
	});
});

describe("profiles reload", () => {
	function writeProfiles(filePath: string, modelCount: number): void {
		const candidates = Array.from({ length: modelCount }, (_, i) => ({
			model: `test-provider/model-${i + 1}`,
		}));
		const doc = {
			version: 1,
			profiles: {
				coder: { description: "Coding ladder.", candidates },
			},
		};
		writeFileSync(filePath, JSON.stringify(doc), "utf8");
		// Force a distinct mtime even on coarse-grained filesystems.
		utimesSync(filePath, new Date(), new Date(Date.now() + modelCount * 1000));
	}

	test("reloads profiles when the source file changes mid-session", () => {
		const dir = mkdtempSync(join(tmpdir(), "subagent-profiles-reload-"));
		const file = join(dir, "profiles.yaml");
		try {
			writeProfiles(file, 2);
			const first = loadSubagentProfilesCurrent(file);
			expect(first.config.profiles.coder.candidates).toHaveLength(2);

			// Simulates the reported bug: the ladder gains a primary candidate
			// while the parent session is still running.
			writeProfiles(file, 3);
			const second = loadSubagentProfilesCurrent(file, first);
			expect(second.config.profiles.coder.candidates).toHaveLength(3);
			expect(second.config.profiles.coder.candidates[0]?.model).toBe("test-provider/model-1");

			// Unchanged file serves the cached snapshot without re-parsing.
			const third = loadSubagentProfilesCurrent(file, second);
			expect(third).toBe(second);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("propagates parse errors instead of serving a stale snapshot", () => {
		const dir = mkdtempSync(join(tmpdir(), "subagent-profiles-broken-"));
		const file = join(dir, "profiles.yaml");
		try {
			writeProfiles(file, 1);
			const loaded = loadSubagentProfilesCurrent(file);
			writeFileSync(file, "{ this is not valid yaml: [", "utf8");
			utimesSync(file, new Date(), new Date(Date.now() + 5000));
			expect(() => loadSubagentProfilesCurrent(file, loaded)).toThrow(/model profiles/i);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("profile diagnostics", () => {
	test("eligibility error lists every configured candidate with its reason", () => {
		const message = formatProfileEligibilityError(
			"coder",
			[
				{ model: "open-weights/glm-flash-latest", thinkingLevel: "max" },
				{ model: "open-weights/kimi-code-latest" },
			],
			new Set(["other-provider/other"]),
			12,
		);
		expect(message).toContain('Profile "coder" has no eligible candidate models (0 of 2');
		expect(message).toContain("12 models in scope");
		expect(message).toContain("- open-weights/glm-flash-latest:max: not in the current delegation model scope");
		expect(message).toContain("- open-weights/kimi-code-latest: not in the current delegation model scope");
	});

	test("eligibility error marks eligible candidates distinctly", () => {
		const message = formatProfileEligibilityError(
			"coder",
			[{ model: "open-weights/glm-flash-latest" }],
			new Set(["open-weights/glm-flash-latest"]),
		);
		expect(message).toContain("- open-weights/glm-flash-latest: eligible");
		expect(message).not.toContain("12 models in scope");
	});

	test("attempt summaries report each candidate and bounded reason", () => {
		const message = formatProfileAttemptSummaries("coder", [
			{ requestedModel: "open-weights/glm-flash-latest", exitCode: 1, errorMessage: "  provider auth missing\nfor key  " },
			{ model: "open-weights/kimi-code-latest", exitCode: 0, errorMessage: undefined },
		]);
		expect(message).toContain('Profile "coder" exhausted 2 candidate(s).');
		expect(message).toContain("open-weights/glm-flash-latest — provider auth missing for key");
		expect(message).toContain("open-weights/kimi-code-latest — exit code 0");
	});

	test("attempt summaries bound very long failure text", () => {
		const message = formatProfileAttemptSummaries("coder", [
			{ model: "a/b", exitCode: 1, errorMessage: "x".repeat(500) },
		]);
		expect(message.length).toBeLessThan(260);
		expect(message).toContain("...");
	});
});
