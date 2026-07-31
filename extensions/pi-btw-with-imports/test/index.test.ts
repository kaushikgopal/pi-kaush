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
const SPLIT_RECORD_TYPE = "split-fork-record";
const SPLIT_MERGE_INTENT_TYPE = "split-merge-intent";
const SPLIT_MERGE_REQUEST_TYPE = "split-merge-request";
const SPLIT_MERGE_RESULT_TYPE = "split-merge-result";
const handoffPrompt = `Prepare the final handoff from this side split for the main coding-agent session.

Preserve:
- each distinct answer or outcome
- important files, commands, and evidence
- decisions and recommendations
- blockers, uncertainty, and follow-up work

Return only the clean, concise handoff. Do not collapse separate results into one, solve the task again, or mention these instructions.`;

let childBranch: any[] = [];
let olderChildBranch: any[] = [];
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
const olderSplitSessionFile = join(
  tmpdir(),
  `pi-split-fork-older-${process.pid}.jsonl`,
);
const sourceSessionFile = join(
  tmpdir(),
  `pi-split-fork-source-${process.pid}.jsonl`,
);
writeFileSync(splitSessionFile, "");
writeFileSync(olderSplitSessionFile, "");
writeFileSync(sourceSessionFile, "");

vi.doMock("@earendil-works/pi-coding-agent", () => ({
  SessionManager: class {
    static open(sessionFile: string) {
      if (sessionFile === splitSessionFile)
        return {
          getBranch: () => childBranch,
          getEntry: (id: string) =>
            childBranch.find((entry) => entry.id === id),
        };
      if (sessionFile === olderSplitSessionFile)
        return {
          getBranch: () => olderChildBranch,
          getEntry: (id: string) =>
            olderChildBranch.find((entry) => entry.id === id),
        };
      // Default: the source session being branched (sourceSessionFile).
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

// Tracks the most recently created merge harness shutdown handler so a
// top-level afterEach can stop the live merge poll loop between tests and
// prevent stray ticks from leaking across test boundaries.
let lastMergeHarnessShutdown: (() => void) | undefined;

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

function splitRecordEntry(
  id: string,
  parentId: string | null,
  data: {
    sessionFile: string;
    baseLeafId: string | null;
    label: string;
    herdrTarget?: string;
  },
) {
  return { type: "custom", id, parentId, customType: SPLIT_RECORD_TYPE, data };
}

function mergeRequestEntry(
  id: string,
  parentId: string | null,
  requestId: string,
  intentEntryId: string,
  promptEntryId: string,
  answerEntryId: string,
) {
  return {
    type: "custom",
    id,
    parentId,
    customType: SPLIT_MERGE_REQUEST_TYPE,
    data: { requestId, intentEntryId, promptEntryId, answerEntryId },
  };
}

function mergeIntentEntry(
  id: string,
  parentId: string | null,
  requestId: string,
  prompt: string,
) {
  return {
    type: "custom",
    id,
    parentId,
    customType: SPLIT_MERGE_INTENT_TYPE,
    data: { requestId, handoffPrompt: prompt },
  };
}

function appendCompletedMerge(
  branch: any[],
  options: {
    prefix?: string;
    requestId: string;
    answerText: string;
    answerStopReason?: string;
  },
) {
  const prefix = options.prefix ?? "merge";
  const parentId = branch.at(-1)?.id ?? null;
  const intentId = `${prefix}-intent`;
  const promptId = `${prefix}-prompt`;
  const answerId = `${prefix}-answer`;
  branch.push(
    mergeIntentEntry(intentId, parentId, options.requestId, handoffPrompt),
    userEntry(promptId, intentId, handoffPrompt),
    assistantEntry(
      answerId,
      promptId,
      options.answerText,
      options.answerStopReason,
    ),
    mergeRequestEntry(
      `${prefix}-request`,
      answerId,
      options.requestId,
      intentId,
      promptId,
      answerId,
    ),
  );
  return { intentId, promptId, answerId };
}

function mergeResultEntry(
  id: string,
  parentId: string | null,
  requestId: string,
  sessionFile: string,
  answerEntryId: string,
) {
  return {
    type: "custom_message",
    id,
    parentId,
    customType: SPLIT_MERGE_RESULT_TYPE,
    content: "Imported handoff",
    display: true,
    details: { requestId, sessionFile, answerEntryId },
  };
}

function createMergeHarness(
  options: {
    olderRecord?: boolean;
    processedRequestId?: string;
    processedAnswerEntryId?: string;
    selectedMergeIndex?: number;
    cancelSelection?: boolean;
    hasUI?: boolean;
    idle?: boolean;
    recordLabel?: string;
    olderLabel?: string;
    herdrTarget?: string;
    olderHerdrTarget?: string;
    selectionPromise?: Promise<string | undefined>;
    processDuringWait?: boolean;
    execResult?: (args: string[]) => {
      code: number;
      stdout: string;
      stderr: string;
      killed?: boolean;
    };
  } = {},
) {
  let btwHandler: ((args: string, ctx: any) => Promise<void>) | undefined;
  let sessionStartHandler:
    | ((event: any, ctx: any) => Promise<void> | void)
    | undefined;
  let sessionShutdownHandler:
    | ((event: any, ctx: any) => Promise<void> | void)
    | undefined;
  const commandNames: string[] = [];
  const sentMessages: any[] = [];
  const sentUserMessages: string[] = [];
  const appendedEntries: Array<{ type: string; data: unknown }> = [];
  const notifications: Array<{ message: string; level: string }> = [];
  const selectionChoices: string[][] = [];
  const execCalls: Array<{ command: string; args: string[] }> = [];

  const parentBranch: any[] = [];
  if (options.olderRecord) {
    parentBranch.push(
      splitRecordEntry("older-record", null, {
        sessionFile: olderSplitSessionFile,
        baseLeafId: "older-base",
        label: options.olderLabel ?? "Investigate the older issue",
        ...(options.olderHerdrTarget
          ? { herdrTarget: options.olderHerdrTarget }
          : {}),
      }),
    );
  }
  parentBranch.push(
    splitRecordEntry("record", options.olderRecord ? "older-record" : null, {
      sessionFile: splitSessionFile,
      baseLeafId: "base",
      label: options.recordLabel ?? "Review the latest change",
      ...(options.herdrTarget ? { herdrTarget: options.herdrTarget } : {}),
    }),
  );
  if (options.processedRequestId) {
    parentBranch.push(
      mergeResultEntry(
        "import",
        "record",
        options.processedRequestId,
        splitSessionFile,
        options.processedAnswerEntryId ?? "merge-answer",
      ),
    );
  }

  const pi = {
    registerCommand(name: string, definition: any) {
      commandNames.push(name);
      if (name === "btw") btwHandler = definition.handler;
    },
    sendMessage(message: {
      customType: string;
      content: string;
      display?: boolean;
      details?: unknown;
    }) {
      sentMessages.push(message);
      // Mirror real pi behavior: a processed merge result becomes a durable
      // custom_message entry in the branch so the poll dedupes it by requestId.
      if (message.customType === SPLIT_MERGE_RESULT_TYPE) {
        const details = message.details as {
          requestId: string;
          sessionFile: string;
          answerEntryId: string;
        };
        parentBranch.push(
          mergeResultEntry(
            `import-${details.requestId}`,
            parentBranch.at(-1)?.id ?? null,
            details.requestId,
            details.sessionFile,
            details.answerEntryId,
          ),
        );
      }
    },
    sendUserMessage(message: string) {
      sentUserMessages.push(message);
    },
    appendEntry(type: string, data: unknown) {
      appendedEntries.push({ type, data });
    },
    exec: async (command: string, args: string[]) => {
      execCalls.push({ command, args });
      return (
        options.execResult?.(args) ?? {
          code: 0,
          stdout: "",
          stderr: "",
          killed: false,
        }
      );
    },
    on(event: string, handler: any) {
      if (event === "session_start") sessionStartHandler = handler;
      if (event === "session_shutdown") sessionShutdownHandler = handler;
    },
  };

  lastMergeHarnessShutdown = () =>
    sessionShutdownHandler?.({ type: "session_shutdown", reason: "quit" }, ctx);

  let idle = options.idle ?? true;
  const ctx = {
    hasUI: options.hasUI ?? true,
    isIdle: () => idle,
    sessionManager: {
      getBranch: () => parentBranch,
      getSessionDir: () => "/tmp",
    },
    waitForIdle: async () => {
      if (options.processDuringWait) {
        parentBranch.push(
          mergeResultEntry(
            "concurrent-import",
            parentBranch.at(-1)?.id ?? null,
            "req-1",
            splitSessionFile,
            "merge-answer",
          ),
        );
      }
    },
    ui: {
      select(_title: string, choices: string[]) {
        selectionChoices.push(choices);
        if (options.selectionPromise) return options.selectionPromise;
        if (options.cancelSelection) return Promise.resolve(undefined);
        return Promise.resolve(choices[options.selectedMergeIndex ?? 0]);
      },
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
    },
  };

  registerSplitSession(pi as any);
  if (!btwHandler) throw new Error("btw command was not registered");

  return {
    merge: (args = "") => btwHandler!(args ? `merge ${args}` : "merge", ctx),
    fireSessionStart: (sessionCtx: any = ctx) =>
      sessionStartHandler!(
        { type: "session_start", reason: "startup" },
        sessionCtx,
      ),
    fireSessionShutdown: (sessionCtx: any = ctx) =>
      sessionShutdownHandler?.(
        { type: "session_shutdown", reason: "quit" },
        sessionCtx,
      ),
    setIdle(value: boolean) {
      idle = value;
    },
    commandNames,
    sentMessages,
    sentUserMessages,
    appendedEntries,
    notifications,
    selectionChoices,
    execCalls,
  };
}

function createChildMergeHarness(
  options: {
    parentPaneId?: string;
    extraBranch?: any[];
    execResult?: (args: string[]) => {
      code: number;
      stdout: string;
      stderr: string;
      killed?: boolean;
    };
  } = {},
) {
  let btwHandler: ((args: string, ctx: any) => Promise<void>) | undefined;
  let sessionStartHandler:
    | ((event: any, ctx: any) => Promise<void>)
    | undefined;
  let agentSettledHandler:
    | ((event: any, ctx: any) => Promise<void>)
    | undefined;
  const sentUserMessages: string[] = [];
  const appendedEntries: Array<{ type: string; data: unknown }> = [];
  const notifications: Array<{ message: string; level: string }> = [];
  const execCalls: Array<{ command: string; args: string[] }> = [];

  const marker = childMarkerEntry("child-marker", null, {
    baseLeafId: "base",
    prompt: "Side goal",
    parentPaneId: options.parentPaneId,
  });
  const branch: any[] = [
    marker,
    ...(options.extraBranch ?? []),
    assistantEntry(
      "pre-existing-answer",
      options.extraBranch?.at(-1)?.id ?? "child-marker",
      "This answer existed before /btw merge",
    ),
  ];
  let customEntryCount = 0;
  let userEntryCount = 0;
  let assistantEntryCount = 0;

  const pi = {
    registerCommand(name: string, definition: any) {
      if (name === "btw") btwHandler = definition.handler;
    },
    sendUserMessage(message: string) {
      sentUserMessages.push(message);
      const id = `sent-user-${++userEntryCount}`;
      branch.push(userEntry(id, branch.at(-1)?.id ?? null, message));
    },
    appendEntry(type: string, data: unknown) {
      const id = `custom-${++customEntryCount}`;
      appendedEntries.push({ type, data });
      branch.push({
        type: "custom",
        id,
        parentId: branch.at(-1)?.id ?? null,
        customType: type,
        data,
      });
      return id;
    },
    exec: async (command: string, args: string[]) => {
      execCalls.push({ command, args });
      return (
        options.execResult?.(args) ?? {
          code: 0,
          stdout: "",
          stderr: "",
          killed: false,
        }
      );
    },
    on(event: string, handler: any) {
      if (event === "session_start") sessionStartHandler = handler;
      if (event === "agent_settled") agentSettledHandler = handler;
    },
  };
  const ctx = {
    hasUI: true,
    isIdle: () => true,
    sessionManager: {
      getBranch: () => branch,
      getSessionDir: () => "/tmp",
    },
    waitForIdle: async () => {},
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
    },
  };

  registerSplitSession(pi as any);
  if (!btwHandler) throw new Error("btw command was not registered");

  return {
    merge: (args = "") => btwHandler!(args ? `merge ${args}` : "merge", ctx),
    appendAssistant(text = "Concise split handoff", stopReason = "stop") {
      const id = `sent-assistant-${++assistantEntryCount}`;
      branch.push(
        assistantEntry(id, branch.at(-1)?.id ?? null, text, stopReason),
      );
      return id;
    },
    fireAgentSettled: () =>
      agentSettledHandler!({ type: "agent_settled" }, ctx),
    fireSessionStart: () =>
      sessionStartHandler!({ type: "session_start", reason: "startup" }, ctx),
    branch,
    sentUserMessages,
    appendedEntries,
    notifications,
    execCalls,
  };
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
    appendError?: Error;
    idle?: boolean;
    sourceSessionFile?: string;
    sourceBranch?: any[];
    leafId?: string | null;
  } = {},
) {
  let btwHandler: ((args: string, ctx: any) => Promise<void>) | undefined;
  const appendedEntries: Array<{ type: string; data: unknown }> = [];
  const appendAttempts: Array<{ type: string; data: unknown }> = [];
  const notifications: Array<{ message: string; level: string }> = [];
  const sourceBranch = options.sourceBranch ?? [
    assistantEntry("base", null, "Base answer"),
    userEntry("selected", "base", "Selected prompt"),
  ];

  const pi = {
    registerCommand(name: string, definition: any) {
      if (name === "btw") btwHandler = definition.handler;
    },
    exec,
    appendEntry(type: string, data: unknown) {
      appendAttempts.push({ type, data });
      if (options.appendError) throw options.appendError;
      appendedEntries.push({ type, data });
    },
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
    appendedEntries,
    appendAttempts,
    notifications,
  };
}

afterAll(() => {
  rmSync(splitSessionFile, { force: true });
  rmSync(olderSplitSessionFile, { force: true });
  rmSync(sourceSessionFile, { force: true });
});

afterEach(() => {
  // Stop any live merge poll loop started during the test and restore real
  // timers so no stray ticks leak into the next test.
  lastMergeHarnessShutdown?.();
  lastMergeHarnessShutdown = undefined;
  vi.useRealTimers();
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

async function fireSessionStartUnderHerdr(harness: {
  fireSessionStart: () => Promise<void> | void;
}): Promise<void> {
  const restore = setHerdrIdentity();
  try {
    await harness.fireSessionStart();
  } finally {
    restore();
  }
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
  writeFileSync(olderSplitSessionFile, "");
  writeFileSync(sourceSessionFile, "");
  childBranch = [
    assistantEntry("base", null, "Inherited context"),
    userEntry("prompt", "base", "Give me a Bruce Lee quote"),
    assistantEntry("first-answer", "prompt", "Be water, my friend."),
    userEntry("follow-up", "first-answer", "Give me a Hemingway quote"),
    assistantEntry("answer", "follow-up", "Exact side answer"),
  ];
  olderChildBranch = [
    assistantEntry("older-base", null, "Older inherited context"),
    userEntry("older-prompt", "older-base", "Investigate the older issue"),
    assistantEntry("older-answer", "older-prompt", "Older split result"),
  ];
});

// Flush the full microtask chain (e.g. the async poll tick and its awaited
// selector) without advancing the recurring poll timer. Scheduling a macrotask
// drains every queued microtask before it runs.
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("command registration", () => {
  test("registers only /btw and no /split* commands", () => {
    const harness = createMergeHarness();
    expect(harness.commandNames).toEqual(["btw"]);
  });
});

describe("merge import (parent)", () => {
  beforeEach(() => {
    appendCompletedMerge(childBranch, {
      requestId: "req-1",
      answerText: "Exact side answer",
    });
    appendCompletedMerge(olderChildBranch, {
      prefix: "older-merge",
      requestId: "req-older",
      answerText: "Older split result",
    });
  });

  test("auto-imports a single valid merge on Herdr session start", async () => {
    const harness = createMergeHarness();
    await fireSessionStartUnderHerdr(harness);

    expect(harness.sentMessages).toHaveLength(1);
    expect(harness.sentMessages[0]).toMatchObject({
      customType: SPLIT_MERGE_RESULT_TYPE,
      content: "Handoff from side split\n\n---\n\nExact side answer",
      details: {
        requestId: "req-1",
        sessionFile: splitSessionFile,
        answerEntryId: "merge-answer",
      },
    });
    expect(harness.sentUserMessages).toHaveLength(0);
    expect(harness.notifications).toContainEqual({
      message: "Imported the side handoff.",
      level: "info",
    });
  });

  test("manually imports a single pending merge with a follow-up", async () => {
    const harness = createMergeHarness();
    await harness.merge("compare with the current approach");

    expect(harness.sentMessages[0]).toMatchObject({
      content: "Handoff from side split\n\n---\n\nExact side answer",
      details: {
        requestId: "req-1",
        sessionFile: splitSessionFile,
        answerEntryId: "merge-answer",
      },
    });
    expect(harness.sentUserMessages).toEqual([
      "compare with the current approach",
    ]);
  });

  test("does not reimport a processed requestId", async () => {
    const harness = createMergeHarness({
      processedRequestId: "req-1",
      processedAnswerEntryId: "merge-answer",
    });
    await harness.merge();
    expect(harness.sentMessages).toHaveLength(0);
  });

  test("rechecks dedupe after waiting for the parent to settle", async () => {
    const harness = createMergeHarness({ processDuringWait: true });
    await harness.merge();
    expect(harness.sentMessages).toHaveLength(0);
  });

  test("shows a selector when multiple pending merges exist", async () => {
    const harness = createMergeHarness({
      olderRecord: true,
      selectedMergeIndex: 1,
    });
    await harness.merge();

    expect(harness.sentMessages[0]).toMatchObject({
      content: "Handoff from side split\n\n---\n\nOlder split result",
      details: {
        requestId: "req-older",
        sessionFile: olderSplitSessionFile,
        answerEntryId: "older-merge-answer",
      },
    });
    expect(harness.selectionChoices).toEqual([
      ["1. Review the latest change", "2. Investigate the older issue"],
    ]);
  });

  test("notifies instead of guessing outside the UI", async () => {
    const harness = createMergeHarness({ olderRecord: true, hasUI: false });
    await harness.merge();
    expect(harness.sentMessages).toHaveLength(0);
    expect(harness.notifications).toContainEqual({
      message:
        "Multiple pending merges are available; choose one in the interactive UI.",
      level: "warning",
    });
  });

  test("auto-shows the selector under Herdr", async () => {
    const harness = createMergeHarness({
      olderRecord: true,
      selectedMergeIndex: 1,
    });
    await fireSessionStartUnderHerdr(harness);
    expect(harness.selectionChoices).toHaveLength(1);
    expect(harness.sentMessages[0]).toMatchObject({
      details: { requestId: "req-older" },
    });
  });

  test("rejects an answer that is not completed", async () => {
    const answer = childBranch.find((entry) => entry.id === "merge-answer");
    answer.message.stopReason = "toolUse";
    const harness = createMergeHarness();
    await harness.merge();
    expect(harness.sentMessages).toHaveLength(0);
    expect(harness.notifications).toContainEqual({
      message:
        "The side handoff is not valid for its merge request; refusing to import.",
      level: "warning",
    });
  });

  test("rejects a request whose answer is not associated with the exact intent prompt", async () => {
    const request = childBranch.find((entry) => entry.id === "merge-request");
    request.data.answerEntryId = "answer";
    const harness = createMergeHarness();
    await harness.merge();
    expect(harness.sentMessages).toHaveLength(0);
    expect(harness.notifications.at(-1)?.message).toContain(
      "not valid for its merge request",
    );
  });
});

describe("merge candidate dispatch (parent)", () => {
  function markerAndSideWork(
    options: {
      markerId?: string;
      baseId?: string;
      promptText?: string;
      answerText?: string;
      answerId?: string;
    } = {},
  ) {
    const markerId = options.markerId ?? "child-marker";
    const baseId = options.baseId ?? "inherited";
    const promptId = "side-prompt";
    const answerId = options.answerId ?? "side-answer";
    return [
      assistantEntry(baseId, null, "Inherited context"),
      childMarkerEntry(markerId, baseId, {
        baseLeafId: "base",
        prompt: "Side goal",
      }),
      userEntry(promptId, markerId, options.promptText ?? "Do the side work"),
      assistantEntry(
        answerId,
        promptId,
        options.answerText ?? "Concise side result",
      ),
    ];
  }

  function herdrAgentListResponse(
    agents: Array<{
      name?: string;
      pane_id?: string;
      agent_session?: { value?: string };
    }>,
  ) {
    return {
      code: 0,
      stdout: JSON.stringify({ result: { agents } }),
      stderr: "",
      killed: false,
    };
  }

  function dispatchExec(
    listAgents: Array<{
      name?: string;
      pane_id?: string;
      agent_session?: { value?: string };
    }> = [],
  ) {
    return (args: string[]) => {
      if (args[0] === "agent" && args[1] === "list") {
        return herdrAgentListResponse(listAgents);
      }
      if (args[0] === "agent" && args[1] === "prompt") {
        return {
          code: 0,
          stdout: JSON.stringify({ result: { type: "agent_prompted" } }),
          stderr: "",
          killed: false,
        };
      }
      throw new Error(`Unexpected Herdr command: ${args.join(" ")}`);
    };
  }

  beforeEach(() => {
    childBranch = markerAndSideWork();
    olderChildBranch = markerAndSideWork({
      markerId: "older-child-marker",
      baseId: "older-inherited",
      answerText: "Older side result",
      answerId: "older-side-answer",
    });
  });

  test("dispatches /btw merge to a stored Herdr target without querying agent list", async () => {
    const restore = setHerdrIdentity();
    const harness = createMergeHarness({
      herdrTarget: "pi-split-stored",
      execResult: dispatchExec(),
    });
    try {
      await harness.merge();
    } finally {
      restore();
    }
    expect(harness.execCalls).toEqual([
      {
        command: expect.any(String),
        args: ["agent", "prompt", "pi-split-stored", "/btw merge"],
      },
    ]);
    expect(harness.sentMessages).toHaveLength(0);
    expect(harness.notifications).toContainEqual({
      message:
        'Asked the side session "Review the latest change" to prepare its handoff. It will be imported here when ready.',
      level: "info",
    });
  });

  test("resolves a legacy record target by matching agent_session.value to the child session file", async () => {
    const restore = setHerdrIdentity();
    const harness = createMergeHarness({
      execResult: dispatchExec([
        {
          name: "pi-split-legacy",
          pane_id: "w1:p2",
          agent_session: { value: splitSessionFile },
        },
      ]),
    });
    try {
      await harness.merge();
    } finally {
      restore();
    }
    expect(harness.execCalls).toHaveLength(2);
    expect(harness.execCalls[0]!.args).toEqual(["agent", "list"]);
    expect(harness.execCalls[1]).toEqual({
      command: expect.any(String),
      args: ["agent", "prompt", "pi-split-legacy", "/btw merge"],
    });
    expect(harness.sentMessages).toHaveLength(0);
  });

  test("falls back to the pane id when the matched agent has no name", async () => {
    const restore = setHerdrIdentity();
    const harness = createMergeHarness({
      execResult: dispatchExec([
        {
          pane_id: "w1:p2",
          agent_session: { value: splitSessionFile },
        },
      ]),
    });
    try {
      await harness.merge();
    } finally {
      restore();
    }
    expect(harness.execCalls[1]!.args).toEqual([
      "agent",
      "prompt",
      "w1:p2",
      "/btw merge",
    ]);
  });

  test("shows a selector and dispatches to the chosen candidate when multiple exist", async () => {
    const restore = setHerdrIdentity();
    const harness = createMergeHarness({
      olderRecord: true,
      olderHerdrTarget: "pi-split-older",
      herdrTarget: "pi-split-newest",
      selectedMergeIndex: 1,
      execResult: dispatchExec(),
    });
    try {
      await harness.merge();
    } finally {
      restore();
    }
    expect(harness.selectionChoices).toEqual([
      ["1. Review the latest change", "2. Investigate the older issue"],
    ]);
    expect(harness.execCalls).toEqual([
      {
        command: expect.any(String),
        args: ["agent", "prompt", "pi-split-older", "/btw merge"],
      },
    ]);
    expect(harness.sentMessages).toHaveLength(0);
  });

  test("never imports the raw latest answer", async () => {
    const restore = setHerdrIdentity();
    const harness = createMergeHarness({
      herdrTarget: "pi-split-stored",
      execResult: dispatchExec(),
    });
    try {
      await harness.merge();
    } finally {
      restore();
    }
    const imported = harness.sentMessages.find(
      (message) => message.customType === SPLIT_MERGE_RESULT_TYPE,
    );
    expect(imported).toBeUndefined();
  });

  test("completed merge requests take priority over candidates", async () => {
    appendCompletedMerge(childBranch, {
      requestId: "req-1",
      answerText: "Authored handoff",
    });
    const restore = setHerdrIdentity();
    const harness = createMergeHarness({
      herdrTarget: "pi-split-stored",
      execResult: dispatchExec(),
    });
    try {
      await harness.merge();
    } finally {
      restore();
    }
    expect(harness.execCalls).toHaveLength(0);
    expect(harness.sentMessages[0]).toMatchObject({
      customType: SPLIT_MERGE_RESULT_TYPE,
      content: "Handoff from side split\n\n---\n\nAuthored handoff",
      details: { requestId: "req-1" },
    });
  });

  test("does not re-offer an already-requested child with no later side work", async () => {
    // A completed merge request with no subsequent work is not a candidate.
    childBranch = markerAndSideWork();
    appendCompletedMerge(childBranch, {
      requestId: "req-1",
      answerText: "Earlier handoff",
    });
    const restore = setHerdrIdentity();
    const harness = createMergeHarness({
      processedRequestId: "req-1",
      processedAnswerEntryId: "merge-answer",
      herdrTarget: "pi-split-stored",
      execResult: dispatchExec(),
    });
    try {
      await harness.merge();
    } finally {
      restore();
    }
    expect(harness.execCalls).toHaveLength(0);
    expect(harness.sentMessages).toHaveLength(0);
    expect(harness.notifications).toContainEqual({
      message: "No pending side-session merges to import.",
      level: "warning",
    });
  });

  test("does not dispatch a second /btw merge into a child mid-handoff", async () => {
    // An intent without a following request means the child is already merging.
    childBranch = markerAndSideWork();
    const parentId = childBranch.at(-1)!.id;
    childBranch.push(
      mergeIntentEntry("pending-intent", parentId, "req-mid", handoffPrompt),
    );
    const restore = setHerdrIdentity();
    const harness = createMergeHarness({
      herdrTarget: "pi-split-stored",
      execResult: dispatchExec(),
    });
    try {
      await harness.merge();
    } finally {
      restore();
    }
    expect(harness.execCalls).toHaveLength(0);
    expect(harness.sentMessages).toHaveLength(0);
    expect(harness.notifications).toContainEqual({
      message: "No pending side-session merges to import.",
      level: "warning",
    });
  });

  test("re-offers a child with new side work after an earlier processed merge", async () => {
    childBranch = markerAndSideWork();
    appendCompletedMerge(childBranch, {
      prefix: "first",
      requestId: "req-1",
      answerText: "First handoff",
    });
    // New side work after the recorded request makes it a candidate again.
    const requestId = childBranch.at(-1)!.id;
    childBranch.push(
      userEntry("new-side-prompt", requestId, "New follow-up work"),
      assistantEntry("new-side-answer", "new-side-prompt", "New side result"),
    );
    const restore = setHerdrIdentity();
    const harness = createMergeHarness({
      processedRequestId: "req-1",
      processedAnswerEntryId: "first-answer",
      herdrTarget: "pi-split-stored",
      execResult: dispatchExec(),
    });
    try {
      await harness.merge();
    } finally {
      restore();
    }
    expect(harness.execCalls).toEqual([
      {
        command: expect.any(String),
        args: ["agent", "prompt", "pi-split-stored", "/btw merge"],
      },
    ]);
  });

  test("tells the user to run /btw merge manually when no live Herdr child matches", async () => {
    const restore = setHerdrIdentity();
    const harness = createMergeHarness({
      execResult: dispatchExec([
        {
          name: "pi-split-other",
          pane_id: "w1:p9",
          agent_session: { value: "/tmp/unrelated-session.jsonl" },
        },
      ]),
    });
    try {
      await harness.merge();
    } finally {
      restore();
    }
    expect(harness.execCalls).toEqual([
      { command: expect.any(String), args: ["agent", "list"] },
    ]);
    expect(harness.sentMessages).toHaveLength(0);
    expect(harness.notifications).toContainEqual({
      message:
        'Could not find a live Herdr agent for "Review the latest change". Run /btw merge inside that side session.',
      level: "warning",
    });
  });

  test("keeps Ghostty manual by instructing the user outside Herdr", async () => {
    const restore = clearHerdrIdentity();
    const harness = createMergeHarness({ herdrTarget: "pi-split-stored" });
    try {
      await harness.merge();
    } finally {
      restore();
    }
    expect(harness.execCalls).toHaveLength(0);
    expect(harness.sentMessages).toHaveLength(0);
    expect(harness.notifications).toContainEqual({
      message:
        'Open the side session "Review the latest change" and run /btw merge there, then run /btw merge here to import it.',
      level: "info",
    });
  });
});

describe("live merge polling", () => {
  test("auto-imports one valid handoff under Herdr", async () => {
    vi.useFakeTimers();
    appendCompletedMerge(childBranch, {
      requestId: "req-1",
      answerText: "Live side answer",
    });
    const harness = createMergeHarness();
    await fireSessionStartUnderHerdr(harness);
    expect(harness.sentMessages[0]).toMatchObject({
      content: "Handoff from side split\n\n---\n\nLive side answer",
      details: { requestId: "req-1" },
    });
  });

  test("detects a handoff that completes after session start", async () => {
    vi.useFakeTimers();
    const harness = createMergeHarness();
    await fireSessionStartUnderHerdr(harness);
    expect(harness.sentMessages).toHaveLength(0);

    appendCompletedMerge(childBranch, {
      requestId: "req-1",
      answerText: "Live side answer",
    });
    await vi.advanceTimersByTimeAsync(2500);
    expect(harness.sentMessages).toHaveLength(1);
  });

  test("skips a busy parent and imports once idle", async () => {
    vi.useFakeTimers();
    appendCompletedMerge(childBranch, {
      requestId: "req-1",
      answerText: "Live side answer",
    });
    const harness = createMergeHarness({ idle: false });
    await fireSessionStartUnderHerdr(harness);
    await vi.advanceTimersByTimeAsync(5000);
    expect(harness.sentMessages).toHaveLength(0);
    harness.setIdle(true);
    await vi.advanceTimersByTimeAsync(2500);
    expect(harness.sentMessages).toHaveLength(1);
  });

  test("does not poll outside Herdr", async () => {
    vi.useFakeTimers();
    appendCompletedMerge(childBranch, {
      requestId: "req-1",
      answerText: "Manual-only answer",
    });
    const restore = clearHerdrIdentity();
    const harness = createMergeHarness();
    try {
      await harness.fireSessionStart();
      await vi.advanceTimersByTimeAsync(7500);
    } finally {
      restore();
    }
    expect(harness.sentMessages).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("does not re-prompt after a cancelled multi-merge selector", async () => {
    vi.useFakeTimers();
    appendCompletedMerge(childBranch, {
      requestId: "req-1",
      answerText: "New answer",
    });
    appendCompletedMerge(olderChildBranch, {
      prefix: "older-live",
      requestId: "req-older",
      answerText: "Older answer",
    });
    const harness = createMergeHarness({
      olderRecord: true,
      cancelSelection: true,
    });
    await fireSessionStartUnderHerdr(harness);
    await vi.advanceTimersByTimeAsync(5000);
    expect(harness.selectionChoices).toHaveLength(1);
    expect(harness.sentMessages).toHaveLength(0);

    // A new completion makes the pending set actionable again. The chooser
    // must include the unchanged older item rather than auto-importing only
    // the new arrival.
    appendCompletedMerge(childBranch, {
      prefix: "new-live",
      requestId: "req-new",
      answerText: "Newest answer",
    });
    await vi.advanceTimersByTimeAsync(2500);
    expect(harness.selectionChoices).toHaveLength(2);
    expect(harness.sentMessages).toHaveLength(0);
  });

  test("an in-flight old selector cannot schedule a stale timer after session switch", async () => {
    vi.useFakeTimers();
    appendCompletedMerge(childBranch, {
      requestId: "req-1",
      answerText: "New answer",
    });
    appendCompletedMerge(olderChildBranch, {
      prefix: "older-stale",
      requestId: "req-older",
      answerText: "Older answer",
    });
    let resolveSelection!: (value: string | undefined) => void;
    const selectionPromise = new Promise<string | undefined>((resolve) => {
      resolveSelection = resolve;
    });
    const harness = createMergeHarness({
      olderRecord: true,
      selectionPromise,
    });
    const restore = setHerdrIdentity();
    try {
      const oldStart = harness.fireSessionStart();
      expect(harness.selectionChoices).toHaveLength(1);

      const replacementCtx = {
        hasUI: true,
        isIdle: () => true,
        sessionManager: {
          getBranch: () => [],
          getSessionDir: () => "/tmp",
        },
        ui: { notify() {} },
      };
      await harness.fireSessionStart(replacementCtx);
      expect(vi.getTimerCount()).toBe(1);

      resolveSelection(undefined);
      await oldStart;
      expect(vi.getTimerCount()).toBe(1);
    } finally {
      restore();
    }
  });

  test("stops the poll loop on session shutdown", async () => {
    vi.useFakeTimers();
    const harness = createMergeHarness();
    await fireSessionStartUnderHerdr(harness);
    harness.fireSessionShutdown();
    appendCompletedMerge(childBranch, {
      requestId: "req-1",
      answerText: "Late answer",
    });
    await vi.advanceTimersByTimeAsync(7500);
    expect(harness.sentMessages).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("merge request (child)", () => {
  test("writes an exact durable intent before sending and finalizes on agent_settled", async () => {
    const harness = createChildMergeHarness();
    await harness.merge();

    expect(harness.appendedEntries).toHaveLength(1);
    expect(harness.appendedEntries[0]).toMatchObject({
      type: SPLIT_MERGE_INTENT_TYPE,
      data: { handoffPrompt },
    });
    expect(harness.sentUserMessages).toEqual([handoffPrompt]);
    const intentIndex = harness.branch.findIndex(
      (entry) => entry.customType === SPLIT_MERGE_INTENT_TYPE,
    );
    const promptIndex = harness.branch.findIndex(
      (entry) => entry.id === "sent-user-1",
    );
    expect(intentIndex).toBeLessThan(promptIndex);

    const answerId = harness.appendAssistant();
    await harness.fireAgentSettled();
    expect(harness.appendedEntries).toHaveLength(2);
    const intent = harness.appendedEntries[0]!.data as { requestId: string };
    expect(harness.appendedEntries[1]).toMatchObject({
      type: SPLIT_MERGE_REQUEST_TYPE,
      data: {
        requestId: intent.requestId,
        intentEntryId: "custom-1",
        promptEntryId: "sent-user-1",
        answerEntryId: answerId,
      },
    });
  });

  test("cannot record the pre-existing answer before the intent", async () => {
    const harness = createChildMergeHarness();
    await harness.merge();
    await harness.fireAgentSettled();
    expect(harness.appendedEntries.map((entry) => entry.type)).toEqual([
      SPLIT_MERGE_INTENT_TYPE,
    ]);
  });

  test("does not finalize an unfinished handoff", async () => {
    const harness = createChildMergeHarness();
    await harness.merge();
    harness.appendAssistant("partial", "toolUse");
    await harness.fireAgentSettled();
    expect(harness.appendedEntries).toHaveLength(1);
  });

  test("recovers and finalizes a completed intent on child session_start", async () => {
    const harness = createChildMergeHarness();
    await harness.merge();
    harness.appendAssistant("Recovered handoff");
    await harness.fireSessionStart();
    expect(harness.appendedEntries.at(-1)?.type).toBe(SPLIT_MERGE_REQUEST_TYPE);
  });

  test("stores follow-up guidance in the exact intent prompt", async () => {
    const harness = createChildMergeHarness();
    await harness.merge("focus on the test results");
    const expected = `${handoffPrompt}\n\nAdditional guidance from the user: focus on the test results`;
    expect(harness.sentUserMessages).toEqual([expected]);
    expect(harness.appendedEntries[0]?.data).toMatchObject({
      handoffPrompt: expected,
    });
  });

  test("refocuses with herdr agent focus and then closes the child", async () => {
    const restore = setHerdrIdentity("child-pane");
    const harness = createChildMergeHarness({ parentPaneId: "parent-pane" });
    try {
      await harness.merge();
      harness.appendAssistant();
      await harness.fireAgentSettled();
    } finally {
      restore();
    }
    expect(harness.execCalls.map((call) => call.args)).toEqual([
      ["agent", "focus", "parent-pane"],
      ["pane", "close", "child-pane"],
    ]);
    expect(harness.notifications).toContainEqual({
      message: "Merge handoff recorded. The live main session will import it.",
      level: "info",
    });
  });

  test("does not close the child when parent refocus returns nonzero", async () => {
    const restore = setHerdrIdentity("child-pane");
    const harness = createChildMergeHarness({
      parentPaneId: "parent-pane",
      execResult: (args) =>
        args[1] === "focus"
          ? { code: 1, stdout: "", stderr: "focus failed" }
          : { code: 0, stdout: "", stderr: "" },
    });
    try {
      await harness.merge();
      harness.appendAssistant();
      await harness.fireAgentSettled();
    } finally {
      restore();
    }
    expect(harness.execCalls).toHaveLength(1);
    expect(harness.notifications.at(-1)?.message).toContain(
      "focus failed. The child pane was left open.",
    );
  });

  test("checks and reports a child close failure", async () => {
    const restore = setHerdrIdentity("child-pane");
    const harness = createChildMergeHarness({
      parentPaneId: "parent-pane",
      execResult: (args) =>
        args[1] === "close"
          ? { code: 1, stdout: "", stderr: "close failed" }
          : { code: 0, stdout: "", stderr: "" },
    });
    try {
      await harness.merge();
      harness.appendAssistant();
      await harness.fireAgentSettled();
    } finally {
      restore();
    }
    expect(harness.execCalls).toHaveLength(2);
    expect(harness.notifications.at(-1)?.message).toContain("close failed");
  });

  test("uses the newest child marker for parent refocus", async () => {
    const restore = setHerdrIdentity("child-pane");
    const harness = createChildMergeHarness({
      parentPaneId: "old-parent",
      extraBranch: [
        childMarkerEntry("new-child-marker", "child-marker", {
          baseLeafId: "new-base",
          prompt: "New side goal",
          parentPaneId: "new-parent",
        }),
      ],
    });
    try {
      await harness.merge();
      harness.appendAssistant();
      await harness.fireAgentSettled();
    } finally {
      restore();
    }
    expect(harness.execCalls[0]?.args).toEqual([
      "agent",
      "focus",
      "new-parent",
    ]);
  });

  test("does not refocus or close without Herdr", async () => {
    const restore = clearHerdrIdentity();
    const harness = createChildMergeHarness({ parentPaneId: "parent-pane" });
    try {
      await harness.merge();
      harness.appendAssistant();
      await harness.fireAgentSettled();
    } finally {
      restore();
    }
    expect(harness.execCalls).toHaveLength(0);
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
    expect(harness.appendedEntries).toHaveLength(0);
    expect(harness.notifications).toContainEqual({
      message: "Wait for the first response to finish before splitting.",
      level: "warning",
    });
  });

  test("warns instead of splitting an empty persisted conversation", async () => {
    const restore = clearHerdrIdentity();
    const calls: Array<{ command: string; args: string[] }> = [];
    const harness = createSplitHarness(async (command, args) => {
      calls.push({ command, args });
      return { code: 1, stdout: "", stderr: "application not found" };
    });

    try {
      await harness.btw("");
    } finally {
      restore();
    }

    expect(branchedSessionCount).toBe(0);
    expect(childMarkers).toHaveLength(0);
    expect(harness.appendedEntries).toHaveLength(0);
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
        customType: SPLIT_MERGE_RESULT_TYPE,
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
    expect(harness.appendedEntries).toHaveLength(0);
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
    expect(harness.appendedEntries).toHaveLength(1);
    expect(childMarkers).toEqual([
      {
        customType: SPLIT_CHILD_TYPE,
        data: { baseLeafId: "base", prompt: "Selected prompt" },
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
    expect(harness.appendedEntries).toHaveLength(0);
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
    expect(harness.appendedEntries).toHaveLength(1);
    expect(harness.appendedEntries[0]).toMatchObject({
      type: SPLIT_RECORD_TYPE,
      data: {
        sessionFile: splitSessionFile,
        label: "[unconfirmed] Selected prompt",
      },
    });
  });

  test("keeps an ambiguous child and reports when its tracking record also fails", async () => {
    const restoreHerdrIdentity = setHerdrIdentity();
    const harness = createSplitHarness(
      async () => ({ code: 0, stdout: "", stderr: "", killed: true }),
      { appendError: new Error("record write failed") },
    );

    try {
      await harness.btw("");
    } finally {
      restoreHerdrIdentity();
    }

    expect(existsSync(splitSessionFile)).toBe(true);
    expect(harness.appendAttempts).toHaveLength(1);
    expect(harness.notifications[0]!.message).toContain(splitSessionFile);
    expect(harness.notifications[0]!.message).toContain(
      "tracking failed: record write failed",
    );
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
    expect(harness.appendedEntries).toHaveLength(1);
    expect(harness.appendedEntries[0]!.data).toMatchObject({
      baseLeafId: "copied-boundary",
      herdrTarget: agentName,
    });
    expect(childMarkers).toEqual([
      {
        customType: SPLIT_CHILD_TYPE,
        data: {
          baseLeafId: "copied-boundary",
          prompt: "Selected prompt",
          parentPaneId: "pane-1",
        },
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
    expect(harness.appendedEntries).toHaveLength(1);
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
    expect(harness.appendedEntries).toHaveLength(0);
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
    expect(harness.appendedEntries).toHaveLength(1);
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
    expect(harness.appendedEntries).toHaveLength(0);
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
    expect(harness.appendedEntries).toHaveLength(1);
    expect(harness.appendedEntries[0]).toMatchObject({
      type: SPLIT_RECORD_TYPE,
      data: { label: "[unconfirmed] Selected prompt" },
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
    expect(harness.appendedEntries).toHaveLength(1);
    expect(harness.appendedEntries[0]).toMatchObject({
      type: SPLIT_RECORD_TYPE,
      data: { label: "[unconfirmed] Selected prompt" },
    });
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
    expect(harness.appendedEntries[0]).toMatchObject({
      type: SPLIT_RECORD_TYPE,
      data: { label: "[unconfirmed] Selected prompt" },
    });
    expect(harness.notifications[0]!.message).toContain(
      "Herdr agent prompt failed",
    );
  });

  test("reports an opened split separately when its tracking record cannot be saved", async () => {
    const restoreHerdrIdentity = setHerdrIdentity();
    const harness = createSplitHarness(successfulHerdrExec, {
      appendError: new Error("record write failed"),
    });

    try {
      await harness.btw("");
    } finally {
      restoreHerdrIdentity();
    }

    expect(existsSync(splitSessionFile)).toBe(true);
    expect(harness.appendedEntries).toHaveLength(0);
    expect(
      harness.notifications.some(
        (notification) =>
          notification.level === "error" &&
          notification.message.startsWith("Opened split (pi-btw-") &&
          notification.message.endsWith(
            ", but could not save its tracking record: record write failed",
          ),
      ),
    ).toBe(true);
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
        data: {
          baseLeafId: "base",
          prompt: "Side task",
          parentPaneId: "pane-1",
        },
      },
    ]);
    // Herdr launch uses the constant command, not the prompt.
    expect(calls[2]!.args[3]).toBe("/btw --launch");
    expect(harness.appendedEntries).toHaveLength(1);
    expect(harness.appendedEntries[0]).toMatchObject({
      type: SPLIT_RECORD_TYPE,
      data: { baseLeafId: "base", label: "Side task" },
    });
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
    expect(harness.appendedEntries).toHaveLength(1);
  });
});
