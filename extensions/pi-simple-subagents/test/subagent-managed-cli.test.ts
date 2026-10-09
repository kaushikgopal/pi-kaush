import { execFileSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { delimiter, isAbsolute, join, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { SessionConcurrencyGate } from "../src/_concurrency.ts";
import {
  createRpcHost,
  getManagedRuntime,
  type ManagedRuntime,
} from "../src/_managed.ts";
import type { SubagentLimitsConfig } from "../src/_limits.ts";
import { SubagentProcessRegistry } from "../src/_process-tree.ts";

const PI_CLI_PATH = fileURLToPath(
  new URL(
    "../../../node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
    import.meta.url,
  ),
);
const BRIDGE_PATH = fileURLToPath(
  new URL("../src/_managed-child.ts", import.meta.url),
);
const FIXTURE_SOURCE = fileURLToPath(
  new URL("./fixtures/managed-smoke-provider.ts", import.meta.url),
);
const NODE_MODULES_PATH = fileURLToPath(
  new URL("../../../node_modules", import.meta.url),
);
const SMOKE_LIMITS: SubagentLimitsConfig = {
  version: 1,
  maxDepth: 2,
  maxChildrenPerCall: 5,
  maxConcurrency: 1,
  maxRuntimeMs: 0,
  maxInactivityMs: 0,
  persistChildSessions: true,
};

interface SmokeCall {
  readonly userTurns: number;
  readonly historyMessages: number;
}

interface Sandbox {
  readonly root: string;
  readonly agentDir: string;
  readonly cwd: string;
  readonly providerPath: string;
  readonly bridgePath: string;
  readonly callLogPath: string;
}

async function createSandbox(prefix: string): Promise<Sandbox> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const agentDir = join(root, "agent");
  const cwd = join(root, "workspace");
  const extensionsDir = join(agentDir, "extensions");
  const providerPath = join(extensionsDir, "managed-smoke-provider.ts");
  const bridgePath = join(agentDir, "managed-smoke-bridge.ts");
  try {
    await Promise.all([
      mkdir(extensionsDir, { recursive: true }),
      mkdir(cwd, { recursive: true }),
    ]);
    await Promise.all([
      copyFile(FIXTURE_SOURCE, providerPath),
      symlink(NODE_MODULES_PATH, join(agentDir, "node_modules"), "dir"),
    ]);
    await writeFile(
      bridgePath,
      `import bridge from ${JSON.stringify(BRIDGE_PATH)};\nimport provider from ${JSON.stringify(providerPath)};\nexport default function(pi) { bridge(pi); provider(pi); }\n`,
    );
    return {
      root,
      agentDir,
      cwd,
      providerPath,
      bridgePath,
      callLogPath: join(agentDir, "managed-smoke-calls.jsonl"),
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

function runtimeEnvironment(
  agentDir: string,
  asTopLevel = false,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PI_CODING_AGENT_DIR: agentDir,
    PI_OFFLINE: "1",
  };
  if (asTopLevel) {
    for (const key of [
      "PI_SUBAGENT_DEPTH",
      "PI_SUBAGENT_PARENT_SESSION_ID",
      "PI_SUBAGENT_PARENT_TOOL_CALL_ID",
      "PI_SUBAGENT_ROOT_SESSION_ID",
    ]) {
      delete env[key];
    }
  }
  return env;
}

function makeRuntime(
  sandbox: Sandbox,
  env: NodeJS.ProcessEnv,
  gate: SessionConcurrencyGate,
  host: ReturnType<typeof createRpcHost> | undefined,
): ManagedRuntime {
  return getManagedRuntime({
    parentSessionId: `managed-cli-smoke-${process.pid}-${Date.now()}`,
    agentDir: sandbox.agentDir,
    limits: SMOKE_LIMITS,
    gate,
    env,
    ports: {
      ...(host ? { host } : {}),
      bridgePath: sandbox.bridgePath,
      invocation: (args) => ({
        command: process.execPath,
        args: [PI_CLI_PATH, ...args, "--offline"],
      }),
      pollMs: 100,
      graceMs: 5_000,
      startupTimeoutMs: 60_000,
    },
  });
}

function smokeLaunch(cwd: string, parentSessionId: string, task: string) {
  return {
    agent: {
      name: "managed-cli-smoke",
      source: "user" as const,
      systemPrompt: "Complete the assignment with the provided yield tool.",
      tools: ["yield"],
    },
    modelCandidates: ["managed-smoke/offline"],
    cwd,
    trace: {
      rootSessionId: parentSessionId,
      parentSessionId,
      parentToolCallId: "managed-cli-smoke-call",
      depth: 1,
    },
    task,
    isolation: {
      noExtensions: true,
      noSkills: true,
      noContextFiles: true,
      noPromptTemplates: true,
    },
  };
}

async function withTemporaryProcessEnv<T>(
  values: Record<string, string>,
  run: () => Promise<T>,
): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function readCalls(filePath: string): Promise<SmokeCall[]> {
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch {
    return [];
  }
  return content
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as SmokeCall);
}

async function waitFor<T>(
  description: string,
  read: () => T | undefined,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

async function waitForYield(
  runtime: ManagedRuntime,
  handle: string,
  assignmentId: string,
) {
  const assignment = await runtime.wait(handle, {
    assignmentId,
    timeoutMs: 45_000,
  });
  expect(assignment.state).toBe("completed");
  expect(assignment.outcome?.source).toBe("yield");
  expect(assignment.outcome?.result).toContain("userText=");
  expect(assignment.usage).toMatchObject({
    input: 11,
    output: 7,
    cacheRead: 2,
    cacheWrite: 1,
    turns: 1,
  });
  expect(assignment.model).toBe("managed-smoke/offline");
  return assignment;
}

async function runOfflineRpcSmoke(sandbox: Sandbox): Promise<void> {
  await withTemporaryProcessEnv(
    { PI_CODING_AGENT_DIR: sandbox.agentDir, PI_OFFLINE: "1" },
    async () => {
      const gate = new SessionConcurrencyGate(SMOKE_LIMITS.maxConcurrency);
      const runtime = makeRuntime(
        sandbox,
        runtimeEnvironment(sandbox.agentDir, true),
        gate,
        createRpcHost(new SubagentProcessRegistry()),
      );
      let handle: string | undefined;
      try {
        const parentSessionId = runtime.parentSessionId;
        const first = await runtime.spawn(
          smokeLaunch(sandbox.cwd, parentSessionId, "FIRST smoke assignment"),
        );
        handle = first.handle;
        expect(gate.status.active).toBe(1);
        const firstResult = await waitForYield(
          runtime,
          first.handle,
          first.assignmentId,
        );
        expect(firstResult.outcome?.result).toContain("FIRST smoke assignment");
        expect(firstResult.outcome?.result).toContain("userTurns=1");

        const second = runtime.send(first.handle, "SECOND smoke assignment");
        const secondResult = await waitForYield(
          runtime,
          first.handle,
          second.assignmentId,
        );
        expect(secondResult.outcome?.result).toContain(
          "SECOND smoke assignment",
        );
        expect(secondResult.outcome?.result).toContain("userTurns=2");

        const beforeStop = runtime.status(first.handle);
        expect(beforeStop.hostKind).toBe("rpc");
        expect(beforeStop.model).toBe("managed-smoke/offline");
        expect(beforeStop.sessionFile).toBeTruthy();
        expect(await readCalls(sandbox.callLogPath)).toHaveLength(2);
        const sessionId = beforeStop.sessionId;
        const sessionFile = beforeStop.sessionFile!;
        const workerDir = beforeStop.dir;
        expect(await fileExists(sessionFile)).toBe(true);

        const stopped = await runtime.stop(first.handle);
        expect(stopped.lifecycle).toBe("stopped");
        expect(stopped.live).toBe(false);
        expect(gate.status.active).toBe(0);
        expect(await fileExists(sessionFile)).toBe(true);
        expect(await fileExists(join(workerDir, "config.json"))).toBe(true);

        const resumed = await runtime.resume(first.handle);
        expect(resumed.lifecycle).toBe("running");
        expect(resumed.sessionId).toBe(sessionId);
        expect(resumed.sessionFile).toBe(sessionFile);
        await waitFor("the resumed CLI worker to become idle", () =>
          runtime.status(first.handle).childState === "idle" ? true : undefined,
        );
        expect(await readCalls(sandbox.callLogPath)).toHaveLength(2);

        const third = runtime.send(
          first.handle,
          "THIRD smoke assignment after resume",
        );
        const thirdResult = await waitForYield(
          runtime,
          first.handle,
          third.assignmentId,
        );
        expect(thirdResult.outcome?.result).toContain(
          "THIRD smoke assignment after resume",
        );
        expect(thirdResult.outcome?.result).toContain("userTurns=3");
        const calls = await readCalls(sandbox.callLogPath);
        expect(calls).toHaveLength(3);
        expect(calls[2]?.userTurns).toBe(3);
        expect(calls[0]?.historyMessages).toBeLessThan(
          calls[1]?.historyMessages ?? 0,
        );
        expect(calls[1]?.historyMessages).toBeLessThan(
          calls[2]?.historyMessages ?? 0,
        );
      } finally {
        if (handle) await runtime.stop(handle).catch(() => {});
      }
    },
  );
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function isExecutable(command: string): boolean {
  const candidates =
    isAbsolute(command) || command.includes(sep)
      ? [command]
      : (process.env.PATH ?? "")
          .split(delimiter)
          .map((directory) => join(directory, command));
  return candidates.some((candidate) => {
    try {
      requireExecutable(candidate);
      return true;
    } catch {
      return false;
    }
  });
}

function requireExecutable(filePath: string): void {
  accessSync(filePath, constants.X_OK);
}

const inheritedDepth = process.env.PI_SUBAGENT_DEPTH?.trim();
const herdrSmokeAvailable =
  process.env.PI_MANAGED_HERDR_SMOKE === "1" &&
  process.env.HERDR_ENV === "1" &&
  !!process.env.HERDR_WORKSPACE_ID?.trim() &&
  !!process.env.HERDR_PANE_ID?.trim() &&
  !!process.env.HERDR_TAB_ID?.trim() &&
  (!inheritedDepth || inheritedDepth === "0") &&
  isExecutable(process.env.HERDR_BIN_PATH?.trim() || "herdr");

function readHerdrSmokeLayout(parentPaneId: string): {
  tabId: string;
  focusedPaneId: string;
  panes: { paneId: string; y: number }[];
} {
  const stdout = execFileSync(
    process.env.HERDR_BIN_PATH?.trim() || "herdr",
    ["pane", "layout", "--pane", parentPaneId],
    { encoding: "utf8", timeout: 10_000, maxBuffer: 128 * 1024 },
  );
  const layout = JSON.parse(stdout).result?.layout;
  expect(typeof layout?.tab_id).toBe("string");
  expect(typeof layout?.focused_pane_id).toBe("string");
  expect(Array.isArray(layout?.panes)).toBe(true);
  return {
    tabId: layout.tab_id,
    focusedPaneId: layout.focused_pane_id,
    panes: layout.panes.map(
      (pane: { pane_id: string; rect: { y: number } }) => ({
        paneId: pane.pane_id,
        y: pane.rect.y,
      }),
    ),
  };
}

describe.sequential("managed worker real Pi CLI smoke", () => {
  test("uses the RPC bridge, yields twice, and resumes the persisted Pi session without replay", async () => {
    expect(await fileExists(PI_CLI_PATH)).toBe(true);
    const sandbox = await createSandbox("managed-cli-smoke-");
    try {
      await runOfflineRpcSmoke(sandbox);
    } finally {
      await rm(sandbox.root, { recursive: true, force: true });
    }
  }, 120_000);

  test.skipIf(!herdrSmokeAvailable)(
    "manual native Herdr smoke creates and closes only an unfocused extension-owned split pane",
    async () => {
      const parentPaneId = process.env.HERDR_PANE_ID;
      if (!parentPaneId)
        throw new Error("Native smoke requires the caller pane ID");
      const before = readHerdrSmokeLayout(parentPaneId);
      const sandbox = await createSandbox("managed-herdr-smoke-");
      try {
        const env = runtimeEnvironment(sandbox.agentDir);
        const gate = new SessionConcurrencyGate(SMOKE_LIMITS.maxConcurrency);
        const runtime = makeRuntime(sandbox, env, gate, undefined);
        let handle: string | undefined;
        try {
          const spawned = await runtime.spawn(
            smokeLaunch(
              sandbox.cwd,
              runtime.parentSessionId,
              "NATIVE first assignment",
            ),
          );
          handle = spawned.handle;
          const worker = runtime.status(spawned.handle);
          expect(worker.hostKind).toBe("herdr");
          expect(worker.placement).toMatchObject({
            kind: "herdr",
            layout: "split",
          });
          const placement = worker.placement;
          if (placement?.kind !== "herdr")
            throw new Error("Expected a native pane");
          const childPaneId = placement.paneId;
          expect(placement.tabId).toBe(before.tabId);
          expect(childPaneId).not.toBe(parentPaneId);
          const during = readHerdrSmokeLayout(parentPaneId);
          const parentPane = during.panes.find(
            (pane) => pane.paneId === parentPaneId,
          );
          const childPane = during.panes.find(
            (pane) => pane.paneId === childPaneId,
          );
          if (!parentPane || !childPane)
            throw new Error("Caller or child pane missing from native layout");
          expect(childPane.y).toBeGreaterThan(parentPane.y);
          expect(during.focusedPaneId).toBe(before.focusedPaneId);
          const first = await waitForYield(
            runtime,
            spawned.handle,
            spawned.assignmentId,
          );
          expect(first.outcome?.result).toContain("NATIVE first assignment");

          const second = runtime.send(
            spawned.handle,
            "NATIVE second assignment",
          );
          const secondResult = await waitForYield(
            runtime,
            spawned.handle,
            second.assignmentId,
          );
          expect(secondResult.outcome?.result).toContain(
            "NATIVE second assignment",
          );
          expect(await readCalls(sandbox.callLogPath)).toHaveLength(2);

          const stopped = await runtime.stop(spawned.handle);
          expect(stopped.lifecycle).toBe("stopped");
          expect(stopped.live).toBe(false);
          expect(gate.status.active).toBe(0);
          const after = readHerdrSmokeLayout(parentPaneId);
          expect(after.tabId).toBe(before.tabId);
          expect(after.panes.some((pane) => pane.paneId === parentPaneId)).toBe(
            true,
          );
          expect(after.panes.some((pane) => pane.paneId === childPaneId)).toBe(
            false,
          );
          expect(after.panes.map((pane) => pane.paneId).sort()).toEqual(
            before.panes.map((pane) => pane.paneId).sort(),
          );
        } finally {
          if (handle) await runtime.stop(handle).catch(() => {});
        }
      } finally {
        await rm(sandbox.root, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
