import { describe, expect, test } from "vitest";
import {
  formatProfileCandidate,
  parseModelProfiles,
} from "@pi-kaush/pi-model-profiles";
import { planProfileAttempts } from "../src/_profile-attempts.ts";
import {
  parseSubagentCall,
  type SubagentCommand,
} from "../src/_subagent-command.ts";

function command(params: Record<string, unknown>): SubagentCommand {
  const parsed = parseSubagentCall(params);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.command;
}

function error(params: Record<string, unknown>): string {
  const parsed = parseSubagentCall(params);
  if (parsed.ok) throw new Error("expected a parse failure");
  return parsed.error;
}

describe("parseSubagentCall run plans", () => {
  test("a single run keeps raw overrides and defaults the agent scope", () => {
    expect(
      command({
        agent: "bee",
        task: "do it",
        profile: "quick",
        cwd: "",
        tools: ["read"],
        isolation: { noSkills: true },
      }),
    ).toEqual({
      kind: "run",
      selection: { scope: "user" },
      plan: {
        kind: "single",
        item: {
          agent: "bee",
          task: "do it",
          profile: "quick",
          cwd: "",
          tools: ["read"],
          isolation: { noSkills: true },
        },
      },
    });
  });

  test("parallel items inherit top-level tools and isolation, but not cwd", () => {
    const parsed = command({
      tasks: [
        { agent: "a", task: "one" },
        { agent: "b", task: "two", tools: ["bash"], cwd: "/b" },
      ],
      tools: ["read"],
      isolation: { noMcp: true },
      cwd: "/top",
      context: "  shared  ",
      agentScope: "both",
      confirmProjectAgents: false,
    });
    expect(parsed).toMatchObject({
      kind: "run",
      selection: { scope: "both", confirmProjectAgents: false },
      plan: {
        kind: "parallel",
        context: "shared",
        items: [
          {
            agent: "a",
            tools: ["read"],
            isolation: { noMcp: true },
          },
          { agent: "b", tools: ["bash"], cwd: "/b" },
        ],
      },
    });
    const firstItem =
      parsed.kind === "run" && parsed.plan.kind === "parallel"
        ? parsed.plan.items[0]
        : undefined;
    expect(firstItem).not.toHaveProperty("cwd");
  });

  test("invalid mode shapes are deferred so the caller can list agents", () => {
    expect(command({})).toMatchObject({
      plan: { kind: "invalid", problem: "modeCount", mode: "single" },
    });
    expect(
      command({ agent: "a", task: "t", chain: [{ agent: "b", task: "u" }] }),
    ).toMatchObject({ plan: { kind: "invalid", problem: "modeCount" } });
    expect(
      command({ chain: [{ agent: "b", task: "u" }], context: "ctx" }),
    ).toMatchObject({
      plan: {
        kind: "invalid",
        problem: "contextOutsideParallel",
        mode: "chain",
      },
    });
    expect(command({ agent: "a", task: "t", context: "   " })).toMatchObject({
      plan: { kind: "single" },
    });
  });

  test("rejects control fields and empty tool overrides before planning", () => {
    expect(error({ agent: "a", task: "t", handle: "mw-1" })).toBe(
      'Action "run" does not accept managed control fields: handle.',
    );
    expect(
      error({ action: "status", handle: "mw-1", tasks: [{ tools: [] }] }),
    ).toBe(
      "An empty tools override is not supported; omit tools to use the agent's configured tools.",
    );
  });
});

describe("parseSubagentCall managed actions", () => {
  test("a spawn batch inherits cwd/tools/isolation and keeps raw context", () => {
    expect(
      command({
        action: "spawn",
        tasks: [{ agent: "a", task: "one", profile: "quick", model: "" }],
        cwd: "/top",
        context: "ctx",
      }),
    ).toEqual({
      kind: "spawn",
      selection: { scope: "user" },
      launch: {
        kind: "batch",
        requests: [{ agent: "a", task: "one", profile: "quick", cwd: "/top" }],
        context: "ctx",
      },
    });
  });

  test("spawn shape errors keep their precedence and wording", () => {
    expect(error({ action: "spawn", agent: "a", task: "t", tasks: [] })).toBe(
      'Action "spawn" requires a non-empty tasks[] batch.',
    );
    expect(
      error({
        action: "spawn",
        agent: "a",
        task: "t",
        tasks: [{ agent: "b", task: "u" }],
      }),
    ).toBe(
      'Action "spawn" requires exactly one agent/task or a tasks[] batch.',
    );
    expect(error({ action: "spawn", agent: "a" })).toBe(
      'Action "spawn" single mode requires both agent and task.',
    );
    expect(
      error({ action: "spawn", agent: "a", task: "t", context: "ctx" }),
    ).toBe('Action "spawn" context is supported only with tasks[].');
    expect(
      error({
        action: "spawn",
        tasks: [{ agent: "a", task: "t" }],
        profile: "quick",
      }),
    ).toBe(
      'Action "spawn" tasks[] takes profile/model on each task, not at the top level.',
    );
  });

  test("control actions accept only their own fields", () => {
    expect(command({ action: "send", handle: "mw-1", message: "hi" })).toEqual({
      kind: "send",
      handle: "mw-1",
      message: "hi",
      delivery: "auto",
    });
    expect(
      command({
        action: "wait",
        handle: "mw-1",
        assignmentId: "as-1",
        waitTimeoutMs: 0,
      }),
    ).toEqual({
      kind: "wait",
      handle: "mw-1",
      assignmentId: "as-1",
      timeoutMs: 0,
    });
    expect(command({ action: "list" })).toEqual({ kind: "list" });
    expect(error({ action: "stop", handle: "mw-1", message: "x" })).toBe(
      'Action "stop" accepts only handle.',
    );
    expect(error({ action: "wait", handle: "mw-1", assignmentId: "" })).toBe(
      "assignmentId must be a non-empty string.",
    );
  });

  test("failures carry the requested action so nested sessions gate first", () => {
    expect(parseSubagentCall({ action: "status" })).toMatchObject({
      ok: false,
      action: "status",
    });
    expect(parseSubagentCall({ action: "explode" })).toEqual({
      ok: false,
      action: "explode",
      error: 'Unknown subagent action "explode".',
    });
  });
});

describe("planProfileAttempts", () => {
  const profiles = parseModelProfiles({
    version: 1,
    profiles: {
      quick: {
        description: "Fast profile.",
        candidates: [
          { model: "provider/model-a", thinkingLevel: "high" },
          { model: "missing/model-b" },
        ],
      },
      offline: {
        description: "Nothing available.",
        candidates: [{ model: "missing/model-c" }],
      },
    },
  });
  const availableModels = new Set(["provider/model-a"]);
  const plan = (
    overrides: Partial<Parameters<typeof planProfileAttempts>[0]>,
  ) =>
    planProfileAttempts({
      agentName: "bee",
      agent: {},
      profiles,
      availableModels,
      ...overrides,
    });

  test("an explicit model beats every profile", () => {
    expect(
      plan({ model: "p/m", profile: "quick", agent: { profile: "quick" } }),
    ).toEqual({ kind: "direct", model: "p/m" });
    expect(plan({ agent: { model: "p/agent" } })).toEqual({ kind: "direct" });
  });

  test("an invocation profile beats the agent's profile and keeps only eligible candidates", () => {
    const quick = profiles.profiles.quick!;
    expect(plan({ profile: "quick", agent: { profile: "offline" } })).toEqual({
      kind: "ladder",
      profile: "quick",
      candidates: [formatProfileCandidate(quick.candidates[0]!)],
    });
  });

  test("conflicting frontmatter is rejected even with an explicit model", () => {
    expect(
      plan({ model: "p/m", agent: { profile: "quick", model: "p/agent" } }),
    ).toMatchObject({
      kind: "rejected",
      problem: "conflictingAgentConfig",
      reason:
        'Agent "bee": declare either "profile" or "model" in frontmatter, not both.',
    });
  });

  test("unknown profiles and empty ladders are rejected with the profile name", () => {
    expect(plan({ profile: "nope" })).toEqual({
      kind: "rejected",
      problem: "unknownProfile",
      profile: "nope",
      reason:
        'Unknown subagent profile "nope". Available profiles: quick, offline.',
    });
    expect(plan({ profile: "offline" })).toMatchObject({
      kind: "rejected",
      problem: "noEligibleCandidates",
      profile: "offline",
    });
  });
});
