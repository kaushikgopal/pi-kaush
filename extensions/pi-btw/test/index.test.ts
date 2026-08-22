import { appendFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import registerBtw from "../src/index.ts";

const sessionFile = join(tmpdir(), `pi-btw-${process.pid}.jsonl`);

type ExecResult = {
  code: number;
  stdout: string;
  stderr: string;
  killed?: boolean;
};

type Exec = (
  command: string,
  args: string[],
  options?: { timeout?: number },
) => Promise<ExecResult>;

function paneSplit(paneId = "side-pane"): ExecResult {
  return {
    code: 0,
    stdout: JSON.stringify({ result: { pane: { pane_id: paneId } } }),
    stderr: "",
  };
}

function success(): ExecResult {
  return { code: 0, stdout: "{}", stderr: "" };
}

function createHarness(
  exec: Exec,
  options: {
    idle?: boolean;
    mode?: string;
    persisted?: boolean;
    leafId?: string | null;
    cancelFork?: boolean;
  } = {},
) {
  let handler: ((args: string, ctx: any) => Promise<void>) | undefined;
  const eventHandlers: Record<string, (event: any, ctx: any) => void> = {};
  const commands: string[] = [];
  const notifications: Array<{ message: string; level: string }> = [];
  const childNotifications: Array<{ message: string; level: string }> = [];
  const childMessages: string[] = [];
  const forks: Array<{ leafId: string; position: string }> = [];
  const pi = {
    registerCommand(name: string, definition: any) {
      commands.push(name);
      handler = definition.handler;
    },
    on(name: string, eventHandler: (event: any, ctx: any) => void) {
      eventHandlers[name] = eventHandler;
    },
    exec,
  };
  const ctx = {
    cwd: "/tmp/project",
    mode: options.mode ?? "tui",
    isIdle: () => options.idle ?? true,
    sessionManager: {
      getSessionFile: () =>
        options.persisted === false ? undefined : sessionFile,
      getLeafId: () =>
        options.leafId === undefined ? "current-leaf" : options.leafId,
    },
    async fork(leafId: string, forkOptions: any) {
      forks.push({ leafId, position: forkOptions.position });
      if (options.cancelFork) return { cancelled: true };
      await forkOptions.withSession({
        ui: {
          notify(message: string, level: string) {
            childNotifications.push({ message, level });
          },
        },
        async sendUserMessage(message: string) {
          childMessages.push(message);
        },
      });
      return { cancelled: false };
    },
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
    },
  };

  registerBtw(pi as any);
  if (!handler) throw new Error("/btw was not registered");
  return {
    btw: (args: string) => handler!(args, ctx),
    startAgent: () => eventHandlers.before_agent_start?.({}, ctx),
    commands,
    notifications,
    childNotifications,
    childMessages,
    forks,
  };
}

function setHerdr(enabled: boolean): () => void {
  const oldEnv = process.env.HERDR_ENV;
  const oldPane = process.env.HERDR_PANE_ID;
  if (enabled) {
    process.env.HERDR_ENV = "1";
    process.env.HERDR_PANE_ID = "parent-pane";
  } else {
    delete process.env.HERDR_ENV;
    delete process.env.HERDR_PANE_ID;
  }
  return () => {
    if (oldEnv === undefined) delete process.env.HERDR_ENV;
    else process.env.HERDR_ENV = oldEnv;
    if (oldPane === undefined) delete process.env.HERDR_PANE_ID;
    else process.env.HERDR_PANE_ID = oldPane;
  };
}

beforeEach(() => {
  const entries = [
    {
      type: "session",
      version: 3,
      id: "test-session",
      timestamp: "2026-01-01T00:00:00.000Z",
      cwd: "/tmp/project",
    },
    {
      type: "message",
      id: "root-user",
      parentId: null,
      timestamp: "2026-01-01T00:00:01.000Z",
      message: {
        role: "user",
        content: [{ type: "text", text: "Parent question" }],
        timestamp: 1,
      },
    },
    {
      type: "message",
      id: "current-leaf",
      parentId: "root-user",
      timestamp: "2026-01-01T00:00:02.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Completed answer" }],
        api: "test",
        provider: "test",
        model: "test",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
          },
        },
        stopReason: "stop",
        timestamp: 2,
      },
    },
  ];
  writeFileSync(
    sessionFile,
    `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
  );
});
afterEach(() => vi.useRealTimers());
afterAll(() => rmSync(sessionFile, { force: true }));

describe("command boundary", () => {
  test("registers only /btw", () => {
    const harness = createHarness(async () => success());
    expect(harness.commands).toEqual(["btw"]);
  });

  test("requires a question", async () => {
    const harness = createHarness(async () => {
      throw new Error("must not launch");
    });
    await harness.btw("   ");
    expect(harness.notifications).toEqual([
      { message: "Usage: /btw <question>", level: "warning" },
    ]);
  });

  test("requires an interactive session", async () => {
    const harness = createHarness(
      async () => {
        throw new Error("must not launch");
      },
      { mode: "rpc" },
    );
    await harness.btw("Side question");
    expect(harness.notifications[0]?.message).toContain("interactive");
  });

  test("keeps the idle requirement outside Herdr", async () => {
    const restore = setHerdr(false);
    const harness = createHarness(
      async () => {
        throw new Error("must not launch");
      },
      { idle: false },
    );
    try {
      await harness.btw("Side question");
    } finally {
      restore();
    }
    expect(harness.notifications[0]?.message).toContain(
      "current response to finish",
    );
  });
});

describe("fallback fork", () => {
  test("switches to a clone of the current branch and asks the question", async () => {
    const restore = setHerdr(false);
    const harness = createHarness(async () => {
      throw new Error("fallback must not spawn a process");
    });
    try {
      await harness.btw("Compare both approaches");
    } finally {
      restore();
    }

    expect(harness.forks).toEqual([{ leafId: "current-leaf", position: "at" }]);
    expect(harness.childMessages).toEqual(["Compare both approaches"]);
    expect(harness.childNotifications[0]?.message).toContain(
      "original session is saved but dormant",
    );
    expect(harness.childNotifications[0]?.message).toContain("/resume");
  });

  test("supports repeated forks without a child-session restriction", async () => {
    const restore = setHerdr(false);
    const first = createHarness(async () => success());
    const second = createHarness(async () => success(), {
      leafId: "nested-leaf",
    });
    try {
      await first.btw("First fork");
      await second.btw("Nested fork");
    } finally {
      restore();
    }
    expect(first.childMessages).toEqual(["First fork"]);
    expect(second.forks).toEqual([{ leafId: "nested-leaf", position: "at" }]);
    expect(second.childMessages).toEqual(["Nested fork"]);
  });

  test("requires conversation context to fork", async () => {
    const restore = setHerdr(false);
    const harness = createHarness(async () => success(), { leafId: null });
    try {
      await harness.btw("Side question");
    } finally {
      restore();
    }
    expect(harness.forks).toHaveLength(0);
    expect(harness.notifications[0]?.message).toContain(
      "no conversation to fork",
    );
  });

  test("reports a cancelled fork without using stale replacement context", async () => {
    const restore = setHerdr(false);
    const harness = createHarness(async () => success(), { cancelFork: true });
    try {
      await harness.btw("Side question");
    } finally {
      restore();
    }
    expect(harness.notifications.at(-1)?.message).toContain("cancelled");
  });
});

describe("Herdr", () => {
  test("forks natively in a right split and sends the question", async () => {
    const restore = setHerdr(true);
    const calls: Array<{ command: string; args: string[] }> = [];
    const harness = createHarness(async (command, args) => {
      calls.push({ command, args });
      if (args[0] === "pane") return paneSplit();
      return success();
    });

    try {
      await harness.btw("Investigate the parser");
    } finally {
      restore();
    }

    expect(calls).toHaveLength(3);
    expect(calls[0]?.args).toEqual([
      "pane",
      "split",
      "--current",
      "--direction",
      "right",
      "--cwd",
      "/tmp/project",
      "--no-focus",
    ]);
    const agentName = calls[1]!.args[2]!;
    expect(agentName).toMatch(/^pi-btw-/);
    expect(calls[1]?.args).toEqual([
      "agent",
      "start",
      agentName,
      "--kind",
      "pi",
      "--pane",
      "side-pane",
      "--timeout",
      "10000",
      "--",
      "--fork",
      sessionFile,
    ]);
    expect(calls[2]?.args).toEqual([
      "agent",
      "prompt",
      agentName,
      "Investigate the parser",
    ]);
    expect(harness.notifications.at(-1)).toEqual({
      message: `Opened a Herdr side session (${agentName}) and sent the question.`,
      level: "info",
    });
  });

  test("forks the last completed response while the parent keeps running", async () => {
    const restore = setHerdr(true);
    const calls: Array<{ command: string; args: string[] }> = [];
    let snapshotFile: string | undefined;
    const harness = createHarness(
      async (command, args) => {
        calls.push({ command, args });
        if (args[0] === "pane") return paneSplit();
        return success();
      },
      { idle: false },
    );

    try {
      harness.startAgent();
      appendFileSync(
        sessionFile,
        `${JSON.stringify({
          type: "message",
          id: "in-flight-user",
          parentId: "current-leaf",
          timestamp: "2026-01-01T00:00:03.000Z",
          message: {
            role: "user",
            content: [{ type: "text", text: "In-flight parent prompt" }],
            timestamp: 3,
          },
        })}\n`,
      );

      await harness.btw("Independent side question");

      const startArgs = calls[1]!.args;
      expect(startArgs.at(-2)).toBe("--session");
      snapshotFile = startArgs.at(-1);
      expect(snapshotFile).toBeDefined();
      const snapshot = readFileSync(snapshotFile!, "utf8");
      expect(snapshot).toContain("Completed answer");
      expect(snapshot).not.toContain("In-flight parent prompt");
      expect(calls[2]?.args.at(-1)).toBe("Independent side question");
    } finally {
      restore();
      if (snapshotFile) rmSync(snapshotFile, { force: true });
    }
  });

  test("rejects /btw only when no response has completed yet", async () => {
    const restore = setHerdr(true);
    const calls: string[][] = [];
    const harness = createHarness(
      async (_command, args) => {
        calls.push(args);
        return success();
      },
      { idle: false, persisted: false, leafId: null },
    );

    try {
      harness.startAgent();
      await harness.btw("Side question");
    } finally {
      restore();
    }

    expect(calls).toHaveLength(0);
    expect(harness.notifications.at(-1)?.message).toContain(
      "at least one completed response",
    );
  });

  test("retries while the new pane shell is still busy", async () => {
    const restore = setHerdr(true);
    vi.useFakeTimers();
    let starts = 0;
    const harness = createHarness(async (_command, args) => {
      if (args[0] === "pane") return paneSplit();
      if (args[1] === "start" && starts++ < 2) {
        return {
          code: 1,
          stdout: "",
          stderr: JSON.stringify({ error: { code: "agent_pane_busy" } }),
        };
      }
      return success();
    });

    try {
      const launch = harness.btw("Side question");
      await vi.runAllTimersAsync();
      await launch;
    } finally {
      restore();
    }

    expect(starts).toBe(3);
    expect(harness.notifications.at(-1)?.level).toBe("info");
  });

  test("does not retry incidental busy text", async () => {
    const restore = setHerdr(true);
    vi.useFakeTimers();
    let starts = 0;
    const failure = "Pi failed after seeing agent_pane_busy in unrelated prose";
    const harness = createHarness(async (_command, args) => {
      if (args[0] === "pane") return paneSplit();
      starts++;
      return { code: 1, stdout: "", stderr: failure };
    });

    try {
      const launch = harness.btw("Side question");
      await vi.runAllTimersAsync();
      await launch;
    } finally {
      restore();
    }

    expect(starts).toBe(1);
    expect(harness.notifications.at(-1)).toMatchObject({
      level: "error",
      message: expect.stringContaining(failure),
    });
  });

  test("leaves a failed pane available for inspection", async () => {
    const restore = setHerdr(true);
    const calls: string[][] = [];
    const harness = createHarness(async (_command, args) => {
      calls.push(args);
      if (args[0] === "pane") return paneSplit("inspect-me");
      return { code: 1, stdout: "", stderr: "Pi failed to start" };
    });

    try {
      await harness.btw("Side question");
    } finally {
      restore();
    }

    expect(calls.some((args) => args[1] === "close")).toBe(false);
    expect(harness.notifications.at(-1)).toEqual({
      message:
        "Failed to open side session: Pane inspect-me was created, but Pi could not start: Pi failed to start",
      level: "error",
    });
  });

  test("reports a malformed pane response", async () => {
    const restore = setHerdr(true);
    const harness = createHarness(async () => success());
    try {
      await harness.btw("Side question");
    } finally {
      restore();
    }
    expect(harness.notifications.at(-1)?.message).toContain(
      "Could not read the new Herdr pane id",
    );
  });

  test("requires a persisted session file for the native CLI fork", async () => {
    const restore = setHerdr(true);
    const harness = createHarness(
      async () => {
        throw new Error("must not launch");
      },
      { persisted: false },
    );
    try {
      await harness.btw("Side question");
    } finally {
      restore();
    }
    expect(harness.notifications[0]?.message).toContain(
      "at least one completed response",
    );
  });

  test("requires a conversation leaf for the native CLI fork", async () => {
    const restore = setHerdr(true);
    writeFileSync(
      sessionFile,
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: "test-session",
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd: "/tmp/project",
      })}\n`,
    );
    const harness = createHarness(
      async () => {
        throw new Error("must not launch");
      },
      { leafId: null },
    );

    try {
      await harness.btw("Side question");
    } finally {
      restore();
    }

    expect(harness.notifications[0]?.message).toContain(
      "at least one completed response",
    );
  });
});
