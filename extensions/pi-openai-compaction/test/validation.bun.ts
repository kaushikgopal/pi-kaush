// @ts-nocheck
import { afterEach, expect, mock, test } from "bun:test";
import {
  DEFAULT_EXTENSION_SETTINGS,
  NATIVE_COMPACTION_DISPLAY_MESSAGE_TYPE,
  NATIVE_COMPACTION_DISPLAY_TEXT,
  NATIVE_COMPACTION_SHIM_SUMMARY,
  createNativeCompactionDetails,
  type ExtensionSettings,
} from "../src/types";
import {
  PORTABLE_SUMMARY_ENTRY_TYPE,
  PORTABLE_SUMMARY_MESSAGE_TYPE,
  projectPortableSummary,
} from "../src/portable-summary";

type AssistantPhase = "commentary" | "final_answer";

type ToolCallBlock = {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

type TextBlock = {
  type: "text";
  text: string;
  textSignature?: string;
};

type TestModel = {
  provider: string;
  api: string;
  id: string;
  baseUrl: string;
  input: string[];
  reasoning: boolean;
};

type TestSessionEntry = {
  type: "message" | "compaction" | "custom_message";
  id: string;
  timestamp: string;
  message?: Record<string, unknown>;
  customType?: string;
  content?: string;
  display?: boolean;
  summary?: string;
  firstKeptEntryId?: string;
  tokensBefore?: number;
  details?: unknown;
};

type HookHandler = (event: unknown, ctx: unknown) => Promise<unknown>;

type CompactClientResult =
  | {
      ok: true;
      status: number;
      compactedWindow: unknown[];
      compactResponseId?: string;
      createdAt?: string;
      response: {
        id?: string;
        created_at?: number | string;
        output: unknown[];
      };
    }
  | {
      ok: false;
      reason: "network-error" | "non-2xx" | "aborted";
      status?: number;
      errorMessage?: string;
    };

type HookHarnessOptions = {
  compactResult?: CompactClientResult;
  settings?: Partial<ExtensionSettings>;
};

const defaultModel: TestModel = {
  provider: "openai",
  api: "openai-responses",
  id: "gpt-5-mini",
  baseUrl: "https://api.openai.com/v1",
  input: ["text"],
  reasoning: true,
};

const COMPACTION_SUMMARY_PREFIX = `The conversation history before this point was compacted into the following summary:\n\n<summary>\n`;
const COMPACTION_SUMMARY_SUFFIX = `\n</summary>`;

let serializerImportCounter = 0;
let timestampCounter = 0;
let activeTestBranchEntries: TestSessionEntry[] | undefined;

function registerPiCodingAgentMock(): void {
  mock.module("@earendil-works/pi-coding-agent", () => ({
    convertToLlm: (messages: Array<Record<string, unknown>>) =>
      messages
        .map((message) => {
          if (message.role === "compactionSummary") {
            return {
              role: "user",
              content: [
                {
                  type: "text",
                  text: `${COMPACTION_SUMMARY_PREFIX}${message.summary ?? ""}${COMPACTION_SUMMARY_SUFFIX}`,
                },
              ],
              timestamp: message.timestamp,
            };
          }

          return message;
        })
        .filter(Boolean),
  }));
}

async function loadSerializerModule() {
  registerPiCodingAgentMock();
  return import(`../src/serializer.ts?validation=${serializerImportCounter++}`);
}

async function serializeResponsesInput(
  model: TestModel,
  messages: Record<string, unknown>[],
): Promise<unknown[]> {
  const { serializeMessagesToResponsesInput } = await loadSerializerModule();
  return serializeMessagesToResponsesInput(model as never, messages as never);
}

async function createInputParitySignature(
  input: readonly unknown[],
): Promise<string[]> {
  const { createResponsesInputParitySignature } = await loadSerializerModule();
  return createResponsesInputParitySignature(input);
}

function nextTimestamp(): string {
  const timestamp = new Date(
    Date.UTC(2026, 2, 20, 12, 0, timestampCounter),
  ).toISOString();
  timestampCounter += 1;
  return timestamp;
}

function createTextBlock(
  text: string,
  phase?: AssistantPhase,
  id = `msg_${timestampCounter}`,
): TextBlock {
  return {
    type: "text",
    text,
    ...(phase
      ? {
          textSignature: JSON.stringify({
            v: 1,
            id,
            phase,
          }),
        }
      : {}),
  };
}

function createToolCallBlock(
  callId: string,
  name: string,
  argumentsObject: Record<string, unknown>,
  itemId = `fc_${callId}`,
): ToolCallBlock {
  return {
    type: "toolCall",
    id: `${callId}|${itemId}`,
    name,
    arguments: argumentsObject,
  };
}

function createUserEntry(id: string, text: string): TestSessionEntry {
  return {
    type: "message",
    id,
    timestamp: nextTimestamp(),
    message: {
      role: "user",
      content: [{ type: "text", text }],
      timestamp: Date.now(),
    },
  };
}

function createAssistantEntry(
  id: string,
  blocks: Array<TextBlock | ToolCallBlock>,
  model: TestModel = defaultModel,
  stopReason: string = "stop",
): TestSessionEntry {
  return {
    type: "message",
    id,
    timestamp: nextTimestamp(),
    message: {
      role: "assistant",
      provider: model.provider,
      api: model.api,
      model: model.id,
      stopReason,
      content: blocks,
      timestamp: Date.now(),
    },
  };
}

function createToolResultEntry(
  id: string,
  toolCallId: string,
  toolName: string,
  text: string,
): TestSessionEntry {
  return {
    type: "message",
    id,
    timestamp: nextTimestamp(),
    message: {
      role: "toolResult",
      toolCallId,
      toolName,
      isError: false,
      content: [{ type: "text", text }],
      timestamp: Date.now(),
    },
  };
}

function createCompactionEntry(args: {
  id: string;
  firstKeptEntryId: string;
  tokensBefore?: number;
  model?: TestModel;
  compactedWindow: unknown[];
  compactResponseId?: string;
}): TestSessionEntry {
  const model = args.model ?? defaultModel;
  return {
    type: "compaction",
    id: args.id,
    timestamp: nextTimestamp(),
    summary: NATIVE_COMPACTION_SHIM_SUMMARY,
    firstKeptEntryId: args.firstKeptEntryId,
    tokensBefore: args.tokensBefore ?? 256,
    details: createNativeCompactionDetails({
      provider: model.provider,
      api: model.api,
      model: model.id,
      baseUrl: model.baseUrl,
      compactedWindow: args.compactedWindow,
      compactResponseId: args.compactResponseId,
      createdAt: nextTimestamp(),
    }),
  };
}

function createCompactionSummaryMessage(
  entry: TestSessionEntry,
): Record<string, unknown> {
  return {
    role: "compactionSummary",
    summary: entry.summary,
    tokensBefore: entry.tokensBefore,
    timestamp: new Date(entry.timestamp).getTime(),
  };
}

function toReplayMessage(entry: TestSessionEntry): Record<string, unknown> {
  if (entry.type !== "message" || !entry.message) {
    throw new Error(`Expected message entry, got ${entry.type}`);
  }
  return entry.message;
}

async function buildPiReplayPayload(args: {
  model?: TestModel;
  branchEntries: TestSessionEntry[];
  compactionEntry: TestSessionEntry;
  instructions: string;
  freshPreamble: string;
  trailingPreamble?: string[];
}): Promise<{
  model: string;
  instructions: string;
  input: unknown[];
}> {
  const model = args.model ?? defaultModel;
  const boundaryIndex = args.branchEntries.findIndex(
    (entry) => entry.id === args.compactionEntry.id,
  );
  if (boundaryIndex < 0) {
    throw new Error(`Missing compaction entry ${args.compactionEntry.id}`);
  }

  const firstKeptEntryIndex = args.branchEntries.findIndex(
    (entry, index) =>
      index < boundaryIndex &&
      entry.id === args.compactionEntry.firstKeptEntryId,
  );
  if (firstKeptEntryIndex < 0) {
    throw new Error(
      `Missing first-kept entry ${args.compactionEntry.firstKeptEntryId}`,
    );
  }

  const preCompactionEntries = args.branchEntries.slice(
    firstKeptEntryIndex,
    boundaryIndex,
  );
  const postCompactionEntries = args.branchEntries.slice(boundaryIndex + 1);
  const piReplayMessages = [
    createCompactionSummaryMessage(args.compactionEntry),
    ...preCompactionEntries.map(toReplayMessage),
    ...postCompactionEntries.map(toReplayMessage),
  ];

  return {
    model: model.id,
    instructions: args.instructions,
    input: [
      {
        role: model.reasoning ? "developer" : "system",
        content: args.freshPreamble,
      },
      ...(await serializeResponsesInput(model, piReplayMessages)),
      ...(args.trailingPreamble ?? []).map((text) => ({
        role: "developer",
        content: [{ type: "input_text", text }],
      })),
    ],
  };
}

function createContext(
  args: {
    branchEntries?: TestSessionEntry[];
    hasUI?: boolean;
    model?: TestModel;
    notifications?: Array<{ message: string; level: string }>;
    systemPrompt?: string;
    sessionContextMessages?: Record<string, unknown>[];
  } = {},
) {
  const branchEntries = args.branchEntries ?? [];
  activeTestBranchEntries = branchEntries;
  const model = args.model ?? defaultModel;
  const sessionContextMessages =
    args.sessionContextMessages ??
    branchEntries
      .filter((entry) => entry.type === "message")
      .map(toReplayMessage);
  return {
    cwd: "/tmp/openai-native-compaction-validation",
    hasUI: args.hasUI ?? false,
    ui: {
      notify: (message: string, level: string) => {
        args.notifications?.push({ message, level });
      },
    },
    getSystemPrompt: () => args.systemPrompt ?? "Current instructions v1",
    isIdle: () => true,
    waitForIdle: async () => {},
    model,
    modelRegistry: {
      find: (provider: string, modelId: string) =>
        provider === defaultModel.provider && modelId === defaultModel.id
          ? defaultModel
          : undefined,
      getApiKeyAndHeaders: async () => ({
        ok: true,
        apiKey: "sk-test-native-compaction",
      }),
    },
    sessionManager: {
      getBranch: () => branchEntries,
      getEntries: () => sessionContextMessages,
      getLeafId: () => branchEntries.at(-1)?.id ?? null,
      buildSessionContext: () => ({
        messages: sessionContextMessages,
        thinkingLevel: "off",
        model: null,
      }),
      getSessionId: () => "session-validation",
      getSessionFile: () =>
        "/tmp/openai-native-compaction-validation/session.json",
      getSessionDir: () => "/tmp/openai-native-compaction-validation",
    },
  };
}

async function loadHookHarness(options: HookHarnessOptions = {}): Promise<{
  sessionBeforeCompact: HookHandler;
  beforeProviderRequest: HookHandler;
  sessionStart?: HookHandler;
  sessionTree?: HookHandler;
  sessionCompact?: HookHandler;
  context?: HookHandler;
  modelSelect?: HookHandler;
  detach?: HookHandler;
  compactCalls: Array<Record<string, unknown>>;
  sentMessages: Array<{ message: unknown; options: unknown }>;
  appendedEntries: Array<{ customType: string; data: unknown }>;
  selectedModels: unknown[];
}> {
  const compactCalls: Array<Record<string, unknown>> = [];
  const sentMessages: Array<{ message: unknown; options: unknown }> = [];
  const appendedEntries: Array<{ customType: string; data: unknown }> = [];
  const selectedModels: unknown[] = [];
  const commands = new Map<string, HookHandler>();

  registerPiCodingAgentMock();

  mock.module("../src/settings", () => ({
    loadExtensionSettings: () => ({
      settings: {
        ...DEFAULT_EXTENSION_SETTINGS,
        ...(options.settings ?? {}),
      },
      sources: [],
      warnings: [],
    }),
  }));

  mock.module("../src/compact-client", () => ({
    executeNativeCompaction: async (args: Record<string, unknown>) => {
      compactCalls.push(args);
      return (
        options.compactResult ?? {
          ok: true,
          status: 200,
          compactedWindow: [
            {
              type: "message",
              role: "assistant",
              status: "completed",
              id: "cmp_default",
              content: [],
            },
          ],
          compactResponseId: "resp_default",
          createdAt: nextTimestamp(),
          response: {
            id: "resp_default",
            created_at: nextTimestamp(),
            output: [
              {
                type: "message",
                role: "assistant",
                status: "completed",
                id: "cmp_default",
                content: [],
              },
            ],
          },
        }
      );
    },
  }));

  const handlers = new Map<string, HookHandler>();
  const { default: extension } = await import(
    `../src/extension-runtime.ts?test=${crypto.randomUUID()}`
  );
  extension({
    on: (eventName: string, handler: HookHandler) => {
      handlers.set(eventName, handler);
    },
    registerCommand: (name: string, command: { handler: HookHandler }) => {
      commands.set(name, command.handler);
    },
    sendMessage: (message: unknown, options: unknown) => {
      sentMessages.push({ message, options });
      const portable = message as {
        customType?: string;
        content?: string;
        display?: boolean;
        details?: unknown;
      };
      activeTestBranchEntries?.push({
        type: "custom_message",
        id: `sent_${activeTestBranchEntries.length}`,
        timestamp: nextTimestamp(),
        customType: portable.customType,
        content: portable.content,
        display: portable.display,
        details: portable.details,
      });
    },
    appendEntry: (customType: string, data: unknown) => {
      appendedEntries.push({ customType, data });
    },
    setModel: async (model: unknown) => {
      selectedModels.push(model);
      return true;
    },
  } as never);

  const sessionBeforeCompact = handlers.get("session_before_compact");
  const beforeProviderRequest = handlers.get("before_provider_request");
  if (!sessionBeforeCompact || !beforeProviderRequest) {
    throw new Error("Expected openai-native-compaction hooks to register");
  }

  return {
    sessionBeforeCompact,
    beforeProviderRequest,
    sessionStart: handlers.get("session_start"),
    sessionTree: handlers.get("session_tree"),
    sessionCompact: handlers.get("session_compact"),
    context: handlers.get("context"),
    modelSelect: handlers.get("model_select"),
    detach: commands.get("native-compaction-detach"),
    compactCalls,
    sentMessages,
    appendedEntries,
    selectedModels,
  };
}

afterEach(() => {
  serializerImportCounter = 0;
  timestampCounter = 0;
  activeTestBranchEntries = undefined;
  mock.restore();
});

test("manual /compact preserves tool/result ordering + assistant phases and persists the native shim", async () => {
  const compactedWindow = [
    {
      type: "message",
      role: "assistant",
      status: "completed",
      id: "cmp_1",
      phase: "commentary",
      content: [],
    },
  ];
  const { sessionBeforeCompact, compactCalls } = await loadHookHarness({
    compactResult: {
      ok: true,
      status: 200,
      compactedWindow,
      compactResponseId: "resp_manual",
      createdAt: nextTimestamp(),
      response: {
        id: "resp_manual",
        created_at: nextTimestamp(),
        output: compactedWindow,
      },
    },
  });
  const model = { ...defaultModel };
  const toolCall = createToolCallBlock(
    "call_docs",
    "search_docs",
    { query: "weekly release status" },
    "fc_docs",
  );
  const user = createUserEntry(
    "entry_user",
    "Check the weekly release status.",
  );
  const assistantCommentary = createAssistantEntry(
    "entry_assistant_commentary",
    [
      createTextBlock(
        "Checking the docs first.",
        "commentary",
        "msg_commentary",
      ),
      toolCall,
    ],
    model,
    "toolUse",
  );
  const toolResult = createToolResultEntry(
    "entry_tool_result",
    toolCall.id,
    toolCall.name,
    "Release notes say green.",
  );
  const assistantFinal = createAssistantEntry(
    "entry_assistant_final",
    [createTextBlock("The release is green.", "final_answer", "msg_final")],
    model,
    "stop",
  );
  const event = {
    signal: new AbortController().signal,
    customInstructions: undefined,
    reason: "manual",
    willRetry: false,
    preparation: {
      tokensBefore: 512,
      firstKeptEntryId: user.id,
      previousSummary: undefined,
      messagesToSummarize: [
        toReplayMessage(user),
        toReplayMessage(assistantCommentary),
        toReplayMessage(toolResult),
        toReplayMessage(assistantFinal),
      ],
      turnPrefixMessages: [],
    },
  };
  const result = (await sessionBeforeCompact(
    event,
    createContext({
      model,
      systemPrompt: "Current instructions v1",
      sessionContextMessages: event.preparation.messagesToSummarize as Record<
        string,
        unknown
      >[],
    }),
  )) as {
    compaction: Record<string, unknown>;
  };

  expect(compactCalls).toHaveLength(1);
  const compactRequest = compactCalls[0]?.request as {
    model: string;
    instructions: string;
    input: unknown[];
  };
  expect(compactRequest.model).toBe(model.id);
  expect(compactRequest.instructions).toBe("Current instructions v1");
  expect(await createInputParitySignature(compactRequest.input)).toEqual([
    "input:user[1]",
    "message:assistant:commentary",
    "function_call:search_docs",
    "function_call_output",
    "message:assistant:final_answer",
  ]);
  expect(result.compaction.summary).toBe(NATIVE_COMPACTION_SHIM_SUMMARY);
  expect(result.compaction.firstKeptEntryId).toBe(user.id);
  expect(result.compaction.tokensBefore).toBe(512);
  const details = result.compaction.details as {
    compactedWindow: unknown[];
    requestMeta?: Record<string, unknown>;
  };
  expect(details.compactedWindow).toEqual(compactedWindow);
  expect(details.requestMeta).toEqual({
    reason: "manual",
    willRetry: false,
    tokensBefore: 512,
    previousSummaryPresent: false,
  });
});

test("overflow retry native compaction omits the failed terminal assistant leaf", async () => {
  const { sessionBeforeCompact, compactCalls } = await loadHookHarness();
  const user = createUserEntry(
    "overflow_user",
    "Please continue the large task.",
  );
  const failedAssistant = createAssistantEntry(
    "overflow_assistant",
    [
      createTextBlock(
        "model_context_window_exceeded: input was too large",
        "final_answer",
      ),
    ],
    defaultModel,
    "error",
  );
  const sessionContextMessages = [
    toReplayMessage(user),
    toReplayMessage(failedAssistant),
  ];

  const result = (await sessionBeforeCompact(
    {
      type: "session_before_compact",
      branchEntries: [user, failedAssistant],
      signal: new AbortController().signal,
      customInstructions: undefined,
      reason: "overflow",
      willRetry: true,
      preparation: {
        tokensBefore: 1024,
        firstKeptEntryId: user.id,
        previousSummary: undefined,
        messagesToSummarize: sessionContextMessages,
        turnPrefixMessages: [],
      },
    },
    createContext({
      branchEntries: [user, failedAssistant],
      sessionContextMessages,
    }),
  )) as {
    compaction?: { details?: { requestMeta?: Record<string, unknown> } };
  };

  expect(compactCalls).toHaveLength(1);
  const compactRequest = compactCalls[0]?.request as {
    instructions: string;
    input: unknown[];
  };
  const compactInput = JSON.stringify(compactRequest.input);
  expect(compactInput).toContain("Please continue the large task.");
  expect(compactInput).not.toContain("model_context_window_exceeded");
  expect(compactRequest.instructions).toContain(
    "Pi will retry the aborted turn after compaction",
  );
  expect(result.compaction?.details?.requestMeta).toEqual({
    reason: "overflow",
    willRetry: true,
    tokensBefore: 1024,
    previousSummaryPresent: false,
  });
});

test("overflow compaction without retry preserves completed assistant output", async () => {
  const { sessionBeforeCompact, compactCalls } = await loadHookHarness();
  const user = createUserEntry(
    "overflow_completed_user",
    "Summarize the completed answer.",
  );
  const completedAssistant = createAssistantEntry(
    "overflow_completed_assistant",
    [
      createTextBlock(
        "Completed assistant answer that should remain available.",
        "final_answer",
      ),
    ],
  );
  const sessionContextMessages = [
    toReplayMessage(user),
    toReplayMessage(completedAssistant),
  ];

  await sessionBeforeCompact(
    {
      type: "session_before_compact",
      branchEntries: [user, completedAssistant],
      signal: new AbortController().signal,
      customInstructions: undefined,
      reason: "overflow",
      willRetry: false,
      preparation: {
        tokensBefore: 2048,
        firstKeptEntryId: user.id,
        previousSummary: undefined,
        messagesToSummarize: sessionContextMessages,
        turnPrefixMessages: [],
      },
    },
    createContext({
      branchEntries: [user, completedAssistant],
      sessionContextMessages,
    }),
  );

  const compactRequest = compactCalls[0]?.request as {
    instructions: string;
    input: unknown[];
  };
  const compactInput = JSON.stringify(compactRequest.input);
  expect(compactInput).toContain(
    "Completed assistant answer that should remain available.",
  );
  expect(compactRequest.instructions).toContain("completed assistant response");
});

test("manual /compact sends only standalone compact fields", async () => {
  const { sessionBeforeCompact, compactCalls } = await loadHookHarness();
  const model = { ...defaultModel };
  const user = createUserEntry("compact_user", "Current compact input.");

  await sessionBeforeCompact(
    {
      signal: new AbortController().signal,
      customInstructions: undefined,
      preparation: {
        tokensBefore: 512,
        firstKeptEntryId: user.id,
        previousSummary: undefined,
        messagesToSummarize: [toReplayMessage(user)],
        turnPrefixMessages: [],
      },
    },
    createContext({
      model,
      systemPrompt: "Current instructions",
      sessionContextMessages: [toReplayMessage(user)],
    }),
  );

  const compactRequest = compactCalls[0]?.request as Record<string, unknown>;
  expect(Object.keys(compactRequest).sort()).toEqual([
    "input",
    "instructions",
    "model",
  ]);
  expect(compactRequest.model).toBe(model.id);
  expect(compactRequest.instructions).toBe("Current instructions");
  expect(JSON.stringify(compactRequest.input)).toContain(
    "Current compact input.",
  );
});

test("first native compaction sends the full current session context, including Pi's kept recent window", async () => {
  const { sessionBeforeCompact, compactCalls } = await loadHookHarness();
  const model = { ...defaultModel };
  const summarizedUser = createUserEntry(
    "summarized_user",
    "Older context slated for summarization.",
  );
  const keptUser = createUserEntry(
    "kept_recent_user",
    "Recent kept window context that must also be compacted.",
  );
  const event = {
    signal: new AbortController().signal,
    customInstructions: undefined,
    preparation: {
      tokensBefore: 384,
      firstKeptEntryId: keptUser.id,
      previousSummary: undefined,
      messagesToSummarize: [toReplayMessage(summarizedUser)],
      turnPrefixMessages: [],
    },
  };

  await sessionBeforeCompact(
    event,
    createContext({
      model,
      systemPrompt: "Current instructions include the kept window too",
      sessionContextMessages: [
        toReplayMessage(summarizedUser),
        toReplayMessage(keptUser),
      ],
    }),
  );

  const compactRequest = compactCalls[0]?.request as {
    model: string;
    instructions: string;
    input: unknown[];
  };
  expect(compactRequest.model).toBe(model.id);
  expect(compactRequest.instructions).toBe(
    "Current instructions include the kept window too",
  );
  expect(await createInputParitySignature(compactRequest.input)).toEqual([
    "input:user[1]",
    "input:user[1]",
  ]);
  expect(JSON.stringify(compactRequest.input)).toContain(
    "Recent kept window context that must also be compacted.",
  );
});

test("repeated native compaction preserves the canonical stored window", async () => {
  const { sessionBeforeCompact, compactCalls } = await loadHookHarness();
  const model = { ...defaultModel };
  const oldKeptUser = createUserEntry(
    "old_normalize_user",
    "Original context before native compaction.",
  );
  const staleDeveloper = {
    type: "message",
    role: "developer",
    status: "completed",
    id: "cmp_stale_developer",
    content: [
      {
        type: "output_text",
        text: "Stale developer instructions must be dropped.",
        annotations: [],
      },
    ],
  };
  const staleSystem = {
    type: "message",
    role: "system",
    status: "completed",
    id: "cmp_stale_system",
    content: [
      {
        type: "output_text",
        text: "Stale system instructions must be dropped.",
        annotations: [],
      },
    ],
  };
  const keptCompaction = {
    type: "compaction",
    encrypted_content: "opaque-compaction-item-survives",
  };
  const keptAssistant = {
    type: "message",
    role: "assistant",
    status: "completed",
    id: "cmp_kept_assistant",
    content: [
      {
        type: "output_text",
        text: "Assistant compacted output survives.",
        annotations: [],
      },
    ],
  };
  const priorCompaction = createCompactionEntry({
    id: "compaction_normalize_repeat",
    firstKeptEntryId: oldKeptUser.id,
    model,
    compactedWindow: [
      staleDeveloper,
      staleSystem,
      keptCompaction,
      keptAssistant,
    ],
  });
  const tailUser = createUserEntry(
    "normalize_tail_user",
    "New follow-up after normalized compaction.",
  );
  const event = {
    signal: new AbortController().signal,
    customInstructions: undefined,
    preparation: {
      tokensBefore: 640,
      firstKeptEntryId: tailUser.id,
      previousSummary: NATIVE_COMPACTION_SHIM_SUMMARY,
      messagesToSummarize: [],
      turnPrefixMessages: [],
    },
  };

  await sessionBeforeCompact(
    event,
    createContext({
      branchEntries: [oldKeptUser, priorCompaction, tailUser],
      model,
      systemPrompt: "Current instructions after normalized repeat compact",
      sessionContextMessages: [
        createCompactionSummaryMessage(priorCompaction),
        toReplayMessage(oldKeptUser),
        toReplayMessage(tailUser),
      ],
    }),
  );

  const compactRequest = compactCalls[0]?.request as { input: unknown[] };
  expect(compactRequest.input).toEqual([
    staleDeveloper,
    staleSystem,
    keptCompaction,
    keptAssistant,
    ...(await serializeResponsesInput(model, [toReplayMessage(tailUser)])),
  ]);
  expect(JSON.stringify(compactRequest.input)).toContain(
    "Stale developer instructions must be dropped.",
  );
  expect(JSON.stringify(compactRequest.input)).toContain(
    "Stale system instructions must be dropped.",
  );
});

test("repeated native compaction reuses the latest stored compacted window instead of Pi's shim summary", async () => {
  const { sessionBeforeCompact, compactCalls } = await loadHookHarness();
  const model = { ...defaultModel };
  const oldKeptUser = createUserEntry(
    "old_kept_user",
    "Original context before native compaction.",
  );
  const compactedWindow = [
    {
      type: "message",
      role: "assistant",
      status: "completed",
      id: "cmp_repeat",
      phase: "commentary",
      content: [
        {
          type: "output_text",
          text: "Opaque compacted window",
          annotations: [],
        },
      ],
    },
  ];
  const priorCompaction = createCompactionEntry({
    id: "compaction_repeat",
    firstKeptEntryId: oldKeptUser.id,
    model,
    compactedWindow,
    compactResponseId: "resp_repeat",
  });
  const tailUser = createUserEntry(
    "repeat_tail_user",
    "New follow-up after the earlier native compaction.",
  );
  const tailAssistant = createAssistantEntry(
    "repeat_tail_assistant",
    [
      createTextBlock(
        "Follow-up answer after the earlier native compaction.",
        "final_answer",
        "msg_repeat_tail",
      ),
    ],
    model,
    "stop",
  );
  const event = {
    signal: new AbortController().signal,
    customInstructions: undefined,
    preparation: {
      tokensBefore: 640,
      firstKeptEntryId: tailUser.id,
      previousSummary: NATIVE_COMPACTION_SHIM_SUMMARY,
      messagesToSummarize: [],
      turnPrefixMessages: [],
    },
  };

  await sessionBeforeCompact(
    event,
    createContext({
      branchEntries: [oldKeptUser, priorCompaction, tailUser, tailAssistant],
      model,
      systemPrompt: "Current instructions v-repeat",
      sessionContextMessages: [
        createCompactionSummaryMessage(priorCompaction),
        toReplayMessage(oldKeptUser),
        toReplayMessage(tailUser),
        toReplayMessage(tailAssistant),
      ],
    }),
  );

  const compactRequest = compactCalls[0]?.request as {
    model: string;
    instructions: string;
    input: unknown[];
  };
  const expectedTail = await serializeResponsesInput(model, [
    toReplayMessage(tailUser),
    toReplayMessage(tailAssistant),
  ]);
  expect(compactRequest.instructions).toBe("Current instructions v-repeat");
  expect(compactRequest.input).toEqual([...compactedWindow, ...expectedTail]);
  expect(JSON.stringify(compactRequest.input)).toContain(
    "Opaque compacted window",
  );
  expect(JSON.stringify(compactRequest.input)).not.toContain(
    "The conversation history before this point was compacted",
  );
  expect(JSON.stringify(compactRequest.input)).not.toContain(
    "Original context before native compaction.",
  );
});

test("session_before_compact converts a latest non-native compaction using filtered session context", async () => {
  const { sessionBeforeCompact, compactCalls } = await loadHookHarness();
  const model = { ...defaultModel };
  const olderUser = createUserEntry(
    "older_non_native_user",
    "Context from before a non-native compaction.",
  );
  const nonNativeCompaction: TestSessionEntry = {
    type: "compaction",
    id: "non_native_compaction",
    timestamp: nextTimestamp(),
    summary: "Legacy Pi summary",
    firstKeptEntryId: olderUser.id,
    tokensBefore: 512,
  };
  const currentUser = createUserEntry(
    "current_after_non_native",
    "Current context after a non-native compaction.",
  );
  const goalContinuation = {
    role: "custom",
    customType: "goal-continuation",
    content:
      "This repeated hidden goal prompt must not enter native compaction.",
    display: false,
    timestamp: Date.now(),
  };
  const event = {
    signal: new AbortController().signal,
    customInstructions: undefined,
    preparation: {
      tokensBefore: 768,
      firstKeptEntryId: currentUser.id,
      previousSummary: "Legacy Pi summary",
      messagesToSummarize: [],
      turnPrefixMessages: [],
    },
  };

  const result = await sessionBeforeCompact(
    event,
    createContext({
      branchEntries: [olderUser, nonNativeCompaction, currentUser],
      model,
      systemPrompt: "Current instructions after a non-native compaction",
      sessionContextMessages: [
        createCompactionSummaryMessage(nonNativeCompaction),
        toReplayMessage(olderUser),
        goalContinuation,
        toReplayMessage(currentUser),
      ],
    }),
  );

  expect(result).toEqual({
    compaction: expect.objectContaining({ firstKeptEntryId: currentUser.id }),
  });
  expect(compactCalls).toHaveLength(1);
  const compactRequest = compactCalls[0]?.request as {
    instructions: string;
    input: unknown[];
  };
  expect(compactRequest.instructions).toBe(
    "Current instructions after a non-native compaction",
  );
  expect(JSON.stringify(compactRequest.input)).toContain("Legacy Pi summary");
  expect(JSON.stringify(compactRequest.input)).toContain(
    "Current context after a non-native compaction.",
  );
  expect(JSON.stringify(compactRequest.input)).not.toContain(
    "repeated hidden goal prompt",
  );
});

test("first post-compaction turn rewrites to fresh preamble + opaque compacted window + live tail without duplication", async () => {
  const { beforeProviderRequest } = await loadHookHarness();
  const model = { ...defaultModel };
  const keptUser = createUserEntry(
    "kept_user",
    "Old user context that Pi should stop duplicating.",
  );
  const keptAssistant = createAssistantEntry(
    "kept_assistant",
    [
      createTextBlock(
        "Old assistant context that should disappear after native replay.",
        "commentary",
        "msg_kept",
      ),
    ],
    model,
  );
  const compactedWindow = [
    {
      type: "message",
      role: "assistant",
      status: "completed",
      id: "cmp_commentary",
      phase: "commentary",
      content: [],
    },
    {
      type: "function_call",
      id: "fc_weather",
      call_id: "call_weather",
      name: "weather_lookup",
      arguments: '{"city":"Berlin"}',
    },
    {
      type: "function_call_output",
      call_id: "call_weather",
      output: "18°C and sunny",
    },
  ];
  const compactionEntry = createCompactionEntry({
    id: "compaction_1",
    firstKeptEntryId: keptUser.id,
    model,
    compactedWindow,
    compactResponseId: "resp_first_turn",
  });
  const currentUser = createUserEntry(
    "post_compaction_user",
    "Now summarize only the deploy risk.",
  );
  const branchEntries = [keptUser, keptAssistant, compactionEntry, currentUser];
  const payload = await buildPiReplayPayload({
    model,
    branchEntries,
    compactionEntry,
    instructions: "Current instructions v2",
    freshPreamble: "Fresh preamble v2",
  });
  const rewritten = (await beforeProviderRequest(
    { payload },
    createContext({ branchEntries, model, systemPrompt: payload.instructions }),
  )) as { input: unknown[]; instructions: string };
  const expectedTail = await serializeResponsesInput(model, [
    toReplayMessage(currentUser),
  ]);
  const expectedInput = [payload.input[0], ...compactedWindow, ...expectedTail];

  expect(rewritten.instructions).toBe("Current instructions v2");
  expect(rewritten.input).toEqual(expectedInput);
  expect(JSON.stringify(rewritten.input)).not.toContain(
    "Old user context that Pi should stop duplicating.",
  );
  expect(JSON.stringify(rewritten.input)).not.toContain(
    "Old assistant context that should disappear after native replay.",
  );
  expect(JSON.stringify(rewritten.input)).not.toContain(
    "The conversation history before this point was compacted",
  );
});

test("first post-compaction provider request rewrites pending live user input not yet persisted", async () => {
  const { beforeProviderRequest } = await loadHookHarness();
  const model = { ...defaultModel };
  const keptUser = createUserEntry(
    "kept_pending_user",
    "Old user context that should be replaced by native replay.",
  );
  const compactedWindow = [
    {
      type: "compaction",
      encrypted_content: "opaque-pending-window",
    },
  ];
  const compactionEntry = createCompactionEntry({
    id: "compaction_pending_live_input",
    firstKeptEntryId: keptUser.id,
    model,
    compactedWindow,
  });
  const pendingUser = createUserEntry(
    "pending_live_user",
    "This live user message is in the provider payload before branch persistence catches up.",
  );
  const persistedBranchEntries = [keptUser, compactionEntry];
  const payload = await buildPiReplayPayload({
    model,
    branchEntries: [...persistedBranchEntries, pendingUser],
    compactionEntry,
    instructions: "Current instructions with pending live input",
    freshPreamble: "Fresh preamble with pending live input",
  });

  const rewritten = (await beforeProviderRequest(
    { payload },
    createContext({
      branchEntries: persistedBranchEntries,
      model,
      systemPrompt: payload.instructions,
    }),
  )) as { input: unknown[]; instructions: string };

  expect(rewritten.instructions).toBe(
    "Current instructions with pending live input",
  );
  expect(rewritten.input).toEqual([
    payload.input[0],
    ...compactedWindow,
    ...(await serializeResponsesInput(model, [toReplayMessage(pendingUser)])),
  ]);
  expect(JSON.stringify(rewritten.input)).toContain(
    "This live user message is in the provider payload",
  );
  expect(JSON.stringify(rewritten.input)).not.toContain(
    "Old user context that should be replaced by native replay.",
  );
  expect(JSON.stringify(rewritten.input)).not.toContain(
    "The conversation history before this point was compacted",
  );
});

test("post-compaction provider replay preserves the canonical native output", async () => {
  const { beforeProviderRequest } = await loadHookHarness();
  const model = { ...defaultModel };
  const keptUser = createUserEntry(
    "kept_normalized_replay_user",
    "Old user context that should disappear.",
  );
  const staleDeveloper = {
    type: "message",
    role: "developer",
    status: "completed",
    id: "cmp_replay_stale_developer",
    content: [
      {
        type: "output_text",
        text: "Stale developer replay output must be dropped.",
        annotations: [],
      },
    ],
  };
  const staleSystem = {
    type: "message",
    role: "system",
    status: "completed",
    id: "cmp_replay_stale_system",
    content: [
      {
        type: "output_text",
        text: "Stale system replay output must be dropped.",
        annotations: [],
      },
    ],
  };
  const keptAssistant = {
    type: "message",
    role: "assistant",
    status: "completed",
    id: "cmp_replay_kept_assistant",
    content: [
      {
        type: "output_text",
        text: "Normalized assistant replay survives.",
        annotations: [],
      },
    ],
  };
  const compactionEntry = createCompactionEntry({
    id: "compaction_normalized_replay",
    firstKeptEntryId: keptUser.id,
    model,
    compactedWindow: [staleDeveloper, staleSystem, keptAssistant],
  });
  const currentUser = createUserEntry(
    "current_normalized_replay_user",
    "Continue after normalized replay.",
  );
  const branchEntries = [keptUser, compactionEntry, currentUser];
  const payload = await buildPiReplayPayload({
    model,
    branchEntries,
    compactionEntry,
    instructions: "Current instructions after normalized replay",
    freshPreamble: "Fresh preamble after normalized replay",
  });

  const rewritten = (await beforeProviderRequest(
    { payload },
    createContext({ branchEntries, model, systemPrompt: payload.instructions }),
  )) as { input: unknown[]; instructions: string };

  expect(rewritten.input).toEqual([
    payload.input[0],
    staleDeveloper,
    staleSystem,
    keptAssistant,
    ...(await serializeResponsesInput(model, [toReplayMessage(currentUser)])),
  ]);
  expect(JSON.stringify(rewritten.input)).toContain(
    "Normalized assistant replay survives.",
  );
  expect(JSON.stringify(rewritten.input)).toContain(
    "Stale developer replay output must be dropped.",
  );
  expect(JSON.stringify(rewritten.input)).toContain(
    "Stale system replay output must be dropped.",
  );
});

test("native replay accepts payloads that omit the pre-compaction kept window", async () => {
  const { beforeProviderRequest } = await loadHookHarness();
  const model = { ...defaultModel };
  const keptUser = createUserEntry(
    "omitted_kept_user",
    "Old kept context that Pi omitted from replay.",
  );
  const compactedWindow = [
    { type: "compaction", encrypted_content: "opaque-omitted-kept-window" },
  ];
  const compactionEntry = createCompactionEntry({
    id: "compaction_omitted_kept",
    firstKeptEntryId: keptUser.id,
    model,
    compactedWindow,
  });
  const currentUser = createUserEntry(
    "omitted_kept_current",
    "Current tail after omitted kept window.",
  );
  const branchEntries = [keptUser, compactionEntry, currentUser];
  const compactionSummaryInput = await serializeResponsesInput(model, [
    createCompactionSummaryMessage(compactionEntry),
  ]);
  const currentTailInput = await serializeResponsesInput(model, [
    toReplayMessage(currentUser),
  ]);
  const payload = {
    model: model.id,
    instructions: "Instructions for omitted kept replay",
    input: [
      { role: "developer", content: "Fresh preamble for omitted kept replay" },
      ...compactionSummaryInput,
      ...currentTailInput,
    ],
  };

  const rewritten = (await beforeProviderRequest(
    { payload },
    createContext({ branchEntries, model, systemPrompt: payload.instructions }),
  )) as { input: unknown[]; instructions: string };

  expect(rewritten.instructions).toBe("Instructions for omitted kept replay");
  expect(rewritten.input).toEqual([
    payload.input[0],
    ...compactedWindow,
    ...currentTailInput,
  ]);
  expect(JSON.stringify(rewritten.input)).not.toContain(
    "Old kept context that Pi omitted from replay.",
  );
});

test("a newer Pi fallback compaction supersedes an older native checkpoint", async () => {
  const { beforeProviderRequest } = await loadHookHarness();
  const model = { ...defaultModel };
  const keptUser = createUserEntry(
    "fallback_native_kept",
    "Original context before native compaction.",
  );
  const nativeCompaction = createCompactionEntry({
    id: "native_compaction_before_fallback",
    firstKeptEntryId: keptUser.id,
    model,
    compactedWindow: [
      {
        type: "compaction",
        encrypted_content: "opaque-native-before-fallback",
      },
    ],
  });
  const fallbackTail = createUserEntry(
    "fallback_tail",
    "Context between native and Pi fallback.",
  );
  const piFallback: TestSessionEntry = {
    type: "compaction",
    id: "pi_fallback_compaction",
    timestamp: nextTimestamp(),
    summary: "Pi fallback summary",
    firstKeptEntryId: fallbackTail.id,
    tokensBefore: 900,
  };
  const currentUser = createUserEntry(
    "after_pi_fallback",
    "Current context after Pi fallback.",
  );
  const branchEntries = [
    keptUser,
    nativeCompaction,
    fallbackTail,
    piFallback,
    currentUser,
  ];
  const payload = {
    model: model.id,
    instructions: "Instructions after Pi fallback",
    input: [
      { role: "developer", content: "Fresh preamble after Pi fallback" },
      ...(await serializeResponsesInput(model, [
        createCompactionSummaryMessage(piFallback),
        toReplayMessage(currentUser),
      ])),
    ],
  };

  const rewritten = await beforeProviderRequest(
    { payload },
    createContext({ branchEntries, model, systemPrompt: payload.instructions }),
  );

  expect(rewritten).toBeUndefined();
});

test("failed repeated native compact returns a portable Pi compaction", async () => {
  const model = { ...defaultModel };
  const keptUser = createUserEntry(
    "fallback_inject_kept",
    "Original context before previous native compaction.",
  );
  const priorCompaction = createCompactionEntry({
    id: "prior_native_for_fallback_injection",
    firstKeptEntryId: keptUser.id,
    model,
    compactedWindow: [
      {
        type: "compaction",
        encrypted_content: "opaque-window-for-pi-fallback",
      },
    ],
  });
  const tailUser = createUserEntry(
    "fallback_inject_tail",
    "Tail that native compact failed to compact.",
  );
  const { sessionBeforeCompact } = await loadHookHarness({
    compactResult: {
      ok: false,
      reason: "network-error",
      errorMessage: "offline",
    },
  });
  globalThis.fetch = mock(
    async () =>
      new Response(
        JSON.stringify({
          object: "response",
          status: "completed",
          output: [
            {
              type: "message",
              content: [
                { type: "output_text", text: "Portable failure summary." },
              ],
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  ) as unknown as typeof fetch;
  const event = {
    signal: new AbortController().signal,
    customInstructions: undefined,
    preparation: {
      tokensBefore: 1024,
      firstKeptEntryId: tailUser.id,
      previousSummary: NATIVE_COMPACTION_SHIM_SUMMARY,
      messagesToSummarize: [],
      turnPrefixMessages: [],
    },
  };
  const ctx = createContext({
    branchEntries: [keptUser, priorCompaction, tailUser],
    model,
    systemPrompt: "Current instructions for failed native compact",
  });

  const result = (await sessionBeforeCompact(event, ctx)) as {
    compaction?: { summary?: string; details?: unknown };
  };
  expect(result.compaction?.summary).toBe("Portable failure summary.");
  expect(result.compaction?.details).toBeUndefined();
});

test("session_before_compact fails open when native compact output is not structured", async () => {
  const { sessionBeforeCompact, compactCalls } = await loadHookHarness({
    compactResult: {
      ok: true,
      status: 200,
      compactedWindow: ["not structured"],
      compactResponseId: "resp_invalid_output",
      createdAt: nextTimestamp(),
      response: {
        id: "resp_invalid_output",
        created_at: nextTimestamp(),
        output: ["not structured"],
      },
    },
  });
  const model = { ...defaultModel };
  const user = createUserEntry("invalid_output_user", "Compact this context.");
  const event = {
    signal: new AbortController().signal,
    customInstructions: undefined,
    preparation: {
      tokensBefore: 512,
      firstKeptEntryId: user.id,
      previousSummary: undefined,
      messagesToSummarize: [toReplayMessage(user)],
      turnPrefixMessages: [],
    },
  };

  const result = await sessionBeforeCompact(
    event,
    createContext({ model, sessionContextMessages: [toReplayMessage(user)] }),
  );

  expect(compactCalls).toHaveLength(1);
  expect(result).toBeUndefined();
});

test("trailing provider-authored developer prompts survive native replay in place", async () => {
  const { beforeProviderRequest } = await loadHookHarness();
  const model = { ...defaultModel, reasoning: true };
  const keptUser = createUserEntry(
    "kept_for_trailing_prompt",
    "Older replay context that should disappear.",
  );
  const compactedWindow = [
    {
      type: "compaction",
      encrypted_content: "opaque-compact-window",
    },
  ];
  const compactionEntry = createCompactionEntry({
    id: "compaction_with_trailing_prompt",
    firstKeptEntryId: keptUser.id,
    model,
    compactedWindow,
  });
  const currentUser = createUserEntry(
    "trailing_prompt_user",
    "Continue with the trailing developer hint preserved.",
  );
  const branchEntries = [keptUser, compactionEntry, currentUser];
  const payload = await buildPiReplayPayload({
    model,
    branchEntries,
    compactionEntry,
    instructions: "Current instructions with trailing provider hint",
    freshPreamble: "Fresh preamble before replay",
    trailingPreamble: ["# Juice: 0 !important"],
  });
  const rewritten = (await beforeProviderRequest(
    { payload },
    createContext({ branchEntries, model, systemPrompt: payload.instructions }),
  )) as { input: unknown[]; instructions: string };
  const expectedTail = await serializeResponsesInput(model, [
    toReplayMessage(currentUser),
  ]);
  const trailingPrompt = payload.input[payload.input.length - 1];

  expect(rewritten.instructions).toBe(
    "Current instructions with trailing provider hint",
  );
  expect(rewritten.input).toEqual([
    payload.input[0],
    ...compactedWindow,
    ...expectedTail,
    trailingPrompt,
  ]);
  expect(rewritten.input[rewritten.input.length - 1]).toEqual(trailingPrompt);
});

test("multi-turn follow-up survives restart/resume while preserving tool/result pairing and assistant phases", async () => {
  const model = { ...defaultModel };
  const keptUser = createUserEntry(
    "resume_kept_user",
    "Remember the earlier migration context.",
  );
  const compactedWindow = [
    {
      type: "message",
      role: "assistant",
      status: "completed",
      id: "cmp_resume",
      phase: "commentary",
      content: [
        {
          type: "output_text",
          text: "Compacted reasoning survives here.",
          annotations: [],
        },
      ],
    },
  ];
  const compactionEntry = createCompactionEntry({
    id: "resume_compaction",
    firstKeptEntryId: keptUser.id,
    model,
    compactedWindow,
    compactResponseId: "resp_resume",
  });
  const reviewCall = createToolCallBlock(
    "call_review",
    "review_branch",
    { branch: "feature/native-compaction" },
    "fc_review",
  );
  const tailUser = createUserEntry(
    "resume_tail_user",
    "Review the branch and call out risks.",
  );
  const tailAssistantCommentary = createAssistantEntry(
    "resume_tail_assistant_commentary",
    [
      createTextBlock(
        "Reviewing the branch now.",
        "commentary",
        "msg_tail_commentary",
      ),
      reviewCall,
    ],
    model,
    "toolUse",
  );
  const tailToolResult = createToolResultEntry(
    "resume_tail_tool_result",
    reviewCall.id,
    reviewCall.name,
    "Found one medium-severity risk.",
  );
  const tailAssistantFinal = createAssistantEntry(
    "resume_tail_assistant_final",
    [
      createTextBlock(
        "The main risk is stale replay state.",
        "final_answer",
        "msg_tail_final",
      ),
    ],
    model,
  );
  const currentUser = createUserEntry(
    "resume_current_user",
    "Which regression should I test first?",
  );
  const branchEntries = [
    keptUser,
    compactionEntry,
    tailUser,
    tailAssistantCommentary,
    tailToolResult,
    tailAssistantFinal,
    currentUser,
  ];
  const payload = await buildPiReplayPayload({
    model,
    branchEntries,
    compactionEntry,
    instructions: "Current instructions after restart",
    freshPreamble: "Fresh preamble after restart",
  });
  const firstHarness = await loadHookHarness();
  const resumedHarness = await loadHookHarness();
  const firstRewrite = (await firstHarness.beforeProviderRequest(
    { payload },
    createContext({ branchEntries, model, systemPrompt: payload.instructions }),
  )) as { input: unknown[]; instructions: string };
  const resumedRewrite = (await resumedHarness.beforeProviderRequest(
    { payload },
    createContext({ branchEntries, model, systemPrompt: payload.instructions }),
  )) as { input: unknown[]; instructions: string };
  const parity = await createInputParitySignature(firstRewrite.input);

  expect(resumedRewrite).toEqual(firstRewrite);
  expect(firstRewrite.instructions).toBe("Current instructions after restart");
  expect(parity).toEqual([
    "input:developer",
    "message:assistant:commentary",
    "input:user[1]",
    "message:assistant:commentary",
    "function_call:review_branch",
    "function_call_output",
    "message:assistant:final_answer",
    "input:user[1]",
  ]);
});

test("a second compaction replays only the latest compacted window and keeps fresh instructions authoritative", async () => {
  const { beforeProviderRequest } = await loadHookHarness();
  const model = { ...defaultModel };
  const initialKeptUser = createUserEntry(
    "initial_kept_user",
    "Initial context before the first compaction.",
  );
  const firstCompaction = createCompactionEntry({
    id: "compaction_first",
    firstKeptEntryId: initialKeptUser.id,
    model,
    compactedWindow: [
      {
        type: "message",
        role: "assistant",
        status: "completed",
        id: "cmp_first",
        phase: "commentary",
        content: [
          {
            type: "output_text",
            text: "First compaction window",
            annotations: [],
          },
        ],
      },
    ],
  });
  const interimUser = createUserEntry(
    "interim_user",
    "Interim question between compactions.",
  );
  const interimAssistant = createAssistantEntry(
    "interim_assistant",
    [
      createTextBlock(
        "Interim answer between compactions.",
        "final_answer",
        "msg_interim",
      ),
    ],
    model,
  );
  const secondCompactionWindow = [
    {
      type: "message",
      role: "assistant",
      status: "completed",
      id: "cmp_second",
      phase: "commentary",
      content: [
        {
          type: "output_text",
          text: "Second compaction window",
          annotations: [],
        },
      ],
    },
  ];
  const secondCompaction = createCompactionEntry({
    id: "compaction_second",
    firstKeptEntryId: interimUser.id,
    model,
    compactedWindow: secondCompactionWindow,
  });
  const currentUser = createUserEntry(
    "post_second_compaction_user",
    "What changed after the second compaction?",
  );
  const branchEntries = [
    initialKeptUser,
    firstCompaction,
    interimUser,
    interimAssistant,
    secondCompaction,
    currentUser,
  ];
  const payload = await buildPiReplayPayload({
    model,
    branchEntries,
    compactionEntry: secondCompaction,
    instructions: "Newest instructions win",
    freshPreamble: "Newest preamble wins too",
  });
  const rewritten = (await beforeProviderRequest(
    { payload },
    createContext({ branchEntries, model, systemPrompt: payload.instructions }),
  )) as { input: unknown[]; instructions: string };

  expect(rewritten.instructions).toBe("Newest instructions win");
  expect(rewritten.input).toEqual([
    payload.input[0],
    ...secondCompactionWindow,
    ...(await serializeResponsesInput(model, [toReplayMessage(currentUser)])),
  ]);
  expect(JSON.stringify(rewritten.input)).toContain("Second compaction window");
  expect(JSON.stringify(rewritten.input)).not.toContain(
    "First compaction window",
  );
  expect(JSON.stringify(rewritten.input)).not.toContain(
    "Interim question between compactions.",
  );
});

test("native compaction notifies without appending a display marker and filters legacy markers from context", async () => {
  const { sessionCompact, context, sentMessages } = await loadHookHarness();
  if (!sessionCompact || !context)
    throw new Error("Expected session_compact and context hooks");
  const notifications: Array<{ message: string; level: string }> = [];
  const model = { ...defaultModel };
  const user = createUserEntry(
    "display_marker_user",
    "Context before native compaction marker.",
  );
  const compactionEntry = createCompactionEntry({
    id: "display_marker_compaction",
    firstKeptEntryId: user.id,
    model,
    compactedWindow: [
      { type: "compaction", encrypted_content: "opaque-display-marker" },
    ],
  });

  await sessionCompact(
    { fromExtension: true, compactionEntry },
    createContext({ hasUI: true, model, notifications }),
  );

  expect(sentMessages).toEqual([]);
  expect(notifications).toEqual([
    { message: NATIVE_COMPACTION_DISPLAY_TEXT, level: "info" },
  ]);
  const filtered = (await context(
    {
      messages: [
        { role: "user", content: "keep me" },
        {
          role: "custom",
          customType: NATIVE_COMPACTION_DISPLAY_MESSAGE_TYPE,
          content: "hide me",
        },
      ],
    },
    createContext({ model }),
  )) as { messages: unknown[] };
  expect(filtered.messages).toEqual([{ role: "user", content: "keep me" }]);
});

test("headless native compaction does not append a display marker", async () => {
  const { sessionCompact, sentMessages } = await loadHookHarness();
  if (!sessionCompact) throw new Error("Expected session_compact hook");
  const notifications: Array<{ message: string; level: string }> = [];
  const model = { ...defaultModel };
  const user = createUserEntry(
    "headless_display_marker_user",
    "Context before native compaction marker.",
  );
  const compactionEntry = createCompactionEntry({
    id: "headless_display_marker_compaction",
    firstKeptEntryId: user.id,
    model,
    compactedWindow: [
      {
        type: "compaction",
        encrypted_content: "opaque-headless-display-marker",
      },
    ],
  });

  await sessionCompact(
    { fromExtension: true, compactionEntry },
    createContext({ hasUI: false, model, notifications }),
  );

  expect(sentMessages).toEqual([]);
  expect(notifications).toEqual([]);
});

test("unsupported model/provider switching fails open instead of replaying stale native state", async () => {
  const { beforeProviderRequest } = await loadHookHarness();
  const matchingModel = { ...defaultModel };
  const switchedModel = {
    ...defaultModel,
    id: "gpt-5-nano",
  };
  const unsupportedProviderModel = {
    ...defaultModel,
    provider: "anthropic",
    api: "anthropic-messages",
    id: "claude-sonnet-4",
  };
  const keptUser = createUserEntry(
    "switch_kept_user",
    "Original context before switching models.",
  );
  const olderMatchingCompaction = createCompactionEntry({
    id: "switch_compaction_old",
    firstKeptEntryId: keptUser.id,
    model: matchingModel,
    compactedWindow: [
      {
        type: "message",
        role: "assistant",
        status: "completed",
        id: "cmp_old",
        content: [],
      },
    ],
  });
  const newerMismatchedCompaction = createCompactionEntry({
    id: "switch_compaction_new",
    firstKeptEntryId: keptUser.id,
    model: switchedModel,
    compactedWindow: [
      {
        type: "message",
        role: "assistant",
        status: "completed",
        id: "cmp_new",
        content: [],
      },
    ],
  });
  const branchEntries = [
    keptUser,
    olderMatchingCompaction,
    newerMismatchedCompaction,
  ];
  const matchingPayload = {
    model: matchingModel.id,
    instructions: "Instructions after switching back",
    input: [
      { role: "developer", content: "Fresh preamble after switching back" },
    ],
  };
  const mismatchedLatestResult = await beforeProviderRequest(
    { payload: matchingPayload },
    createContext({
      branchEntries,
      model: matchingModel,
      systemPrompt: matchingPayload.instructions,
    }),
  );
  const unsupportedProviderResult = await beforeProviderRequest(
    { payload: { ...matchingPayload, model: unsupportedProviderModel.id } },
    createContext({
      branchEntries,
      model: unsupportedProviderModel,
      systemPrompt: matchingPayload.instructions,
    }),
  );

  expect(mismatchedLatestResult).toBeUndefined();
  expect(unsupportedProviderResult).toBeUndefined();
});

test("portable state replaces the native marker without changing the retained tail", () => {
  const model = { ...defaultModel };
  const keptUser = createUserEntry("portable_kept", "Old retained context.");
  const native = createCompactionEntry({
    id: "portable_native",
    firstKeptEntryId: keptUser.id,
    model,
    compactedWindow: [
      { type: "compaction", encrypted_content: "opaque-portable-state" },
    ],
  });
  const portable = {
    type: "custom",
    id: "portable_state",
    timestamp: nextTimestamp(),
    customType: PORTABLE_SUMMARY_ENTRY_TYPE,
    data: {
      version: 1,
      sourceCompactionEntryId: native.id,
      source: {
        provider: model.provider,
        api: model.api,
        model: model.id,
        baseUrl: model.baseUrl,
      },
      summary: "Portable summary for another model.",
      createdAt: nextTimestamp(),
    },
  };
  const currentUser = {
    role: "user",
    content: [{ type: "text", text: "Current tail." }],
    timestamp: 10,
  };
  const projected = projectPortableSummary(
    [createCompactionSummaryMessage(native), currentUser] as never,
    [keptUser, native, portable] as never,
  );

  expect((projected[0] as { summary?: string }).summary).toBe(
    "Portable summary for another model.",
  );
  expect(projected[1]).toBe(currentUser);
});

test("durable portable message removes the native shim while keeping its context", () => {
  const model = { ...defaultModel };
  const keptUser = createUserEntry("portable_message_kept", "Old context.");
  const native = createCompactionEntry({
    id: "portable_message_native",
    firstKeptEntryId: keptUser.id,
    model,
    compactedWindow: [
      { type: "compaction", encrypted_content: "opaque-portable-message" },
    ],
  });
  const state = {
    version: 1,
    sourceCompactionEntryId: native.id,
    source: {
      provider: model.provider,
      api: model.api,
      model: model.id,
      baseUrl: model.baseUrl,
    },
    summary: "Durable portable summary.",
    createdAt: nextTimestamp(),
  };
  const entry = {
    type: "custom_message",
    id: "portable_message_entry",
    timestamp: nextTimestamp(),
    customType: PORTABLE_SUMMARY_MESSAGE_TYPE,
    content: "Portable conversation checkpoint.\n\nDurable portable summary.",
    display: false,
    details: state,
  };
  const contextMessage = {
    role: "custom",
    customType: PORTABLE_SUMMARY_MESSAGE_TYPE,
    content: entry.content,
    display: false,
    details: state,
    timestamp: 10,
  };

  const projected = projectPortableSummary(
    [createCompactionSummaryMessage(native), contextMessage] as never,
    [keptUser, native, entry] as never,
  );

  expect(projected).toEqual([contextMessage]);
});

test("portable state stays isolated to its fork branch", () => {
  const model = { ...defaultModel };
  const keptUser = createUserEntry("fork_kept", "Shared old context.");
  const native = createCompactionEntry({
    id: "fork_native",
    firstKeptEntryId: keptUser.id,
    model,
    compactedWindow: [
      { type: "compaction", encrypted_content: "opaque-fork-state" },
    ],
  });
  const portable = {
    type: "custom",
    id: "fork_a_portable",
    timestamp: nextTimestamp(),
    customType: PORTABLE_SUMMARY_ENTRY_TYPE,
    data: {
      version: 1,
      sourceCompactionEntryId: native.id,
      source: {
        provider: model.provider,
        api: model.api,
        model: model.id,
        baseUrl: model.baseUrl,
      },
      summary: "Fork A portable summary.",
      createdAt: nextTimestamp(),
    },
  };
  const marker = createCompactionSummaryMessage(native);

  const forkA = projectPortableSummary(
    [marker] as never,
    [keptUser, native, portable] as never,
  );
  const forkB = projectPortableSummary(
    [marker] as never,
    [keptUser, native] as never,
  );

  expect((forkA[0] as { summary?: string }).summary).toBe(
    "Fork A portable summary.",
  );
  expect((forkB[0] as { summary?: string }).summary).toBe(
    NATIVE_COMPACTION_SHIM_SUMMARY,
  );
});

test("selecting the same checkpoint identity keeps native replay active", async () => {
  const model = { ...defaultModel };
  const keptUser = createUserEntry("same_identity_kept", "Old context.");
  const native = createCompactionEntry({
    id: "same_identity_native",
    firstKeptEntryId: keptUser.id,
    model,
    compactedWindow: [
      { type: "compaction", encrypted_content: "opaque-same-identity" },
    ],
  });
  globalThis.fetch = mock(async () => {
    throw new Error("portable summary should not run");
  }) as unknown as typeof fetch;
  const { modelSelect, appendedEntries, selectedModels } =
    await loadHookHarness();

  await modelSelect?.(
    { model: { ...model }, previousModel: model, source: "set" },
    createContext({ branchEntries: [keptUser, native], model }),
  );

  expect(appendedEntries).toEqual([]);
  expect(selectedModels).toEqual([]);
});

test("session start reconciles a native checkpoint before an incompatible restored model runs", async () => {
  const model = { ...defaultModel };
  const keptUser = createUserEntry("startup_kept", "Old context.");
  const native = createCompactionEntry({
    id: "startup_native",
    firstKeptEntryId: keptUser.id,
    model,
    compactedWindow: [
      { type: "compaction", encrypted_content: "opaque-startup-state" },
    ],
  });
  globalThis.fetch = mock(
    async () =>
      new Response(
        JSON.stringify({
          object: "response",
          status: "completed",
          output: [
            {
              type: "message",
              content: [
                { type: "output_text", text: "Portable startup summary." },
              ],
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  ) as unknown as typeof fetch;
  const { sessionStart, sessionTree, sentMessages, selectedModels } =
    await loadHookHarness();
  const restoredModel = {
    ...model,
    provider: "anthropic",
    api: "anthropic-messages",
    id: "claude-test",
  };

  await sessionStart?.(
    {},
    createContext({ branchEntries: [keptUser, native], model: restoredModel }),
  );
  expect(sessionTree).toBeDefined();

  expect(sentMessages).toHaveLength(1);
  expect((sentMessages[0]?.message as { content?: string }).content).toContain(
    "Portable startup summary.",
  );
  expect(selectedModels).toEqual([]);
});

test("model change lazily materializes portable context with the previous GPT model", async () => {
  const model = { ...defaultModel };
  const keptUser = createUserEntry(
    "switch_kept",
    "Context represented by the native checkpoint.",
  );
  const native = createCompactionEntry({
    id: "switch_native",
    firstKeptEntryId: keptUser.id,
    model,
    compactedWindow: [
      { type: "compaction", encrypted_content: "opaque-switch-state" },
    ],
  });
  const tail = createUserEntry(
    "switch_tail",
    "Recent work after native compaction.",
  );
  const branchEntries = [keptUser, native, tail];
  let requestBody: Record<string, unknown> | undefined;
  globalThis.fetch = mock(
    async (_url: string | URL | Request, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          object: "response",
          status: "completed",
          output: [
            {
              type: "message",
              content: [
                { type: "output_text", text: "Portable switch summary." },
              ],
            },
          ],
          usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  ) as unknown as typeof fetch;

  const { modelSelect, sentMessages, appendedEntries, selectedModels } =
    await loadHookHarness();
  expect(modelSelect).toBeDefined();
  await modelSelect?.(
    {
      model: {
        ...model,
        provider: "anthropic",
        api: "anthropic-messages",
        id: "claude-test",
      },
      previousModel: model,
      source: "set",
    },
    createContext({
      branchEntries,
      model: {
        ...model,
        provider: "anthropic",
        api: "anthropic-messages",
        id: "claude-test",
      },
    }),
  );

  expect(selectedModels).toEqual([]);
  expect(appendedEntries).toEqual([]);
  expect(sentMessages).toHaveLength(1);
  expect((sentMessages[0]?.message as { customType?: string }).customType).toBe(
    PORTABLE_SUMMARY_MESSAGE_TYPE,
  );
  expect((sentMessages[0]?.message as { content?: string }).content).toContain(
    "Portable switch summary.",
  );
  expect(requestBody?.store).toBe(false);
  expect(requestBody?.instructions).toContain("structured checkpoint");
  expect(JSON.stringify(requestBody?.input)).toContain("opaque-switch-state");
  expect(JSON.stringify(requestBody?.input)).toContain(
    "Recent work after native compaction.",
  );
});

test("detach materializes portable context without changing models", async () => {
  const model = { ...defaultModel };
  const keptUser = createUserEntry(
    "detach_kept",
    "Context represented by the native checkpoint.",
  );
  const native = createCompactionEntry({
    id: "detach_native",
    firstKeptEntryId: keptUser.id,
    model,
    compactedWindow: [
      { type: "compaction", encrypted_content: "opaque-detach-state" },
    ],
  });
  globalThis.fetch = mock(
    async () =>
      new Response(
        JSON.stringify({
          object: "response",
          status: "completed",
          output: [
            {
              type: "message",
              content: [
                { type: "output_text", text: "Portable detach summary." },
              ],
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  ) as unknown as typeof fetch;
  const notifications: Array<{ message: string; level: string }> = [];
  const { detach, sentMessages, appendedEntries, selectedModels } =
    await loadHookHarness();
  const context = createContext({
    branchEntries: [keptUser, native],
    hasUI: true,
    model,
    notifications,
  });

  await detach?.("", context);

  expect(appendedEntries).toEqual([]);
  expect(sentMessages).toHaveLength(1);
  expect((sentMessages[0]?.message as { customType?: string }).customType).toBe(
    PORTABLE_SUMMARY_MESSAGE_TYPE,
  );
  expect((sentMessages[0]?.message as { content?: string }).content).toContain(
    "Portable detach summary.",
  );
  expect(selectedModels).toEqual([]);
  expect(notifications).toEqual([
    {
      message: "Native checkpoint converted to portable Pi context.",
      level: "info",
    },
  ]);
});

test("failed portable materialization restores the previous model", async () => {
  const model = { ...defaultModel };
  const keptUser = createUserEntry("failed_switch_kept", "Old context.");
  const native = createCompactionEntry({
    id: "failed_switch_native",
    firstKeptEntryId: keptUser.id,
    model,
    compactedWindow: [
      { type: "compaction", encrypted_content: "opaque-failed-switch" },
    ],
  });
  globalThis.fetch = mock(
    async () => new Response("unavailable", { status: 503 }),
  ) as unknown as typeof fetch;
  const notifications: Array<{ message: string; level: string }> = [];
  const { modelSelect, appendedEntries, selectedModels } =
    await loadHookHarness();

  await modelSelect?.(
    {
      model: {
        ...model,
        provider: "anthropic",
        api: "anthropic-messages",
        id: "claude-test",
      },
      previousModel: model,
      source: "set",
    },
    createContext({
      branchEntries: [keptUser, native],
      hasUI: true,
      model: {
        ...model,
        provider: "anthropic",
        api: "anthropic-messages",
        id: "claude-test",
      },
      notifications,
    }),
  );

  expect(appendedEntries).toEqual([]);
  expect(selectedModels).toEqual([model]);
  expect(notifications).toEqual([
    {
      message: "Model change cancelled: portable compaction failed (non-2xx).",
      level: "error",
    },
  ]);
});
