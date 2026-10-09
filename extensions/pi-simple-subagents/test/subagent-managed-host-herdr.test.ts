import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  ManagedError,
  type ManagedHostLaunch,
  ManagedStartupError,
} from "../src/_managed-host.ts";
import {
  createHerdrHost,
  detectManagedHost,
  HerdrCommandError,
  herdrAgentName,
  herdrForwardEnvironment,
  parseHerdrError,
} from "../src/_managed-host-herdr.ts";
import {
  managedPaths,
  parseManagedConfig,
  readChildStatus,
} from "../src/_managed-store.ts";
import { SubagentProcessRegistry } from "../src/_process-tree.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

const tick = (ms = 1) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

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
  test("watches the pid the runtime reports for this boot", async () => {
    const host = herdrHost(async (_bin, args) =>
      args[0] === "pane" ? paneCreated : "{}",
    );
    const dir = fs.mkdtempSync(path.join(tmpdir(), "managed-herdr-pid-"));
    roots.push(dir);
    let reads = 0;
    const proc = await host.launch(
      request(dir, {
        // The bridge has not reported yet on the first reads.
        readBootPid: () => (++reads < 3 ? undefined : 4242),
      }),
    );
    // isPidAlive reports every pid gone, so the pane ends once the pid is known.
    await proc.exited;
    expect(reads).toBe(3);
  });

  test("reports focus failures as runtime errors with Herdr's message", async () => {
    const failures: Error[] = [
      new HerdrCommandError("pane_not_found", "pane p-1 not found"),
      new HerdrCommandError("agent_not_found", "agent missing"),
      new Error("herdr exited with code 2"),
    ];
    const host = herdrHost(async () => {
      throw failures.shift();
    });
    const placement = {
      kind: "herdr",
      tabId: "caller-tab",
      paneId: "p-1",
    } as const;
    for (const [code, message] of [
      ["not_running", "pane p-1 not found"],
      ["not_running", "agent missing"],
      ["unsupported", "herdr exited with code 2"],
    ] as const) {
      const error = await host.focus(placement).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(ManagedError);
      expect(error).toMatchObject({ code, message });
    }
    await expect(host.focus({ kind: "rpc", pid: 1 })).rejects.toMatchObject({
      code: "unsupported",
    });
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
