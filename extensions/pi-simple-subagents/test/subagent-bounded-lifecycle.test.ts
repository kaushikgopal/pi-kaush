import { EventEmitter } from "node:events";
import { readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  withFileMutationQueue: vi.fn(
    async (_filePath: string, operation: () => Promise<unknown>) => operation(),
  ),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: mocks.spawn };
});
vi.mock("@earendil-works/pi-coding-agent", async () => {
  const { createPiCodingAgentMock } = await import("./pi-coding-agent.mock.ts");
  return {
    ...createPiCodingAgentMock(),
    withFileMutationQueue: mocks.withFileMutationQueue,
  };
});

import type { ModelProfilesConfig } from "@pi-kaush/pi-model-profiles";
import type { AgentConfig } from "../src/_definition.ts";
import { SessionConcurrencyGate } from "../src/_concurrency.ts";
import { SubagentProcessRegistry } from "../src/_process-tree.ts";
import { runBoundedPlan, type RunContext } from "../src/_bounded-runner.ts";

const agent: AgentConfig = {
  name: "bee",
  description: "General worker.",
  tools: ["read"],
  systemPrompt: "Work.",
  source: "user",
  filePath: "/agents/bee.md",
};

function makeRunContext(rootSessionId = "root"): {
  context: RunContext;
  concurrency: SessionConcurrencyGate;
  processes: SubagentProcessRegistry;
} {
  const concurrency = new SessionConcurrencyGate(1);
  const processes = new SubagentProcessRegistry("win32");
  return {
    context: {
      defaultCwd: process.cwd(),
      agents: [agent],
      profiles: {} as ModelProfilesConfig,
      availableModels: new Set(),
      resolveModel: () => undefined,
      trace: {
        rootSessionId,
        parentSessionId: "parent",
        parentToolCallId: "call",
        depth: 1,
      },
      sessionFile: undefined,
      limits: {
        version: 1,
        maxDepth: 2,
        maxChildrenPerCall: 5,
        maxConcurrency: 1,
        maxRuntimeMs: 0,
        maxInactivityMs: 0,
        statusReportAfterMs: 0,
        persistChildSessions: false,
      },
      concurrency,
      processes,
    },
    concurrency,
    processes,
  };
}

function scheduleSuccessfulExit(): void {
  mocks.spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      pid: undefined,
    });
    queueMicrotask(() => {
      child.stdout.end();
      child.stderr.end();
      child.emit("exit", 0, null);
      child.emit("close", 0, null);
    });
    return child;
  });
}

function scheduleUtf8Output(stdoutText: string, stderrText: string): void {
  mocks.spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      pid: undefined,
    });
    queueMicrotask(() => {
      for (const [stream, text] of [
        [child.stdout, stdoutText],
        [child.stderr, stderrText],
      ] as const) {
        const bytes = Buffer.from(text);
        const marker = Buffer.from("🐝");
        const splitAt = bytes.indexOf(marker) + 2;
        stream.write(bytes.subarray(0, splitAt));
        stream.write(bytes.subarray(splitAt));
        stream.end();
      }
      child.emit("exit", 0, null);
      child.emit("close", 0, null);
    });
    return child;
  });
}

beforeEach(() => {
  mocks.spawn.mockReset();
  mocks.withFileMutationQueue
    .mockReset()
    .mockImplementation(async (_filePath, operation) => operation());
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("bounded process admission", () => {
  test("does not spawn after shutdown while it writes the prompt", async () => {
    let enterPromptWrite!: () => void;
    let releasePromptWrite!: () => void;
    const promptWriteEntered = new Promise<void>((resolve) => {
      enterPromptWrite = resolve;
    });
    const promptWriteReleased = new Promise<void>((resolve) => {
      releasePromptWrite = resolve;
    });
    mocks.withFileMutationQueue.mockImplementation(
      async (_filePath, operation) => {
        enterPromptWrite();
        await promptWriteReleased;
        return operation();
      },
    );
    scheduleSuccessfulExit();
    const { context, concurrency, processes } = makeRunContext();
    const run = runBoundedPlan(context, {
      kind: "single",
      item: { agent: "bee", task: "finish the task" },
    });

    await promptWriteEntered;
    await processes.terminateAll();
    releasePromptWrite();

    const outcome = await run;
    if (outcome.kind !== "completed") throw new Error(outcome.message);
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(outcome.results[0]?.status).toEqual({
      kind: "rejected",
      reason: "Subagent did not start because the session is shutting down.",
    });
    expect(concurrency.status.active).toBe(0);
  });
});

describe("bounded child streams", () => {
  test("preserves UTF-8 characters split across child stream chunks", async () => {
    const output = "The child says 🐝 and café.";
    const stdout =
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: output }],
        },
      }) + "\n";
    const stderr = "Warning: café 🐝\n";
    const { context } = makeRunContext(randomUUID());
    scheduleUtf8Output(stdout, stderr);
    let transcriptPath: string | undefined;

    try {
      const outcome = await runBoundedPlan(context, {
        kind: "single",
        item: { agent: "bee", task: "emit Unicode" },
      });
      if (outcome.kind !== "completed") throw new Error(outcome.message);
      const result = outcome.results[0]!;
      transcriptPath = result.transcriptPath;
      expect(result.output).toBe(output);
      expect(result.stderr).toBe(stderr);
      expect(transcriptPath).toBeDefined();
      const records = readFileSync(transcriptPath!, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const streamData = records
        .filter((record) => record.record === "stream")
        .map((record) => record.data as string)
        .join("");
      expect(streamData).toBe(stdout + stderr);
    } finally {
      if (transcriptPath)
        rmSync(dirname(transcriptPath), { recursive: true, force: true });
    }
  });
});
