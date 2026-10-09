import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { SessionConcurrencyGate } from "../src/_concurrency.ts";
import type { SubagentLimitsConfig } from "../src/_limits.ts";
import {
  createHerdrHost,
  createRpcHost,
  createRpcRecordReader,
  deriveAssignmentView,
  detectManagedHost,
  getManagedRuntime,
  handleRpcRecord,
  HerdrCommandError,
  herdrAgentName,
  herdrForwardEnvironment,
  ManagedError,
  type ManagedHostLaunch,
  type ManagedHostPort,
  type ManagedHostProcess,
  type ManagedLaunch,
  type ManagedRuntimePorts,
  ManagedStartupError,
  parseElapsedSeconds,
  parseHerdrError,
} from "../src/_managed.ts";
import {
  ManagedChildBridge,
  managedBridgeOptionsFromEnv,
} from "../src/_managed-child.ts";
import {
  type ChildStatus,
  emptyUsage,
  managedParentDir,
  managedPaths,
  readChildStatus,
  parseManagedConfig,
  readManagedConfig,
  writeArchivedAssignment,
  writeJsonAtomic,
} from "../src/_managed-store.ts";
import { SubagentProcessRegistry } from "../src/_process-tree.ts";

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

const SLOW_EXIT_MS = 150;

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
        setTimeout(
          () => {
            this.bridge?.onShutdown();
            this.markExited();
          },
          this.mode === "slowExit" ? SLOW_EXIT_MS : 1,
        );
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

  async launch(request: ManagedHostLaunch): Promise<ManagedHostProcess> {
    const failure = this.launchErrors.shift();
    if (failure) throw failure;
    this.liveAtLaunch.push(this.workers.filter((w) => !w.exited).length);
    const worker = new FakeWorker(
      request,
      this.workers.length,
      (prompt, context) => this.behavior(prompt, context),
      this.startModes.shift() ?? "ok",
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

const RUNTIMES = Symbol.for("pi-simple-subagents.managed-runtimes");

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
  const runtime = getManagedRuntime({
    parentSessionId,
    agentDir,
    limits,
    gate,
    env: options.env ?? {},
    ports: {
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
    },
  });
  return { agentDir, limits, gate, host, runtime, parentSessionId };
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
    const { runtime, host } = setup({ graceMs: 1_000 });
    host.startModes = ["slowExit"];
    host.behavior = (_prompt, context) =>
      context.model === "fake/bad"
        ? [{ kind: "error", message: "model unavailable" }]
        : [{ kind: "yield", status: "completed", result: "recovered" }];
    const { handle, assignmentId } = await runtime.spawn(
      launch({ modelCandidates: ["fake/bad", "fake/good"] }),
    );
    const seen = new Set<string>();
    const deadline = Date.now() + 3_000;
    for (;;) {
      const view = await runtime.wait(handle, { assignmentId, timeoutMs: 0 });
      seen.add(view.state);
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
        live: liveBootId !== undefined,
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
    const second = setup({ agentDir: first.agentDir, host: first.host });
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

describe("rpc host", () => {
  test("parses LF-delimited records across chunk boundaries and skips transcript lines", () => {
    const records: Record<string, unknown>[] = [];
    const reader = createRpcRecordReader((record) => records.push(record));
    const dialog = JSON.stringify({
      type: "extension_ui_request",
      id: "d1",
      method: "confirm",
      title: "Proceed\u2028now? é",
    });
    const bytes = Buffer.from(
      `${JSON.stringify({ type: "message_update", text: "x".repeat(5_000) })}\n${dialog}\r\n{"type":"extension_error","error":"boom"}`,
    );
    const split = bytes.indexOf(Buffer.from("é")) + 1; // inside the two-byte é
    reader.push(bytes.subarray(0, split));
    reader.push(bytes.subarray(split));
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      id: "d1",
      title: "Proceed\u2028now? é",
    });
    reader.end();
    expect(records[1]).toMatchObject({
      type: "extension_error",
      error: "boom",
    });

    const oversized: unknown[] = [];
    const strict = createRpcRecordReader((record) => oversized.push(record));
    strict.push(
      `{"type":"extension_ui_request","id":"big","method":"editor","prefill":"${"y".repeat(1_100_000)}"}\n`,
    );
    expect(oversized).toEqual([]);
  });

  test("cancels dialogs by id, logs extension errors, and never copies notification text", () => {
    const responses: unknown[] = [];
    const log: string[] = [];
    const respond = (response: Record<string, unknown>) =>
      responses.push(response);
    handleRpcRecord(
      { type: "extension_ui_request", id: "q", method: "select" },
      respond,
      (entry) => log.push(entry),
    );
    handleRpcRecord(
      {
        type: "extension_ui_request",
        id: "n",
        method: "notify",
        notifyType: "error",
        message: "secret-ish text",
      },
      respond,
      (entry) => log.push(entry),
    );
    handleRpcRecord(
      {
        type: "extension_error",
        extensionPath: "/x/ext.ts",
        event: "input",
        error: "bad",
      },
      respond,
      (entry) => log.push(entry),
    );
    expect(responses).toEqual([
      { type: "extension_ui_response", id: "q", cancelled: true },
    ]);
    expect(log.join("\n")).not.toContain("secret-ish");
    expect(log.at(-1)).toBe("extension error in input (ext.ts): bad");
  });

  test("answers a real child's dialog with a cancel and stops it by closing stdin", async () => {
    const dir = fs.mkdtempSync(path.join(tmpdir(), "managed-rpc-"));
    roots.push(dir);
    const paths = managedPaths(dir);
    fs.mkdirSync(dir, { recursive: true });
    const script = path.join(dir, "child.mjs");
    const reply = path.join(dir, "reply.json");
    fs.writeFileSync(
      script,
      `
import * as fs from "node:fs";
process.stdout.write(JSON.stringify({ type: "extension_ui_request", id: "d1", method: "confirm", title: "ok?" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "extension_error", extensionPath: "/e/x.ts", event: "input", error: "kaboom" }) + "\\n");
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  if (buffer.includes("\\n")) fs.writeFileSync(${JSON.stringify(reply)}, buffer.split("\\n")[0]);
});
process.stdin.on("end", () => process.exit(0));
`,
    );
    const host = createRpcHost(new SubagentProcessRegistry());
    const proc = await host.launch({
      handle: "mw-rpc",
      bootId: "b",
      label: "x",
      cwd: dir,
      command: process.execPath,
      args: [script],
      piArgs: [],
      env: {},
      paths,
    });
    await waitFor(() => fs.existsSync(reply), 5_000);
    expect(JSON.parse(fs.readFileSync(reply, "utf8"))).toEqual({
      type: "extension_ui_response",
      id: "d1",
      cancelled: true,
    });
    proc.requestStop?.();
    await proc.exited;
    const stderr = fs.readFileSync(paths.stderr, "utf8");
    expect(stderr).toContain("cancelled a confirm dialog");
    expect(stderr).toContain("extension error in input (x.ts): kaboom");
  });
});

describe("herdr host", () => {
  function herdrHost(
    exec: (bin: string, args: readonly string[]) => Promise<string>,
    forwardEnv?: Record<string, string>,
    sleep: (ms: number, signal?: AbortSignal) => Promise<void> = () => tick(2),
  ) {
    return createHerdrHost({
      parentPaneId: "parent-pane",
      tabId: "caller-tab",
      bin: "herdr",
      exec,
      registry: new SubagentProcessRegistry(),
      isPidAlive: () => false,
      sleep,
      pollMs: 2,
      ...(forwardEnv ? { forwardEnv } : {}),
    });
  }

  function request(
    dir: string,
    overrides: Partial<ManagedHostLaunch> = {},
  ): ManagedHostLaunch {
    return {
      handle: "mw-abcdef",
      bootId: "boot-123",
      label: "🤖 c3po abcdef",
      cwd: "/work",
      command: "/usr/bin/node",
      args: ["/pi/cli.js", "--name", "it's"],
      piArgs: ["--name", "it's"],
      env: { PI_MANAGED_SUBAGENT_DIR: dir },
      paths: managedPaths(dir),
      ownedPlacements: [],
      ...overrides,
    };
  }

  const paneCreated = JSON.stringify({
    result: { pane: { pane_id: "p-9" } },
  });

  test("splits below the caller without focus and closes only its pane", async () => {
    const calls: string[][] = [];
    const host = herdrHost(
      async (_bin, args) => {
        calls.push([...args]);
        return args[0] === "pane" ? paneCreated : "{}";
      },
      { PI_OFFLINE: "1" },
    );
    const dir = fs.mkdtempSync(path.join(tmpdir(), "managed-herdr-"));
    roots.push(dir);
    const proc = await host.launch(request(dir));
    expect(proc.placement).toEqual({
      kind: "herdr",
      tabId: "caller-tab",
      paneId: "p-9",
      layout: "split",
    });
    expect(proc.readyConfirmed).toBe(true);
    expect(calls[0]).toEqual([
      "pane",
      "split",
      "--pane",
      "parent-pane",
      "--direction",
      "down",
      "--cwd",
      "/work",
      "--no-focus",
      "--env",
      "PI_OFFLINE=1",
      "--env",
      `PI_MANAGED_SUBAGENT_DIR=${dir}`,
    ]);
    expect(calls[1]).toEqual([
      "agent",
      "start",
      herdrAgentName("mw-abcdef", "boot-123"),
      "--kind",
      "pi",
      "--pane",
      "p-9",
      "--timeout",
      "15000",
      "--",
      "--name",
      "it's",
    ]);
    expect(calls.flat()).not.toContain("--approve");
    expect(calls.some((args) => args[0] === "tab")).toBe(false);

    await host.focus(proc.placement);
    expect(calls.at(-1)).toEqual(["agent", "focus", "p-9"]);
    await host.focus({ kind: "herdr", tabId: "old-tab", paneId: "old-pane" });
    expect(calls.at(-1)).toEqual(["agent", "focus", "old-pane"]);
    await proc.terminate();
    await proc.exited;
    expect(calls.at(-1)).toEqual(["pane", "close", "p-9"]);
    expect(calls.some((args) => args[0] === "tab")).toBe(false);
    expect(readChildStatus(managedPaths(dir).status)).toBeUndefined();
  });
  test("retries pane-busy startup until Herdr accepts the agent", async () => {
    const calls: string[][] = [];
    const delays: number[] = [];
    const dir = fs.mkdtempSync(path.join(tmpdir(), "managed-herdr-busy-"));
    roots.push(dir);
    const host = herdrHost(
      async (_bin, args) => {
        calls.push([...args]);
        if (args[0] === "pane") return paneCreated;
        if (args[0] === "agent" && args[1] === "start") {
          const attempts = calls.filter(
            (call) => call[0] === "agent" && call[1] === "start",
          );
          if (attempts.length < 3)
            throw new HerdrCommandError("agent_pane_busy", "pane busy");
        }
        return "{}";
      },
      undefined,
      // The PID liveness poll shares this sleep; record only startup retries
      // and yield so the poll loop cannot starve the event loop.
      async (ms) => {
        if (ms === 2) return tick(2);
        delays.push(ms);
      },
    );

    const proc = await host.launch(request(dir));

    expect(
      calls.filter((call) => call[0] === "agent" && call[1] === "start"),
    ).toHaveLength(3);
    expect(delays).toEqual([100, 100]);
    await proc.terminate();
    expect(calls.at(-1)).toEqual(["pane", "close", "p-9"]);
  });

  test("exhausting pane-busy retries closes the allocated pane", async () => {
    const calls: string[][] = [];
    const delays: number[] = [];
    const dir = fs.mkdtempSync(path.join(tmpdir(), "managed-herdr-busy-"));
    roots.push(dir);
    const host = herdrHost(
      async (_bin, args) => {
        calls.push([...args]);
        if (args[0] === "pane") return paneCreated;
        if (args[0] === "agent" && args[1] === "start")
          throw new HerdrCommandError("agent_pane_busy", "pane busy");
        return "{}";
      },
      undefined,
      async (ms) => {
        delays.push(ms);
      },
    );

    const error = await host.launch(request(dir)).then(
      () => undefined,
      (failure: unknown) => failure,
    );

    expect(error).toBeInstanceOf(ManagedStartupError);
    expect((error as ManagedStartupError).retryable).toBe(false);
    expect(
      calls.filter((call) => call[0] === "agent" && call[1] === "start"),
    ).toHaveLength(30);
    expect(delays).toHaveLength(29);
    expect(delays.every((ms) => ms === 100)).toBe(true);
    expect(
      calls.filter((call) => call[0] === "pane" && call[1] === "close"),
    ).toEqual([["pane", "close", "p-9"]]);
  });

  test("does not retry non-busy startup failures", async () => {
    const calls: string[][] = [];
    const delays: number[] = [];
    const dir = fs.mkdtempSync(path.join(tmpdir(), "managed-herdr-failure-"));
    roots.push(dir);
    const host = herdrHost(
      async (_bin, args) => {
        calls.push([...args]);
        if (args[0] === "pane") return paneCreated;
        if (args[0] === "agent" && args[1] === "start")
          throw new HerdrCommandError("agent_not_ready", "blocked");
        return "{}";
      },
      undefined,
      async (ms) => {
        delays.push(ms);
      },
    );

    const error = await host.launch(request(dir)).then(
      () => undefined,
      (failure: unknown) => failure,
    );

    expect(error).toBeInstanceOf(ManagedStartupError);
    expect(calls.filter((call) => call[0] === "agent")).toHaveLength(1);
    expect(delays).toEqual([]);
    expect(calls.at(-1)).toEqual(["pane", "close", "p-9"]);
  });

  test("cancellation during a pane-busy retry delay closes the pane", async () => {
    const calls: string[][] = [];
    const controller = new AbortController();
    const delayStarted = deferred();
    const dir = fs.mkdtempSync(path.join(tmpdir(), "managed-herdr-abort-"));
    roots.push(dir);
    const host = herdrHost(
      async (_bin, args) => {
        calls.push([...args]);
        if (args[0] === "pane") return paneCreated;
        if (args[0] === "agent" && args[1] === "start")
          throw new HerdrCommandError("agent_pane_busy", "pane busy");
        return "{}";
      },
      undefined,
      (_ms, signal) =>
        new Promise<void>((_resolve, reject) => {
          const abort = () =>
            reject(
              new ManagedError("aborted", "Managed worker launch was aborted."),
            );
          if (!signal) {
            reject(new Error("retry delay did not receive an abort signal"));
            return;
          }
          if (signal.aborted) {
            abort();
            return;
          }
          signal.addEventListener("abort", abort, { once: true });
          delayStarted.resolve();
        }),
    );

    const launching = host
      .launch(request(dir, { signal: controller.signal }))
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    await delayStarted.promise;
    controller.abort();
    const error = await launching;

    expect(error).toMatchObject({ code: "aborted" });
    expect(calls.filter((call) => call[0] === "agent")).toHaveLength(1);
    expect(calls.at(-1)).toEqual(["pane", "close", "p-9"]);
  });

  test("reports blocked startup and closes only the owned pane", async () => {
    const dir = fs.mkdtempSync(path.join(tmpdir(), "managed-herdr-"));
    roots.push(dir);
    for (const [code, retryable] of [
      ["agent_not_ready", false],
      ["timeout", false],
      ["agent_start_failed", true],
    ] as const) {
      const calls: string[][] = [];
      const host = herdrHost(async (_bin, args) => {
        calls.push([...args]);
        if (args[0] === "agent") throw new HerdrCommandError(code, "failed");
        return paneCreated;
      });
      const error = await host.launch(request(dir)).then(
        () => undefined,
        (failure: unknown) => failure,
      );
      expect(error).toBeInstanceOf(ManagedStartupError);
      expect((error as ManagedStartupError).retryable).toBe(retryable);
      expect(calls.at(-1)).toEqual(["pane", "close", "p-9"]);
      expect(calls.some((args) => args[0] === "tab")).toBe(false);
    }
  });

  test("never closes the parent when a split response wrongly identifies it", async () => {
    const calls: string[][] = [];
    const host = herdrHost(async (_bin, args) => {
      calls.push([...args]);
      return JSON.stringify({ result: { pane: { pane_id: "parent-pane" } } });
    });
    const dir = fs.mkdtempSync(path.join(tmpdir(), "managed-herdr-parent-"));
    roots.push(dir);
    await expect(host.launch(request(dir))).rejects.toThrow("new pane ID");
    expect(calls.map((args) => args.slice(0, 2))).toEqual([["pane", "split"]]);
  });

  test("keeps the latest lower split as anchor when an earlier worker is still starting", async () => {
    const anchors: string[] = [];
    const starts: string[] = [];
    const firstReady = deferred();
    let sequence = 0;
    const host = herdrHost(async (_bin, args) => {
      if (args[0] === "pane" && args[1] === "split") {
        anchors.push(argValue(args, "--pane")!);
        return JSON.stringify({
          result: { pane: { pane_id: `child-${++sequence}` } },
        });
      }
      if (args[0] === "agent" && args[1] === "start") {
        const pane = argValue(args, "--pane")!;
        starts.push(pane);
        if (pane === "child-1") await firstReady.promise;
      }
      return "{}";
    });
    const dirs = Array.from({ length: 3 }, () => {
      const dir = fs.mkdtempSync(path.join(tmpdir(), "managed-herdr-order-"));
      roots.push(dir);
      return dir;
    });
    const firstLaunch = host.launch(request(dirs[0]!, { handle: "mw-first" }));
    await waitFor(() => starts.includes("child-1"));
    const second = await host.launch(
      request(dirs[1]!, { handle: "mw-second" }),
    );
    const third = await host.launch(
      request(dirs[2]!, {
        handle: "mw-third",
        ownedPlacements: [second.placement],
      }),
    );
    expect(anchors).toEqual(["parent-pane", "child-1", "child-2"]);
    firstReady.resolve();
    const first = await firstLaunch;
    await Promise.all(
      [first, second, third].map((process) => process.terminate()),
    );
  });

  test("allocates a vertical stack serially while starts remain independent", async () => {
    const anchors: string[] = [];
    const started: string[] = [];
    const startGate = deferred();
    let pane = 0;
    const host = herdrHost(async (_bin, args) => {
      if (args[0] === "pane") {
        anchors.push(argValue(args, "--pane")!);
        return JSON.stringify({
          result: {
            pane: { pane_id: `child-${++pane}`, tab_id: "caller-tab" },
          },
        });
      }
      if (args[0] === "agent") {
        started.push(argValue(args, "--pane")!);
        await startGate.promise;
      }
      return "{}";
    });
    const dirs = Array.from({ length: 3 }, () => {
      const dir = fs.mkdtempSync(path.join(tmpdir(), "managed-herdr-stack-"));
      roots.push(dir);
      return dir;
    });
    const launches = dirs.map((dir, index) =>
      host.launch(request(dir, { handle: `mw-stack${index}` })),
    );

    await waitFor(() => started.length === 3);
    expect(anchors).toEqual(["parent-pane", "child-1", "child-2"]);
    startGate.resolve();
    const processes = await Promise.all(launches);
    expect(processes.map((proc) => proc.placement)).toEqual([
      {
        kind: "herdr",
        tabId: "caller-tab",
        paneId: "child-1",
        layout: "split",
      },
      {
        kind: "herdr",
        tabId: "caller-tab",
        paneId: "child-2",
        layout: "split",
      },
      {
        kind: "herdr",
        tabId: "caller-tab",
        paneId: "child-3",
        layout: "split",
      },
    ]);
    await Promise.all(processes.map((proc) => proc.terminate()));
  });

  test("falls back from stale split anchors to a live owned pane then the caller", async () => {
    const tried: string[] = [];
    const dir = fs.mkdtempSync(path.join(tmpdir(), "managed-herdr-anchor-"));
    roots.push(dir);
    const host = herdrHost(async (_bin, args) => {
      if (args[0] === "pane" && args[1] === "split") {
        const anchor = argValue(args, "--pane")!;
        tried.push(anchor);
        if (anchor === "stale")
          throw new HerdrCommandError("pane_not_found", "anchor closed");
        return paneCreated;
      }
      return "{}";
    });
    const proc = await host.launch(
      request(dir, {
        ownedPlacements: [
          {
            kind: "herdr",
            tabId: "caller-tab",
            paneId: "older",
            layout: "split",
          },
          {
            kind: "herdr",
            tabId: "caller-tab",
            paneId: "stale",
            layout: "split",
          },
        ],
      }),
    );
    expect(tried).toEqual(["stale", "older"]);
    await proc.terminate();

    const parentFallback = herdrHost(async (_bin, args) => {
      if (args[0] === "pane" && args[1] === "split") {
        const anchor = argValue(args, "--pane")!;
        tried.push(anchor);
        if (anchor !== "parent-pane")
          throw new HerdrCommandError("pane_not_found", "anchor closed");
        return paneCreated;
      }
      return "{}";
    });
    const next = await parentFallback.launch(
      request(dir, {
        handle: "mw-parent-fallback",
        ownedPlacements: [
          {
            kind: "herdr",
            tabId: "caller-tab",
            paneId: "older",
            layout: "split",
          },
          {
            kind: "herdr",
            tabId: "caller-tab",
            paneId: "stale",
            layout: "split",
          },
        ],
      }),
    );
    expect(tried.slice(2)).toEqual(["stale", "older", "parent-pane"]);
    await next.terminate();
  });

  test("does not replay an ambiguous pane split failure", async () => {
    const calls: string[][] = [];
    const dir = fs.mkdtempSync(path.join(tmpdir(), "managed-herdr-ambiguous-"));
    roots.push(dir);
    const host = herdrHost(async (_bin, args) => {
      calls.push([...args]);
      throw new Error("connection lost after split request");
    });
    await expect(host.launch(request(dir))).rejects.toBeInstanceOf(
      ManagedStartupError,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.slice(0, 2)).toEqual(["pane", "split"]);
  });

  test("falls back to RPC when caller context or Herdr CLI is missing", () => {
    const context = {
      HERDR_ENV: "1",
      HERDR_WORKSPACE_ID: "ws-1",
      HERDR_TAB_ID: "caller-tab",
      HERDR_PANE_ID: "parent-pane",
      HERDR_BIN_PATH: "/missing/herdr",
    };
    expect(
      detectManagedHost(context, new SubagentProcessRegistry(), 2).kind,
    ).toBe("rpc");
    expect(
      detectManagedHost(
        {
          ...context,
          HERDR_BIN_PATH: process.execPath,
          HERDR_PANE_ID: undefined,
        },
        new SubagentProcessRegistry(),
        2,
      ).kind,
    ).toBe("rpc");
  });

  test("forwards only non-secret Pi configuration into panes", () => {
    expect(
      herdrForwardEnvironment({
        PI_CODING_AGENT_DIR: "/agent",
        PI_OFFLINE: "1",
        PI_API_KEY: "secret",
        OPENAI_API_KEY: "secret",
        PI_MANAGED_SUBAGENT_DIR: "/leak",
        PI_TELEMETRY: "",
      }),
    ).toEqual({ PI_CODING_AGENT_DIR: "/agent", PI_OFFLINE: "1" });
  });

  test("parses Herdr's structured errors and builds valid agent names", () => {
    expect(
      parseHerdrError(
        'noise\n{"error":{"code":"agent_not_ready","message":"blocked"}}\n',
      ),
    ).toEqual({ code: "agent_not_ready", message: "blocked" });
    expect(parseHerdrError("plain failure")).toBeUndefined();
    const name = herdrAgentName("mw-ABC_def-0123456789", "Boot-XYZ-0123456789");
    expect(name).toMatch(/^[a-z][a-z0-9_-]{0,31}$/);
  });

  test("accepts legacy Herdr tab placement and split pane markers", () => {
    const base = {
      v: 1,
      handle: "mw-abc123",
      parentSessionId: "parent",
      createdAt: 1,
      launch: {
        agent: { name: "coder", source: "user" },
        modelCandidates: ["model"],
        cwd: "/repo",
        trace: {
          rootSessionId: "root",
          parentSessionId: "parent",
          parentToolCallId: "",
          depth: 0,
        },
        isolation: {},
        taskPreview: "task",
      },
      lifecycle: "running",
      candidateIndex: 0,
      sessionId: "session-1",
      attempts: [],
      nextSeq: 1,
      lastAssignmentId: "assignment-1",
      updatedAt: 2,
    };
    expect(
      parseManagedConfig({
        ...base,
        placement: { kind: "herdr", tabId: "old-tab", paneId: "old-pane" },
      })?.placement,
    ).toEqual({ kind: "herdr", tabId: "old-tab", paneId: "old-pane" });
    expect(
      parseManagedConfig({
        ...base,
        placement: {
          kind: "herdr",
          tabId: "current-tab",
          paneId: "split-pane",
          layout: "split",
        },
      })?.placement,
    ).toEqual({
      kind: "herdr",
      tabId: "current-tab",
      paneId: "split-pane",
      layout: "split",
    });
  });
});

describe("process identity", () => {
  test("parses ps elapsed times", () => {
    expect(parseElapsedSeconds("  05:07\n")).toBe(307);
    expect(parseElapsedSeconds("02:05:07")).toBe(7_507);
    expect(parseElapsedSeconds("3-02:05:07")).toBe(266_707);
    expect(parseElapsedSeconds("garbage")).toBeUndefined();
  });
});

describe("managed runtime result listing", () => {
  test("refreshes the default Herdr adapter after reload without launching a pane", async () => {
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
    const oldHost = (runtime as unknown as { ports: { host: ManagedHostPort } })
      .ports.host;
    expect(oldHost.kind).toBe("herdr");

    vi.resetModules();
    const fresh = await import("../src/_managed.ts");
    const reloaded = fresh.getManagedRuntime({ ...options, env: {} });
    const newHost = (
      reloaded as unknown as { ports: { host: ManagedHostPort } }
    ).ports.host;
    expect(reloaded).toBe(runtime);
    expect(newHost).not.toBe(oldHost);
    expect(newHost.kind).toBe("rpc");
  });

  test("a /reload re-evaluation upgrades the surviving runtime in place", async () => {
    const { runtime, host, gate, limits, agentDir, parentSessionId } = setup();
    const { handle, assignmentId } = await runtime.spawn(launch());
    await runtime.wait(handle, { assignmentId, timeoutMs: 2_000 });
    const options = { parentSessionId, agentDir, limits, gate, env: {} };
    const revision = Object.getPrototypeOf(runtime);
    // Reuse within one module revision leaves the runtime untouched.
    expect(getManagedRuntime(options)).toBe(runtime);
    expect(Object.getPrototypeOf(runtime)).toBe(revision);

    // Stand in for a runtime built by a revision without result listing.
    const legacy = Object.create(Object.prototype);
    for (const name of Object.getOwnPropertyNames(revision))
      if (name !== "listResults" && name !== "workerResults")
        Object.defineProperty(
          legacy,
          name,
          Object.getOwnPropertyDescriptor(revision, name)!,
        );
    Object.setPrototypeOf(runtime, legacy);
    delete (runtime as { resultCache?: unknown }).resultCache;
    expect("listResults" in runtime).toBe(false);
    const pid = runtime.status(handle).placement;
    const hostAdapter = (
      runtime as unknown as { ports: { host: ManagedHostPort } }
    ).ports.host;
    const prompts = host.last.prompts.length;

    vi.resetModules();
    const fresh = await import("../src/_managed.ts");
    const reloaded = fresh.getManagedRuntime(options);

    expect(reloaded).toBe(runtime);
    expect(
      (reloaded as unknown as { ports: { host: ManagedHostPort } }).ports.host,
    ).toBe(hostAdapter);
    expect(Object.getPrototypeOf(reloaded)).not.toBe(legacy);
    expect(
      (reloaded as unknown as { resultCache: unknown }).resultCache,
    ).toBeInstanceOf(Map);
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
    const { runtime, host } = setup({ graceMs: 1_000 });
    host.startModes = ["slowExit"];
    host.behavior = (_prompt, context) =>
      context.model === "fake/bad"
        ? [{ kind: "error", message: "model unavailable" }]
        : [{ kind: "yield", status: "completed", result: "recovered" }];
    const { handle, assignmentId } = await runtime.spawn(
      launch({ modelCandidates: ["fake/bad", "fake/good"] }),
    );
    const seen: string[] = [];
    const deadline = Date.now() + 3_000;
    while (!seen.includes("completed")) {
      seen.push(...runtime.listResults().map((result) => result.state));
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
