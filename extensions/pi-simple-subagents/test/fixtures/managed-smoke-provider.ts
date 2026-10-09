import { appendFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Model,
  type TranscriptContext,
} from "@earendil-works/pi-ai";

const API = "managed-smoke-api";
const PROVIDER = "managed-smoke";
const MODEL = "offline";

function textOf(message: TranscriptContext["messages"][number]): string {
  if (message.role !== "user") return "";
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function assistantMessage(
  model: Model<string>,
  toolCall: Extract<AssistantMessage["content"][number], { type: "toolCall" }>,
): AssistantMessage {
  return {
    role: "assistant",
    content: [toolCall],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 11,
      output: 7,
      cacheRead: 2,
      cacheWrite: 1,
      totalTokens: 21,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: Date.now(),
  };
}

function streamYield(model: Model<string>, context: TranscriptContext) {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    const users = context.messages.filter((message) => message.role === "user");
    const latestUserText =
      users.length > 0 ? textOf(users[users.length - 1]!) : "";
    const historyMessages = context.messages.filter(
      (message) => message.role !== "system",
    ).length;
    const result = [
      `userText=${JSON.stringify(latestUserText)}`,
      `userTurns=${users.length}`,
      `historyMessages=${historyMessages}`,
    ].join("; ");

    const agentDir = process.env.PI_CODING_AGENT_DIR;
    if (!agentDir)
      throw new Error("PI_CODING_AGENT_DIR is required by the smoke provider");
    appendFileSync(
      join(agentDir, "managed-smoke-calls.jsonl"),
      `${JSON.stringify({ userTurns: users.length, historyMessages })}\n`,
    );

    const toolCall = {
      type: "toolCall" as const,
      id: `managed-smoke-yield-${users.length}`,
      name: "yield",
      arguments: { status: "completed", result },
    };
    const message = assistantMessage(model, toolCall);
    const partial: AssistantMessage = {
      ...message,
      content: [],
      stopReason: "pending",
    };
    stream.push({ type: "start", partial });

    const partialToolCall: AssistantMessage = {
      ...partial,
      content: [
        {
          type: "toolCall",
          id: toolCall.id,
          name: toolCall.name,
          arguments: {},
        },
      ],
    };
    stream.push({
      type: "toolcall_start",
      contentIndex: 0,
      partial: partialToolCall,
    });
    stream.push({
      type: "toolcall_delta",
      contentIndex: 0,
      delta: JSON.stringify(toolCall.arguments),
      partial: partialToolCall,
    });
    stream.push({
      type: "toolcall_end",
      contentIndex: 0,
      toolCall,
      partial: { ...partialToolCall, content: [toolCall] },
    });
    stream.push({ type: "done", reason: "toolUse", message });
    stream.end(message);
  });
  return stream;
}

export default function managedSmokeProvider(pi: ExtensionAPI): void {
  pi.registerProvider(PROVIDER, {
    name: "Managed CLI offline smoke provider",
    baseUrl: "http://127.0.0.1:9/no-network",
    apiKey: "offline",
    api: API,
    models: [
      {
        id: MODEL,
        name: "Offline managed smoke model",
        api: API,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 8_192,
        maxTokens: 128,
      },
    ],
    streamSimple(model, context) {
      return streamYield(model, context);
    },
  });
}
