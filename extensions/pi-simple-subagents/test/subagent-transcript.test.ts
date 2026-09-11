import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import {
	appendBoundedJsonValue,
	createTranscriptArtifact,
	resolveSessionFilePath,
	truncateUtf8Head,
	truncateUtf8Tail,
} from "../src/_transcript";

const metadata = {
	rootSessionId: "root/session:private",
	parentSessionId: "parent-session",
	parentToolCallId: "tool-call",
	depth: 1,
	agent: "bee",
	task: "diagnose a private failure",
};

describe("subagent transcript artifacts", () => {
	test("writes complete private stdout and stderr JSONL records with an opaque filename", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "subagent-transcript-"));
		try {
			const artifact = createTranscriptArtifact(agentDir, metadata);
			expect(artifact.error).toBeUndefined();
			expect(typeof artifact.path).toBe("string");
			expect(basename(artifact.path!)).not.toContain("diagnose");

			const largeDiagnostic = "nested transcript ".repeat(8_000);
			artifact.append("stdout", '{"type":"message_end"}\n');
			artifact.append("stderr", "warning: full diagnostic\n");
			artifact.append("stdout", largeDiagnostic);
			await artifact.close(7);
			await artifact.close(7);

			const records = readFileSync(artifact.path!, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			expect(records[0]).toMatchObject({ record: "header", version: 1, ...metadata });
			expect(records[1]).toMatchObject({ record: "stream", stream: "stdout", data: '{"type":"message_end"}\n' });
			expect(records[2]).toMatchObject({ record: "stream", stream: "stderr", data: "warning: full diagnostic\n" });
			expect(records[3]).toMatchObject({ record: "stream", stream: "stdout", data: largeDiagnostic });
			expect(records[4]).toMatchObject({ record: "footer", exitCode: 7 });
			expect(statSync(artifact.path!).mode & 0o777).toBe(0o600);
			expect(statSync(dirname(artifact.path!)).mode & 0o777).toBe(0o700);
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	test("reports artifact creation failures without throwing", () => {
		const root = mkdtempSync(join(tmpdir(), "subagent-transcript-error-"));
		const notDirectory = join(root, "agent-file");
		writeFileSync(notDirectory, "occupied");
		try {
			const artifact = createTranscriptArtifact(notDirectory, metadata);
			expect(artifact.path).toBeUndefined();
			expect(typeof artifact.error).toBe("string");
			expect(artifact.append("stdout", "still safe")).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("keeps recent JSON values within the configured byte cap", () => {
		const values: Array<{ id: number; text: string }> = [];
		expect(appendBoundedJsonValue(values, { id: 1, text: "a".repeat(20) }, 80)).toBe(false);
		expect(appendBoundedJsonValue(values, { id: 2, text: "b".repeat(20) }, 80)).toBe(false);
		expect(appendBoundedJsonValue(values, { id: 3, text: "c".repeat(20) }, 80)).toBe(true);
		expect(values.at(-1)?.id).toBe(3);
		expect(Buffer.byteLength(values.map((value) => JSON.stringify(value)).join(""), "utf8")).toBeLessThanOrEqual(80);

		const beforeOversized = [...values];
		expect(appendBoundedJsonValue(values, { id: 4, text: "x".repeat(100) }, 80)).toBe(true);
		expect(values).toEqual(beforeOversized);
	});

	test("truncates UTF-8 previews without splitting characters", () => {
		expect(truncateUtf8Head("a🙂b", 5)).toEqual({ value: "a🙂", truncated: true });
		expect(truncateUtf8Tail("a🙂b", 5)).toEqual({ value: "🙂b", truncated: true });
		expect(truncateUtf8Head("short", 20)).toEqual({ value: "short", truncated: false });
	});
});

describe("child session file resolution", () => {
	const sessionId = "0123abcd-4567-7890-abcd-ef0123456789";

	function writeChildSession(agentDir: string, cwd: string): string {
		const canonical = realpathSync(cwd);
		const bucket = join(
			agentDir,
			"sessions",
			`--${canonical.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`,
		);
		mkdirSync(bucket, { recursive: true });
		const file = join(bucket, `2026-09-11T00-00-00-000Z_${sessionId}.jsonl`);
		writeFileSync(file, '{"type":"session"}\n');
		return file;
	}

	test("resolves by the encoded child cwd bucket", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "subagent-sessions-"));
		const cwd = mkdtempSync(join(tmpdir(), "subagent-child-cwd-"));
		try {
			const file = writeChildSession(agentDir, cwd);
			expect(resolveSessionFilePath(agentDir, cwd, sessionId)).toBe(file);
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("falls back to scanning all buckets when the cwd does not match", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "subagent-sessions-"));
		const cwd = mkdtempSync(join(tmpdir(), "subagent-child-cwd-"));
		try {
			const file = writeChildSession(agentDir, cwd);
			const movedCwd = join(cwd, "does", "not", "exist");
			expect(resolveSessionFilePath(agentDir, movedCwd, sessionId)).toBe(file);
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("returns undefined when no session file matches", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "subagent-sessions-"));
		const cwd = mkdtempSync(join(tmpdir(), "subagent-child-cwd-"));
		try {
			expect(resolveSessionFilePath(agentDir, cwd, sessionId)).toBeUndefined();
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
