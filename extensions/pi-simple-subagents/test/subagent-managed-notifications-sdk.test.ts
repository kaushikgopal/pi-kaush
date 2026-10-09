import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fauxAssistantMessage,
  fauxProvider,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test } from "vitest";
import { registerManagedNotifications } from "../src/_managed-notifications.ts";
import type { ManagedResultView, ManagedRuntime } from "../src/_managed.ts";

const roots: string[] = [];
const fixtures: SmokeFixture[] = [];

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) fixture.dispose();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("managed result notifications through the Pi SDK", () => {
  test("auto-reports while idle once, acknowledges the persisted message, and resumes without a duplicate", async () => {
    const fixture = await createSmokeFixture(() =>
      Promise.resolve("Parent acknowledged the managed result."),
    );
    const assignment = makeAssignment();
    fixture.setResults([assignment]);

    const session = await fixture.createSession();
    await session.bindExtensions({ mode: "json" });
    await fixture.waitForProviderCalls(1);
    await session.waitForIdle();

    expect(fixture.providerContexts).toHaveLength(1);
    expect(JSON.stringify(fixture.providerContexts[0])).toContain(
      assignment.outcome?.result,
    );
    expect(persistedCustomMessages(session)).toHaveLength(1);
    expect(persistedCustomMessages(session).join("\n")).toContain(
      assignment.outcome?.result,
    );
    expect(persistedAssistantText(session)).toContain(
      "Parent acknowledged the managed result.",
    );

    const firstContext = fixture.extensionContext();
    expect(
      fixture
        .notifications()
        .isReported(firstContext, assignment.handle, assignment.id),
    ).toBe(true);
    const manuallyCollected = makeAssignment(
      "mw-collected",
      "a-manually-collected",
    );
    await fixture
      .notifications()
      .markCollected(firstContext, manuallyCollected);
    expect(
      fixture
        .notifications()
        .isReported(
          firstContext,
          manuallyCollected.handle,
          manuallyCollected.id,
        ),
    ).toBe(true);
    fixture.setResults([assignment, manuallyCollected]);

    // The report turn itself causes another poll. It must not emit a second
    // custom message for the same terminal assignment.
    const repeatedPoll = fixture.listReadCount + 1;
    await fixture.waitForListReads(repeatedPoll);
    await session.waitForIdle();
    expect(persistedCustomMessages(session)).toHaveLength(1);
    expect(fixture.providerContexts).toHaveLength(1);

    const sessionFile = session.sessionFile;
    if (!sessionFile) throw new Error("SDK session did not persist to disk");
    session.dispose();

    const resumed = await fixture.createSession(
      SessionManager.open(sessionFile),
    );
    const readsBeforeResume = fixture.listReadCount;
    await resumed.bindExtensions({ mode: "json" });
    await fixture.waitForListReads(readsBeforeResume + 1);
    await resumed.waitForIdle();

    expect(fixture.providerContexts).toHaveLength(1);
    expect(persistedCustomMessages(resumed)).toHaveLength(1);
    const resumedContext = fixture.extensionContext();
    expect(
      fixture
        .notifications()
        .isReported(resumedContext, assignment.handle, assignment.id),
    ).toBe(true);
    expect(
      fixture
        .notifications()
        .isReported(
          resumedContext,
          manuallyCollected.handle,
          manuallyCollected.id,
        ),
    ).toBe(true);
  }, 20_000);

  test("queues a report as a follow-up while the parent is busy instead of interrupting it", async () => {
    let releaseFirstResponse = () => {};
    const firstResponseGate = new Promise<void>((resolve) => {
      releaseFirstResponse = resolve;
    });
    let firstResponseStarted = () => {};
    const firstResponseStartedPromise = new Promise<void>((resolve) => {
      firstResponseStarted = resolve;
    });
    const fixture = await createSmokeFixture(async (_context, callIndex) => {
      if (callIndex === 0) {
        firstResponseStarted();
        await firstResponseGate;
        return "The original parent turn completed.";
      }
      return "The parent acknowledged the queued report.";
    });
    const session = await fixture.createSession();
    try {
      await session.bindExtensions({ mode: "json" });

      const prompt = session.prompt("Keep this parent turn running.");
      await firstResponseStartedPromise;
      const assignment = makeAssignment("mw-busy", "a-busy-result");
      const nextPoll = fixture.listReadCount + 1;
      fixture.setResults([assignment]);
      await fixture.waitForListReads(nextPoll);

      expect(session.isStreaming).toBe(true);
      expect(session.agent.hasQueuedMessages()).toBe(true);
      const queuedMessages = session.agent.peekQueuedMessages();
      expect(queuedMessages).toHaveLength(1);
      expect(queuedMessages[0]?.role).toBe("custom");
      if (queuedMessages[0]?.role === "custom")
        expect(JSON.stringify(queuedMessages[0].content)).toContain(
          assignment.outcome?.result,
        );
      // Pi stores custom sendMessage entries on Agent's queues, not the
      // session string queue; clearing steers leaves only a follow-up queued.
      session.agent.clearSteeringQueue();
      expect(session.agent.hasQueuedMessages()).toBe(true);
      expect(fixture.providerContexts).toHaveLength(1);

      releaseFirstResponse();
      await fixture.waitForProviderCalls(2);
      await prompt;
      await session.waitForIdle();

      expect(fixture.providerContexts).toHaveLength(2);
      expect(persistedAssistantText(session)).toContain(
        "The original parent turn completed.",
      );
      expect(persistedAssistantText(session)).toContain(
        "The parent acknowledged the queued report.",
      );
      expect(persistedCustomMessages(session)).toHaveLength(1);
      expect(persistedCustomMessages(session).join("\n")).toContain(
        assignment.outcome?.result,
      );
      expect(JSON.stringify(fixture.providerContexts[1])).toContain(
        assignment.outcome?.result,
      );

      const branch = session.sessionManager.getBranch();
      const initialAssistantIndex = branch.findIndex(
        (entry) =>
          entry.type === "message" &&
          entry.message.role === "assistant" &&
          JSON.stringify(entry.message.content).includes(
            "The original parent turn completed.",
          ),
      );
      const notificationIndex = branch.findIndex(
        (entry) => entry.type === "custom_message",
      );
      const followUpAssistantIndex = branch.findIndex(
        (entry) =>
          entry.type === "message" &&
          entry.message.role === "assistant" &&
          JSON.stringify(entry.message.content).includes(
            "The parent acknowledged the queued report.",
          ),
      );
      expect(initialAssistantIndex).toBeGreaterThanOrEqual(0);
      expect(notificationIndex).toBeGreaterThan(initialAssistantIndex);
      expect(followUpAssistantIndex).toBeGreaterThan(notificationIndex);
    } finally {
      releaseFirstResponse();
    }
  }, 20_000);
});

interface Counter {
  readonly value: number;
  increment(): void;
  waitForAtLeast(target: number): Promise<void>;
}

function createCounter(): Counter {
  let value = 0;
  const waiters = new Set<{ target: number; resolve: () => void }>();
  return {
    get value() {
      return value;
    },
    increment() {
      value++;
      for (const waiter of [...waiters]) {
        if (value < waiter.target) continue;
        waiters.delete(waiter);
        waiter.resolve();
      }
    },
    waitForAtLeast(target) {
      if (value >= target) return Promise.resolve();
      return new Promise<void>((resolve) => {
        waiters.add({ target, resolve });
      });
    },
  };
}

interface SmokeFixture {
  readonly providerCalls: Counter;
  readonly providerContexts: TranscriptContext[];
  readonly listReadCount: number;
  setResults(results: ManagedResultView[]): void;
  waitForProviderCalls(count: number): Promise<void>;
  waitForListReads(count: number): Promise<void>;
  createSession(
    sessionManager?: ReturnType<typeof SessionManager.create>,
  ): Promise<AgentSession>;
  extensionContext(): ExtensionContext;
  notifications(): ReturnType<typeof registerManagedNotifications>;
  dispose(): void;
}

async function createSmokeFixture(
  respond: (context: TranscriptContext, callIndex: number) => Promise<string>,
): Promise<SmokeFixture> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-managed-notifications-sdk-"));
  roots.push(cwd);
  const agentDir = join(cwd, "agent");
  const sessionDir = join(cwd, "sessions");
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  });
  const faux = fauxProvider({
    provider: "managed-notifications-faux",
    api: "managed-notifications-faux-api",
    models: [
      {
        id: "offline",
        name: "Offline managed notifications model",
        contextWindow: 8_192,
        maxTokens: 256,
      },
    ],
  });
  const modelRuntime = await ModelRuntime.create({
    modelsPath: null,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);

  const providerCalls = createCounter();
  const providerContexts: TranscriptContext[] = [];
  let callIndex = 0;
  faux.setResponses(
    Array.from({ length: 8 }, () => async (context: TranscriptContext) => {
      const index = callIndex++;
      providerContexts.push(context);
      providerCalls.increment();
      return fauxAssistantMessage(await respond(context, index));
    }),
  );

  const listReads = createCounter();
  let results: ManagedResultView[] = [];
  const runtime: ManagedRuntime = {
    parentSessionId: "sdk-parent-session",
    async spawn() {
      throw new Error("The offline smoke test must not launch a child");
    },
    list: () => [],
    listResults: () => {
      listReads.increment();
      return results;
    },
    status() {
      throw new Error("The offline smoke test does not inspect workers");
    },
    send() {
      throw new Error("The offline smoke test does not send child messages");
    },
    async wait() {
      throw new Error("The offline smoke test does not wait for child work");
    },
    async stop() {
      throw new Error("The offline smoke test does not stop workers");
    },
    async resume() {
      throw new Error("The offline smoke test does not resume workers");
    },
    async suspendAll() {},
    async restore() {
      return [];
    },
    async open() {},
    bind() {},
  };

  let notificationApi:
    | ReturnType<typeof registerManagedNotifications>
    | undefined;
  let currentContext: ExtensionContext | undefined;
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    extensionFactories: [
      {
        name: "managed-notifications-sdk-smoke",
        factory(pi) {
          notificationApi = registerManagedNotifications(
            pi,
            async () => runtime,
          );
          pi.on("session_start", (_event, ctx) => {
            currentContext = ctx;
          });
        },
      },
    ],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();

  const sessions: AgentSession[] = [];
  const fixture: SmokeFixture = {
    providerCalls,
    providerContexts,
    get listReadCount() {
      return listReads.value;
    },
    setResults(nextResults) {
      results = nextResults;
    },
    waitForProviderCalls(count) {
      return providerCalls.waitForAtLeast(count);
    },
    waitForListReads(count) {
      return listReads.waitForAtLeast(count);
    },
    async createSession(
      sessionManager = SessionManager.create(cwd, sessionDir),
    ) {
      const { session, extensionsResult } = await createAgentSession({
        cwd,
        agentDir,
        model: faux.getModel(),
        modelRuntime,
        sessionManager,
        settingsManager,
        resourceLoader,
        tools: [],
      });
      expect(extensionsResult.errors).toEqual([]);
      sessions.push(session);
      return session;
    },
    extensionContext() {
      if (!currentContext)
        throw new Error(
          "Pi did not deliver the session_start extension context",
        );
      return currentContext;
    },
    notifications() {
      if (!notificationApi)
        throw new Error("Pi did not load the managed notification extension");
      return notificationApi;
    },
    dispose() {
      for (const session of sessions.splice(0)) session.dispose();
    },
  };
  fixtures.push(fixture);
  return fixture;
}

function makeAssignment(
  handle = "mw-idle",
  id = "a-idle-result",
): ManagedResultView {
  return {
    handle,
    id,
    state: "completed",
    terminal: true,
    preview: "Complete the offline assignment",
    outcome: {
      source: "yield",
      result: `Result for ${id}: the offline assignment is complete.`,
    },
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      turns: 1,
      contextTokens: 15,
    },
    toolActivity: true,
    model: "managed-notifications-faux/offline",
    endedAt: Date.now(),
  };
}

function persistedCustomMessages(session: AgentSession): string[] {
  const messages: string[] = [];
  for (const entry of session.sessionManager.getBranch()) {
    if (entry.type !== "custom_message") continue;
    if (typeof entry.content === "string") {
      messages.push(entry.content);
      continue;
    }
    for (const part of entry.content)
      if (part.type === "text") messages.push(part.text);
  }
  return messages;
}

function persistedAssistantText(session: AgentSession): string {
  const messages: string[] = [];
  for (const entry of session.sessionManager.getBranch()) {
    if (entry.type !== "message" || entry.message.role !== "assistant")
      continue;
    for (const part of entry.message.content)
      if (part.type === "text") messages.push(part.text);
  }
  return messages.join("\n");
}
