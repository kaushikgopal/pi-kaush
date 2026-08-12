import { existsSync, rmSync, writeFileSync } from "node:fs";
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

const SPLIT_CHILD_TYPE = "split-fork-child";

let forkedLeafId = "base";
let branchedSessionCount = 0;
let branchedLeafIds: string[] = [];
let childMarkers: Array<{ customType: string; data: unknown }> = [];
let buildContextResult: {
  messages: any[];
  thinkingLevel: string;
  model: { provider: string; modelId: string } | null;
} = { messages: [], thinkingLevel: "off", model: null };
let buildContextLeafIds: Array<string | null | undefined> = [];
let snapshotChild: {
  modelChanges: Array<{ provider: string; modelId: string }>;
  thinkingChanges: string[];
  messages: any[];
  operations: string[];
} = { modelChanges: [], thinkingChanges: [], messages: [], operations: [] };

const splitSessionFile = join(tmpdir(), `pi-split-fork-${process.pid}.jsonl`);
const sourceSessionFile = join(
  tmpdir(),
  `pi-split-fork-source-${process.pid}.jsonl`,
);
writeFileSync(splitSessionFile, "");
writeFileSync(sourceSessionFile, "");

vi.doMock("@earendil-works/pi-coding-agent", () => ({
  SessionManager: class {
    static open(_sessionFile: string) {
      return {
        createBranchedSession: (leafId: string) => {
          branchedSessionCount++;
          branchedLeafIds.push(leafId);
          return splitSessionFile;
        },
        getLeafId: () => forkedLeafId,
        getSessionFile: () => splitSessionFile,
        getHeader: () => ({
          type: "session",
          id: "source",
          timestamp: new Date().toISOString(),
          cwd: "/tmp",
        }),
        getEntries: () => [],
        appendCustomEntry: (customType: string, data: unknown) =>
          childMarkers.push({ customType, data }),
      };
    }
    static create() {
      return {
        createBranchedSession: (leafId: string) => {
          branchedSessionCount++;
          branchedLeafIds.push(leafId);
          return splitSessionFile;
        },
        getLeafId: () => forkedLeafId,
        getSessionFile: () => splitSessionFile,
        getHeader: () => ({
          type: "session",
          id: "child",
          timestamp: new Date().toISOString(),
          cwd: "/tmp",
        }),
        getEntries: () => [],
        appendCustomEntry: (customType: string, data: unknown) =>
          childMarkers.push({ customType, data }),
        appendModelChange: (provider: string, modelId: string) => {
          snapshotChild.modelChanges.push({ provider, modelId });
          snapshotChild.operations.push("model");
        },
        appendThinkingLevelChange: (level: string) => {
          snapshotChild.thinkingChanges.push(level);
          snapshotChild.operations.push("thinking");
        },
        appendMessage: (message: unknown) => {
          snapshotChild.messages.push(message);
          snapshotChild.operations.push("message");
        },
      };
    }
  },
  UserMessageSelectorComponent: class {
    constructor(
      _messages: unknown[],
      private readonly onSelect: (entryId: string) => void,
    ) {}

    render() {
      return [];
    }

    invalidate() {}

    getMessageList() {
      return { handleInput: () => this.onSelect("selected") };
    }
  },
  buildSessionContext: (
    _entries: unknown,
    leafId: string | null | undefined,
  ) => {
    buildContextLeafIds.push(leafId);
    return buildContextResult;
  },
}));

const { default: registerSplitSession } = await import("../src/index.ts");

function assistantEntry(
  id: string,
  parentId: string | null,
  text: string,
  stopReason: string = "stop",
) {
  return {
    type: "message",
    id,
    parentId,
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      stopReason,
    },
  };
}

function userEntry(id: string, parentId: string | null, text: string) {
  return {
    type: "message",
    id,
    parentId,
    message: { role: "user", content: [{ type: "text", text }] },
  };
}

function childMarkerEntry(
  id: string,
  parentId: string | null,
  data: Record<string, unknown>,
) {
  return { type: "custom", id, parentId, customType: SPLIT_CHILD_TYPE, data };
}

function createSplitHarness(
  exec: (
    command: string,
    args: string[],
    options?: { timeout?: number },
  ) => Promise<{
    code: number;
    stdout: string;
    stderr: string;
    killed?: boolean;
  }>,
  options: {
    idle?: boolean;
    sourceSessionFile?: string;
    sourceBranch?: any[];
    leafId?: string | null;
  } = {},
) {
  let btwHandler: ((args: string, ctx: any) => Promise<void>) | undefined;
  const commandNames: string[] = [];
  const notifications: Array<{ message: string; level: string }> = [];
  const sourceBranch = options.sourceBranch ?? [
    assistantEntry("base", null, "Base answer"),
    userEntry("selected", "base", "Selected prompt"),
  ];

  const pi = {
    registerCommand(name: string, definition: any) {
      commandNames.push(name);
      if (name === "btw") btwHandler = definition.handler;
    },
    exec,
    events: { on: () => () => undefined, emit: () => undefined },
    on: () => {},
  };
  const ctx = {
    cwd: "/tmp",
    hasUI: true,
    mode: "tui",
    isIdle: () => options.idle ?? true,
    sessionManager: {
      getSessionFile: () => options.sourceSessionFile ?? sourceSessionFile,
      getSessionDir: () => "/tmp",
      getBranch: () => sourceBranch,
      getEntries: () => sourceBranch,
      getEntry: (entryId: string) =>
        sourceBranch.find((entry) => entry.id === entryId),
      getLeafId: () =>
        options.leafId === undefined ? "selected" : options.leafId,
    },
    ui: {
      custom: (factory: any) =>
        new Promise((resolve) => {
          const component = factory({ requestRender() {} }, {}, {}, resolve);
          component.handleInput("enter");
        }),
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
    },
  };

  registerSplitSession(pi as any);
  if (!btwHandler) throw new Error("btw command was not registered");

  return {
    btw: (args = "") => btwHandler!(args, ctx),
    commandNames,
    notifications,
  };
}

afterAll(() => {
  rmSync(splitSessionFile, { force: true });
  rmSync(sourceSessionFile, { force: true });
});

afterEach(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  forkedLeafId = "base";
  branchedSessionCount = 0;
  branchedLeafIds = [];
  childMarkers = [];
  buildContextResult = { messages: [], thinkingLevel: "off", model: null };
  buildContextLeafIds = [];
  snapshotChild = {
    modelChanges: [],
    thinkingChanges: [],
    messages: [],
    operations: [],
  };
  writeFileSync(splitSessionFile, "");
  writeFileSync(sourceSessionFile, "");
});

function setHerdrIdentity(paneId = "pane-1"): () => void {
  const previous = {
    herdr: process.env.HERDR_ENV,
    pane: process.env.HERDR_PANE_ID,
  };
  process.env.HERDR_ENV = "1";
  process.env.HERDR_PANE_ID = paneId;
  return () => {
    for (const [key, value] of [
      ["HERDR_ENV", previous.herdr],
      ["HERDR_PANE_ID", previous.pane],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

function clearHerdrIdentity(): () => void {
  const previous = {
    herdr: process.env.HERDR_ENV,
    pane: process.env.HERDR_PANE_ID,
  };
  delete process.env.HERDR_ENV;
  delete process.env.HERDR_PANE_ID;
  return () => {
    for (const [key, value] of [
      ["HERDR_ENV", previous.herdr],
      ["HERDR_PANE_ID", previous.pane],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

function herdrPaneSplitResponse(paneId: string) {
  return {
    code: 0,
    stdout: JSON.stringify({ result: { pane: { pane_id: paneId } } }),
    stderr: "",
  };
}

function herdrAgentStartResponse() {
  return {
    code: 0,
    stdout: JSON.stringify({ result: { agent: { pane_id: "split-pane-1" } } }),
    stderr: "",
  };
}

function herdrAgentPromptResponse() {
  return {
    code: 0,
    stdout: JSON.stringify({ result: { type: "agent_prompted" } }),
    stderr: "",
  };
}

function successfulHerdrExec(_command: string, args: string[]) {
  if (args[0] === "pane" && args[1] === "split") {
    return Promise.resolve(herdrPaneSplitResponse("split-pane-1"));
  }
  if (args[0] === "agent" && args[1] === "start") {
    return Promise.resolve(herdrAgentStartResponse());
  }
  if (args[0] === "agent" && args[1] === "prompt") {
    return Promise.resolve(herdrAgentPromptResponse());
  }
  if (args[0] === "pane" && args[1] === "close") {
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  }
  throw new Error(`Unexpected Herdr command: ${args.join(" ")}`);
}

describe("command registration", () => {
  test("registers only /btw", async () => {
    const harness = createSplitHarness(successfulHerdrExec);
    expect(harness.commandNames).toEqual(["btw"]);
  });
});

describe("removed merge command", () => {
  test("rejects /btw merge without forking or launching", async () => {
    const restore = setHerdrIdentity();
    const harness = createSplitHarness(async () => {
      throw new Error("a removed merge must not launch a split");
    });
    try {
      await harness.btw("merge");
    } finally {
      restore();
    }
    expect(branchedSessionCount).toBe(0);
    expect(childMarkers).toHaveLength(0);
    expect(harness.notifications).toContainEqual({
      message:
        "Side-session merging was removed; /btw merge is no longer supported.",
      level: "warning",
    });
  });

  test("rejects /btw merge with an argument and never treats it as a goal", async () => {
    const restore = setHerdrIdentity();
    const harness = createSplitHarness(async () => {
      throw new Error("a removed merge must not launch a split");
    });
    try {
      await harness.btw("merge focus on the tests");
    } finally {
      restore();
    }
    expect(branchedSessionCount).toBe(0);
    expect(harness.notifications).toContainEqual({
      message:
        "Side-session merging was removed; /btw merge is no longer supported.",
      level: "warning",
    });
  });
});

describe("btw launch dispatch", () => {
  test("dispatches the embedded prompt inside a child", async () => {
    let btwHandler: ((args: string, ctx: any) => Promise<void>) | undefined;
    const sentUserMessages: string[] = [];
    const notifications: Array<{ message: string; level: string }> = [];
    const branch = [
      childMarkerEntry("child-marker", null, {
        baseLeafId: "base",
        prompt: "Embedded side goal",
      }),
    ];
    const pi = {
      registerCommand(name: string, definition: any) {
        if (name === "btw") btwHandler = definition.handler;
      },
      events: { on: () => () => undefined, emit: () => undefined },
      sendUserMessage(message: string) {
        sentUserMessages.push(message);
      },
      on: () => {},
    };
    const ctx = {
      hasUI: true,
      sessionManager: { getBranch: () => branch },
      waitForIdle: async () => {},
      ui: {
        notify(message: string, level: string) {
          notifications.push({ message, level });
        },
      },
    };
    registerSplitSession(pi as any);
    if (!btwHandler) throw new Error("btw command was not registered");

    await btwHandler!("--launch", ctx as any);

    expect(sentUserMessages).toEqual(["Embedded side goal"]);
    expect(notifications).toContainEqual({
      message: "Started the side task in this split.",
      level: "info",
    });
  });

  test("dispatches the prompt from the newest child marker", async () => {
    let btwHandler: ((args: string, ctx: any) => Promise<void>) | undefined;
    const sentUserMessages: string[] = [];
    const branch = [
      childMarkerEntry("old", null, {
        baseLeafId: null,
        prompt: "Old prompt",
      }),
      childMarkerEntry("new", "old", {
        baseLeafId: "old",
        prompt: "Newest prompt",
      }),
    ];
    const pi = {
      registerCommand(name: string, definition: any) {
        if (name === "btw") btwHandler = definition.handler;
      },
      events: { on: () => () => undefined, emit: () => undefined },
      sendUserMessage(message: string) {
        sentUserMessages.push(message);
      },
      on: () => {},
    };
    registerSplitSession(pi as any);
    await btwHandler!("--launch", {
      sessionManager: { getBranch: () => branch },
      waitForIdle: async () => {},
      ui: { notify() {} },
    } as any);
    expect(sentUserMessages).toEqual(["Newest prompt"]);
  });

  test("refuses --launch outside a side split", async () => {
    let btwHandler: ((args: string, ctx: any) => Promise<void>) | undefined;
    const notifications: Array<{ message: string; level: string }> = [];
    const pi = {
      registerCommand(name: string, definition: any) {
        if (name === "btw") btwHandler = definition.handler;
      },
      events: { on: () => () => undefined, emit: () => undefined },
      sendUserMessage: () => {
        throw new Error("must not send a message outside a child");
      },
      on: () => {},
    };
    const ctx = {
      hasUI: true,
      sessionManager: { getBranch: () => [] },
      waitForIdle: async () => {},
      ui: {
        notify(message: string, level: string) {
          notifications.push({ message, level });
        },
      },
    };
    registerSplitSession(pi as any);
    if (!btwHandler) throw new Error("btw command was not registered");

    await btwHandler!("--launch", ctx as any);

    expect(notifications).toContainEqual({
      message:
        "/btw --launch can only run inside a side split created by /btw.",
      level: "warning",
    });
  });
});

describe("split launch", () => {
  test("rejects nested /btw launches inside a side split", async () => {
    const restore = setHerdrIdentity();
    const harness = createSplitHarness(
      async () => {
        throw new Error("a nested split must not execute");
      },
      {
        sourceBranch: [
          childMarkerEntry("child", null, {
            baseLeafId: null,
            prompt: "Outer side task",
          }),
        ],
        leafId: "child",
      },
    );
    try {
      await harness.btw("Nested task");
    } finally {
      restore();
    }
    expect(branchedSessionCount).toBe(0);
    expect(harness.notifications).toContainEqual({
      message: "Cannot start a nested /btw split from inside a side split.",
      level: "warning",
    });
  });

  test("warns instead of splitting during the first response", async () => {
    const restore = setHerdrIdentity();
    const harness = createSplitHarness(
      async () => {
        throw new Error("an unresolved first turn must not launch a split");
      },
      {
        idle: false,
        sourceBranch: [userEntry("user", null, "Main task")],
        leafId: "user",
      },
    );

    try {
      await harness.btw("Side task");
    } finally {
      restore();
    }

    expect(branchedSessionCount).toBe(0);
    expect(harness.notifications).toContainEqual({
      message: "Wait for the first response to finish before splitting.",
      level: "warning",
    });
  });

  test("warns instead of splitting an empty persisted conversation", async () => {
    const restore = clearHerdrIdentity();
    const harness = createSplitHarness(async () => {
      return { code: 1, stdout: "", stderr: "application not found" };
    });

    try {
      await harness.btw("");
    } finally {
      restore();
    }

    expect(branchedSessionCount).toBe(0);
    expect(childMarkers).toHaveLength(0);
    expect(
      harness.notifications.some((notification) =>
        notification.message.startsWith("Cannot split:"),
      ),
    ).toBe(true);
  });

  test("preserves trailing custom context while excluding an unresolved prompted turn", async () => {
    const restoreHerdrIdentity = setHerdrIdentity();
    const sourceBranch = [
      assistantEntry("settled", null, ""),
      {
        type: "custom_message",
        id: "import-result",
        parentId: "settled",
        customType: "some-custom-context",
        content: "Imported context",
      },
      userEntry("in-flight", "import-result", "Main task"),
    ];
    const harness = createSplitHarness(successfulHerdrExec, {
      idle: false,
      sourceBranch,
      leafId: "in-flight",
    });

    try {
      await harness.btw("Side task");
    } finally {
      restoreHerdrIdentity();
    }

    expect(branchedLeafIds).toEqual(["import-result"]);
    expect(harness.notifications).toContainEqual({
      message: "Split from last settled state; in-flight turn continues here.",
      level: "info",
    });
  });

  test("uses the current leaf for a completed turn even when isIdle is stale", async () => {
    const restoreHerdrIdentity = setHerdrIdentity();
    const sourceBranch = [
      assistantEntry("first-answer", null, ""),
      userEntry("user", "first-answer", "Main task"),
      assistantEntry("latest-answer", "user", ""),
    ];
    const harness = createSplitHarness(successfulHerdrExec, {
      idle: false,
      sourceBranch,
      leafId: "latest-answer",
    });

    try {
      await harness.btw("Side task");
    } finally {
      restoreHerdrIdentity();
    }

    expect(branchedLeafIds).toEqual(["latest-answer"]);
    expect(
      harness.notifications.some((notification) =>
        notification.message.includes("in-flight turn"),
      ),
    ).toBe(false);
  });

  test("forks before the oldest unresolved user when a delivered steer trails tool work", async () => {
    const restoreHerdrIdentity = setHerdrIdentity();
    const sourceBranch = [
      assistantEntry("settled", null, ""),
      userEntry("user", "settled", "Main task"),
      assistantEntry("partial", "user", "", "toolUse"),
      {
        type: "message",
        id: "tool",
        parentId: "partial",
        message: { role: "toolResult", content: "result" },
      },
      userEntry("steer", "tool", "Steer"),
    ];
    const harness = createSplitHarness(successfulHerdrExec, {
      idle: false,
      sourceBranch,
      leafId: "steer",
    });

    try {
      await harness.btw("Side task");
    } finally {
      restoreHerdrIdentity();
    }

    expect(branchedLeafIds).toEqual(["settled"]);
  });

  test("fails before copying a session when no supported terminal host is available", async () => {
    const restoreHerdrIdentity = clearHerdrIdentity();
    const calls: Array<{ command: string; args: string[] }> = [];
    const harness = createSplitHarness(async (command, args) => {
      calls.push({ command, args });
      return { code: 1, stdout: "", stderr: "application not found" };
    });

    try {
      await harness.btw("");
    } finally {
      restoreHerdrIdentity();
    }

    expect(branchedSessionCount).toBe(0);
    expect(childMarkers).toHaveLength(0);
    if (process.platform === "darwin")
      expect(calls).toEqual([{ command: "open", args: ["-Ra", "Ghostty"] }]);
    else expect(calls).toHaveLength(0);
  });

  test("auto-submits the selected prompt when launching through Ghostty", async () => {
    if (process.platform !== "darwin") return;
    const restoreHerdrIdentity = clearHerdrIdentity();
    const calls: Array<{ command: string; args: string[] }> = [];
    const harness = createSplitHarness(async (command, args) => {
      calls.push({ command, args });
      return { code: 0, stdout: "", stderr: "" };
    });

    try {
      await harness.btw("");
    } finally {
      restoreHerdrIdentity();
    }

    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({ command: "open", args: ["-Ra", "Ghostty"] });
    expect(calls[1]!.command).toBe("osascript");
    expect(calls[1]!.args.at(-1)?.endsWith("'Selected prompt'\n")).toBe(true);
    expect(childMarkers).toEqual([
      {
        customType: SPLIT_CHILD_TYPE,
        data: { prompt: "Selected prompt" },
      },
    ]);
    expect(harness.notifications).toContainEqual({
      message: "Opened split in a ghostty right split and sent prompt.",
      level: "info",
    });
  });

  test("removes the copied session when Herdr cannot create a pane", async () => {
    const restoreHerdrIdentity = setHerdrIdentity();
    const calls: Array<{ command: string; args: string[] }> = [];
    const harness = createSplitHarness(async (command, args) => {
      calls.push({ command, args });
      return { code: 1, stdout: "", stderr: "Herdr pane split failed" };
    });

    try {
      await harness.btw("");
    } finally {
      restoreHerdrIdentity();
    }

    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toEqual([
      "pane",
      "split",
      "--pane",
      "pane-1",
      "--direction",
      "right",
      "--cwd",
      "/tmp",
      "--env",
      "HERDR_AGENT=pi",
      "--focus",
    ]);
    expect(existsSync(splitSessionFile)).toBe(false);
    expect(harness.notifications).toContainEqual({
      message: "Failed to launch split: Herdr pane split failed",
      level: "error",
    });
  });

  test("keeps the copied session when a killed Herdr pane split is ambiguous", async () => {
    const restoreHerdrIdentity = setHerdrIdentity();
    const harness = createSplitHarness(async () => ({
      code: 0,
      stdout: JSON.stringify({ result: { pane: { pane_id: "split-pane-1" } } }),
      stderr: "",
      killed: true,
    }));

    try {
      await harness.btw("");
    } finally {
      restoreHerdrIdentity();
    }

    expect(existsSync(splitSessionFile)).toBe(true);
    expect(harness.notifications).toContainEqual({
      message: `Failed to launch split: Herdr pane split failed timed out; copied session kept at ${splitSessionFile}`,
      level: "error",
    });
  });

  test("launches a Herdr split with a constant /btw --launch command and embeds the prompt in the child marker", async () => {
    const restoreHerdrIdentity = setHerdrIdentity();
    forkedLeafId = "copied-boundary";
    const calls: Array<{ command: string; args: string[] }> = [];
    const harness = createSplitHarness(async (command, args) => {
      calls.push({ command, args });
      return successfulHerdrExec(command, args);
    });

    try {
      await harness.btw("");
    } finally {
      restoreHerdrIdentity();
    }

    expect(calls).toHaveLength(3);
    expect(calls[0]!.args).toEqual([
      "pane",
      "split",
      "--pane",
      "pane-1",
      "--direction",
      "right",
      "--cwd",
      "/tmp",
      "--env",
      "HERDR_AGENT=pi",
      "--focus",
    ]);
    const agentName = calls[1]!.args[2]!;
    expect(calls[1]!.args).toEqual([
      "agent",
      "start",
      expect.stringMatching(/^pi-btw-/),
      "--kind",
      "pi",
      "--pane",
      "split-pane-1",
      "--timeout",
      "10000",
      "--",
      "--session",
      splitSessionFile,
    ]);
    // The user prompt never appears in argv; only the constant launch command.
    expect(calls[2]).toEqual({
      command: expect.any(String),
      args: ["agent", "prompt", agentName, "/btw --launch"],
    });
    expect(
      calls.every(
        (call) =>
          !call.args.includes("Selected prompt") &&
          !call.args.some(
            (arg) =>
              typeof arg === "string" &&
              /Selected prompt/.test(arg) &&
              call.args[1] !== "prompt",
          ),
      ),
    ).toBe(true);
    expect(childMarkers).toEqual([
      {
        customType: SPLIT_CHILD_TYPE,
        data: { prompt: "Selected prompt" },
      },
    ]);
    expect(harness.notifications).toContainEqual({
      message: expect.stringMatching(
        /^Opened split in a herdr right split \(pi-btw-.+\) and sent prompt\.$/,
      ),
      level: "info",
    });
  });

  test("retries a transient busy Herdr pane until its shell is ready", async () => {
    const restoreHerdrIdentity = setHerdrIdentity();
    vi.useFakeTimers();
    const calls: Array<{ command: string; args: string[] }> = [];
    let startAttempts = 0;
    const harness = createSplitHarness(async (command, args) => {
      calls.push({ command, args });
      if (args[0] === "pane" && args[1] === "split") {
        return herdrPaneSplitResponse("split-pane-1");
      }
      if (args[0] === "agent" && args[1] === "start") {
        startAttempts++;
        if (startAttempts <= 2) {
          return {
            code: 1,
            stdout: "",
            stderr: JSON.stringify({
              error: {
                code: "agent_pane_busy",
                message: "agent target pane is not an available shell",
              },
            }),
          };
        }
        return herdrAgentStartResponse();
      }
      return herdrAgentPromptResponse();
    });

    try {
      const launch = harness.btw("");
      await vi.runAllTimersAsync();
      await launch;
    } finally {
      restoreHerdrIdentity();
    }

    const starts = calls.filter(
      (call) => call.args[0] === "agent" && call.args[1] === "start",
    );
    const prompts = calls.filter(
      (call) => call.args[0] === "agent" && call.args[1] === "prompt",
    );
    expect(starts).toHaveLength(3);
    expect(starts[1]!.args).toEqual(starts[0]!.args);
    expect(starts[2]!.args).toEqual(starts[0]!.args);
    expect(prompts).toEqual([
      {
        command: expect.any(String),
        args: ["agent", "prompt", starts[0]!.args[2], "/btw --launch"],
      },
    ]);
    expect(
      calls.some((call) => call.args[0] === "pane" && call.args[1] === "close"),
    ).toBe(false);
    expect(harness.notifications).toContainEqual({
      message: expect.stringMatching(/^Opened split in a herdr right split/),
      level: "info",
    });
  });

  test("bounds busy-pane retries and preserves definite failure cleanup", async () => {
    const restoreHerdrIdentity = setHerdrIdentity();
    vi.useFakeTimers();
    const calls: Array<{ command: string; args: string[] }> = [];
    const busyResult = {
      code: 1,
      stdout: "",
      stderr: JSON.stringify({
        error: {
          code: "agent_pane_busy",
          message: "agent target pane is not an available shell",
        },
      }),
    };
    const harness = createSplitHarness(async (command, args) => {
      calls.push({ command, args });
      if (args[0] === "pane" && args[1] === "split") {
        return herdrPaneSplitResponse("split-pane-1");
      }
      if (args[0] === "pane" && args[1] === "close") {
        return { code: 0, stdout: "", stderr: "" };
      }
      return busyResult;
    });

    try {
      const launch = harness.btw("");
      await vi.runAllTimersAsync();
      await launch;
    } finally {
      restoreHerdrIdentity();
    }

    const starts = calls.filter(
      (call) => call.args[0] === "agent" && call.args[1] === "start",
    );
    const prompts = calls.filter(
      (call) => call.args[0] === "agent" && call.args[1] === "prompt",
    );
    const closes = calls.filter(
      (call) => call.args[0] === "pane" && call.args[1] === "close",
    );
    expect(starts).toHaveLength(30);
    expect(prompts).toHaveLength(0);
    expect(closes).toEqual([
      { command: expect.any(String), args: ["pane", "close", "split-pane-1"] },
    ]);
    expect(existsSync(splitSessionFile)).toBe(false);
    expect(harness.notifications).toContainEqual({
      message: expect.stringContaining("agent_pane_busy"),
      level: "error",
    });
  });

  test("propagates the matching local -e extension path to the child once", async () => {
    const restoreHerdrIdentity = setHerdrIdentity();
    const extensionPath = join(
      process.cwd(),
      "extensions/pi-btw-with-imports/src/index.ts",
    );
    const originalArgv = process.argv;
    process.argv = [originalArgv[0]!, originalArgv[1]!, "-e", extensionPath];
    const calls: Array<{
      args: string[];
      timeout: number | undefined;
    }> = [];
    const harness = createSplitHarness(async (command, args, options) => {
      calls.push({ args, timeout: options?.timeout });
      return successfulHerdrExec(command, args);
    });

    try {
      await harness.btw("Local side task");
    } finally {
      process.argv = originalArgv;
      restoreHerdrIdentity();
    }

    const startArgs = calls[1]!.args;
    expect(startArgs.slice(-5)).toEqual([
      "--",
      "-e",
      extensionPath,
      "--session",
      splitSessionFile,
    ]);
    expect(startArgs.filter((arg) => arg === extensionPath)).toHaveLength(1);
    expect(calls.slice(0, 3).map((call) => call.timeout)).toEqual([
      15000, 15000, 15000,
    ]);
  });

  test("submits the constant launch command even for a multiline prompt", async () => {
    const restoreHerdrIdentity = setHerdrIdentity();
    const calls: Array<{ command: string; args: string[] }> = [];
    const harness = createSplitHarness(async (command, args) => {
      calls.push({ command, args });
      return successfulHerdrExec(command, args);
    });
    const prompt = "Review this:\n\t- preserve formatting";

    try {
      await harness.btw(prompt);
    } finally {
      restoreHerdrIdentity();
    }

    expect(calls).toHaveLength(3);
    expect(calls[1]!.args.every((arg) => !/[\n\t]/.test(arg))).toBe(true);
    expect(calls[2]!.args.slice(0, 3)).toEqual([
      "agent",
      "prompt",
      calls[1]!.args[2],
    ]);
    expect(calls[2]!.args[3]).toBe("/btw --launch");
    expect(childMarkers[0]!.data).toMatchObject({ prompt });
  });

  test("closes the new pane and deletes the child when Herdr agent start fails definitely", async () => {
    const restoreHerdrIdentity = setHerdrIdentity();
    const calls: Array<{ command: string; args: string[] }> = [];
    const harness = createSplitHarness(async (command, args) => {
      calls.push({ command, args });
      if (args[0] === "pane" && args[1] === "split") {
        return herdrPaneSplitResponse("split-pane-1");
      }
      if (args[0] === "pane" && args[1] === "close") {
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "Herdr agent start failed" };
    });

    try {
      await harness.btw("");
    } finally {
      restoreHerdrIdentity();
    }

    const closeCall = calls.find(
      (call) => call.args[0] === "pane" && call.args[1] === "close",
    );
    expect(closeCall).toBeDefined();
    expect(closeCall!.args).toEqual(["pane", "close", "split-pane-1"]);
    expect(existsSync(splitSessionFile)).toBe(false);
    expect(harness.notifications).toContainEqual({
      message: "Failed to launch split: Herdr agent start failed",
      level: "error",
    });
  });

  test("retains the child when Herdr agent start times out ambiguously", async () => {
    const restoreHerdrIdentity = setHerdrIdentity();
    const calls: Array<{ command: string; args: string[] }> = [];
    const harness = createSplitHarness(async (command, args) => {
      calls.push({ command, args });
      if (args[0] === "pane" && args[1] === "split") {
        return herdrPaneSplitResponse("split-pane-1");
      }
      return { code: 0, stdout: "", stderr: "", killed: true };
    });

    try {
      await harness.btw("");
    } finally {
      restoreHerdrIdentity();
    }

    expect(
      calls.some((call) => call.args[0] === "pane" && call.args[1] === "close"),
    ).toBe(false);
    expect(existsSync(splitSessionFile)).toBe(true);
    expect(harness.notifications).toContainEqual({
      message: `Failed to launch split: Herdr agent start failed timed out; copied session kept at ${splitSessionFile}`,
      level: "error",
    });
  });

  test("retains the child when pane cleanup after a definite start failure is ambiguous", async () => {
    const restoreHerdrIdentity = setHerdrIdentity();
    const harness = createSplitHarness(async (command, args) => {
      if (args[0] === "pane" && args[1] === "split") {
        return herdrPaneSplitResponse("split-pane-1");
      }
      if (args[0] === "pane" && args[1] === "close") {
        return { code: 0, stdout: "", stderr: "", killed: true };
      }
      return { code: 1, stdout: "", stderr: "Herdr agent start failed" };
    });

    try {
      await harness.btw("");
    } finally {
      restoreHerdrIdentity();
    }

    expect(existsSync(splitSessionFile)).toBe(true);
    expect(harness.notifications[0]!.message).toContain(
      "pane cleanup retained",
    );
  });

  test("keeps the copied session when Herdr cannot submit the launch command", async () => {
    const restoreHerdrIdentity = setHerdrIdentity();
    const calls: Array<{ command: string; args: string[] }> = [];
    const harness = createSplitHarness(async (command, args) => {
      calls.push({ command, args });
      if (args[0] === "pane") return herdrPaneSplitResponse("split-pane-1");
      if (args[1] === "start") return herdrAgentStartResponse();
      return { code: 1, stdout: "", stderr: "Herdr agent prompt failed" };
    });

    try {
      await harness.btw("");
    } finally {
      restoreHerdrIdentity();
    }

    expect(calls).toHaveLength(3);
    expect(calls[2]!.args[3]).toBe("/btw --launch");
    expect(existsSync(splitSessionFile)).toBe(true);
    expect(harness.notifications).toContainEqual({
      message: `Failed to launch split: Herdr agent prompt failed; copied session kept at ${splitSessionFile}`,
      level: "error",
    });
  });
});

describe("first-turn snapshot", () => {
  test("snapshots the in-memory context into a persisted child when the source file does not exist", async () => {
    const restoreHerdrIdentity = setHerdrIdentity();
    buildContextResult = {
      messages: [
        { role: "user", content: [{ type: "text", text: "Main task" }] },
        {
          role: "assistant",
          content: [{ type: "text", text: "Main answer" }],
          stopReason: "stop",
        },
      ],
      thinkingLevel: "high",
      model: { provider: "anthropic", modelId: "claude-test" },
    };
    const calls: Array<{ command: string; args: string[] }> = [];
    const harness = createSplitHarness(
      async (command, args) => {
        calls.push({ command, args });
        return successfulHerdrExec(command, args);
      },
      { sourceSessionFile: `${sourceSessionFile}.missing` },
    );

    try {
      await harness.btw("Side task");
    } finally {
      restoreHerdrIdentity();
    }

    // Snapshot path does not branch from a persisted leaf.
    expect(branchedSessionCount).toBe(0);
    expect(branchedLeafIds).toHaveLength(0);
    // Exact messages preserved.
    expect(snapshotChild.messages).toEqual(buildContextResult.messages);
    expect(snapshotChild.modelChanges).toEqual([
      { provider: "anthropic", modelId: "claude-test" },
    ]);
    expect(snapshotChild.thinkingChanges).toEqual(["high"]);
    expect(snapshotChild.operations).toEqual([
      "message",
      "message",
      "model",
      "thinking",
    ]);
    // Child marker embeds the prompt for /btw --launch dispatch.
    expect(childMarkers).toEqual([
      {
        customType: SPLIT_CHILD_TYPE,
        data: { prompt: "Side task" },
      },
    ]);
    // Herdr launch uses the constant command, not the prompt.
    expect(calls[2]!.args[3]).toBe("/btw --launch");
  });

  test("preserves a null boundary for an unresolved in-memory first turn", async () => {
    const restoreHerdrIdentity = setHerdrIdentity();
    buildContextResult = { messages: [], thinkingLevel: "off", model: null };
    const harness = createSplitHarness(successfulHerdrExec, {
      sourceSessionFile: `${sourceSessionFile}.missing`,
      sourceBranch: [userEntry("in-flight", null, "Main task")],
      leafId: "in-flight",
    });
    try {
      await harness.btw("Side task");
    } finally {
      restoreHerdrIdentity();
    }
    expect(buildContextLeafIds).toEqual([null]);
    expect(snapshotChild.messages).toEqual([]);
    expect(harness.notifications).toContainEqual({
      message: "Split from last settled state; in-flight turn continues here.",
      level: "info",
    });
  });

  test.each(["branchSummary", "compactionSummary"])(
    "rejects unsupported %s snapshot context",
    async (role) => {
      const restoreHerdrIdentity = setHerdrIdentity();
      buildContextResult = {
        messages: [{ role, summary: "summary" }],
        thinkingLevel: "off",
        model: null,
      };
      const harness = createSplitHarness(successfulHerdrExec, {
        sourceSessionFile: `${sourceSessionFile}.missing`,
      });
      try {
        await harness.btw("Side task");
      } finally {
        restoreHerdrIdentity();
      }
      expect(snapshotChild.messages).toHaveLength(0);
      expect(childMarkers).toHaveLength(0);
      expect(harness.notifications.at(-1)?.message).toContain(
        `Cannot snapshot ${role} context`,
      );
    },
  );

  test("snapshots an empty first-turn context as a fresh child with the goal", async () => {
    const restoreHerdrIdentity = setHerdrIdentity();
    buildContextResult = { messages: [], thinkingLevel: "off", model: null };
    const harness = createSplitHarness(successfulHerdrExec, {
      sourceSessionFile: `${sourceSessionFile}.missing`,
    });

    try {
      await harness.btw("Brand new side task");
    } finally {
      restoreHerdrIdentity();
    }

    expect(snapshotChild.messages).toEqual([]);
    expect(snapshotChild.modelChanges).toEqual([]);
    expect(snapshotChild.thinkingChanges).toEqual(["off"]);
    expect(childMarkers[0]!.data).toMatchObject({
      prompt: "Brand new side task",
    });
  });
});
