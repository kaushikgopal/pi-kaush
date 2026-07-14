import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SessionManager,
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

test("round-trips selectable side handoffs through real session files", async () => {
  const previousHerdr = {
    env: process.env.HERDR_ENV,
    workspace: process.env.HERDR_WORKSPACE_ID,
    tab: process.env.HERDR_TAB_ID,
  };
  process.env.HERDR_ENV = "1";
  process.env.HERDR_WORKSPACE_ID = "integration-workspace";
  process.env.HERDR_TAB_ID = "integration-tab";

  try {
    let activeSession = SessionManager.create(cwd, sessionDir);
    activeSession.appendMessage(userMessage("Set up the main task"));
    activeSession.appendMessage(assistantMessage("Main task is ready"));
    const parentFile = activeSession.getSessionFile();
    if (!parentFile) throw new Error("Parent session was not persisted");

    const commands = new Map<
      string,
      (args: string, ctx: any) => Promise<void>
    >();
    const notifications: string[] = [];
    let selectedSplitIndex = 0;
    const pi = {
      registerCommand(
        name: string,
        definition: { handler: (args: string, ctx: any) => Promise<void> },
      ) {
        commands.set(name, definition.handler);
      },
      appendEntry(customType: string, data: unknown) {
        activeSession.appendCustomEntry(customType, data);
      },
      sendMessage(message: {
        customType: string;
        content: string;
        display: boolean;
        details?: unknown;
      }) {
        activeSession.appendCustomMessageEntry(
          message.customType,
          message.content,
          message.display,
          message.details,
        );
      },
      sendUserMessage(content: string) {
        activeSession.appendMessage(userMessage(content));
      },
      exec: async () => ({
        code: 0,
        stdout: JSON.stringify({
          result: { agent: { pane_id: "integration-pane" } },
        }),
        stderr: "",
      }),
    };
    registerSplitSession(pi as any);

    const contextFor = (sessionManager: SessionManagerInstance) => ({
      cwd,
      hasUI: true,
      mode: "tui",
      isIdle: () => true,
      waitForIdle: async () => {},
      sessionManager,
      ui: {
        select: async (_title: string, choices: string[]) =>
          choices[selectedSplitIndex],
        notify: (message: string) => notifications.push(message),
      },
    });

    const split = commands.get("split");
    const handoff = commands.get("split-handoff");
    const importSummary = commands.get("split-import");
    if (!split || !handoff || !importSummary)
      throw new Error("Split commands were not registered");

    await split("Investigate the first approach", contextFor(activeSession));
    await split("Investigate the second approach", contextFor(activeSession));

    const parentRecords = activeSession
      .getBranch()
      .filter(
        (entry): entry is CustomEntry =>
          entry.type === "custom" && entry.customType === "split-fork-record",
      );
    expect(parentRecords).toHaveLength(2);
    const firstChildFile = (parentRecords[0]!.data as { sessionFile: string })
      .sessionFile;
    const secondChildFile = (parentRecords[1]!.data as { sessionFile: string })
      .sessionFile;

    for (const [sessionFile, summary] of [
      [firstChildFile, "First approach handoff"],
      [secondChildFile, "Second approach handoff"],
    ] as const) {
      activeSession = SessionManager.open(sessionFile, sessionDir);
      expect(
        activeSession
          .getBranch()
          .some(
            (entry: any) =>
              entry.type === "custom" &&
              entry.customType === "split-fork-child",
          ),
      ).toBe(true);
      await handoff("", contextFor(activeSession));
      activeSession.appendMessage(assistantMessage(summary));
    }

    activeSession = SessionManager.open(parentFile, sessionDir);
    selectedSplitIndex = 1;
    await importSummary("", contextFor(activeSession));

    const reopenedParent = SessionManager.open(parentFile, sessionDir);
    const importedResults = reopenedParent
      .getBranch()
      .filter(
        (entry): entry is CustomMessageEntry =>
          entry.type === "custom_message" &&
          entry.customType === "split-fork-result",
      );
    expect(importedResults).toHaveLength(1);
    const importedResult = importedResults[0]!;
    expect(importedResult.content).toContain("First approach handoff");
    expect(importedResult.content).not.toContain(
      "Investigate the first approach",
    );
    expect(importedResult.content).not.toContain("Second approach handoff");
    expect(importedResult.details).toMatchObject({
      sessionFile: firstChildFile,
      format: "summary",
    });
    expect(notifications).toContain(
      "Split import queued. The side split stays open; close it manually when you're done.",
    );
  } finally {
    for (const [key, value] of [
      ["HERDR_ENV", previousHerdr.env],
      ["HERDR_WORKSPACE_ID", previousHerdr.workspace],
      ["HERDR_TAB_ID", previousHerdr.tab],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
