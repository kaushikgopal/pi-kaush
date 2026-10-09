import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { SessionConcurrencyGate } from "../src/_concurrency.ts";
import type { SubagentLimitsConfig } from "../src/_limits.ts";
import {
  deriveAssignmentView,
  getManagedRuntime,
  ManagedError,
  type ManagedLaunch,
  type ManagedRuntimePorts,
  managedRuntimeHostKind,
} from "../src/_managed.ts";
import {
  defaultSleep,
  type ManagedHostLaunch,
  type ManagedHostPort,
  type ManagedHostProcess,
  ManagedStartupError,
} from "../src/_managed-host.ts";
import {
  ManagedChildBridge,
  managedBridgeOptionsFromEnv,
} from "../src/_managed-child.ts";
import {
  type ChildStatus,
  managedParentDir,
  managedPaths,
  readChildStatus,
  readManagedConfig,
  writeArchivedAssignment,
  writeJsonAtomic,
} from "../src/_managed-store.ts";
import { decodeManagedBootEnv } from "../src/_managed-protocol.ts";
import { emptyUsage } from "../src/_usage.ts";

// ------------------------------------------------------------ fake child

type Step =
  | { kind: "text"; text: string }
  | { kind: "tool" }
  | {
      kind: "yield";
      status: "completed" | "blocked" | "failed";
      result: string;
      artifacts?: readonly string[];
    }
  | { kind: "error"; message: string }
  | { kind: "hang" }
  /** Ignores abort, like a tool stuck in uninterruptible I/O. */
  | { kind: "stuck" }
  | { kind: "until"; promise: Promise<void> }
  /** Pi echoes the prompt, then rejects it before any run (no model or credentials). */
  | { kind: "reject" };

interface FakeModelContext {
  readonly model: string | undefined;
  readonly boot: number;
}
type Behavior = (prompt: string, context: FakeModelContext) => Step[];
/** never: the process lives but Pi never finishes starting. */
type StartMode = "ok" | "exit" | "ignoreShutdown" | "slowExit" | "never";

const tick = (ms = 1) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function argValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

const assistant = (text: string, extra: Record<string, unknown> = {}) => ({
  role: "assistant",
  content: text ? [{ type: "text", text }] : [],
  usage: {
    input: 10,
    output: 5,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 15,
    cost: { total: 0.01 },
  },
  provider: "fake",
  model: "model",
  stopReason: "stop",
  ...extra,
});

const user = (text: string) => ({
  role: "user",
  content: [{ type: "text", text }],
});

/**
 * In-process stand-in for a Pi child: real bridge, real files, scripted model.
 * Mirrors Pi's ordering: input echo, validation, before_agent_start, then the
 * user message; steers arrive between turns, follow-ups after the last turn.
 */
class FakeWorker {
  readonly prompts: string[] = [];
  readonly steers: string[] = [];
  bridge: ManagedChildBridge | undefined;
  terminated = false;
  exited = false;
  shutdownRequests = 0;
  private idle = true;
  private running = false;
  private aborted = false;
  private abortWaiters: (() => void)[] = [];
  private readonly steerQueue: string[] = [];
  private readonly followUps: string[] = [];
  private readonly exit = deferred();
  private sessionId = "";
  readonly process: ManagedHostProcess;

  constructor(
    readonly request: ManagedHostLaunch,
    readonly boot: number,
    private readonly behavior: Behavior,
    private readonly mode: StartMode,
    /** Released by the test; a slowExit worker finishes its shutdown only then. */
    private readonly slowExitGate: () => Promise<void>,
  ) {
    this.process = {
      placement: { kind: "rpc", pid: this.pid },
      exited: this.exit.promise,
      terminate: async () => {
        this.terminated = true;
        this.markExited();
      },
    };
  }

  get pid(): number {
    return 10_000 + this.boot;
  }

  get model(): string | undefined {
    return argValue(this.request.args, "--model");
  }

  start(): void {
    if (this.mode === "exit") {
      this.markExited();
      return;
    }
    if (this.mode === "never" || this.exited) return;
    const sessionDir = argValue(this.request.args, "--session-dir")!;
    this.sessionId = argValue(this.request.args, "--session-id")!;
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.appendFileSync(
      path.join(sessionDir, `${this.sessionId}.jsonl`),
      `${JSON.stringify({ type: "session", id: this.sessionId })}\n`,
    );
    this.boot_(this.sessionId);
  }

  /** Simulates a process crash: no shutdown hook runs. */
  crash(): void {
    this.markExited();
  }

  /** Simulates /quit in the worker's own tab: Pi runs its shutdown hook, then exits. */
  quit(): void {
    this.bridge?.onShutdown("quit");
    this.markExited();
  }

  /** Simulates Pi replacing the session in-process (for example /new). */
  replaceSession(nextSessionId: string): void {
    this.bridge?.onShutdown("new");
    this.boot_(nextSessionId);
  }

  private boot_(sessionId: string): void {
    const options = managedBridgeOptionsFromEnv(
      { ...this.request.env },
      (text, delivery) => this.sendUserMessage(text, delivery),
    );
    if (!options) throw new Error("missing managed environment");
    this.bridge = new ManagedChildBridge({
      ...options,
      pid: this.pid,
      pollMs: 5,
      deliveryConfirmMs: 150,
      settleGraceMs: 50,
    });
    const sessionDir = argValue(this.request.args, "--session-dir")!;
    this.bridge.start({
      isIdle: () => this.idle,
      abort: () => {
        this.aborted = true;
        for (const wake of this.abortWaiters.splice(0)) wake();
      },
      shutdown: () => {
        this.shutdownRequests++;
        if (this.mode === "ignoreShutdown") return;
        const finish = () => {
          this.bridge?.onShutdown();
          this.markExited();
        };
        if (this.mode === "slowExit") void this.slowExitGate().then(finish);
        else setTimeout(finish, 1);
      },
      hasPendingMessages: () =>
        this.steerQueue.length + this.followUps.length > 0,
      sessionId,
      sessionFile: path.join(sessionDir, `${sessionId}.jsonl`),
    });
  }

  private markExited(): void {
    if (this.exited) return;
    this.exited = true;
    this.bridge?.dispose();
    for (const wake of this.abortWaiters.splice(0)) wake();
    this.exit.resolve();
  }

  private sendUserMessage(
    text: string,
    delivery?: { deliverAs: "steer" | "followUp" },
  ): void {
    if (this.exited) return;
    if (this.running) {
      if (delivery?.deliverAs === "steer") {
        this.steers.push(text);
        this.steerQueue.push(text);
      } else this.followUps.push(text);
      return;
    }
    this.running = true;
    setTimeout(() => void this.run(text), 1);
  }

  private drainSteers(): void {
    for (const steer of this.steerQueue.splice(0))
      this.bridge?.onMessageStart(user(steer));
  }

  private async run(text: string): Promise<void> {
    const bridge = this.bridge!;
    bridge.onInput(text, "extension");
    let steps = this.behavior(text, { model: this.model, boot: this.boot });
    if (steps[0]?.kind === "reject") {
      this.running = false;
      return;
    }
    this.idle = false;
    bridge.onBeforeAgentStart(text);
    let current: string | undefined = text;
    while (current !== undefined && !this.exited) {
      bridge.onMessageStart(user(current));
      this.prompts.push(current);
      bridge.onActivity();
      for (const step of steps) {
        await tick();
        if (this.aborted || this.exited) break;
        this.drainSteers();
        if (step.kind === "text") bridge.onMessageEnd(assistant(step.text));
        else if (step.kind === "tool") bridge.onToolStart("bash");
        else if (step.kind === "yield") {
          bridge.onToolStart("yield");
          bridge.onMessageEnd({
            role: "toolResult",
            toolName: "yield",
            details: {
              status: step.status,
              result: step.result,
              ...(step.artifacts ? { artifacts: step.artifacts } : {}),
            },
          });
        } else if (step.kind === "error")
          bridge.onMessageEnd(
            assistant("", { stopReason: "error", errorMessage: step.message }),
          );
        else if (step.kind === "hang")
          await new Promise<void>((resolve) => this.abortWaiters.push(resolve));
        else if (step.kind === "stuck") await new Promise<void>(() => {});
        else if (step.kind === "until") await step.promise;
      }
      if (this.aborted) {
        bridge.onMessageEnd(assistant("", { stopReason: "aborted" }));
        break;
      }
      this.drainSteers();
      current = this.followUps.shift();
      if (current !== undefined)
        steps = this.behavior(current, { model: this.model, boot: this.boot });
    }
    this.aborted = false;
    this.idle = true;
    this.running = false;
    if (!this.exited) bridge.onSettled();
  }
}

class FakeHost implements ManagedHostPort {
  readonly kind = "rpc" as const;
  readonly workers: FakeWorker[] = [];
  /** Live earlier workers at each launch; a second writer would show up here. */
  readonly liveAtLaunch: number[] = [];
  behavior: Behavior = (prompt) => [
    { kind: "text", text: "working" },
    {
      kind: "yield",
      status: "completed",
      result: `done: ${prompt.split("\n")[1]}`,
    },
  ];
  startModes: StartMode[] = [];
  launchErrors: (Error | undefined)[] = [];
  launchGate: Promise<void> | undefined;
  slowExitGate: Promise<void> = Promise.resolve();

  async launch(request: ManagedHostLaunch): Promise<ManagedHostProcess> {
    const failure = this.launchErrors.shift();
    if (failure) throw failure;
    this.liveAtLaunch.push(this.workers.filter((w) => !w.exited).length);
    const worker = new FakeWorker(
      request,
      this.workers.length,
      (prompt, context) => this.behavior(prompt, context),
      this.startModes.shift() ?? "ok",
      () => this.slowExitGate,
    );
    this.workers.push(worker);
    setTimeout(() => worker.start(), 2);
    await this.launchGate;
    return worker.process;
  }

  async focus(): Promise<void> {
    throw new ManagedError("unsupported", "rpc");
  }

  /** Fake workers are identified by pid; only one still running matches. */
  async identity(pid: number): Promise<"match" | "gone"> {
    return this.workers.some((w) => w.pid === pid && !w.exited)
      ? "match"
      : "gone";
  }

  get last(): FakeWorker {
    return this.workers.at(-1)!;
  }
}

// --------------------------------------------------------------- harness

const LIMITS: SubagentLimitsConfig = {
  version: 1,
  maxDepth: 2,
  maxChildrenPerCall: 5,
  maxConcurrency: 2,
  maxRuntimeMs: 0,
  maxInactivityMs: 0,
  persistChildSessions: true,
};

const RUNTIMES = Symbol.for("pi-simple-subagents.managed-runtime-states.v1");

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

/** Forgets cached runtimes, as a new parent process would start without them. */
function forgetRuntimes(): void {
  (globalThis as { [RUNTIMES]?: Map<string, unknown> })[RUNTIMES]?.clear();
}

function setup(
  options: {
    limits?: Partial<SubagentLimitsConfig>;
    parentSessionId?: string;
    env?: NodeJS.ProcessEnv;
    graceMs?: number;
    agentDir?: string;
    host?: FakeHost;
    ports?: Partial<ManagedRuntimePorts>;
  } = {},
) {
  const agentDir =
    options.agentDir ?? fs.mkdtempSync(path.join(tmpdir(), "managed-runtime-"));
  if (!roots.includes(agentDir)) roots.push(agentDir);
  const limits = { ...LIMITS, ...options.limits };
  const gate = new SessionConcurrencyGate(limits.maxConcurrency);
  const host = options.host ?? new FakeHost();
  const parentSessionId = options.parentSessionId ?? "parent-session";
  const ports: Partial<ManagedRuntimePorts> = {
    host,
    pollMs: 5,
    graceMs: options.graceMs ?? 100,
    startupTimeoutMs: 1_000,
    bridgePath: "/ext/_managed-child.ts",
    invocation: (args) => ({ command: "pi", args }),
    parentPid: process.pid,
    processIdentity: (pid) => host.identity(pid),
    orphanExitTimeoutMs: 300,
    ...options.ports,
  };
  const runtime = getManagedRuntime({
    parentSessionId,
    agentDir,
    limits,
    gate,
    env: options.env ?? {},
    ports,
  });
  return { agentDir, limits, gate, host, runtime, parentSessionId, ports };
}

function launch(overrides: Partial<ManagedLaunch> = {}): ManagedLaunch {
  return {
    agent: {
      name: "c3po",
      emoji: "🤖",
      source: "user",
      systemPrompt: "Be precise.",
    },
    profile: "coder",
    modelCandidates: ["fake/primary"],
    cwd: "/work",
    trace: {
      rootSessionId: "root",
      parentSessionId: "parent-session",
      parentToolCallId: "call-1",
      depth: 1,
    },
    task: "first task",
    ...overrides,
  };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await tick(5);
  }
}

async function expectCode(
  promise: Promise<unknown> | (() => unknown),
  code: string,
): Promise<ManagedError> {
  try {
    await (typeof promise === "function" ? promise() : promise);
  } catch (error) {
    expect(error).toBeInstanceOf(ManagedError);
    expect((error as ManagedError).code).toBe(code);
    return error as ManagedError;
  }
  throw new Error(`expected ManagedError ${code}`);
}

/** A clock that moves only when the runtime sleeps, so timeouts expire without real waiting. */
function virtualClock(): Pick<ManagedRuntimePorts, "now" | "sleep"> {
  let now = Date.now();
  return {
    now: () => now,
    sleep: async (ms) => {
      now += ms;
      await tick(0);
    },
  };
}

/** Real sleeps, except the shutdown grace window never elapses, so no forced kill races the test. */
function holdGrace(graceMs: number): ManagedRuntimePorts["sleep"] {
  return (ms, signal) =>
    ms === graceMs ? new Promise<void>(() => {}) : defaultSleep(ms, signal);
}

// ----------------------------------------------------------------- tests

describe("managed runtime lifecycle", () => {
  test("does not deliver the initial assignment before host readiness resolves", async () => {
    const host = new FakeHost();
    const readiness = deferred();
    host.launchGate = readiness.promise;
    const { runtime } = setup({ host });
    const spawning = runtime.spawn(launch());

    await waitFor(
      () =>
        host.workers.length === 1 &&
        readChildStatus(host.last.request.paths.status)?.state === "idle",
    );
    const paths = host.last.request.paths;
    expect(fs.existsSync(paths.activation)).toBe(false);
    expect(readChildStatus(paths.status)).toMatchObject({
      state: "idle",
      ackedSeq: 0,
    });
    expect(host.last.prompts).toEqual([]);

    readiness.resolve();
    const { handle, assignmentId } = await spawning;
    expect(
      await runtime.wait(handle, { assignmentId, timeoutMs: 2_000 }),
    ).toMatchObject({
      state: "completed",
    });
    expect(host.last.prompts).toHaveLength(1);
    await runtime.stop(handle);
  });

  test("delivers the first task once and returns the yielded result with persisted state", async () => {
    const { runtime, host, agentDir, gate } = setup();
    const { handle, assignmentId } = await runtime.spawn(launch());

    const result = await runtime.wait(handle, {
      assignmentId,
      timeoutMs: 2_000,
    });
    expect(result).toMatchObject({
      state: "completed",
      terminal: true,
      outcome: { source: "yield", result: "done: first task" },
    });
    expect(host.workers).toHaveLength(1);
    expect(host.last.prompts).toHaveLength(1);
    expect(host.last.prompts[0]).toContain(
      `[Managed assignment ${assignmentId}]`,
    );
    expect(gate.status.active).toBe(1);

    const args = host.last.request.args;
    expect(args.slice(0, 2)).toEqual(["--mode", "rpc"]);
    expect(argValue(args, "--extension")).toBe("/ext/_managed-child.ts");
    expect(argValue(args, "--model")).toBe("fake/primary");
    expect(argValue(args, "--session-id")).toBe(handle);
    expect(host.last.request.env.PI_SUBAGENT_DEPTH).toBe("1");

    const dir = path.join(managedParentDir(agentDir, "parent-session"), handle);
    const paths = managedPaths(dir);
    // The first task is seq 1, so the initial boot's control floor is 1 and it
    // replays nothing on resume.
    expect(decodeManagedBootEnv(host.last.request.env)).toEqual({
      kind: "ok",
      boot: {
        dir,
        bootId: expect.any(String),
        parentPid: process.pid,
        expectedSessionId: handle,
        resumeFloorSeq: 0,
        controlFloorSeq: 1,
        freshAttempt: false,
        holdOnInitialModelError: false,
        limits: { maxRuntimeMs: 0, maxInactivityMs: 0 },
      },
    });
    expect(fs.statSync(paths.config).mode & 0o777).toBe(0o600);
    expect(fs.statSync(paths.status).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(paths.systemPrompt, "utf8")).toContain(
      "Managed Pi worker boundary",
    );

    const view = runtime.status(handle);
    expect(view).toMatchObject({
      lifecycle: "running",
      live: true,
      childState: "idle",
      label: "🤖 c3po",
      profile: "coder",
      model: "fake/model",
    });
    expect(view.usage.cost).toBeCloseTo(0.01);
    expect(view.sessionFile).toBe(
      path.join(paths.sessionDir, `${handle}.jsonl`),
    );
    expect(runtime.list().map((worker) => worker.handle)).toEqual([handle]);
  });

  test("reuses the session for later assignments and never returns a stale result", async () => {
    const { runtime, host } = setup();
    const { handle, assignmentId: first } = await runtime.spawn(launch());
    await runtime.wait(handle, { assignmentId: first, timeoutMs: 2_000 });

    const { assignmentId: second } = runtime.send(handle, "second task");
    const latest = await runtime.wait(handle, { timeoutMs: 2_000 });
    expect(latest).toMatchObject({
      id: second,
      state: "completed",
      outcome: { result: "done: second task" },
    });
    expect(
      (await runtime.wait(handle, { assignmentId: first })).outcome?.result,
    ).toBe("done: first task");
    expect(host.workers).toHaveLength(1);
    expect(host.last.prompts).toHaveLength(2);
  });

  test("reads a pruned terminal result from its archive before and after stop/resume", async () => {
    const { runtime, host, agentDir } = setup();
    host.behavior = (prompt) =>
      prompt.includes("second task")
        ? [
            { kind: "text", text: "second answer" },
            {
              kind: "yield",
              status: "completed",
              result: "second durable result",
              artifacts: ["/tmp/second-output"],
            },
          ]
        : [{ kind: "yield", status: "completed", result: "first result" }];
    const { handle, assignmentId: first } = await runtime.spawn(launch());
    await runtime.wait(handle, { assignmentId: first, timeoutMs: 2_000 });
    const { assignmentId: second } = runtime.send(handle, "second task");
    const completed = await runtime.wait(handle, {
      assignmentId: second,
      timeoutMs: 2_000,
    });
    expect(completed).toMatchObject({
      state: "completed",
      terminal: true,
      outcome: {
        source: "yield",
        result: "second durable result",
        artifacts: ["/tmp/second-output"],
      },
      usage: { input: 10, output: 5, cost: 0.01, turns: 1 },
    });

    const dir = path.join(managedParentDir(agentDir, "parent-session"), handle);
    const paths = managedPaths(dir);
    const withoutSecond = (status: ChildStatus): ChildStatus => ({
      ...status,
      assignments: status.assignments.filter((entry) => entry.id !== second),
    });
    const snapshot = readChildStatus(paths.status)!;
    expect(snapshot.assignments.some((entry) => entry.id === second)).toBe(
      true,
    );
    writeJsonAtomic(paths.status, withoutSecond(snapshot));

    expect(
      await runtime.wait(handle, { assignmentId: second, timeoutMs: 0 }),
    ).toMatchObject({
      state: "completed",
      terminal: true,
      outcome: {
        result: "second durable result",
        artifacts: ["/tmp/second-output"],
      },
      usage: { input: 10, output: 5, cost: 0.01, turns: 1 },
    });

    await runtime.stop(handle);
    const stopped = readChildStatus(paths.status)!;
    writeJsonAtomic(paths.status, withoutSecond(stopped));
    await runtime.resume(handle);
    await waitFor(() => runtime.status(handle).childState === "idle");
    expect(
      await runtime.wait(handle, { assignmentId: second, timeoutMs: 0 }),
    ).toMatchObject({
      state: "completed",
      terminal: true,
      outcome: {
        result: "second durable result",
        artifacts: ["/tmp/second-output"],
      },
      usage: { input: 10, output: 5, cost: 0.01, turns: 1 },
    });
    await runtime.stop(handle);
  });

  test("a nonterminal archive is not treated as a finished pruned assignment", async () => {
    const { runtime, agentDir } = setup();
    const { handle, assignmentId } = await runtime.spawn(launch());
    await runtime.wait(handle, { assignmentId, timeoutMs: 2_000 });

    const dir = path.join(managedParentDir(agentDir, "parent-session"), handle);
    const paths = managedPaths(dir);
    const status = readChildStatus(paths.status)!;
    const finished = status.assignments.find(
      (entry) => entry.id === assignmentId,
    )!;
    const unfinished = { ...finished, state: "running" as const };
    delete unfinished.outcome;
    delete unfinished.endedAt;
    writeArchivedAssignment(dir, handle, unfinished);
    writeJsonAtomic(paths.status, {
      ...status,
      assignments: status.assignments.filter(
        (entry) => entry.id !== assignmentId,
      ),
    });

    expect(
      await runtime.wait(handle, { assignmentId, timeoutMs: 0 }),
    ).toMatchObject({
      state: "queued",
      terminal: false,
      waitTimedOut: true,
    });

    writeArchivedAssignment(dir, handle, finished);
    await runtime.stop(handle);
  });
  test("steers busy auto messages into the active assignment and queues follow-ups", async () => {
    const { runtime, host } = setup();
    const release = deferred();
    host.behavior = (prompt) =>
      prompt.includes("first task")
        ? [
            { kind: "until", promise: release.promise },
            { kind: "yield", status: "completed", result: "first" },
          ]
        : [{ kind: "yield", status: "completed", result: "follow" }];
    const { handle, assignmentId: first } = await runtime.spawn(launch());
    await waitFor(() => runtime.status(handle).childState === "busy");

    const steer = runtime.send(handle, "also check docs");
    const follow = runtime.send(handle, "then summarize", "followUp");
    await waitFor(() => host.last.steers.length === 1);
    const pending = await runtime.wait(handle, {
      assignmentId: follow.assignmentId,
      timeoutMs: 20,
    });
    expect(pending).toMatchObject({
      state: "accepted",
      terminal: false,
      waitTimedOut: true,
    });

    release.resolve();
    expect(
      await runtime.wait(handle, {
        assignmentId: steer.assignmentId,
        timeoutMs: 2_000,
      }),
    ).toMatchObject({
      state: "completed",
      mergedInto: first,
      outcome: { result: "first" },
    });
    expect(
      await runtime.wait(handle, {
        assignmentId: follow.assignmentId,
        timeoutMs: 2_000,
      }),
    ).toMatchObject({
      state: "completed",
      disposition: "followUp",
      outcome: { result: "follow" },
    });
  });

  test("reports unread messages as queued until the worker acknowledges them", async () => {
    const { runtime, agentDir } = setup();
    const { handle } = await runtime.spawn(launch());
    await runtime.wait(handle, { timeoutMs: 2_000 });
    const { assignmentId } = runtime.send(handle, "later");
    const view = await runtime.wait(handle, { assignmentId, timeoutMs: 0 });
    expect(view).toMatchObject({
      state: "queued",
      terminal: false,
      waitTimedOut: true,
    });
    const config = readManagedConfig(
      managedPaths(
        path.join(managedParentDir(agentDir, "parent-session"), handle),
      ).config,
    );
    expect(config?.lastAssignmentId).toBe(assignmentId);
  });

  test("applies watchdogs to the active assignment only and keeps the worker", async () => {
    const { runtime, host } = setup({ limits: { maxRuntimeMs: 40 } });
    host.behavior = (prompt) =>
      prompt.includes("first task")
        ? [{ kind: "hang" }]
        : [{ kind: "yield", status: "completed", result: "ok" }];
    const { handle } = await runtime.spawn(launch());
    const timedOut = await runtime.wait(handle, { timeoutMs: 2_000 });
    expect(timedOut).toMatchObject({
      state: "timedOut",
      outcome: { source: "lifecycle" },
    });
    expect(timedOut.outcome?.result).toContain("runtime limit");

    // An idle worker is not timed out, and it accepts more work.
    await tick(80);
    expect(runtime.status(handle).lifecycle).toBe("running");
    runtime.send(handle, "next");
    expect(await runtime.wait(handle, { timeoutMs: 2_000 })).toMatchObject({
      state: "completed",
    });
  });

  test("falls back to the next model only before tool activity on the initial assignment", async () => {
    const { runtime, host } = setup();
    host.behavior = (_prompt, context) =>
      context.model === "fake/bad"
        ? [{ kind: "error", message: "model unavailable" }]
        : [
            {
              kind: "yield",
              status: "completed",
              result: `ran on ${context.model}`,
            },
          ];
    const { handle, assignmentId } = await runtime.spawn(
      launch({ modelCandidates: ["fake/bad", "fake/good"] }),
    );

    const result = await runtime.wait(handle, {
      assignmentId,
      timeoutMs: 3_000,
    });
    expect(result).toMatchObject({
      state: "completed",
      outcome: { result: "ran on fake/good" },
    });
    expect(host.workers.map((worker) => worker.model)).toEqual([
      "fake/bad",
      "fake/good",
    ]);
    expect(argValue(host.workers[1]!.request.args, "--session-id")).toBe(
      `${handle}-m1`,
    );
    const view = runtime.status(handle);
    expect(view.candidateIndex).toBe(1);
    expect(view.attempts).toMatchObject([
      { candidateIndex: 0, model: "fake/bad" },
    ]);
  });

  test("does not fall back after tool activity", async () => {
    const { runtime, host } = setup();
    host.behavior = () => [
      { kind: "tool" },
      { kind: "error", message: "boom" },
    ];
    const { handle } = await runtime.spawn(
      launch({ modelCandidates: ["fake/bad", "fake/good"] }),
    );
    const result = await runtime.wait(handle, { timeoutMs: 2_000 });
    expect(result).toMatchObject({
      state: "failed",
      toolActivity: true,
      outcome: { source: "error", result: "boom" },
    });
    await tick(30);
    expect(host.workers).toHaveLength(1);
  });

  test("falls back when a candidate exits before it is ready", async () => {
    const { runtime, host } = setup();
    host.startModes = ["exit"];
    const { handle } = await runtime.spawn(
      launch({ modelCandidates: ["fake/broken", "fake/good"] }),
    );
    expect(await runtime.wait(handle, { timeoutMs: 2_000 })).toMatchObject({
      state: "completed",
    });
    expect(host.workers.map((worker) => worker.model)).toEqual([
      "fake/broken",
      "fake/good",
    ]);
  });

  test("marks the worker failed and releases its slot when no candidate starts", async () => {
    const { runtime, host, gate } = setup();
    host.startModes = ["exit"];
    await expectCode(runtime.spawn(launch()), "launch");
    expect(gate.status.active).toBe(0);
    expect(runtime.list()[0]).toMatchObject({
      lifecycle: "failed",
      live: false,
    });
  });
});

describe("managed runtime capacity and ownership", () => {
  test("idle workers hold their slot and spawn fails fast without capacity", async () => {
    const { runtime, gate } = setup({ limits: { maxConcurrency: 1 } });
    const { handle } = await runtime.spawn(launch());
    await runtime.wait(handle, { timeoutMs: 2_000 });
    expect(gate.status).toMatchObject({ active: 1, available: 0 });
    await expectCode(runtime.spawn(launch()), "capacity");

    const stopped = await runtime.stop(handle);
    expect(stopped).toMatchObject({ lifecycle: "stopped", live: false });
    expect(gate.status.active).toBe(0);
    expect(
      fs.existsSync(path.join(stopped.dir, "session", `${handle}.jsonl`)),
    ).toBe(true);
  });

  test("only depth-0 parents may spawn depth-1 workers they own", async () => {
    await expectCode(
      setup({ env: { PI_SUBAGENT_DEPTH: "1" } }).runtime.spawn(launch()),
      "depth",
    );
    const { runtime } = setup();
    await expectCode(
      runtime.spawn(
        launch({
          trace: {
            rootSessionId: "r",
            parentSessionId: "parent-session",
            parentToolCallId: "c",
            depth: 2,
          },
        }),
      ),
      "depth",
    );
    await expectCode(
      runtime.spawn(
        launch({
          trace: {
            rootSessionId: "r",
            parentSessionId: "other",
            parentToolCallId: "c",
            depth: 1,
          },
        }),
      ),
      "ownership",
    );
  });

  test("refuses handles whose stored config belongs to another parent", async () => {
    const { runtime, agentDir } = setup();
    const { handle } = await runtime.spawn(launch());
    await runtime.wait(handle, { timeoutMs: 2_000 });
    const configPath = managedPaths(
      path.join(managedParentDir(agentDir, "parent-session"), handle),
    ).config;
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    fs.writeFileSync(
      configPath,
      JSON.stringify({ ...config, parentSessionId: "intruder" }),
    );
    expect(() => runtime.status(handle)).toThrow(/different parent/);
    expect(runtime.list()).toEqual([]);
    expect(() => runtime.status("../etc")).toThrow(
      /Invalid managed worker handle/,
    );
    fs.writeFileSync(configPath, JSON.stringify(config));
    await runtime.stop(handle);
  });

  test("rebinding after reload keeps the same runtime and moves live slots to the new gate", async () => {
    const { runtime, gate, agentDir, limits } = setup();
    const { handle } = await runtime.spawn(launch());
    const nextGate = new SessionConcurrencyGate(2);
    const rebound = getManagedRuntime({
      parentSessionId: "parent-session",
      agentDir,
      limits,
      gate: nextGate,
    });
    expect(rebound).toBe(runtime);
    expect(gate.status.active).toBe(0);
    expect(nextGate.status.active).toBe(1);
    await runtime.stop(handle);
    await tick();
    expect(nextGate.status.active).toBe(0);
  });

  test("a /reload with a new gate moves live slots to it", async () => {
    const { runtime, gate, agentDir, limits, parentSessionId, ports } = setup();
    const { handle } = await runtime.spawn(launch());
    vi.resetModules();
    const fresh = await import("../src/_managed.ts");
    const nextGate = new SessionConcurrencyGate(2);
    const reloaded = fresh.getManagedRuntime({
      parentSessionId,
      agentDir,
      limits,
      gate: nextGate,
      ports,
    });
    expect(reloaded).not.toBe(runtime);
    expect(gate.status.active).toBe(0);
    expect(nextGate.status.active).toBe(1);
    await reloaded.stop(handle);
    await tick();
    expect(nextGate.status.active).toBe(0);
    expect(gate.status.active).toBe(0);
  });

  test("an aborted spawn reports aborted, not capacity", async () => {
    const { runtime, gate } = setup();
    const controller = new AbortController();
    controller.abort();
    const error = await expectCode(
      runtime.spawn(launch(), controller.signal),
      "aborted",
    );
    expect(error.message).toBe("Subagent was aborted before it started.");
    expect(gate.status.active).toBe(0);
    expect(runtime.list()).toEqual([]);
  });

  test("open is unsupported outside Herdr", async () => {
    const { runtime } = setup();
    const { handle } = await runtime.spawn(launch());
    await expectCode(runtime.open(handle), "unsupported");
    await runtime.stop(handle);
  });
});

describe("managed runtime suspend, exit, and restore", () => {
  test("suspend interrupts the active assignment and restore resumes idle without replay", async () => {
    const { runtime, host, gate } = setup();
    host.behavior = (prompt) =>
      prompt.includes("first task")
        ? [{ kind: "hang" }]
        : [{ kind: "yield", status: "completed", result: "ok" }];
    const { handle, assignmentId } = await runtime.spawn(launch());
    await waitFor(() => runtime.status(handle).childState === "busy");

    await runtime.suspendAll();
    expect(runtime.status(handle)).toMatchObject({
      lifecycle: "suspended",
      live: false,
    });
    expect(gate.status.active).toBe(0);
    expect(await runtime.wait(handle, { assignmentId })).toMatchObject({
      state: "interrupted",
      terminal: true,
    });

    const results = await runtime.restore();
    expect(results).toEqual([{ handle, restored: true }]);
    expect(host.workers).toHaveLength(2);
    expect(argValue(host.last.request.args, "--session-id")).toBe(handle);
    await tick(30);
    expect(host.last.prompts).toEqual([]);
    expect(await runtime.wait(handle, { assignmentId })).toMatchObject({
      state: "interrupted",
    });

    runtime.send(handle, "after restore");
    expect(await runtime.wait(handle, { timeoutMs: 2_000 })).toMatchObject({
      state: "completed",
    });
    expect(host.last.prompts).toHaveLength(1);
    await runtime.stop(handle);
  });

  test("restore cancels messages that were never read instead of replaying them", async () => {
    const { runtime, host } = setup();
    const release = deferred();
    host.behavior = (prompt) =>
      prompt.includes("first task")
        ? [
            { kind: "until", promise: release.promise },
            { kind: "yield", status: "completed", result: "x" },
          ]
        : [{ kind: "yield", status: "completed", result: "y" }];
    const { handle } = await runtime.spawn(launch());
    await waitFor(() => runtime.status(handle).childState === "busy");
    host.last.bridge!.dispose(); // stop reading the inbox
    const { assignmentId } = runtime.send(handle, "unread");
    host.last.crash();
    await waitFor(() => runtime.status(handle).lifecycle === "exited");
    expect(await runtime.wait(handle, { assignmentId })).toMatchObject({
      state: "cancelled",
      terminal: true,
    });

    // Crashed workers are not auto-restored; an explicit resume is still idle.
    expect(await runtime.restore()).toEqual([]);
    await runtime.resume(handle);
    await tick(40);
    expect(host.workers).toHaveLength(2);
    expect(host.last.prompts).toEqual([]);
    expect(await runtime.wait(handle, { assignmentId })).toMatchObject({
      state: "cancelled",
      terminal: true,
    });
    release.resolve();
    await runtime.stop(handle);
  });

  test("unexpected exits are recorded, release the slot, and block sends until resume", async () => {
    const { runtime, host, gate } = setup();
    host.behavior = () => [{ kind: "hang" }];
    const { handle, assignmentId } = await runtime.spawn(launch());
    await waitFor(() => runtime.status(handle).childState === "busy");
    host.last.crash();
    await waitFor(() => runtime.status(handle).lifecycle === "exited");
    expect(gate.status.active).toBe(0);
    expect(runtime.status(handle).lastError).toContain("exited unexpectedly");
    expect(await runtime.wait(handle, { assignmentId })).toMatchObject({
      state: "interrupted",
    });
    expect(() => runtime.send(handle, "hello")).toThrow(/resume it/);

    host.behavior = () => [
      { kind: "yield", status: "completed", result: "back" },
    ];
    expect(await runtime.resume(handle)).toMatchObject({
      lifecycle: "running",
      live: true,
    });
    runtime.send(handle, "hello");
    expect(await runtime.wait(handle, { timeoutMs: 2_000 })).toMatchObject({
      outcome: { result: "back" },
    });
    await runtime.stop(handle);
  });

  test("stop forces tree cleanup after the grace window", async () => {
    const { runtime, host, gate } = setup({ graceMs: 30 });
    host.startModes = ["ignoreShutdown"];
    const { handle } = await runtime.spawn(launch());
    await runtime.wait(handle, { timeoutMs: 2_000 });
    await runtime.stop(handle);
    expect(host.last.shutdownRequests).toBe(1);
    expect(host.last.terminated).toBe(true);
    expect(gate.status.active).toBe(0);
    expect(runtime.status(handle).lifecycle).toBe("stopped");
  });
});

describe("managed runtime delivery and fallback safety", () => {
  test("a prompt Pi echoes but never starts falls back to the next model", async () => {
    const { runtime, host } = setup();
    host.behavior = (_prompt, context) =>
      context.model === "fake/bad"
        ? [{ kind: "reject" }]
        : [
            {
              kind: "yield",
              status: "completed",
              result: `ran on ${context.model}`,
            },
          ];
    const { handle, assignmentId } = await runtime.spawn(
      launch({ modelCandidates: ["fake/bad", "fake/good"] }),
    );
    expect(
      await runtime.wait(handle, { assignmentId, timeoutMs: 3_000 }),
    ).toMatchObject({
      state: "completed",
      outcome: { result: "ran on fake/good" },
    });
    expect(host.workers[0]!.prompts).toEqual([]);
    expect(runtime.status(handle).attempts[0]?.error).toContain(
      "did not start this assignment",
    );
  });

  test("wait never returns the failed attempt while a slow fallback teardown runs", async () => {
    const { runtime, host } = setup({
      graceMs: 1_000,
      ports: { sleep: holdGrace(1_000) },
    });
    const teardown = deferred();
    host.slowExitGate = teardown.promise;
    host.startModes = ["slowExit"];
    host.behavior = (_prompt, context) =>
      context.model === "fake/bad"
        ? [{ kind: "error", message: "model unavailable" }]
        : [{ kind: "yield", status: "completed", result: "recovered" }];
    const { handle, assignmentId } = await runtime.spawn(
      launch({ modelCandidates: ["fake/bad", "fake/good"] }),
    );
    const seen = new Set<string>();
    let pollsDuringTeardown = 0;
    const deadline = Date.now() + 3_000;
    for (;;) {
      const view = await runtime.wait(handle, { assignmentId, timeoutMs: 0 });
      seen.add(view.state);
      // Let several polls observe the held worker before its teardown finishes.
      if (
        host.workers[0]?.shutdownRequests === 1 &&
        ++pollsDuringTeardown === 5
      )
        teardown.resolve();
      if (view.terminal) {
        expect(view).toMatchObject({
          state: "completed",
          outcome: { result: "recovered" },
        });
        break;
      }
      if (Date.now() > deadline) throw new Error("fallback never finished");
      await tick(3);
    }
    expect(seen.has("failed")).toBe(false);
    expect(host.workers).toHaveLength(2);
    expect(host.workers[0]!.terminated).toBe(false);
    expect(host.liveAtLaunch).toEqual([0, 0]);
  });

  test("a non-retryable startup failure stops the model walk; a retryable one continues", async () => {
    const blocked = setup();
    blocked.host.launchErrors = [
      new ManagedStartupError("Pi is blocked during startup.", false),
    ];
    const error = await expectCode(
      blocked.runtime.spawn(launch({ modelCandidates: ["fake/a", "fake/b"] })),
      "launch",
    );
    expect(error.message).toContain("blocked during startup");
    expect(blocked.host.workers).toHaveLength(0);
    expect(blocked.gate.status.active).toBe(0);

    const retry = setup();
    retry.host.launchErrors = [
      new ManagedStartupError("Pi exited before it was ready.", true),
    ];
    const { handle } = await retry.runtime.spawn(
      launch({ modelCandidates: ["fake/a", "fake/b"] }),
    );
    expect(
      await retry.runtime.wait(handle, { timeoutMs: 2_000 }),
    ).toMatchObject({ state: "completed" });
    expect(retry.host.workers.map((worker) => worker.model)).toEqual([
      "fake/b",
    ]);
  });

  test("aborting a launch stops the startup wait and releases the slot", async () => {
    const { runtime, host, gate } = setup();
    host.startModes = ["never"];
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(), 30);
    await expectCode(
      runtime.spawn(
        launch({ modelCandidates: ["fake/a", "fake/b"] }),
        controller.signal,
      ),
      "aborted",
    );
    expect(Date.now() - started).toBeLessThan(800);
    expect(host.workers).toHaveLength(1);
    expect(host.last.terminated).toBe(true);
    expect(gate.status.active).toBe(0);
  });

  test("the parent terminates a worker that ignores its own runtime limit", async () => {
    const { runtime, host, gate } = setup({
      limits: { maxRuntimeMs: 40 },
      ports: { watchdogGraceMs: 40 },
    });
    host.behavior = () => [{ kind: "stuck" }];
    const { handle, assignmentId } = await runtime.spawn(launch());
    await waitFor(() => host.last.terminated);
    await waitFor(() => runtime.status(handle).lifecycle === "exited");
    expect(runtime.status(handle).lastError).toContain("runtime limit");
    expect(await runtime.wait(handle, { assignmentId })).toMatchObject({
      state: "interrupted",
      terminal: true,
    });
    expect(gate.status.active).toBe(0);
  });

  test("the parent terminates a worker that ignores its own inactivity limit", async () => {
    const { runtime, host, gate } = setup({
      limits: { maxInactivityMs: 20 },
      ports: { watchdogGraceMs: 10 },
    });
    host.behavior = () => [{ kind: "stuck" }];
    const { handle, assignmentId } = await runtime.spawn(launch());
    await waitFor(() =>
      runtime
        .status(handle)
        .recentAssignments.some(
          (assignment) =>
            assignment.id === assignmentId && assignment.state === "running",
        ),
    );
    await waitFor(() => host.last.terminated);
    await waitFor(() => runtime.status(handle).lifecycle === "exited");
    expect(runtime.status(handle).lastError).toContain("inactivity limit");
    expect(await runtime.wait(handle, { assignmentId })).toMatchObject({
      state: "interrupted",
      terminal: true,
    });
    expect(gate.status.active).toBe(0);
  });
});

describe("managed runtime session safety", () => {
  test("a worker whose session was replaced reports its work and later messages as ended", async () => {
    const { runtime, host } = setup();
    host.startModes = ["ignoreShutdown"];
    const { handle, assignmentId: first } = await runtime.spawn(launch());
    await runtime.wait(handle, { assignmentId: first, timeoutMs: 2_000 });
    host.behavior = () => [{ kind: "hang" }];
    const { assignmentId: busy } = runtime.send(handle, "long task");
    await waitFor(() =>
      runtime
        .status(handle)
        .recentAssignments.some(
          (assignment) =>
            assignment.id === busy && assignment.state === "running",
        ),
    );

    host.last.replaceSession("someone-elses-session");
    const ended = await runtime.wait(handle, {
      assignmentId: busy,
      timeoutMs: 2_000,
    });
    expect(ended).toMatchObject({ state: "interrupted", terminal: true });
    expect(ended.outcome?.result).toContain("replaced by /new");

    // The detached bridge no longer reads the inbox; nothing waits forever.
    const { assignmentId: late } = runtime.send(handle, "after replacement");
    const view = await runtime.wait(handle, {
      assignmentId: late,
      timeoutMs: 2_000,
    });
    expect(view).toMatchObject({ state: "cancelled", terminal: true });
    expect(view.outcome?.result).toContain("someone-elses-session");
    expect(host.last.prompts).toHaveLength(2);
    await runtime.stop(handle);
  });

  test("derives detached views only from the live boot's own status", () => {
    const config = {
      v: 1 as const,
      handle: "mw-x",
      parentSessionId: "parent-session",
      createdAt: 1,
      launch: {} as never,
      lifecycle: "running" as const,
      candidateIndex: 0,
      sessionId: "mw-x",
      attempts: [],
      nextSeq: 3,
      lastAssignmentId: "a2",
      updatedAt: 1,
    };
    const status: ChildStatus = {
      v: 1,
      bootId: "boot-1",
      pid: 1,
      state: "stopping",
      sessionId: "mw-x",
      ackedSeq: 1,
      queue: [],
      assignments: [],
      usage: emptyUsage(),
      toolActivity: false,
      lastError: "Parent Pi process exited; this worker stopped.",
      updatedAt: 1,
    };
    const view = (raw: ChildStatus, liveBootId: string | undefined) =>
      deriveAssignmentView({
        config,
        status: raw,
        inboxText: (id) =>
          id === "a2" ? { seq: 2, text: "unread" } : undefined,
        ...(liveBootId ? { liveBootId } : {}),
        assignmentId: "a2",
      });
    expect(view(status, "boot-1")).toMatchObject({
      state: "cancelled",
      terminal: true,
    });
    expect(view(status, "boot-1")?.outcome?.result).toContain(
      "Parent Pi process exited",
    );
    // A healthy worker that has not read the message yet still owes it.
    const { lastError: _lastError, ...healthy } = status;
    expect(view({ ...healthy, state: "idle" }, "boot-1")).toMatchObject({
      state: "queued",
      terminal: false,
    });
    // An older boot's status says nothing about the live one.
    expect(view(status, "boot-2")).toMatchObject({
      state: "queued",
      terminal: false,
    });
    // A live boot reporting another session is detached even without an error.
    expect(
      view({ ...healthy, state: "idle", sessionId: "other" }, "boot-1"),
    ).toMatchObject({ state: "cancelled", terminal: true });
  });

  test("restore waits for a surviving earlier boot to exit before starting another", async () => {
    const first = setup();
    const { handle } = await first.runtime.spawn(launch());
    await first.runtime.wait(handle, { timeoutMs: 2_000 });
    const survivor = first.host.last;

    // A new parent process starts with no record of live workers.
    forgetRuntimes();
    const second = setup({ agentDir: first.agentDir, host: first.host });
    const restoring = second.runtime.restore();
    await waitFor(() => survivor.shutdownRequests === 1);
    expect(second.gate.status.active).toBe(1);
    expect(await restoring).toEqual([{ handle, restored: true }]);
    expect(survivor.exited).toBe(true);
    expect(first.host.liveAtLaunch).toEqual([0, 0]);
    expect(first.host.workers).toHaveLength(2);
    await second.runtime.stop(handle);
  });

  test("restore refuses to start a second copy while the earlier boot will not exit", async () => {
    const first = setup({ graceMs: 30 });
    first.host.startModes = ["ignoreShutdown"];
    const { handle } = await first.runtime.spawn(launch());
    await first.runtime.wait(handle, { timeoutMs: 2_000 });

    forgetRuntimes();
    const second = setup({
      agentDir: first.agentDir,
      host: first.host,
      ports: virtualClock(),
    });
    const [result] = await second.runtime.restore();
    expect(result).toMatchObject({ handle, restored: false });
    expect(result?.error).toContain("still running");
    expect(first.host.workers).toHaveLength(1);
    expect(second.gate.status.active).toBe(0);
    await first.runtime.stop(handle);
  });

  test("resume fails safely when the earlier boot cannot be identified", async () => {
    const first = setup();
    const { handle } = await first.runtime.spawn(launch());
    await first.runtime.wait(handle, { timeoutMs: 2_000 });

    forgetRuntimes();
    const second = setup({
      agentDir: first.agentDir,
      host: first.host,
      ports: { processIdentity: async () => "unknown" },
    });
    const [result] = await second.runtime.restore();
    expect(result?.error).toContain("cannot be verified");
    expect(first.host.last.shutdownRequests).toBe(0);
    expect(first.host.workers).toHaveLength(1);
    await first.runtime.stop(handle);
  });
});

describe("managed runtime result listing", () => {
  test("a reload detects the default host again without launching a pane", async () => {
    const agentDir = fs.mkdtempSync(
      path.join(tmpdir(), "managed-runtime-reload-"),
    );
    roots.push(agentDir);
    const limits = { ...LIMITS };
    const gate = new SessionConcurrencyGate(limits.maxConcurrency);
    const options = {
      parentSessionId: "parent-default-host",
      agentDir,
      limits,
      gate,
      env: {
        HERDR_ENV: "1",
        HERDR_WORKSPACE_ID: "ws-1",
        HERDR_TAB_ID: "caller-tab",
        HERDR_PANE_ID: "parent-pane",
        HERDR_BIN_PATH: process.execPath,
      },
    };
    const runtime = getManagedRuntime(options);
    expect(managedRuntimeHostKind(runtime)).toBe("herdr");

    vi.resetModules();
    const fresh = await import("../src/_managed.ts");
    const reloaded = fresh.getManagedRuntime({ ...options, env: {} });
    expect(reloaded).not.toBe(runtime);
    expect(fresh.managedRuntimeHostKind(reloaded)).toBe("rpc");
    // The accessor reads runtimes from any module revision.
    expect(managedRuntimeHostKind(reloaded)).toBe("rpc");
    expect(fresh.managedRuntimeHostKind(runtime)).toBe("herdr");
  });

  test("a /reload re-evaluation builds a fresh runtime over the surviving workers", async () => {
    const { runtime, host, gate, limits, agentDir, parentSessionId, ports } =
      setup();
    const { handle, assignmentId } = await runtime.spawn(launch());
    await runtime.wait(handle, { assignmentId, timeoutMs: 2_000 });
    const options = { parentSessionId, agentDir, limits, gate, env: {}, ports };
    // Reuse within one module revision returns the same runtime.
    expect(getManagedRuntime(options)).toBe(runtime);
    const pid = runtime.status(handle).placement;
    const prompts = host.last.prompts.length;

    vi.resetModules();
    const fresh = await import("../src/_managed.ts");
    const reloaded = fresh.getManagedRuntime(options);

    expect(reloaded).not.toBe(runtime);
    expect(fresh.getManagedRuntime(options)).toBe(reloaded);
    expect(reloaded.listResults()).toMatchObject([
      { handle, id: assignmentId, state: "completed" },
    ]);
    expect(reloaded.listResults()).toHaveLength(1);
    expect(reloaded.status(handle)).toMatchObject({
      live: true,
      lifecycle: "running",
      placement: pid,
    });
    expect(host.workers).toHaveLength(1);
    expect(host.last.prompts).toHaveLength(prompts);
    expect(gate.status.active).toBe(1);

    reloaded.send(handle, "after reload");
    expect(await reloaded.wait(handle, { timeoutMs: 2_000 })).toMatchObject({
      state: "completed",
      outcome: { result: "done: after reload" },
    });
    expect(host.workers).toHaveLength(1);
    await reloaded.stop(handle);
    expect(gate.status.active).toBe(0);
  });

  test("a clean quit after completion keeps the result and releases the slot", async () => {
    const { runtime, host, gate } = setup();
    const { handle, assignmentId } = await runtime.spawn(launch());
    await runtime.wait(handle, { assignmentId, timeoutMs: 2_000 });
    expect(gate.status.active).toBe(1);

    host.last.quit();
    await waitFor(() => runtime.status(handle).lifecycle === "exited");
    const view = runtime.status(handle);
    expect(view.lastError).toBeUndefined();
    expect(view.live).toBe(false);
    expect(gate.status.active).toBe(0);
    expect(await runtime.wait(handle, { assignmentId })).toMatchObject({
      state: "completed",
      outcome: { result: "done: first task" },
    });
    expect(runtime.listResults()).toMatchObject([
      { handle, id: assignmentId, state: "completed" },
    ]);
  });

  test("normalizes only the legacy generic diagnostic after a clean exit", async () => {
    const { runtime, host } = setup();
    const { handle, assignmentId } = await runtime.spawn(launch());
    await runtime.wait(handle, { assignmentId, timeoutMs: 2_000 });
    host.last.quit();
    await waitFor(() => runtime.status(handle).lifecycle === "exited");
    const paths = managedPaths(runtime.status(handle).dir);
    const config = readManagedConfig(paths.config)!;
    writeJsonAtomic(paths.config, {
      ...config,
      lastError: "Worker process exited unexpectedly.",
    });
    expect(runtime.status(handle).lastError).toBeUndefined();
    expect(runtime.listResults()[0]?.state).toBe("completed");

    const failure =
      "Worker exceeded its runtime limit; the parent terminated it.";
    writeJsonAtomic(paths.config, { ...config, lastError: failure });
    expect(runtime.status(handle).lastError).toBe(failure);

    const status = readChildStatus(paths.status)!;
    writeJsonAtomic(paths.status, {
      ...status,
      lastError: "Child failed to shut down cleanly.",
    });
    writeJsonAtomic(paths.config, {
      ...config,
      lastError: "Worker process exited unexpectedly.",
    });
    expect(runtime.status(handle).lastError).toBe(
      "Worker process exited unexpectedly.",
    );
  });

  test("lists every terminal result beyond the recent window without launching", async () => {
    const { runtime, host, agentDir } = setup();
    const { handle, assignmentId } = await runtime.spawn(launch());
    const ids = [assignmentId];
    await runtime.wait(handle, { assignmentId, timeoutMs: 2_000 });
    for (let index = 0; index < 6; index++) {
      const next = runtime.send(handle, `task ${index}`);
      ids.push(next.assignmentId);
      await runtime.wait(handle, {
        assignmentId: next.assignmentId,
        timeoutMs: 2_000,
      });
    }
    expect(runtime.status(handle).recentAssignments.length).toBeLessThan(7);
    const workers = host.workers.length;
    await runtime.stop(handle);

    const results = runtime.listResults();
    expect(results.map((result) => result.id)).toEqual(ids);
    expect(results.every((result) => result.state === "completed")).toBe(true);
    expect(host.workers).toHaveLength(workers);

    // A new parent process reads the same results from disk.
    forgetRuntimes();
    const restored = setup({ agentDir });
    expect(restored.runtime.listResults().map((result) => result.id)).toEqual(
      ids,
    );
    expect(restored.host.workers).toHaveLength(0);
  });

  test("folds merged steers into their root result", async () => {
    const { runtime, host } = setup();
    const release = deferred();
    host.behavior = (prompt) =>
      prompt.includes("first task")
        ? [
            { kind: "until", promise: release.promise },
            { kind: "yield", status: "completed", result: "first" },
          ]
        : [{ kind: "yield", status: "completed", result: "follow" }];
    const { handle, assignmentId: first } = await runtime.spawn(launch());
    await waitFor(() => runtime.status(handle).childState === "busy");
    const steer = runtime.send(handle, "also check docs");
    await waitFor(() => host.last.steers.length === 1);
    release.resolve();
    await runtime.wait(handle, {
      assignmentId: steer.assignmentId,
      timeoutMs: 2_000,
    });

    expect(runtime.listResults()).toMatchObject([
      { id: first, mergedUpdates: [steer.assignmentId] },
    ]);
    await runtime.stop(handle);
  });

  test("never lists a failed attempt while its fallback is pending, or a launch failure", async () => {
    const { runtime, host } = setup({
      graceMs: 1_000,
      ports: { sleep: holdGrace(1_000) },
    });
    const teardown = deferred();
    host.slowExitGate = teardown.promise;
    host.startModes = ["slowExit"];
    host.behavior = (_prompt, context) =>
      context.model === "fake/bad"
        ? [{ kind: "error", message: "model unavailable" }]
        : [{ kind: "yield", status: "completed", result: "recovered" }];
    const { handle, assignmentId } = await runtime.spawn(
      launch({ modelCandidates: ["fake/bad", "fake/good"] }),
    );
    const seen: string[] = [];
    let pollsDuringTeardown = 0;
    const deadline = Date.now() + 3_000;
    while (!seen.includes("completed")) {
      seen.push(...runtime.listResults().map((result) => result.state));
      if (
        host.workers[0]?.shutdownRequests === 1 &&
        ++pollsDuringTeardown === 5
      )
        teardown.resolve();
      if (Date.now() > deadline) throw new Error("fallback never finished");
      await tick(3);
    }
    expect(seen.filter((state) => state !== "completed")).toEqual([]);
    expect(runtime.listResults()).toMatchObject([
      { handle, id: assignmentId, outcome: { result: "recovered" } },
    ]);

    const blocked = setup();
    blocked.host.launchErrors = [
      new ManagedStartupError("Pi is blocked during startup.", false),
    ];
    await expectCode(blocked.runtime.spawn(launch()), "launch");
    expect(blocked.runtime.listResults()).toEqual([]);
  });
});
