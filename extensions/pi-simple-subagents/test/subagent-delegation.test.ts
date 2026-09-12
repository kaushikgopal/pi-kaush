import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import {
  buildChildSessionName,
  buildDelegatedSystemPrompt,
  buildSubagentEnvironment,
  buildSharedTaskPrompt,
  createDelegationTrace,
  hasDelegatedToolActivity,
  createModelResolver,
  delegationModelCandidates,
  resolveRequestedModel,
  resolveModelReference,
  sessionIdFromJsonEvent,
} from "../src/_delegation.ts";
import {
  formatAgentDisplayName,
  formatProfileDisplayName,
  resolveAgentDisplayName,
} from "../src/_display.ts";
import type { SubagentLimitsConfig } from "../src/_limits.ts";
const limits: SubagentLimitsConfig = {
  version: 1,
  maxDepth: 2,
  maxChildrenPerCall: 5,
  maxConcurrency: 5,
  maxRuntimeMs: 7_200_000,
  maxInactivityMs: 900_000,
  persistChildSessions: true,
};

vi.mock("@earendil-works/pi-coding-agent", async () => {
  const { createPiCodingAgentMock } = await import("./pi-coding-agent.mock.ts");
  return createPiCodingAgentMock();
});

const { discoverAgents, shouldConfirmProjectAgent } = await import(
  "../src/_definition.ts"
);

describe("agent display names", () => {
  test("keeps a stable name while adding optional emoji", () => {
    expect(formatAgentDisplayName({ name: "bee", emoji: "🐝" })).toBe("🐝 bee");
    expect(formatAgentDisplayName({ name: "reviewer" })).toBe("reviewer");
  });

  test("resolves configured emoji and preserves unknown names", () => {
    const agents = [{ name: "lucien", emoji: "📚" }, { name: "reviewer" }];
    expect(resolveAgentDisplayName("lucien", agents)).toBe("📚 lucien");
    expect(resolveAgentDisplayName("reviewer", agents)).toBe("reviewer");
    expect(resolveAgentDisplayName("missing", agents)).toBe("missing");
  });

  test("formats optional profile badges", () => {
    expect(formatProfileDisplayName("deep-reasoner")).toBe("[deep-reasoner]");
    expect(formatProfileDisplayName("  ")).toBe("");
    expect(formatProfileDisplayName(undefined)).toBe("");
  });
});

describe("subagent model selection", () => {
  test("prefers an invocation model over the agent default", () => {
    expect(
      resolveRequestedModel(
        "provider/task-model:high",
        "provider/default-model",
      ),
    ).toBe("provider/task-model:high");
    expect(resolveRequestedModel("  ", "provider/default-model")).toBe(
      "provider/default-model",
    );
    expect(resolveRequestedModel()).toBeUndefined();
  });

  test("resolves a bare model id or display name to the first available match", () => {
    const available = [
      { provider: "provider-a", id: "gpt-5.6-luna", name: "GPT-5.6 Luna" },
      { provider: "provider-b", id: "gpt-5.6-luna", name: "GPT-5.6 Luna" },
    ];
    expect(resolveModelReference("gpt-5.6-luna", available)).toBe(
      "provider-a/gpt-5.6-luna",
    );
    expect(resolveModelReference("GPT-5.6 Luna", available)).toBe(
      "provider-a/gpt-5.6-luna",
    );
  });

  test("preserves qualified references and thinking levels", () => {
    const available = [{ provider: "provider-a", id: "gpt-5.6-luna" }];
    expect(resolveModelReference("provider-a/gpt-5.6-luna", available)).toBe(
      "provider-a/gpt-5.6-luna",
    );
    expect(resolveModelReference("gpt-5.6-luna:high", available)).toBe(
      "provider-a/gpt-5.6-luna:high",
    );
    expect(
      resolveModelReference("provider-a/gpt-5.6-luna:high", available),
    ).toBe("provider-a/gpt-5.6-luna:high");
  });

  test("delegation resolves Kimi K3 from the enabled model scope", () => {
    const available = [
      { provider: "huggingface", id: "moonshotai/Kimi-K3", name: "Kimi K3" },
    ];
    const scoped = [
      {
        model: {
          provider: "fireworks-kimi",
          id: "kimi-k3-fast",
          name: "Kimi K3 Fast",
        },
      },
    ];
    const resolveModel = createModelResolver(
      delegationModelCandidates(scoped, available),
    );
    expect(resolveRequestedModel("Kimi K3", undefined, resolveModel)).toBe(
      "fireworks-kimi/kimi-k3-fast",
    );
  });

  test("falls back to the in-scope family member when the exact version is unavailable", () => {
    const available = [
      { provider: "provider-b", id: "glm-5.6", name: "GLM 5.6" },
    ];
    const scoped = [
      {
        model: {
          provider: "provider-a",
          id: "glm-5.2-fast",
          name: "GLM 5.2 Fast",
        },
      },
    ];
    const resolveModel = createModelResolver(
      delegationModelCandidates(scoped, available),
    );
    expect(resolveRequestedModel("GLM 5.6", undefined, resolveModel)).toBe(
      "provider-a/glm-5.2-fast",
    );
  });

  test("serves every available model when the parent scope is empty", () => {
    const available = [
      { provider: "provider-a", id: "glm-5.2-fast", name: "GLM 5.2 Fast" },
      { provider: "provider-b", id: "glm-5.6", name: "GLM 5.6" },
    ];
    const resolveModel = createModelResolver(
      delegationModelCandidates([], available),
    );
    expect(resolveRequestedModel("GLM 5.6", undefined, resolveModel)).toBe(
      "provider-b/glm-5.6",
    );
  });

  test("does not cross model families when the requested version is absent", () => {
    const scoped = [
      {
        model: {
          provider: "provider-a",
          id: "glm-5.2-fast",
          name: "GLM 5.2 Fast",
        },
      },
    ];
    const resolveModel = createModelResolver(
      delegationModelCandidates(scoped, []),
    );
    expect(
      resolveRequestedModel("GPT 5.6", undefined, resolveModel),
    ).toBeUndefined();
  });

  test("picks the nearest available version within a family", () => {
    const scoped = [
      { model: { provider: "zai", id: "glm-5.2-fast", name: "GLM 5.2 Fast" } },
      { model: { provider: "zai", id: "glm-5.8-fast", name: "GLM 5.8 Fast" } },
    ];
    const resolveModel = createModelResolver(
      delegationModelCandidates(scoped, []),
    );
    expect(resolveRequestedModel("glm 5.6", undefined, resolveModel)).toBe(
      "zai/glm-5.8-fast",
    );
    expect(resolveRequestedModel("glm 5.3", undefined, resolveModel)).toBe(
      "zai/glm-5.2-fast",
    );
  });

  test("prefers an exact version over nearby versions in the same family", () => {
    const scoped = [
      { model: { provider: "zai", id: "glm-5.6-fast", name: "GLM 5.6 Fast" } },
      { model: { provider: "zai", id: "glm-5.8-fast", name: "GLM 5.8 Fast" } },
    ];
    const resolveModel = createModelResolver(
      delegationModelCandidates(scoped, []),
    );
    expect(resolveRequestedModel("glm 5.6", undefined, resolveModel)).toBe(
      "zai/glm-5.6-fast",
    );
  });

  test("a brand-only query resolves to the newest same-family candidate", () => {
    const scoped = [
      { model: { provider: "zai", id: "glm-5.2-fast", name: "GLM 5.2 Fast" } },
      { model: { provider: "zai", id: "glm-5.8-fast", name: "GLM 5.8 Fast" } },
    ];
    const resolveModel = createModelResolver(
      delegationModelCandidates(scoped, []),
    );
    expect(resolveRequestedModel("glm", undefined, resolveModel)).toBe(
      "zai/glm-5.8-fast",
    );
  });

  test("a brandless version query does not guess across families", () => {
    const scoped = [
      { model: { provider: "zai", id: "glm-5.2-fast", name: "GLM 5.2 Fast" } },
    ];
    const resolveModel = createModelResolver(
      delegationModelCandidates(scoped, []),
    );
    expect(
      resolveRequestedModel("5.6", undefined, resolveModel),
    ).toBeUndefined();
  });

  test("keeps registry order when multiple providers match", () => {
    const available = [
      { provider: "provider-b", id: "gpt-5.6-luna" },
      { provider: "provider-a", id: "gpt-5.6-luna" },
    ];
    expect(resolveModelReference("gpt-5.6-luna", available)).toBe(
      "provider-b/gpt-5.6-luna",
    );
  });

  test("createModelResolver wires resolveRequestedModel", () => {
    const available = [{ provider: "provider-a", id: "gpt-5.6-luna" }];
    const resolveModel = createModelResolver(available);
    expect(resolveRequestedModel("gpt-5.6-luna", undefined, resolveModel)).toBe(
      "provider-a/gpt-5.6-luna",
    );
    expect(resolveRequestedModel(undefined, "gpt-5.6-luna", resolveModel)).toBe(
      "provider-a/gpt-5.6-luna",
    );
    expect(
      resolveRequestedModel("provider-a/gpt-5.6-luna", undefined, resolveModel),
    ).toBe("provider-a/gpt-5.6-luna");
  });
});

describe("project-agent approval frontmatter", () => {
  test("loads the boolean preference and lets an invocation override it", () => {
    const projectDir = mkdtempSync(join(tmpdir(), "pi-agent-definition-"));
    try {
      const agentsDir = join(projectDir, ".pi", "agents");
      mkdirSync(agentsDir, { recursive: true });
      writeFileSync(
        join(agentsDir, "telly.md"),
        "---\nname: telly\ndescription: TV agent\nconfirmProjectAgents: false\n---\nInstructions\n",
      );

      const agent = discoverAgents(projectDir, "project").agents[0];
      if (!agent) throw new Error("test agent was not discovered");
      expect(agent.confirmProjectAgents).toBe(false);
      expect(shouldConfirmProjectAgent(agent)).toBe(false);
      expect(shouldConfirmProjectAgent(agent, true)).toBe(true);
      expect(shouldConfirmProjectAgent(agent, false)).toBe(false);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test("defaults to confirmation when the preference is absent", () => {
    const agent = {
      name: "example",
      description: "Example agent",
      systemPrompt: "",
      source: "project" as const,
      filePath: "/tmp/example.md",
    };

    expect(shouldConfirmProjectAgent(agent)).toBe(true);
    expect(
      shouldConfirmProjectAgent({ ...agent, confirmProjectAgents: true }),
    ).toBe(true);
    expect(
      shouldConfirmProjectAgent({ ...agent, confirmProjectAgents: false }),
    ).toBe(false);
  });
});

describe("delegation lineage", () => {
  test("starts at depth one and preserves the inherited root", () => {
    const root = createDelegationTrace("main-session", "call-1", {});
    expect(root).toEqual({
      rootSessionId: "main-session",
      parentSessionId: "main-session",
      parentToolCallId: "call-1",
      depth: 1,
    });

    const nested = createDelegationTrace("bee-session", "call-2", {
      PI_SUBAGENT_ROOT_SESSION_ID: "main-session",
      PI_SUBAGENT_DEPTH: "1",
    });
    expect(nested).toEqual({
      rootSessionId: "main-session",
      parentSessionId: "bee-session",
      parentToolCallId: "call-2",
      depth: 2,
    });
    expect(
      createDelegationTrace("bee-session", "call-3", {
        PI_SUBAGENT_DEPTH: "2junk",
      }).depth,
    ).toBe(1);
  });

  test("strips herdr state and passes trace metadata to the child", () => {
    const baseEnv = {
      PATH: "/bin",
      HERDR_ENV: "1",
      HERDR_SOCKET_PATH: "/tmp/herdr.sock",
      HERDR_PANE_ID: "1-1",
      Herdr_Mixed_Case: "enabled",
    };
    const trace = createDelegationTrace("main-session", "call-1", {});
    const childEnv = buildSubagentEnvironment(trace, baseEnv);

    expect(childEnv.PATH).toBe("/bin");
    expect(childEnv.HERDR_ENV).toBeUndefined();
    expect(childEnv.HERDR_SOCKET_PATH).toBeUndefined();
    expect(childEnv.HERDR_PANE_ID).toBeUndefined();
    expect(childEnv.Herdr_Mixed_Case).toBeUndefined();
    expect(childEnv.PI_SUBAGENT_ROOT_SESSION_ID).toBe("main-session");
    expect(childEnv.PI_SUBAGENT_PARENT_SESSION_ID).toBe("main-session");
    expect(childEnv.PI_SUBAGENT_PARENT_TOOL_CALL_ID).toBe("call-1");
    expect(childEnv.PI_SUBAGENT_DEPTH).toBe("1");
    expect(baseEnv.HERDR_ENV).toBe("1");
  });
});

describe("delegated prompt boundary", () => {
  test("allows one bounded subdelegation level and prohibits herdr", () => {
    const trace = createDelegationTrace("main-session", "call-1", {});
    const prompt = buildDelegatedSystemPrompt(
      "Agent-specific instructions.",
      trace,
      limits,
    );

    expect(prompt).toContain("Agent-specific instructions.");
    expect(prompt).toContain("Never invoke or control herdr");
    expect(prompt).toContain("run at most 5 children at once");
    expect(prompt).toContain("delegation depth 1 of the hard maximum 2");
    expect(prompt).toContain('calling the "yield" tool exactly once');
  });

  test("prohibits delegation at the hard maximum depth", () => {
    const trace = createDelegationTrace("bee-session", "call-2", {
      PI_SUBAGENT_DEPTH: "1",
    });
    const prompt = buildDelegatedSystemPrompt("", trace, limits);

    expect(prompt).toContain("Do not invoke Pi subagents");
    expect(prompt).toContain("depth 2 of the hard maximum 2");
  });
});

describe("parallel shared context", () => {
  test("prepends one immutable context block without changing the assigned task", () => {
    expect(
      buildSharedTaskPrompt(
        "Inspect server changes",
        "  Preserve the public API.  ",
      ),
    ).toBe(
      "Shared context:\nPreserve the public API.\n\nAssigned task:\nInspect server changes",
    );
    expect(buildSharedTaskPrompt("Inspect server changes")).toBe(
      "Inspect server changes",
    );
    expect(buildSharedTaskPrompt("Inspect server changes", "   ")).toBe(
      "Inspect server changes",
    );
  });
});

describe("profile fallback safety", () => {
  test("only treats actual delegated tool activity as a side-effect boundary", () => {
    expect(
      hasDelegatedToolActivity([
        { role: "assistant", content: [{ type: "text" }] },
      ]),
    ).toBe(false);
    expect(
      hasDelegatedToolActivity([
        { role: "assistant", content: [{ type: "toolCall" }] },
      ]),
    ).toBe(true);
    expect(
      hasDelegatedToolActivity([{ role: "toolResult", content: [] }]),
    ).toBe(true);
  });
});

describe("child session correlation", () => {
  test("extracts only JSON session header ids", () => {
    expect(
      sessionIdFromJsonEvent({ type: "session", id: "child-session" }),
    ).toBe("child-session");
    expect(
      sessionIdFromJsonEvent({ type: "message_end", id: "entry-id" }),
    ).toBeUndefined();
    expect(sessionIdFromJsonEvent({ type: "session", id: 42 })).toBeUndefined();
  });
});

describe("child session naming", () => {
  test("builds a picker-friendly name from the agent and task preview", () => {
    expect(buildChildSessionName("bee", "fix the flaky auth test")).toBe(
      "subagent(bee): fix the flaky auth test",
    );
  });

  test("collapses whitespace and clips long tasks", () => {
    const longTask = `${"write more tests ".repeat(10)}done`;
    const name = buildChildSessionName(
      "bee",
      `  ${longTask}\nwith\tmessy  whitespace `,
    );
    expect(name.startsWith("subagent(bee): write more tests")).toBe(true);
    expect(name.length).toBeLessThanOrEqual("subagent(bee): ".length + 60);
    expect(name.endsWith("...")).toBe(true);
    expect(name).not.toContain("\n");
  });

  test("handles an empty task without trailing separators", () => {
    expect(buildChildSessionName("bee", "   ")).toBe("subagent(bee)");
  });
});
