import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  ManagedError,
  type ManagedHostLaunch,
  ManagedStartupError,
} from "../src/_managed-host.ts";
import { detectManagedHost } from "../src/_managed-host-detect.ts";
import {
  createRexHost,
  parseRexError,
  RexCommandError,
  type RexExecOptions,
} from "../src/_managed-host-rex.ts";
import { managedPaths, parseManagedConfig } from "../src/_managed-store.ts";
import { SubagentProcessRegistry } from "../src/_process-tree.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

const tick = (ms = 1) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

function argValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

type Exec = (
  bin: string,
  args: readonly string[],
  options?: RexExecOptions,
) => Promise<string>;

/** `rex wait` that stays pending until its block is closed or the waiter aborts. */
function pendingWait(options?: RexExecOptions): Promise<string> {
  return new Promise((_resolve, reject) => {
    options?.signal?.addEventListener("abort", () =>
      reject(new Error("aborted")),
    );
  });
}

const splitResult = (blockId: string) =>
  JSON.stringify({ anchor_id: "block:caller", block_ids: [blockId] });

describe("rex host", () => {
  function rexHost(
    exec: Exec,
    overrides: {
      forwardEnv?: Record<string, string>;
      isPidAlive?: (pid: number) => boolean;
    } = {},
  ) {
    return createRexHost({
      sessionId: "session:caller",
      parentBlockId: "block:caller",
      bin: "/rex/bin/rex",
      exec,
      registry: new SubagentProcessRegistry(),
      isPidAlive: overrides.isPidAlive ?? (() => false),
      sleep: () => tick(2),
      pollMs: 2,
      ...(overrides.forwardEnv ? { forwardEnv: overrides.forwardEnv } : {}),
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

  test("splits below the caller without focus and closes only its block", async () => {
    const calls: string[][] = [];
    const host = rexHost(
      async (_bin, args, options) => {
        calls.push([...args]);
        if (args[0] === "split") return splitResult("block:child");
        if (args[0] === "wait") return pendingWait(options);
        return "";
      },
      { forwardEnv: { PI_OFFLINE: "1" } },
    );
    const dir = tempDir("managed-rex-");
    const proc = await host.launch(request(dir, { readBootPid: () => 4242 }));
    expect(proc.placement).toEqual({
      kind: "rex",
      sessionId: "session:caller",
      blockId: "block:child",
    });
    // Rex has no agent handshake: readiness comes from the bridge status file.
    expect(proc.readyConfirmed).toBeUndefined();
    expect(calls[0]).toEqual([
      "split",
      "-s",
      "session:caller",
      "-b",
      "block:caller",
      "--split=below",
      "--focus=false",
      "--label",
      "🤖 c3po abcdef",
      "-c",
      "/work",
      "--json",
      "--",
      "env",
      "PI_OFFLINE=1",
      `PI_MANAGED_SUBAGENT_DIR=${dir}`,
      "/usr/bin/node",
      "/pi/cli.js",
      "--name",
      "it's",
    ]);
    expect(calls[1]).toEqual([
      "wait",
      "-s",
      "session:caller",
      "block:child",
      "--json",
    ]);

    await host.focus(proc.placement);
    expect(calls.at(-1)).toEqual([
      "focus",
      "-s",
      "session:caller",
      "block:child",
    ]);
    await proc.terminate();
    await proc.exited;
    expect(calls.at(-1)).toEqual([
      "block",
      "close",
      "-s",
      "session:caller",
      "block:child",
    ]);
    expect(
      calls.filter(
        (args) => args.includes("block:caller") && args[0] !== "split",
      ),
    ).toEqual([]);
  });

  test("watches the pid the bridge reports for this boot", async () => {
    let reads = 0;
    const host = rexHost(async (_bin, args, options) =>
      args[0] === "split" ? splitResult("block:child") : pendingWait(options),
    );
    const proc = await host.launch(
      request(tempDir("managed-rex-pid-"), {
        readBootPid: () => (++reads < 3 ? undefined : 4242),
      }),
    );
    // isPidAlive reports every pid gone, so the block ends once the pid is known.
    await proc.exited;
    expect(reads).toBe(3);
  });

  test("a program that exits before reporting a pid ends the worker", async () => {
    let endWait = () => {};
    const host = rexHost(async (_bin, args) =>
      args[0] === "split"
        ? splitResult("block:child")
        : args[0] === "wait"
          ? new Promise<string>((resolve) => {
              endWait = () => resolve('{"exit_code":1}');
            })
          : "",
    );
    const proc = await host.launch(
      request(tempDir("managed-rex-crash-"), { readBootPid: () => undefined }),
    );
    let ended = false;
    void proc.exited.then(() => {
      ended = true;
    });
    await tick(20);
    expect(ended).toBe(false);
    endWait();
    await proc.exited;
  });

  test("a returned wait does not end a worker whose pid is alive", async () => {
    let alive = true;
    const host = rexHost(
      async (_bin, args) =>
        args[0] === "split" ? splitResult("block:child") : "",
      { isPidAlive: () => alive },
    );
    const proc = await host.launch(
      request(tempDir("managed-rex-alive-"), { readBootPid: () => 4242 }),
    );
    let ended = false;
    void proc.exited.then(() => {
      ended = true;
    });
    await tick(20);
    expect(ended).toBe(false);
    // Never signal the fake pid: it may name a real process on this machine.
    alive = false;
    await proc.exited;
  });

  test("stacks later workers below the latest owned block, then falls back to the caller", async () => {
    const tried: string[] = [];
    let next = 0;
    const host = rexHost(async (_bin, args, options) => {
      if (args[0] === "split") {
        const anchor = argValue(args, "-b")!;
        tried.push(anchor);
        if (anchor === "block:stale" || anchor === "block:older")
          throw new RexCommandError(
            true,
            "rex split failed: block target not found",
          );
        return splitResult(`block:new-${++next}`);
      }
      return args[0] === "wait" ? pendingWait(options) : "";
    });
    const owned = [
      {
        kind: "rex" as const,
        sessionId: "session:caller",
        blockId: "block:older",
      },
      {
        kind: "rex" as const,
        sessionId: "session:other",
        blockId: "block:foreign",
      },
      {
        kind: "rex" as const,
        sessionId: "session:caller",
        blockId: "block:stale",
      },
    ];
    const first = await host.launch(
      request(tempDir("managed-rex-anchor-"), { ownedPlacements: owned }),
    );
    expect(tried).toEqual(["block:stale", "block:older", "block:caller"]);
    // The pending block from the first launch anchors the second.
    const second = await host.launch(
      request(tempDir("managed-rex-anchor-"), { handle: "mw-second" }),
    );
    expect(tried.at(-1)).toBe("block:new-1");
    await Promise.all([first.terminate(), second.terminate()]);
  });

  test("never adopts the caller block from a wrong split response", async () => {
    const calls: string[][] = [];
    const host = rexHost(async (_bin, args) => {
      calls.push([...args]);
      return splitResult("block:caller");
    });
    await expect(
      host.launch(request(tempDir("managed-rex-wrong-"))),
    ).rejects.toBeInstanceOf(ManagedStartupError);
    expect(calls.some((args) => args[0] === "block")).toBe(false);
  });

  test("does not replay an ambiguous split failure", async () => {
    const calls: string[][] = [];
    const host = rexHost(async (_bin, args) => {
      calls.push([...args]);
      throw new RexCommandError(false, "rex split timed out.");
    });
    await expect(
      host.launch(request(tempDir("managed-rex-ambiguous-"))),
    ).rejects.toBeInstanceOf(ManagedStartupError);
    expect(calls).toHaveLength(1);
  });

  test("reports focus failures as runtime errors", async () => {
    const host = rexHost(async () => {
      throw new RexCommandError(
        true,
        "rex focus failed: block target not found",
      );
    });
    const placement = {
      kind: "rex" as const,
      sessionId: "session:caller",
      blockId: "block:gone",
    };
    await expect(host.focus(placement)).rejects.toMatchObject({
      code: "not_running",
    });
    await expect(host.focus({ kind: "rpc", pid: 1 })).rejects.toBeInstanceOf(
      ManagedError,
    );
  });

  test("detects Rex only with caller context and an executable rex", () => {
    const binDir = tempDir("managed-rex-bin-");
    const rexBin = path.join(binDir, "rex");
    fs.writeFileSync(rexBin, "#!/bin/sh\n", { mode: 0o755 });
    const context = {
      REX_SESSION: "session:caller",
      REX_BLOCK: "block:caller",
      REX_BIN_DIR: binDir,
      PATH: "/nonexistent",
    };
    const registry = new SubagentProcessRegistry();
    expect(detectManagedHost(context, registry, 2).kind).toBe("rex");
    expect(
      detectManagedHost({ ...context, REX_BLOCK: " " }, registry, 2).kind,
    ).toBe("rpc");
    expect(
      detectManagedHost({ ...context, REX_BIN_DIR: "/missing" }, registry, 2)
        .kind,
    ).toBe("rpc");
    // Herdr panes inherit REX_* from the Rex terminal, so Herdr wins when both are present.
    expect(
      detectManagedHost(
        {
          ...context,
          HERDR_ENV: "1",
          HERDR_WORKSPACE_ID: "ws-1",
          HERDR_TAB_ID: "tab-1",
          HERDR_PANE_ID: "pane-1",
          HERDR_BIN_PATH: process.execPath,
        },
        registry,
        2,
      ).kind,
    ).toBe("herdr");
  });

  test("parses Rex's stderr diagnostic", () => {
    expect(parseRexError('\nError: block target "block:x" not found\n')).toBe(
      'block target "block:x" not found',
    );
    expect(parseRexError("")).toBeUndefined();
  });

  test("persists Rex placements and rejects incomplete ones", () => {
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
    const placement = {
      kind: "rex",
      sessionId: "session:caller",
      blockId: "block:child",
    };
    expect(parseManagedConfig({ ...base, placement })?.placement).toEqual(
      placement,
    );
    expect(
      parseManagedConfig({
        ...base,
        placement: { kind: "rex", sessionId: "session:caller" },
      })?.placement,
    ).toBeUndefined();
  });
});
