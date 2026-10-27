import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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

let rexBinDir: string | undefined;

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

function configureRex(): string {
  rexBinDir = mkdtempSync(join(tmpdir(), "pi-btw-rex-" + process.pid + "-"));
  const rexPath = join(rexBinDir, "rex");
  writeFileSync(rexPath, "");
  chmodSync(rexPath, 0o755);
  vi.stubEnv("REX_SESSION", "rex-session");
  vi.stubEnv("REX_BLOCK", "parent-block");
  vi.stubEnv("REX_BIN_DIR", rexBinDir);
  return rexPath;
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

beforeEach(() => {
  vi.stubEnv("HERDR_ENV", "0");
  vi.stubEnv("HERDR_PANE_ID", "");
  vi.stubEnv("REX_SESSION", "");
  vi.stubEnv("REX_BLOCK", "");
  vi.stubEnv("REX_BIN_DIR", "");

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
afterEach(() => {
  vi.useRealTimers();
  if (rexBinDir) rmSync(rexBinDir, { recursive: true, force: true });
  rexBinDir = undefined;
  vi.unstubAllEnvs();
});
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
    const harness = createHarness(
      async () => {
        throw new Error("must not launch");
      },
      { idle: false },
    );
    await harness.btw("Side question");
    expect(harness.notifications[0]?.message).toContain(
      "current response to finish",
    );
  });
});

describe("fallback fork", () => {
  test("switches to a clone of the current branch and asks the question", async () => {
    const harness = createHarness(async () => {
      throw new Error("fallback must not spawn a process");
    });
    await harness.btw("Compare both approaches");

    expect(harness.forks).toEqual([{ leafId: "current-leaf", position: "at" }]);
    expect(harness.childMessages).toEqual(["Compare both approaches"]);
    expect(harness.childNotifications[0]?.message).toContain(
      "original session is saved but dormant",
    );
    expect(harness.childNotifications[0]?.message).toContain("/resume");
  });

  test("supports repeated forks without a child-session restriction", async () => {
    const first = createHarness(async () => success());
    const second = createHarness(async () => success(), {
      leafId: "nested-leaf",
    });
    await first.btw("First fork");
    await second.btw("Nested fork");
    expect(first.childMessages).toEqual(["First fork"]);
    expect(second.forks).toEqual([{ leafId: "nested-leaf", position: "at" }]);
    expect(second.childMessages).toEqual(["Nested fork"]);
  });

  test("requires conversation context to fork", async () => {
    const harness = createHarness(async () => success(), { leafId: null });
    await harness.btw("Side question");
    expect(harness.forks).toHaveLength(0);
    expect(harness.notifications[0]?.message).toContain(
      "no conversation to fork",
    );
  });

  test("reports a cancelled fork without using stale replacement context", async () => {
    const harness = createHarness(async () => success(), { cancelFork: true });
    await harness.btw("Side question");
    expect(harness.notifications.at(-1)?.message).toContain("cancelled");
  });
});

describe("Rex", () => {
  beforeEach(() => {
    configureRex();
  });

  test("opens a side session when Rex is available", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const harness = createHarness(async (command, args) => {
      calls.push({ command, args });
      return {
        code: 0,
        stdout: JSON.stringify({ block_ids: ["rex-block"] }),
        stderr: "",
      };
    });

    await harness.btw("Investigate the parser");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe(join(rexBinDir!, "rex"));
    expect(harness.notifications.at(-1)).toEqual({
      message: "Opened a Rex side session (rex-block) and sent the question.",
      level: "info",
    });
  });

  test("uses the exact split arguments and forwards only allowed settings", async () => {
    const forwarded = [
      ["PI_CODING_AGENT_DIR", "/config/pi"],
      ["PI_PACKAGE_DIR", "/packages"],
      ["PI_OFFLINE", "1"],
      ["PI_SKIP_VERSION_CHECK", "1"],
      ["PI_TELEMETRY", "0"],
      ["PI_CACHE_RETENTION", "7d"],
    ] as const;
    for (const [key, value] of forwarded) vi.stubEnv(key, value);
    vi.stubEnv("OPENAI_API_KEY", "credential-must-not-be-forwarded");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "another-credential");

    let splitArgs: string[] = [];
    const harness = createHarness(async (_command, args) => {
      splitArgs = args;
      return {
        code: 0,
        stdout: JSON.stringify({ block_ids: ["rex-block"] }),
        stderr: "",
      };
    });
    await harness.btw("Compare both designs");

    const piInvocation =
      existsSync(process.execPath) &&
      process.argv[1] &&
      existsSync(process.argv[1])
        ? [process.execPath, resolve(process.argv[1])]
        : ["pi"];
    expect(splitArgs).toEqual([
      "split",
      "-s",
      "rex-session",
      "-b",
      "parent-block",
      "--split=right",
      "--focus=false",
      "--label",
      "btw",
      "-c",
      "/tmp/project",
      "--json",
      "--",
      "env",
      ...forwarded.map(([key, value]) => key + "=" + value),
      ...piInvocation,
      "--fork",
      sessionFile,
      "--",
      "Compare both designs",
    ]);
    expect(splitArgs.join(" ")).not.toContain(
      "credential-must-not-be-forwarded",
    );
    expect(splitArgs.join(" ")).not.toContain("another-credential");
    expect(harness.forks).toHaveLength(0);
  });

  test("uses the pre-run snapshot while the parent is busy", async () => {
    let splitArgs: string[] = [];
    let snapshotFile: string | undefined;
    const harness = createHarness(
      async (_command, args) => {
        splitArgs = args;
        return {
          code: 0,
          stdout: JSON.stringify({ block_ids: ["rex-block"] }),
          stderr: "",
        };
      },
      { idle: false },
    );

    try {
      harness.startAgent();
      appendFileSync(
        sessionFile,
        JSON.stringify({
          type: "message",
          id: "in-flight-user",
          parentId: "current-leaf",
          timestamp: "2026-01-01T00:00:03.000Z",
          message: {
            role: "user",
            content: [{ type: "text", text: "In-flight parent prompt" }],
            timestamp: 3,
          },
        }) + "\n",
      );

      await harness.btw("Independent side question");

      const sessionIndex = splitArgs.indexOf("--session");
      expect(sessionIndex).toBeGreaterThan(-1);
      snapshotFile = splitArgs[sessionIndex + 1];
      expect(snapshotFile).toBeDefined();
      const snapshot = readFileSync(snapshotFile!, "utf8");
      expect(snapshot).toContain("Completed answer");
      expect(snapshot).not.toContain("In-flight parent prompt");
      expect(splitArgs.slice(-2)).toEqual(["--", "Independent side question"]);
      expect(harness.notifications.at(-1)?.level).toBe("info");
    } finally {
      if (snapshotFile) rmSync(snapshotFile, { force: true });
    }
  });

  test.each(["-leading option", "@literal text"])(
    "passes a question beginning with %s as text",
    async (question) => {
      let splitArgs: string[] = [];
      const harness = createHarness(async (_command, args) => {
        splitArgs = args;
        return {
          code: 0,
          stdout: JSON.stringify({ block_ids: ["rex-block"] }),
          stderr: "",
        };
      });
      await harness.btw(question);
      expect(splitArgs.at(-2)).toBe("--");
      expect(splitArgs.at(-1)).toBe(
        question.startsWith("@") ? " " + question : question,
      );
    },
  );

  test("reports Rex split failures and malformed JSON", async () => {
    const failed = createHarness(async () => ({
      code: 1,
      stdout: "",
      stderr: "Error: session not found",
    }));
    await failed.btw("Side question");
    expect(failed.notifications.at(-1)).toEqual({
      message: "Failed to open side session: Error: session not found",
      level: "error",
    });

    const malformed = createHarness(async () => ({
      code: 0,
      stdout: "not JSON",
      stderr: "",
    }));
    await malformed.btw("Side question");
    expect(malformed.notifications.at(-1)).toEqual({
      message:
        "Failed to open side session: Rex split returned non-JSON output",
      level: "error",
    });
  });

  test("gives Herdr precedence when both hosts are available", async () => {
    vi.stubEnv("HERDR_ENV", "1");
    vi.stubEnv("HERDR_PANE_ID", "parent-pane");
    const calls: Array<{ command: string; args: string[] }> = [];
    const harness = createHarness(async (command, args) => {
      calls.push({ command, args });
      return args[0] === "pane" ? paneSplit() : success();
    });

    await harness.btw("Use Herdr");

    expect(
      calls.every((call) => call.command !== join(rexBinDir!, "rex")),
    ).toBe(true);
    expect(harness.notifications.at(-1)?.message).toContain(
      "Opened a Herdr side session",
    );
  });

  test("falls back when no Rex executable is available", async () => {
    vi.stubEnv("REX_BIN_DIR", join(rexBinDir!, "missing-path"));
    vi.stubEnv("PATH", join(rexBinDir!, "missing-path"));
    const harness = createHarness(async () => {
      throw new Error("Rex must not launch");
    });

    await harness.btw("Use the fork fallback");

    expect(harness.forks).toEqual([{ leafId: "current-leaf", position: "at" }]);
    expect(harness.childMessages).toEqual(["Use the fork fallback"]);
    expect(harness.childNotifications[0]?.message).toContain(
      "Herdr or Rex is unavailable",
    );
  });
});

describe("Herdr", () => {
  beforeEach(() => {
    vi.stubEnv("HERDR_ENV", "1");
    vi.stubEnv("HERDR_PANE_ID", "parent-pane");
  });

  test("forks natively in a right split and sends the question", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const harness = createHarness(async (command, args) => {
      calls.push({ command, args });
      if (args[0] === "pane") return paneSplit();
      return success();
    });

    await harness.btw("Investigate the parser");

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
      if (snapshotFile) rmSync(snapshotFile, { force: true });
    }
  });

  test("retries while the new pane shell is still busy", async () => {
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

    const launch = harness.btw("Side question");
    await vi.runAllTimersAsync();
    await launch;

    expect(starts).toBe(3);
    expect(harness.notifications.at(-1)?.level).toBe("info");
  });

  test("does not retry incidental busy text", async () => {
    vi.useFakeTimers();
    let starts = 0;
    const failure = "Pi failed after seeing agent_pane_busy in unrelated prose";
    const harness = createHarness(async (_command, args) => {
      if (args[0] === "pane") return paneSplit();
      starts++;
      return { code: 1, stdout: "", stderr: failure };
    });

    const launch = harness.btw("Side question");
    await vi.runAllTimersAsync();
    await launch;

    expect(starts).toBe(1);
    expect(harness.notifications.at(-1)).toMatchObject({
      level: "error",
      message: expect.stringContaining(failure),
    });
  });

  test("leaves a failed pane available for inspection", async () => {
    const calls: string[][] = [];
    const harness = createHarness(async (_command, args) => {
      calls.push(args);
      if (args[0] === "pane") return paneSplit("inspect-me");
      return { code: 1, stdout: "", stderr: "Pi failed to start" };
    });

    await harness.btw("Side question");

    expect(calls.some((args) => args[1] === "close")).toBe(false);
    expect(harness.notifications.at(-1)).toEqual({
      message:
        "Failed to open side session: Pane inspect-me was created, but Pi could not start: Pi failed to start",
      level: "error",
    });
  });

  test("reports a malformed pane response", async () => {
    const harness = createHarness(async () => success());
    await harness.btw("Side question");
    expect(harness.notifications.at(-1)?.message).toContain(
      "Could not read the new Herdr pane id",
    );
  });

  test("requires a persisted session file for the native CLI fork", async () => {
    const harness = createHarness(
      async () => {
        throw new Error("must not launch");
      },
      { persisted: false },
    );
    await harness.btw("Side question");
    expect(harness.notifications[0]?.message).toContain(
      "at least one completed response",
    );
  });

  test("requires a conversation leaf for the native CLI fork", async () => {
    const harness = createHarness(
      async () => {
        throw new Error("must not launch");
      },
      { leafId: null },
    );

    await harness.btw("Side question");

    expect(harness.notifications[0]?.message).toContain(
      "at least one completed response",
    );
  });
});
