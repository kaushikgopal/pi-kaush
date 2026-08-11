import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SessionManager,
  buildSessionContext,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { afterAll, expect, test } from "vitest";
import registerSplitSession from "../src/index.ts";

type SessionManagerInstance = ReturnType<typeof SessionManager.create>;
type CustomEntry = Extract<SessionEntry, { type: "custom" }>;
type CustomMessageEntry = Extract<SessionEntry, { type: "custom_message" }>;

const rootDir = join(tmpdir(), `pi-split-fork-integration-${process.pid}`);
const cwd = join(rootDir, "project");
const sessionDir = join(rootDir, "sessions");
mkdirSync(cwd, { recursive: true });
mkdirSync(sessionDir, { recursive: true });

afterAll(() => rmSync(rootDir, { recursive: true, force: true }));

function userMessage(text: string) {
  return {
    role: "user" as const,
    content: [{ type: "text" as const, text }],
    timestamp: Date.now(),
  };
}

function assistantMessage(text: string) {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    api: "openai-responses" as const,
    provider: "test",
    model: "test-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop" as const,
    timestamp: Date.now(),
  };
}

function herdrExec(_command: string, args: string[]) {
  if (args[0] === "pane" && args[1] === "split") {
    return Promise.resolve({
      code: 0,
      stdout: JSON.stringify({
        result: { pane: { pane_id: "integration-child-pane" } },
      }),
      stderr: "",
    });
  }
  if (args[0] === "agent" && args[1] === "start") {
    return Promise.resolve({
      code: 0,
      stdout: JSON.stringify({
        result: { agent: { pane_id: "integration-child-pane" } },
      }),
      stderr: "",
    });
  }
  if (args[0] === "agent" && args[1] === "prompt") {
    return Promise.resolve({
      code: 0,
      stdout: JSON.stringify({ result: { type: "agent_prompted" } }),
      stderr: "",
    });
  }
  if (
    (args[0] === "agent" && args[1] === "focus") ||
    (args[0] === "pane" && args[1] === "close")
  ) {
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  }
  return Promise.resolve({ code: 0, stdout: "", stderr: "" });
}

function buildPi(sessionManager: SessionManagerInstance) {
  return {
    events: { on: () => () => undefined, emit: () => undefined },
    registerCommand(
      _name: string,
      definition: { handler: (args: string, ctx: any) => Promise<void> },
    ) {
      (sessionManager as any).__btwHandler = definition.handler;
    },
    appendEntry(customType: string, data: unknown) {
      sessionManager.appendCustomEntry(customType, data);
    },
    sendMessage(message: {
      customType: string;
      content: string;
      display: boolean;
      details?: unknown;
    }) {
      sessionManager.appendCustomMessageEntry(
        message.customType,
        message.content,
        message.display,
        message.details,
      );
    },
    sendUserMessage(content: string) {
      sessionManager.appendMessage(userMessage(content));
    },
    exec: herdrExec,
    on: () => {},
  } as any;
}

function contextFor(
  sessionManager: SessionManagerInstance,
  options?: {
    hasUI?: boolean;
  },
) {
  return {
    cwd,
    hasUI: options?.hasUI ?? true,
    mode: "tui" as const,
    isIdle: () => true,
    waitForIdle: async () => {},
    sessionManager,
    ui: {
      select: async (_title: string, _choices: string[]) => undefined,
      notify: () => {},
    },
  } as any;
}

test("first-turn snapshot preserves exact in-memory messages and model state into a persisted child", async () => {
  const previousHerdr = {
    env: process.env.HERDR_ENV,
    pane: process.env.HERDR_PANE_ID,
  };
  process.env.HERDR_ENV = "1";
  process.env.HERDR_PANE_ID = "integration-parent-pane";

  try {
    // In-memory parent: no session file yet (first turn).
    const parent = SessionManager.inMemory(cwd);
    parent.appendMessage(userMessage("Set up the main task"));
    parent.appendMessage(assistantMessage("Main task is ready"));
    parent.appendModelChange("anthropic", "claude-test");
    parent.appendThinkingLevelChange("high");
    expect(parent.getSessionFile()).toBeUndefined();

    const pi = buildPi(parent);
    registerSplitSession(pi);
    const btw = (parent as any).__btwHandler as (
      args: string,
      ctx: any,
    ) => Promise<void>;

    await btw("Investigate the side approach", contextFor(parent));

    const records = parent
      .getBranch()
      .filter(
        (entry): entry is CustomEntry =>
          entry.type === "custom" && entry.customType === "split-fork-record",
      );
    expect(records).toHaveLength(1);
    const childFile = (records[0]!.data as { sessionFile: string }).sessionFile;
    expect(existsSync(childFile)).toBe(true);

    const child = SessionManager.open(childFile, sessionDir);
    // The snapshot preserves the exact messages from the in-memory context.
    const childMessages = child
      .getBranch()
      .filter((entry) => entry.type === "message");
    expect(childMessages).toHaveLength(2);
    expect(childMessages[0]!.type).toBe("message");
    expect(
      (childMessages[0] as SessionEntry & { type: "message" }).message.role,
    ).toBe("user");
    const childContext = child.buildSessionContext();
    expect(childContext.model).toEqual({
      provider: "anthropic",
      modelId: "claude-test",
    });
    expect(childContext.thinkingLevel).toBe("high");
    // The child marker embeds the prompt for /btw --launch dispatch.
    const childMarker = child
      .getBranch()
      .find(
        (entry): entry is CustomEntry =>
          entry.type === "custom" && entry.customType === "split-fork-child",
      );
    expect(childMarker).toBeDefined();
    expect((childMarker!.data as { prompt: string }).prompt).toBe(
      "Investigate the side approach",
    );
  } finally {
    for (const [key, value] of [
      ["HERDR_ENV", previousHerdr.env],
      ["HERDR_PANE_ID", previousHerdr.pane],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("round-trips a side handoff through merge request, durable pending state, and parent import", async () => {
  const previousHerdr = {
    env: process.env.HERDR_ENV,
    pane: process.env.HERDR_PANE_ID,
  };
  process.env.HERDR_ENV = "1";
  process.env.HERDR_PANE_ID = "integration-parent-pane";

  try {
    let parent = SessionManager.create(cwd, sessionDir);
    parent.appendMessage(userMessage("Set up the main task"));
    parent.appendMessage(assistantMessage("Main task is ready"));
    const parentFile = parent.getSessionFile();
    if (!parentFile) throw new Error("Parent session was not persisted");

    const pi = buildPi(parent);
    registerSplitSession(pi);
    const btw = (parent as any).__btwHandler as (
      args: string,
      ctx: any,
    ) => Promise<void>;

    // Fork a side session from the persisted parent.
    await btw("Investigate the approach", contextFor(parent));

    const records = parent
      .getBranch()
      .filter(
        (entry): entry is CustomEntry =>
          entry.type === "custom" && entry.customType === "split-fork-record",
      );
    expect(records).toHaveLength(1);
    const childFile = (records[0]!.data as { sessionFile: string }).sessionFile;

    // Inside the child: append the same durable intent -> exact user prompt ->
    // completed assistant -> merge request chain used by the extension.
    const child = SessionManager.open(childFile, sessionDir);
    child.appendMessage(userMessage("Investigate the approach"));
    child.appendMessage(assistantMessage("Side answer is ready"));
    const handoffPrompt = "Prepare the exact integration handoff";
    const intentEntryId = child.appendCustomEntry("split-merge-intent", {
      requestId: "req-integration",
      handoffPrompt,
    });
    const promptEntryId = child.appendMessage(userMessage(handoffPrompt));
    const answerEntryId = child.appendMessage(
      assistantMessage("Validated integration handoff"),
    );
    child.appendCustomEntry("split-merge-request", {
      requestId: "req-integration",
      intentEntryId,
      promptEntryId,
      answerEntryId,
    });

    // Back in the parent: manually process the pending merge.
    parent = SessionManager.open(parentFile, sessionDir);
    await btw("merge", contextFor(parent, { hasUI: false }));

    const reopenedParent = SessionManager.open(parentFile, sessionDir);
    const importedResults = reopenedParent
      .getBranch()
      .filter(
        (entry): entry is CustomMessageEntry =>
          entry.type === "custom_message" &&
          entry.customType === "split-merge-result",
      );
    expect(importedResults).toHaveLength(1);
    const imported = importedResults[0]!;
    expect(imported.content).toContain("Validated integration handoff");
    expect(imported.content).not.toContain("Side answer is ready");
    expect(imported.content).not.toContain("Investigate the approach");
    expect(imported.details).toMatchObject({
      requestId: "req-integration",
      sessionFile: childFile,
    });

    // Dedupe: re-running /btw merge finds nothing new (same requestId).
    await btw(
      "merge",
      contextFor(SessionManager.open(parentFile, sessionDir), {
        hasUI: false,
      }),
    );
    const reopenedParent2 = SessionManager.open(parentFile, sessionDir);
    const importedResults2 = reopenedParent2
      .getBranch()
      .filter(
        (entry): entry is CustomMessageEntry =>
          entry.type === "custom_message" &&
          entry.customType === "split-merge-result",
      );
    expect(importedResults2).toHaveLength(1);
  } finally {
    for (const [key, value] of [
      ["HERDR_ENV", previousHerdr.env],
      ["HERDR_PANE_ID", previousHerdr.pane],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

// Reference the imported buildSessionContext so the import stays used even if
// future edits change the snapshot path; it documents the public API choice.
void buildSessionContext;
