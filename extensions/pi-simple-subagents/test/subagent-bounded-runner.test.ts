import { describe, expect, test, vi } from "vitest";
vi.mock("@earendil-works/pi-coding-agent", async () => {
  const { createPiCodingAgentMock } = await import("./pi-coding-agent.mock.ts");
  return createPiCodingAgentMock();
});

import type { AgentConfig } from "../src/_definition.ts";
import {
  buildChildArgs,
  isActiveResult,
  isFailedResult,
  parsePersistedResult,
  type SingleResult,
  toPersistedResult,
} from "../src/_bounded-runner.ts";
import { emptyUsage } from "../src/_usage.ts";

const agent: AgentConfig = {
  name: "bee",
  description: "General worker.",
  tools: ["read", "bash"],
  systemPrompt: "Work.",
  source: "user",
  filePath: "/agents/bee.md",
};

function result(overrides: Partial<SingleResult> = {}): SingleResult {
  return {
    agent: "bee",
    agentSource: "user",
    task: "do it",
    status: { kind: "exited", code: 0 },
    messages: [],
    output: "",
    stderr: "",
    usage: emptyUsage(),
    ...overrides,
  };
}

describe("buildChildArgs", () => {
  test("orders session, isolation, model, tools, depth guard, prompt, and task", () => {
    expect(
      buildChildArgs({
        agent,
        task: "do it",
        requestedModel: "provider/model",
        isolation: { noExtensions: true, noMcp: true },
        promptPath: "/tmp/prompt.md",
        depth: 2,
        limits: { persistChildSessions: true, maxDepth: 2 },
        extensionEntrypoint: "/pkg/src/index.ts",
      }),
    ).toEqual([
      "--mode",
      "json",
      "-p",
      "--name",
      "subagent(bee): do it",
      "--no-extensions",
      "--extension",
      "/pkg/src/index.ts",
      "--no-mcp",
      "--model",
      "provider/model",
      "--tools",
      "read,bash,yield",
      "--exclude-tools",
      "subagent",
      "--append-system-prompt",
      "/tmp/prompt.md",
      "Task: do it",
    ]);
  });

  test("an invocation tool override replaces agent tools; shallow children keep subagent", () => {
    expect(
      buildChildArgs({
        agent,
        task: "t",
        tools: ["grep"],
        promptPath: "/p",
        depth: 1,
        limits: { persistChildSessions: false, maxDepth: 2 },
      }),
    ).toEqual([
      "--mode",
      "json",
      "-p",
      "--no-session",
      "--tools",
      "grep,yield",
      "--append-system-prompt",
      "/p",
      "Task: t",
    ]);
  });
});

describe("result status", () => {
  test("failure and activity derive from the lifecycle status", () => {
    expect(isFailedResult(result())).toBe(false);
    expect(
      isFailedResult(result({ status: { kind: "exited", code: 2 } })),
    ).toBe(true);
    expect(
      isFailedResult(result({ status: { kind: "rejected", reason: "full" } })),
    ).toBe(true);
    expect(
      isFailedResult(
        result({ status: { kind: "timedOut", reason: "runtime" } }),
      ),
    ).toBe(true);
    expect(
      isFailedResult(result({ status: { kind: "aborted", cause: "abort" } })),
    ).toBe(true);
    expect(isFailedResult(result({ yieldStatus: "blocked" }))).toBe(true);
    expect(isActiveResult(result({ status: { kind: "pending" } }))).toBe(true);
    expect(isActiveResult(result({ status: { kind: "running" } }))).toBe(true);
    expect(isActiveResult(result())).toBe(false);
  });

  test("persisted results round-trip the status", () => {
    const persisted = toPersistedResult(
      result({ status: { kind: "timedOut", reason: "inactivity" } }),
    );
    expect(persisted).not.toHaveProperty("exitCode");
    expect(parsePersistedResult(JSON.parse(JSON.stringify(persisted)))).toEqual(
      persisted,
    );
  });

  test("results persisted before status existed still parse", () => {
    const legacy = (fields: Record<string, unknown>) =>
      parsePersistedResult({
        agent: "bee",
        agentSource: "user",
        task: "t",
        messages: [],
        output: "",
        stderr: "",
        usage: emptyUsage(),
        ...fields,
      });
    expect(legacy({ exitCode: -1 })?.status).toEqual({ kind: "pending" });
    expect(legacy({ exitCode: 0 })?.status).toEqual({
      kind: "exited",
      code: 0,
    });
    expect(legacy({ exitCode: 3 })?.status).toEqual({
      kind: "exited",
      code: 3,
    });
    expect(
      legacy({ exitCode: 1, spawnBlocked: true, errorMessage: "closed" })
        ?.status,
    ).toEqual({ kind: "rejected", reason: "closed" });
    expect(legacy({ exitCode: 1, executionTimedOut: true })?.status).toEqual({
      kind: "timedOut",
    });
    const parsed = legacy({ exitCode: 1, spawnBlocked: true });
    expect(parsed).not.toHaveProperty("spawnBlocked");
    expect(parsed).not.toHaveProperty("exitCode");
    expect(parsePersistedResult("not a result")).toBeUndefined();
  });
});
