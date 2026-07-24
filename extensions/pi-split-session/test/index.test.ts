import { existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";

let childBranch: any[] = [];
let olderChildBranch: any[] = [];
let forkedLeafId = "base";
let branchedSessionCount = 0;
let branchedLeafIds: string[] = [];
let childMarkers: Array<{ customType: string; data: unknown }> = [];
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
        return { getBranch: () => childBranch };
      if (sessionFile === olderSplitSessionFile)
        return { getBranch: () => olderChildBranch };
      return {
        createBranchedSession: (leafId: string) => {
          branchedSessionCount++;
          branchedLeafIds.push(leafId);
          return splitSessionFile;
        },
        getLeafId: () => forkedLeafId,
        appendCustomEntry: (customType: string, data: unknown) =>
          childMarkers.push({ customType, data }),
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
}));

const { default: registerSplitSession } = await import("../src/index.ts");

function createHarness(
  options: {
    baseLeafId?: string | null;
    importedAnswerEntryId?: string;
    importedFormat?: "transcript" | "summary";
    olderUnimportedSplit?: boolean;
    selectedSplitIndex?: number;
    hasUI?: boolean;
    recordLabel?: string;
  } = {},
) {
  let fullImportHandler:
    | ((args: string, ctx: any) => Promise<void>)
    | undefined;
  let summaryImportHandler:
    | ((args: string, ctx: any) => Promise<void>)
    | undefined;
  let handoffHandler: ((args: string, ctx: any) => Promise<void>) | undefined;
  const commandNames: string[] = [];
  const events: string[] = [];
  const sentMessages: any[] = [];
  const sentUserMessages: string[] = [];
  const appendedEntries: Array<{ type: string; data: unknown }> = [];
  const notifications: Array<{ message: string; level: string }> = [];
  const selectionChoices: string[][] = [];

  const splitRecord = {
    type: "custom",
    id: "record",
    parentId: null,
    customType: "split-fork-record",
    data: {
      sessionFile: splitSessionFile,
      baseLeafId:
        options.baseLeafId === undefined ? "base" : options.baseLeafId,
      label: options.recordLabel ?? "Review the latest change",
    },
  };
  const parentBranch: any[] = [];
  if (options.olderUnimportedSplit) {
    parentBranch.push({
      type: "custom",
      id: "older-record",
      parentId: null,
      customType: "split-fork-record",
      data: {
        sessionFile: olderSplitSessionFile,
        baseLeafId: "older-base",
        label: "Investigate the older issue",
      },
    });
  }
  parentBranch.push(splitRecord);
  if (options.importedAnswerEntryId !== undefined) {
    parentBranch.push({
      type: "custom_message",
      id: "import",
      parentId: "record",
      customType: "split-fork-result",
      content: "Imported split result",
      display: true,
      details: {
        sessionFile: splitSessionFile,
        answerEntryId: options.importedAnswerEntryId,
        format: options.importedFormat,
      },
    });
  }
  const pi = {
    registerCommand(name: string, definition: any) {
      commandNames.push(name);
      if (name === "split-import-full") fullImportHandler = definition.handler;
      if (name === "split-import") summaryImportHandler = definition.handler;
      if (name === "split-handoff") handoffHandler = definition.handler;
    },
    sendMessage(message: unknown) {
      events.push("send-message");
      sentMessages.push(message);
    },
    sendUserMessage(message: string) {
      events.push("send-user-message");
      sentUserMessages.push(message);
    },
    appendEntry(type: string, data: unknown) {
      events.push("append-entry");
      appendedEntries.push({ type, data });
    },
    exec: async () => {
      throw new Error("split import must not wait on Herdr");
    },
  };

  const ctx = {
    hasUI: options.hasUI ?? true,
    sessionManager: {
      getBranch: () => parentBranch,
      getSessionDir: () => "/tmp",
    },
    waitForIdle: async () => {
      events.push("wait-for-idle");
    },
    ui: {
      select(_title: string, choices: string[]) {
        selectionChoices.push(choices);
        return Promise.resolve(choices[options.selectedSplitIndex ?? 0]);
      },
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
    },
  };

  registerSplitSession(pi as any);
  if (!fullImportHandler || !summaryImportHandler || !handoffHandler)
    throw new Error("split commands were not registered");

  return {
    importFull: (args = "") => fullImportHandler!(args, ctx),
    importSummary: (args = "") => summaryImportHandler!(args, ctx),
    handoff: (branch: any[]) =>
      handoffHandler!("", {
        ...ctx,
        sessionManager: { getBranch: () => branch },
      }),
    commandNames,
    events,
    sentMessages,
    sentUserMessages,
    appendedEntries,
    notifications,
    selectionChoices,
  };
}

function createSplitHarness(
  exec: (
    command: string,
    args: string[],
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
  let splitHandler: ((args: string, ctx: any) => Promise<void>) | undefined;
  const appendedEntries: Array<{ type: string; data: unknown }> = [];
  const appendAttempts: Array<{ type: string; data: unknown }> = [];
  const notifications: Array<{ message: string; level: string }> = [];
  const sourceBranch = options.sourceBranch ?? [
    {
      type: "message",
      id: "base",
      parentId: null,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Base answer" }],
        stopReason: "stop",
      },
    },
    {
      type: "message",
      id: "selected",
      parentId: "base",
      message: {
        role: "user",
        content: [{ type: "text", text: "Selected prompt" }],
      },
    },
  ];

  const pi = {
    registerCommand(name: string, definition: any) {
      if (name === "split") splitHandler = definition.handler;
    },
    exec,
    appendEntry(type: string, data: unknown) {
      appendAttempts.push({ type, data });
      if (options.appendError) throw options.appendError;
      appendedEntries.push({ type, data });
    },
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
  if (!splitHandler) throw new Error("split command was not registered");

  return {
    split: (args = "") => splitHandler!(args, ctx),
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

function setHerdrIdentity(): () => void {
  const previous = {
    herdr: process.env.HERDR_ENV,
    pane: process.env.HERDR_PANE_ID,
  };
  process.env.HERDR_ENV = "1";
  process.env.HERDR_PANE_ID = "pane-1";
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

function successfulHerdrExec(_command: string, args: string[]) {
  if (args[0] === "pane" && args[1] === "split") {
    return Promise.resolve(herdrPaneSplitResponse("split-pane-1"));
  }
  if (args[0] === "agent" && args[1] === "start") {
    return Promise.resolve(herdrAgentStartResponse());
  }
  throw new Error(`Unexpected Herdr command: ${args.join(" ")}`);
}

beforeEach(() => {
  forkedLeafId = "base";
  branchedSessionCount = 0;
  branchedLeafIds = [];
  childMarkers = [];
  writeFileSync(splitSessionFile, "");
  writeFileSync(olderSplitSessionFile, "");
  writeFileSync(sourceSessionFile, "");
  childBranch = [
    {
      type: "message",
      id: "base",
      parentId: null,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Inherited context" }],
        stopReason: "stop",
      },
    },
    {
      type: "message",
      id: "prompt",
      parentId: "base",
      message: {
        role: "user",
        content: [{ type: "text", text: "Give me a Bruce Lee quote" }],
      },
    },
    {
      type: "message",
      id: "first-answer",
      parentId: "prompt",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Be water, my friend." }],
        stopReason: "stop",
      },
    },
    {
      type: "message",
      id: "follow-up",
      parentId: "first-answer",
      message: {
        role: "user",
        content: [{ type: "text", text: "Give me a Hemingway quote" }],
      },
    },
    {
      type: "message",
      id: "answer",
      parentId: "follow-up",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Exact side answer" }],
        stopReason: "stop",
      },
    },
  ];
  olderChildBranch = [
    {
      type: "message",
      id: "older-base",
      parentId: null,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Older inherited context" }],
        stopReason: "stop",
      },
    },
    {
      type: "message",
      id: "older-prompt",
      parentId: "older-base",
      message: {
        role: "user",
        content: [{ type: "text", text: "Investigate the older issue" }],
      },
    },
    {
      type: "message",
      id: "older-answer",
      parentId: "older-prompt",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Older split result" }],
        stopReason: "stop",
      },
    },
  ];
});

const handoffPrompt = `Prepare the final handoff from this side split for the main coding-agent session.

Preserve:
- each distinct answer or outcome
- important files, commands, and evidence
- decisions and recommendations
- blockers, uncertainty, and follow-up work

Return only the clean, concise handoff. Do not collapse separate results into one, solve the task again, or mention these instructions.`;

function appendCompletedHandoff(): void {
  childBranch.push(
    {
      type: "message",
      id: "handoff-prompt",
      parentId: "answer",
      message: {
        role: "user",
        content: [{ type: "text", text: handoffPrompt }],
      },
    },
    {
      type: "message",
      id: "handoff-answer",
      parentId: "handoff-prompt",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Concise split handoff" }],
        stopReason: "stop",
      },
    },
  );
}

describe("split import", () => {
  test("imports the full side transcript without waiting on Herdr or starting an agent turn", async () => {
    const harness = createHarness();

    await harness.importFull();

    expect(harness.sentMessages).toEqual([
      {
        customType: "split-fork-result",
        content:
          "Transcript from side split\n\n---\n\n## User\nGive me a Bruce Lee quote\n\n## Assistant\nBe water, my friend.\n\n## User\nGive me a Hemingway quote\n\n## Assistant\nExact side answer",
        display: true,
        details: {
          sessionFile: splitSessionFile,
          answerEntryId: "answer",
          format: "transcript",
        },
      },
    ]);
    expect(harness.events).toEqual(["wait-for-idle", "send-message"]);
    expect(harness.appendedEntries).toHaveLength(0);
    expect(harness.sentUserMessages).toHaveLength(0);
    expect(harness.commandNames).toEqual([
      "split",
      "split-handoff",
      "split-import",
      "split-import-full",
    ]);
    expect(harness.notifications).toEqual([
      {
        message:
          "Split import queued. The side split stays open; close it manually when you're done.",
        level: "info",
      },
    ]);
  });

  test("imports the transcript before submitting split-import-full arguments", async () => {
    const harness = createHarness();

    await harness.importFull("What was the Bruce Lee quote?");

    expect(harness.sentMessages).toHaveLength(1);
    expect(harness.sentMessages[0].content).toContain("Be water, my friend.");
    expect(harness.sentUserMessages).toEqual(["What was the Bruce Lee quote?"]);
    expect(harness.events).toEqual([
      "wait-for-idle",
      "send-message",
      "send-user-message",
    ]);
  });

  test("imports only the side agent's completed handoff before submitting arguments", async () => {
    appendCompletedHandoff();
    const harness = createHarness();

    await harness.importSummary("What was the Bruce Lee quote?");

    expect(harness.sentMessages).toEqual([
      {
        customType: "split-fork-result",
        content: "Summary from side split\n\n---\n\nConcise split handoff",
        display: true,
        details: {
          sessionFile: splitSessionFile,
          answerEntryId: "handoff-answer",
          format: "summary",
        },
      },
    ]);
    expect(harness.sentUserMessages).toEqual(["What was the Bruce Lee quote?"]);
    expect(harness.events).toEqual([
      "wait-for-idle",
      "send-message",
      "send-user-message",
    ]);
  });

  test("requires the side agent to prepare a handoff before summary import", async () => {
    const harness = createHarness();

    await harness.importSummary();

    expect(harness.sentMessages).toHaveLength(0);
    expect(harness.notifications).toContainEqual({
      message:
        "No completed side-agent handoff found. Run /split-handoff in the side split first.",
      level: "warning",
    });
  });

  test("treats an unconfirmed child without a handoff as a clean no-op", async () => {
    const harness = createHarness({
      recordLabel: "[unconfirmed] Selected prompt",
    });

    await harness.importSummary();

    expect(harness.sentMessages).toHaveLength(0);
    expect(harness.notifications).toContainEqual({
      message:
        "No completed side-agent handoff found. Run /split-handoff in the side split first.",
      level: "warning",
    });
  });

  test("imports a summary after the same handoff was imported as a full transcript", async () => {
    appendCompletedHandoff();
    const harness = createHarness({
      importedAnswerEntryId: "handoff-answer",
      importedFormat: "transcript",
    });

    await harness.importSummary();

    expect(harness.sentMessages).toHaveLength(1);
    expect(harness.sentMessages[0]).toMatchObject({
      content: "Summary from side split\n\n---\n\nConcise split handoff",
      details: { answerEntryId: "handoff-answer", format: "summary" },
    });
  });

  test("imports a full transcript after the same handoff was imported as a summary", async () => {
    appendCompletedHandoff();
    const harness = createHarness({
      importedAnswerEntryId: "handoff-answer",
      importedFormat: "summary",
    });

    await harness.importFull();

    expect(harness.sentMessages).toHaveLength(1);
    expect(harness.sentMessages[0]).toMatchObject({
      details: { answerEntryId: "handoff-answer", format: "transcript" },
    });
    expect(harness.sentMessages[0].content).toContain("Concise split handoff");
  });

  test("does not import the same summary twice", async () => {
    appendCompletedHandoff();
    const harness = createHarness({
      importedAnswerEntryId: "handoff-answer",
      importedFormat: "summary",
    });

    await harness.importSummary();

    expect(harness.sentMessages).toHaveLength(0);
    expect(harness.notifications).toContainEqual({
      message: "No new split result to import.",
      level: "warning",
    });
  });

  test("submits arguments without duplicating an already imported transcript", async () => {
    const harness = createHarness({
      importedAnswerEntryId: "answer",
      importedFormat: "transcript",
    });

    await harness.importFull("Compare the two quotes.");

    expect(harness.sentMessages).toHaveLength(0);
    expect(harness.sentUserMessages).toEqual(["Compare the two quotes."]);
    expect(harness.events).toEqual(["wait-for-idle", "send-user-message"]);
    expect(harness.notifications).toContainEqual({
      message:
        "Split result was already imported; sent the follow-up to the main agent.",
      level: "info",
    });
  });

  test("does not import an unfinished assistant turn", async () => {
    childBranch[childBranch.length - 1].message.stopReason = "toolUse";
    const harness = createHarness();

    await harness.importFull();

    expect(harness.sentMessages).toHaveLength(0);
    expect(harness.appendedEntries).toHaveLength(0);
    expect(harness.notifications).toContainEqual({
      message: "Split session has no completed final answer to import yet.",
      level: "warning",
    });
  });

  test("refuses to import when the copied conversation boundary is missing", async () => {
    const harness = createHarness({ baseLeafId: "missing-boundary" });

    await harness.importFull();

    expect(harness.sentMessages).toHaveLength(0);
    expect(harness.appendedEntries).toHaveLength(0);
    expect(harness.notifications).toContainEqual({
      message: "Split session boundary is missing; refusing to import.",
      level: "error",
    });
  });

  test("does not import the same answer twice", async () => {
    const harness = createHarness({
      importedAnswerEntryId: "answer",
      importedFormat: "transcript",
    });

    await harness.importFull();

    expect(harness.sentMessages).toHaveLength(0);
    expect(harness.appendedEntries).toHaveLength(0);
    expect(harness.notifications).toContainEqual({
      message: "No new split result to import.",
      level: "warning",
    });
  });

  test("imports a newer answer from the latest split before an older unimported split", async () => {
    const harness = createHarness({
      importedAnswerEntryId: "older-answer",
      olderUnimportedSplit: true,
    });

    await harness.importFull();

    expect(harness.sentMessages).toHaveLength(1);
    expect(harness.sentMessages[0]).toMatchObject({
      customType: "split-fork-result",
      details: {
        sessionFile: splitSessionFile,
        answerEntryId: "answer",
        format: "transcript",
      },
    });
    expect(harness.appendedEntries).toHaveLength(0);
    expect(harness.selectionChoices).toEqual([
      ["1. Review the latest change", "2. Investigate the older issue"],
    ]);
  });

  test("can select and import an older split", async () => {
    const harness = createHarness({
      olderUnimportedSplit: true,
      selectedSplitIndex: 1,
    });

    await harness.importFull();

    expect(harness.sentMessages).toHaveLength(1);
    expect(harness.sentMessages[0]).toMatchObject({
      customType: "split-fork-result",
      details: {
        sessionFile: olderSplitSessionFile,
        answerEntryId: "older-answer",
        format: "transcript",
      },
    });
    expect(harness.sentMessages[0].content).toContain("Older split result");
    expect(harness.selectionChoices).toEqual([
      ["1. Review the latest change", "2. Investigate the older issue"],
    ]);
  });

  test("does not guess between multiple splits outside the interactive UI", async () => {
    const harness = createHarness({ olderUnimportedSplit: true, hasUI: false });

    await harness.importFull();

    expect(harness.sentMessages).toHaveLength(0);
    expect(harness.selectionChoices).toHaveLength(0);
    expect(harness.notifications).toContainEqual({
      message:
        "Multiple split sessions are available; choose one in the interactive UI.",
      level: "warning",
    });
  });
});

describe("split handoff", () => {
  test("asks the live side agent to prepare the summary", async () => {
    const harness = createHarness();
    const sideBranch = [
      {
        type: "custom",
        id: "child-marker",
        parentId: "base",
        customType: "split-fork-child",
        data: { baseLeafId: "base" },
      },
    ];

    await harness.handoff(sideBranch);

    expect(harness.sentUserMessages).toEqual([handoffPrompt]);
    expect(harness.events).toEqual(["wait-for-idle", "send-user-message"]);
    expect(harness.notifications).toContainEqual({
      message: "Asked this side agent to prepare its final handoff.",
      level: "info",
    });
  });

  test("refuses to prepare a handoff in the main session", async () => {
    const harness = createHarness();

    await harness.handoff([]);

    expect(harness.sentUserMessages).toHaveLength(0);
    expect(harness.notifications).toContainEqual({
      message:
        "/split-handoff can only run inside a side split created by /split.",
      level: "warning",
    });
  });
});

describe("split launch", () => {
  test("warns instead of splitting during the first response", async () => {
    const harness = createSplitHarness(
      async () => {
        throw new Error("an unsaved conversation must not launch a split");
      },
      { idle: false, sourceSessionFile: `${sourceSessionFile}.missing` },
    );

    await harness.split();

    expect(harness.appendedEntries).toHaveLength(0);
    expect(harness.notifications).toContainEqual({
      message: "Wait for the first response to finish before splitting.",
      level: "warning",
    });
  });

  test("warns instead of splitting an empty conversation", async () => {
    const harness = createSplitHarness(
      async () => {
        throw new Error("an empty conversation must not launch a split");
      },
      { idle: true, sourceSessionFile: `${sourceSessionFile}.missing` },
    );

    await harness.split();

    expect(harness.appendedEntries).toHaveLength(0);
    expect(harness.notifications).toContainEqual({
      message: "Send a message before splitting.",
      level: "warning",
    });
  });

  test("preserves trailing custom context while excluding an unresolved prompted turn", async () => {
    const restoreHerdrIdentity = setHerdrIdentity();
    const sourceBranch = [
      {
        type: "message",
        id: "settled",
        parentId: null,
        message: { role: "assistant", content: [], stopReason: "stop" },
      },
      {
        type: "custom_message",
        id: "import-result",
        parentId: "settled",
        customType: "split-fork-result",
        content: "Imported context",
      },
      {
        type: "message",
        id: "in-flight",
        parentId: "import-result",
        message: { role: "user", content: "Main task" },
      },
    ];
    const harness = createSplitHarness(
      successfulHerdrExec,
      {
        idle: false,
        sourceBranch,
        leafId: "in-flight",
      },
    );

    try {
      await harness.split("Side task");
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
      {
        type: "message",
        id: "first-answer",
        parentId: null,
        message: { role: "assistant", content: [], stopReason: "stop" },
      },
      {
        type: "message",
        id: "user",
        parentId: "first-answer",
        message: { role: "user", content: "Main task" },
      },
      {
        type: "message",
        id: "latest-answer",
        parentId: "user",
        message: { role: "assistant", content: [], stopReason: "stop" },
      },
    ];
    const harness = createSplitHarness(
      successfulHerdrExec,
      {
        idle: false,
        sourceBranch,
        leafId: "latest-answer",
      },
    );

    try {
      await harness.split("Side task");
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
      {
        type: "message",
        id: "settled",
        parentId: null,
        message: { role: "assistant", content: [], stopReason: "stop" },
      },
      {
        type: "message",
        id: "user",
        parentId: "settled",
        message: { role: "user", content: "Main task" },
      },
      {
        type: "message",
        id: "partial",
        parentId: "user",
        message: { role: "assistant", content: [], stopReason: "toolUse" },
      },
      {
        type: "message",
        id: "tool",
        parentId: "partial",
        message: { role: "toolResult", content: "result" },
      },
      {
        type: "message",
        id: "steer",
        parentId: "tool",
        message: { role: "user", content: "Steer" },
      },
    ];
    const harness = createSplitHarness(
      successfulHerdrExec,
      {
        idle: false,
        sourceBranch,
        leafId: "steer",
      },
    );

    try {
      await harness.split("Side task");
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
      await harness.split();
    } finally {
      restoreHerdrIdentity();
    }

    expect(branchedSessionCount).toBe(0);
    expect(childMarkers).toHaveLength(0);
    expect(harness.appendedEntries).toHaveLength(0);
    expect(
      harness.notifications.some((notification) =>
        notification.message.startsWith("Cannot split:"),
      ),
    ).toBe(true);
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
      await harness.split();
    } finally {
      restoreHerdrIdentity();
    }

    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({ command: "open", args: ["-Ra", "Ghostty"] });
    expect(calls[1]!.command).toBe("osascript");
    expect(calls[1]!.args.at(-1)?.endsWith("'Selected prompt'\n")).toBe(true);
    expect(harness.appendedEntries).toHaveLength(1);
    expect(childMarkers).toEqual([
      { customType: "split-fork-child", data: { baseLeafId: "base" } },
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
      await harness.split();
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
      await harness.split();
    } finally {
      restoreHerdrIdentity();
    }

    expect(existsSync(splitSessionFile)).toBe(true);
    expect(harness.appendedEntries).toHaveLength(1);
    expect(harness.appendedEntries[0]).toMatchObject({
      type: "split-fork-record",
      data: {
        sessionFile: splitSessionFile,
        label: "[unconfirmed] Selected prompt",
      },
    });
    expect(harness.notifications[0]!.message).toContain(splitSessionFile);
    expect(harness.notifications[0]!.message).toContain(
      "unconfirmed split record was added",
    );
  });

  test("keeps an ambiguous child and reports when its tracking record also fails", async () => {
    const restoreHerdrIdentity = setHerdrIdentity();
    const harness = createSplitHarness(
      async () => ({ code: 0, stdout: "", stderr: "", killed: true }),
      { appendError: new Error("record write failed") },
    );

    try {
      await harness.split();
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

  test("splits a Herdr pane and starts Pi with the selected prompt", async () => {
    const restoreHerdrIdentity = setHerdrIdentity();
    forkedLeafId = "copied-boundary";
    const calls: Array<{ command: string; args: string[] }> = [];
    const harness = createSplitHarness(async (command, args) => {
      calls.push({ command, args });
      return successfulHerdrExec(command, args);
    });

    try {
      await harness.split();
    } finally {
      restoreHerdrIdentity();
    }

    expect(calls).toHaveLength(2);
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
    expect(calls[1]!.args.slice(0, 10)).toEqual([
      "agent",
      "start",
      expect.stringMatching(/^pi-split-/),
      "--kind",
      "pi",
      "--pane",
      "split-pane-1",
      "--timeout",
      "10000",
      "--",
    ]);
    expect(calls[1]!.args.at(-1)).toBe("Selected prompt");
    expect(calls[1]!.args).not.toContain("--workspace");
    expect(calls[1]!.args).not.toContain("--tab");
    expect(harness.appendedEntries).toHaveLength(1);
    expect(harness.appendedEntries[0]!.data).toMatchObject({
      baseLeafId: "copied-boundary",
    });
    expect(childMarkers).toEqual([
      {
        customType: "split-fork-child",
        data: { baseLeafId: "copied-boundary" },
      },
    ]);
    expect(harness.notifications).toContainEqual({
      message: expect.stringMatching(
        /^Opened split in a herdr right split \(pi-split-.+\) and sent prompt\.$/,
      ),
      level: "info",
    });
  });

  test("keeps the copied session when Herdr agent start fails after pane split", async () => {
    const restoreHerdrIdentity = setHerdrIdentity();
    const calls: Array<{ command: string; args: string[] }> = [];
    const harness = createSplitHarness(async (command, args) => {
      calls.push({ command, args });
      if (args[0] === "pane" && args[1] === "split") {
        return herdrPaneSplitResponse("split-pane-1");
      }
      return { code: 1, stdout: "", stderr: "Herdr agent start failed" };
    });

    try {
      await harness.split();
    } finally {
      restoreHerdrIdentity();
    }

    expect(calls).toHaveLength(2);
    expect(existsSync(splitSessionFile)).toBe(true);
    expect(harness.appendedEntries).toHaveLength(1);
    expect(harness.appendedEntries[0]).toMatchObject({
      type: "split-fork-record",
      data: {
        sessionFile: splitSessionFile,
        label: "[unconfirmed] Selected prompt",
      },
    });
    expect(
      harness.notifications.some(
        (notification) =>
          notification.level === "error" &&
          notification.message.startsWith(
            "Failed to launch split: Herdr agent start failed; copied session kept at",
          ) &&
          notification.message.endsWith("an unconfirmed split record was added"),
      ),
    ).toBe(true);
  });

  test("reports an opened split separately when its tracking record cannot be saved", async () => {
    const restoreHerdrIdentity = setHerdrIdentity();
    const harness = createSplitHarness(
      successfulHerdrExec,
      { appendError: new Error("record write failed") },
    );

    try {
      await harness.split();
    } finally {
      restoreHerdrIdentity();
    }

    expect(existsSync(splitSessionFile)).toBe(true);
    expect(harness.appendedEntries).toHaveLength(0);
    expect(
      harness.notifications.some(
        (notification) =>
          notification.level === "error" &&
          notification.message.startsWith("Opened split (pi-split-") &&
          notification.message.endsWith(
            ", but could not save its tracking record: record write failed",
          ),
      ),
    ).toBe(true);
  });
});
