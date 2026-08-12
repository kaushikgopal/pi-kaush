import { existsSync, mkdirSync, rmSync } from "node:fs";
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
  return Promise.resolve({ code: 0, stdout: "", stderr: "" });
}

function buildPi(sessionManager: SessionManagerInstance) {
  const execCalls: Array<{ command: string; args: string[] }> = [];
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
    sendUserMessage(content: string) {
      sessionManager.appendMessage(userMessage(content));
    },
    exec: async (command: string, args: string[]) => {
      execCalls.push({ command, args });
      return herdrExec(command, args);
    },
    on: () => {},
    execCalls,
  } as any;
}

function contextFor(sessionManager: SessionManagerInstance) {
  return {
    cwd,
    hasUI: true,
    mode: "tui" as const,
    isIdle: () => true,
    waitForIdle: async () => {},
    sessionManager,
    ui: {
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

    // The child session file is known only to the launch itself: it is passed
    // as the `--session` argument of the Herdr `agent start` command.
    const execCalls: Array<{ command: string; args: string[] }> = pi.execCalls;
    const startCall = execCalls.find(
      (call) => call.args[0] === "agent" && call.args[1] === "start",
    );
    const sessionFlag = startCall?.args.indexOf("--session");
    const childFile = sessionFlag
      ? startCall!.args[sessionFlag + 1]!
      : undefined;
    expect(childFile).toBeDefined();
    expect(existsSync(childFile!)).toBe(true);

    const child = SessionManager.open(childFile!, sessionDir);
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
    // The constant launch command is submitted instead of the raw prompt.
    const promptCall = execCalls.find(
      (call) =>
        call.args[0] === "agent" &&
        call.args[1] === "prompt" &&
        call.args[3] === "/btw --launch",
    );
    expect(promptCall).toBeDefined();
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
