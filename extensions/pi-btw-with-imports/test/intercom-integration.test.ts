import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SessionManager,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import registerSplitSession from "../src/index.ts";

// Change-set-D integration coverage: optional Intercom awareness for /btw.
// Runs against the real SessionManager so child session ids, session_info
// naming, and durable markers are exercised end to end. Pi-intercom itself is
// never loaded; its extension channel is simulated through pi.events to prove
// the observational contract and load-order tolerance.

type SessionManagerInstance = ReturnType<typeof SessionManager.create>;
type CustomEntry = Extract<SessionEntry, { type: "custom" }>;

const rootDir = join(tmpdir(), `pi-btw-intercom-${process.pid}`);
const cwd = join(rootDir, "project");
const sessionDir = join(rootDir, "sessions");
mkdirSync(cwd, { recursive: true });
mkdirSync(sessionDir, { recursive: true });

const SPLIT_RECORD_TYPE = "split-fork-record";
const SPLIT_CHILD_TYPE = "split-fork-child";
const INTERCOM_REGISTER_EVENT = "intercom:extension-register";
const INTERCOM_REGISTRY_READY_EVENT = "intercom:extension-registry-ready";

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
        result: { pane: { pane_id: "intercom-child-pane" } },
      }),
      stderr: "",
    });
  }
  if (args[0] === "agent" && args[1] === "start") {
    return Promise.resolve({
      code: 0,
      stdout: JSON.stringify({
        result: { agent: { pane_id: "intercom-child-pane" } },
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
  return Promise.resolve({
    code: 0,
    stdout: "{}",
    stderr: "",
  });
}

type EventBusMock = {
  handlers: Map<string, Array<(data: unknown) => void>>;
  emitted: Array<{ channel: string; data: unknown }>;
  on(channel: string, handler: (data: unknown) => void): () => void;
  emit(channel: string, data: unknown): void;
};

function createEventBusMock(): EventBusMock {
  const bus: EventBusMock = {
    handlers: new Map(),
    emitted: [],
    on(channel, handler) {
      const list = bus.handlers.get(channel) ?? [];
      list.push(handler);
      bus.handlers.set(channel, list);
      return () => {
        bus.handlers.set(
          channel,
          list.filter((candidate) => candidate !== handler),
        );
      };
    },
    emit(channel, data) {
      bus.emitted.push({ channel, data });
      for (const handler of bus.handlers.get(channel) ?? []) {
        handler(data);
      }
    },
  };
  return bus;
}

type Harness = {
  parent: SessionManagerInstance;
  bus: EventBusMock;
  btw: (args: string, ctx: any) => Promise<void>;
  sessionStart: (ctx: any) => Promise<void>;
  agentSettled: (ctx: any) => Promise<void>;
  beforeAgentStart: (
    event: { systemPrompt: string },
    ctx: any,
  ) => { systemPrompt: string } | undefined;
  ctx: any;
  execCalls: Array<{ command: string; args: string[] }>;
  sentUserMessages: string[];
  appendedEntries: Array<{ type: string; data: unknown }>;
  notifications: Array<{ message: string; level: string }>;
  activeTools: string[];
  contextFor(manager: SessionManagerInstance): any;
  records(): CustomEntry[];
};

const ENV_KEYS = [
  "PI_INTERCOM_SESSION_ID",
  "PI_INTERCOM_STABLE_ID",
  "HERDR_ENV",
  "HERDR_PANE_ID",
] as const;

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

function createHarness(parent: SessionManagerInstance): Harness {
  const bus = createEventBusMock();
  const execCalls: Array<{ command: string; args: string[] }> = [];
  const sentUserMessages: string[] = [];
  const appendedEntries: Array<{ type: string; data: unknown }> = [];
  const notifications: Array<{ message: string; level: string }> = [];
  let currentManager: SessionManagerInstance = parent;
  let activeTools = ["read", "bash", "write", "edit", "intercom"];
  let btwHandler: ((args: string, ctx: any) => Promise<void>) | undefined;
  let sessionStartHandler:
    | ((event: any, ctx: any) => Promise<void> | void)
    | undefined;
  let agentSettledHandler:
    | ((event: any, ctx: any) => Promise<void> | void)
    | undefined;
  let beforeAgentStartHandler:
    | ((event: never, ctx: any) => { systemPrompt: string } | undefined)
    | undefined;

  const pi = {
    registerCommand(name: string, definition: any) {
      if (name === "btw") btwHandler = definition.handler;
    },
    appendEntry(type: string, data: unknown) {
      appendedEntries.push({ type, data });
      currentManager.appendCustomEntry(type, data);
    },
    sendMessage() {},
    sendUserMessage(message: string) {
      sentUserMessages.push(message);
      currentManager.appendMessage(userMessage(message));
    },
    exec: async (command: string, args: string[]) => {
      execCalls.push({ command, args });
      return herdrExec(command, args);
    },
    getActiveTools: () => [...activeTools],
    events: bus,
    on(event: string, handler: any) {
      if (event === "session_start") sessionStartHandler = handler;
      if (event === "agent_settled") agentSettledHandler = handler;
      if (event === "before_agent_start") beforeAgentStartHandler = handler;
    },
  };
  registerSplitSession(pi as any);
  if (!btwHandler) throw new Error("btw command was not registered");

  const contextFor = (manager: SessionManagerInstance) =>
    ({
      cwd,
      hasUI: true,
      mode: "tui",
      isIdle: () => true,
      waitForIdle: async () => {},
      sessionManager: manager,
      ui: {
        select: async () => undefined,
        notify: (message: string, level: string) => {
          notifications.push({ message, level });
        },
      },
    }) as any;

  return {
    parent,
    bus,
    btw: (args, ctx) => {
      const resolvedCtx = ctx ?? contextFor(parent);
      currentManager = resolvedCtx.sessionManager;
      return btwHandler!(args, resolvedCtx);
    },
    sessionStart: async (ctx) => {
      const resolvedCtx = ctx ?? contextFor(parent);
      currentManager = resolvedCtx.sessionManager;
      await sessionStartHandler!({ type: "session_start" }, resolvedCtx);
    },
    agentSettled: async (ctx) => {
      const resolvedCtx = ctx ?? contextFor(parent);
      currentManager = resolvedCtx.sessionManager;
      await agentSettledHandler!({ type: "agent_settled" }, resolvedCtx);
    },
    beforeAgentStart: (event, ctx) =>
      beforeAgentStartHandler!(event as never, ctx ?? contextFor(parent)),
    ctx: contextFor(parent),
    execCalls,
    sentUserMessages,
    appendedEntries,
    notifications,
    activeTools,
    contextFor,
    records: () =>
      parent
        .getBranch()
        .filter(
          (entry): entry is CustomEntry =>
            entry.type === "custom" && entry.customType === SPLIT_RECORD_TYPE,
        ),
  };
}

function createPersistedParent(): SessionManagerInstance {
  const parent = SessionManager.create(cwd, sessionDir);
  parent.appendMessage(userMessage("Set up the main task"));
  parent.appendMessage(assistantMessage("Main task is ready"));
  return parent;
}

function createInMemoryParent(): SessionManagerInstance {
  const parent = SessionManager.inMemory(cwd);
  parent.appendMessage(userMessage("Set up the main task"));
  parent.appendMessage(assistantMessage("Main task is ready"));
  return parent;
}

function childFileFor(record: CustomEntry): string {
  return (record.data as { sessionFile: string }).sessionFile;
}

function childMarker(manager: SessionManagerInstance): CustomEntry | undefined {
  return manager
    .getBranch()
    .find(
      (entry): entry is CustomEntry =>
        entry.type === "custom" && entry.customType === SPLIT_CHILD_TYPE,
    );
}

function childIntercom(
  manager: SessionManagerInstance,
): Record<string, unknown> | undefined {
  const marker = childMarker(manager);
  return (marker?.data as { intercom?: Record<string, unknown> }).intercom;
}

function sessionInfoNames(manager: SessionManagerInstance): string[] {
  return manager
    .getBranch()
    .filter(
      (entry): entry is Extract<SessionEntry, { type: "session_info" }> =>
        entry.type === "session_info",
    )
    .map((entry) => entry.name ?? "");
}

describe("/btw Intercom awareness", () => {
  test("Intercom absent: launches stay unchanged with no identity or extra naming", async () => {
    process.env.HERDR_ENV = "1";
    process.env.HERDR_PANE_ID = "parent-pane";
    const parent = createPersistedParent();
    const harness = createHarness(parent);

    await harness.btw("Investigate the approach", harness.ctx);
    expect(harness.records()).toHaveLength(1);
    expect(harness.records()[0]!.data).not.toHaveProperty("intercom");
    const child = SessionManager.open(
      childFileFor(harness.records()[0]!),
      sessionDir,
    );
    expect(childIntercom(child)).toBeUndefined();
    expect(sessionInfoNames(child)).toEqual([]);
    expect(
      harness.notifications.some(({ message }) =>
        message.includes("intercom contact"),
      ),
    ).toBe(false);
  });

  test("a registered but disabled Intercom tool does not count as an initialized runtime", async () => {
    // The tool is active but the runtime env identity is absent (disabled
    // config); no guidance may be projected.
    process.env.HERDR_ENV = "1";
    process.env.HERDR_PANE_ID = "parent-pane";
    const parent = createPersistedParent();
    const harness = createHarness(parent);
    expect(harness.activeTools).toContain("intercom");

    const result = harness.beforeAgentStart(
      { systemPrompt: "base" },
      harness.ctx,
    );
    expect(result).toBeUndefined();
  });

  test("initialized runtime with disconnected channel is never labeled live", async () => {
    process.env.HERDR_ENV = "1";
    process.env.HERDR_PANE_ID = "parent-pane";
    const parent = createPersistedParent();
    process.env.PI_INTERCOM_SESSION_ID = parent.getSessionId();
    const harness = createHarness(parent);

    await harness.btw("Investigate the approach", harness.ctx);
    const record = harness.records()[0]!;
    const identity = (record.data as { intercom: Record<string, unknown> })
      .intercom;
    expect(identity.childTarget).toBeTypeOf("string");

    // Intercom loads, ready fires, and a channel reports disconnected.
    harness.bus.emit(INTERCOM_REGISTRY_READY_EVENT, { version: 1 });
    const registration = harness.bus.emitted.find(
      (entry) => entry.channel === INTERCOM_REGISTER_EVENT,
    );
    expect(registration).toBeDefined();
    const channel = {
      connected: false,
      snapshot: () => ({ connected: false, supported: true }),
      publish: () => {},
      commitState: () => {},
      listSessions: async () => [],
    };
    (registration!.data as any).onReady(channel);

    const guidance = harness.beforeAgentStart(
      { systemPrompt: "base" },
      harness.ctx,
    )?.systemPrompt;
    expect(guidance).toContain((identity as { childName: string }).childName);
    // Capability phrasing, never a live-delivery claim.
    expect(guidance).toContain('action: "send"');
    expect(guidance).not.toContain("(live)");
  });

  test("an agent whose tool list omits intercom gets no guidance and no widened tools", async () => {
    process.env.HERDR_ENV = "1";
    process.env.HERDR_PANE_ID = "parent-pane";
    const parent = createPersistedParent();
    process.env.PI_INTERCOM_SESSION_ID = parent.getSessionId();
    const harness = createHarness(parent);
    harness.activeTools = ["read", "bash"];

    const result = harness.beforeAgentStart(
      { systemPrompt: "base" },
      harness.ctx,
    );
    expect(result).toBeUndefined();
    expect(harness.activeTools).toEqual(["read", "bash"]);
  });

  test("default identity mode records the exact child Pi session id", async () => {
    process.env.HERDR_ENV = "1";
    process.env.HERDR_PANE_ID = "parent-pane";
    const parent = createPersistedParent();
    // Parent Intercom id equals its Pi session id: default identity mode.
    process.env.PI_INTERCOM_SESSION_ID = parent.getSessionId();

    const harness = createHarness(parent);
    await harness.btw("Investigate the approach", harness.ctx);

    const record = harness.records()[0]!;
    const identity = (record.data as { intercom: Record<string, unknown> })
      .intercom;
    expect(identity.defaultIdentityMode).toBe(true);
    expect(identity.parentTarget).toBe(parent.getSessionId());
    expect(identity.childName).toMatch(/^btw-[a-f0-9]{8}$/);

    const child = SessionManager.open(childFileFor(record), sessionDir);
    // Exact child targeting: the recorded childTarget equals the child's own
    // Pi session id, available before any asynchronous name registration.
    expect(identity.childTarget).toBe(child.getSessionId());
    expect(childIntercom(child)).toEqual(identity);

    // The generated session name was appended before the backend started and
    // the Herdr agent name shares the same split id.
    expect(sessionInfoNames(child)).toEqual([identity.childName]);
    const agentStart = harness.execCalls.find(
      (call) => call.args[0] === "agent" && call.args[1] === "start",
    );
    const shortId = (identity.childName as string).slice(4);
    expect(agentStart!.args[2]).toBe(`pi-btw-${shortId}`);
    expect(
      harness.notifications.some(({ message }) =>
        message.includes(`intercom contact: ${identity.childName}`),
      ),
    ).toBe(true);
  });

  test("exact-ID delivery is available before any name/presence update", async () => {
    process.env.HERDR_ENV = "1";
    process.env.HERDR_PANE_ID = "parent-pane";
    const parent = createPersistedParent();
    process.env.PI_INTERCOM_SESSION_ID = parent.getSessionId();
    const harness = createHarness(parent);

    await harness.btw("Investigate the approach", harness.ctx);
    const identity = (
      harness.records()[0]!.data as {
        intercom: Record<string, unknown>;
      }
    ).intercom;

    // No intercom channel, no presence events: the recorded exact target is
    // already usable, and the parent projection uses it in the example.
    const guidance = harness.beforeAgentStart(
      { systemPrompt: "base" },
      harness.ctx,
    )?.systemPrompt;
    expect(guidance).toContain(identity.childTarget as string);
  });

  test("a parent Intercom id differing from its Pi session id disables exact child targeting", async () => {
    process.env.HERDR_ENV = "1";
    process.env.HERDR_PANE_ID = "parent-pane";
    const parent = createPersistedParent();
    process.env.PI_INTERCOM_SESSION_ID = "some-other-machine-id";
    const harness = createHarness(parent);

    await harness.btw("Investigate the approach", harness.ctx);
    const identity = (
      harness.records()[0]!.data as {
        intercom: Record<string, unknown>;
      }
    ).intercom;
    expect(identity.defaultIdentityMode).toBe(false);
    expect(identity).not.toHaveProperty("childTarget");
    expect(identity).not.toHaveProperty("parentTarget");
    expect(identity.childName).toMatch(/^btw-[a-f0-9]{8}$/);
  });

  test("a configured PI_INTERCOM_STABLE_ID never produces a guessed child target", async () => {
    process.env.HERDR_ENV = "1";
    process.env.HERDR_PANE_ID = "parent-pane";
    const parent = createPersistedParent();
    process.env.PI_INTERCOM_SESSION_ID = parent.getSessionId();
    process.env.PI_INTERCOM_STABLE_ID = "shared-stable-id";
    const harness = createHarness(parent);

    await harness.btw("Investigate the approach", harness.ctx);
    const identity = (
      harness.records()[0]!.data as {
        intercom: Record<string, unknown>;
      }
    ).intercom;
    expect(identity.defaultIdentityMode).toBe(false);
    expect(identity).not.toHaveProperty("childTarget");
    expect(identity).not.toHaveProperty("parentTarget");
  });

  test("persisted fork and first-turn snapshot paths both return the actual child session id", async () => {
    process.env.HERDR_ENV = "1";
    process.env.HERDR_PANE_ID = "parent-pane";

    // Persisted-fork path.
    const persisted = createPersistedParent();
    process.env.PI_INTERCOM_SESSION_ID = persisted.getSessionId();
    const forkHarness = createHarness(persisted);
    await forkHarness.btw("Forked approach", forkHarness.ctx);
    const forkIdentity = (
      forkHarness.records()[0]!.data as {
        intercom: Record<string, unknown>;
      }
    ).intercom;
    const forkChild = SessionManager.open(
      childFileFor(forkHarness.records()[0]!),
      sessionDir,
    );
    expect(forkIdentity.childTarget).toBe(forkChild.getSessionId());

    // First-turn snapshot path (in-memory parent).
    const memory = createInMemoryParent();
    process.env.PI_INTERCOM_SESSION_ID = memory.getSessionId();
    const snapshotHarness = createHarness(memory);
    await snapshotHarness.btw("Snapshot approach", snapshotHarness.ctx);
    const snapshotRecord = snapshotHarness.records()[0]!;
    const snapshotIdentity = (
      snapshotRecord.data as {
        intercom: Record<string, unknown>;
      }
    ).intercom;
    const snapshotChild = SessionManager.open(
      childFileFor(snapshotRecord),
      sessionDir,
    );
    expect(snapshotIdentity.childTarget).toBe(snapshotChild.getSessionId());
    expect(sessionInfoNames(snapshotChild)).toEqual([
      snapshotIdentity.childName,
    ]);
  });

  test("child session_start bootstrap reasserts the name once and stays idempotent across reload", async () => {
    process.env.HERDR_ENV = "1";
    process.env.HERDR_PANE_ID = "parent-pane";
    const parent = createPersistedParent();
    process.env.PI_INTERCOM_SESSION_ID = parent.getSessionId();
    const harness = createHarness(parent);

    await harness.btw("Investigate the approach", harness.ctx);
    const record = harness.records()[0]!;
    const childFile = childFileFor(record);
    const child = SessionManager.open(childFile, sessionDir);
    const identity = (record.data as { intercom: Record<string, unknown> })
      .intercom;

    // Startup, /btw --launch, and reload must not duplicate the name entry or
    // inject model-context messages.
    const childCtx = harness.contextFor(child);
    await harness.sessionStart(childCtx);
    await harness.sessionStart(childCtx);
    await harness.btw("--launch", childCtx);

    expect(sessionInfoNames(child)).toEqual([identity.childName]);
    // Only the /btw --launch dispatches the embedded prompt; session_start
    // never sends messages.
    expect(harness.sentUserMessages).toEqual(["Investigate the approach"]);
  });

  test("Ghostty with initialized but disconnected Intercom does not delay the initial prompt", async () => {
    const isDarwin = process.platform === "darwin";
    const parent = createPersistedParent();
    process.env.PI_INTERCOM_SESSION_ID = parent.getSessionId();
    const harness = createHarness(parent);

    // No HERDR_ENV routes to Ghostty on darwin (and fails cleanly elsewhere):
    // the startup input is built and submitted immediately with the real
    // prompt and never held for the broker.
    await harness.btw("Ghostty approach", harness.ctx);

    if (isDarwin) {
      const osascriptCall = harness.execCalls.find(
        (call) => call.command === "osascript",
      );
      expect(osascriptCall).toBeDefined();
      expect(osascriptCall!.args.join(" ")).toContain("Ghostty approach");
      expect(
        harness.execCalls.some(
          (call) => call.args[0] === "agent" && call.args[1] === "start",
        ),
      ).toBe(false);
      expect(harness.records()).toHaveLength(1);
      const identity = (
        harness.records()[0]!.data as {
          intercom: Record<string, unknown>;
        }
      ).intercom;
      expect(identity.childName).toMatch(/^btw-[a-f0-9]{8}$/);
    } else {
      // Non-darwin hosts fail cleanly before copying anything: no launch, no
      // record, no identity, and the error is surfaced.
      expect(harness.records()).toHaveLength(0);
      expect(
        harness.notifications.some(({ message }) =>
          message.includes("Cannot split"),
        ),
      ).toBe(true);
    }
  });

  test("observational channel registration is load-order tolerant and never publishes control traffic", async () => {
    process.env.HERDR_ENV = "1";
    process.env.HERDR_PANE_ID = "parent-pane";
    const parent = createPersistedParent();
    process.env.PI_INTERCOM_SESSION_ID = parent.getSessionId();
    const harness = createHarness(parent);

    // Intercom loads AFTER this extension: the ready event reaches the
    // factory-time listener.
    harness.bus.emit(INTERCOM_REGISTRY_READY_EVENT, { version: 1 });
    const registrations = harness.bus.emitted.filter(
      (entry) => entry.channel === INTERCOM_REGISTER_EVENT,
    );
    expect(registrations.length).toBeGreaterThanOrEqual(1);
    const registration = registrations[0]!.data as {
      namespace: string;
      ownerEligible: boolean;
      onEvent: (event: unknown) => void;
      onReady: (channel: unknown) => void;
    };
    expect(registration.namespace).toBe("pi-btw-presence/v1");
    expect(registration.ownerEligible).toBe(false);

    // A session_start retry when the ready event was missed must not throw on
    // duplicate registration.
    const channel = {
      snapshot: () => ({ connected: true, supported: true }),
      publish: () => {},
      commitState: () => {},
      listSessions: async () => [],
    };
    registration.onReady(channel);
    for (const canvas of [
      () => harness.sessionStart(harness.ctx),
      () => harness.sessionStart(harness.ctx),
    ]) {
      await expect(canvas()).resolves.toBeUndefined();
    }
  });

  test("joined/left/presence events update only ephemeral liveness labels", async () => {
    process.env.HERDR_ENV = "1";
    process.env.HERDR_PANE_ID = "parent-pane";
    const parent = createPersistedParent();
    process.env.PI_INTERCOM_SESSION_ID = parent.getSessionId();
    const harness = createHarness(parent);

    await harness.btw("Investigate the approach", harness.ctx);
    const identity = (
      harness.records()[0]!.data as {
        intercom: Record<string, unknown>;
      }
    ).intercom;
    const child = SessionManager.open(
      childFileFor(harness.records()[0]!),
      sessionDir,
    );

    // Deliver the channel and presence lifecycle for the exact child.
    harness.bus.emit(INTERCOM_REGISTRY_READY_EVENT, { version: 1 });
    const registration = harness.bus.emitted.find(
      (entry) => entry.channel === INTERCOM_REGISTER_EVENT,
    )!.data as {
      onEvent: (event: unknown) => void;
      onReady: (channel: unknown) => void;
    };
    const channel = {
      snapshot: () => ({ connected: true, supported: true }),
      publish: () => {},
      commitState: () => {},
      listSessions: async () => [],
    };
    registration.onReady(channel);
    registration.onEvent({
      type: "session_joined",
      session: { id: child.getSessionId(), name: identity.childName },
    });
    registration.onEvent({
      type: "presence_update",
      session: { id: child.getSessionId(), name: identity.childName },
    });

    const guidance = harness.beforeAgentStart(
      { systemPrompt: "base" },
      harness.ctx,
    )?.systemPrompt;
    expect(guidance).toContain("(live)");

    registration.onEvent({
      type: "session_left",
      sessionId: child.getSessionId(),
    });
    const afterLeft = harness.beforeAgentStart(
      { systemPrompt: "base" },
      harness.ctx,
    )?.systemPrompt;
    expect(afterLeft).toContain("(disconnected)");

    // The events never produced model turns, merge traffic, or session state.
    expect(harness.sentUserMessages).toEqual([]);
    expect(harness.appendedEntries.map((entry) => entry.type)).toEqual([
      SPLIT_RECORD_TYPE,
    ]);
  });

  test("parent projection is bounded and never triggers an extra turn", async () => {
    process.env.HERDR_ENV = "1";
    process.env.HERDR_PANE_ID = "parent-pane";
    const parent = createPersistedParent();
    process.env.PI_INTERCOM_SESSION_ID = parent.getSessionId();
    const harness = createHarness(parent);

    // Eight recorded splits; the projection roster must be bounded.
    for (let index = 0; index < 8; index++) {
      await harness.btw(`Approach ${index}`, harness.ctx);
    }
    expect(harness.records()).toHaveLength(8);

    const guidance = harness.beforeAgentStart(
      { systemPrompt: "base" },
      harness.ctx,
    )?.systemPrompt;
    expect(guidance).toContain("Live side splits (Intercom)");
    const rosterLines = guidance!
      .split("\n")
      .filter((line) => line.startsWith("- "));
    expect(rosterLines).toHaveLength(6);
    expect(harness.sentUserMessages).toEqual([]);
  });

  test("child projection contains only its newest marker's parent route", async () => {
    process.env.HERDR_ENV = "1";
    process.env.HERDR_PANE_ID = "parent-pane";
    const parent = createPersistedParent();
    process.env.PI_INTERCOM_SESSION_ID = parent.getSessionId();
    const harness = createHarness(parent);
    await harness.btw("Investigate the approach", harness.ctx);

    // The child inherits its parent's split records; its projection must be
    // the child route only, never an inherited roster.
    const record = harness.records()[0]!;
    const child = SessionManager.open(childFileFor(record), sessionDir);
    const identity = (record.data as { intercom: Record<string, unknown> })
      .intercom;

    const guidance = harness.beforeAgentStart(
      { systemPrompt: "base" },
      harness.contextFor(child),
    )?.systemPrompt;
    expect(guidance).toContain("Main-session contact (Intercom)");
    expect(guidance).toContain(identity.childName as string);
    expect(guidance).toContain(identity.parentTarget as string);
    expect(guidance).not.toContain("Live side splits");
  });

  test("multiple simultaneous splits receive unique names and exact targets", async () => {
    process.env.HERDR_ENV = "1";
    process.env.HERDR_PANE_ID = "parent-pane";
    const parent = createPersistedParent();
    process.env.PI_INTERCOM_SESSION_ID = parent.getSessionId();
    const harness = createHarness(parent);

    await harness.btw("First split", harness.ctx);
    await harness.btw("Second split", harness.ctx);

    const identities = harness
      .records()
      .map(
        (record) =>
          (record.data as { intercom: Record<string, unknown> }).intercom,
      );
    expect(identities).toHaveLength(2);
    expect(identities[0]!.childName).not.toBe(identities[1]!.childName);
    expect(identities[0]!.childTarget).not.toBe(identities[1]!.childTarget);
    const children = harness
      .records()
      .map((record) => SessionManager.open(childFileFor(record), sessionDir));
    expect(identities[0]!.childTarget).toBe(children[0]!.getSessionId());
    expect(identities[1]!.childTarget).toBe(children[1]!.getSessionId());
  });

  test("old split records without Intercom fields still launch and merge cleanly", async () => {
    process.env.HERDR_ENV = "1";
    process.env.HERDR_PANE_ID = "parent-pane";
    const parent = createPersistedParent();
    const harness = createHarness(parent);
    // No Intercom env at all: legacy behavior including merge dispatch.
    await harness.btw("Legacy approach", harness.ctx);
    expect(harness.records()[0]!.data).not.toHaveProperty("intercom");

    // Merge still records the intent and finalizes on agent_settled.
    const childFile = childFileFor(harness.records()[0]!);
    const child = SessionManager.open(childFile, sessionDir);
    const childCtx = harness.contextFor(child);
    await harness.btw("merge", childCtx);
    // The child answers the handoff prompt; only then does agent_settled
    // finalize the durable merge request.
    // finalize the durable merge request.
    child.appendMessage(assistantMessage("Here is the clean handoff."));
    await harness.agentSettled(childCtx);
    const mergeRequest = child
      .getBranch()
      .find(
        (entry): entry is CustomEntry =>
          entry.type === "custom" && entry.customType === "split-merge-request",
      );
    expect(mergeRequest).toBeDefined();
    expect(existsSync(childFile)).toBe(true);
  });
});
