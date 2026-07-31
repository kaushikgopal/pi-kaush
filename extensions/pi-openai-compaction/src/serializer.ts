import { createHash } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import type {
  Api,
  AssistantMessage,
  ImageContent,
  Message,
  Model,
  TextContent,
  ThinkingContent,
  ToolCall,
  ToolResultMessage,
  UserMessage,
} from "@earendil-works/pi-ai";

/**
 * Decision for T4: keep a narrow local serializer instead of importing Pi internals.
 *
 * Why this is sufficient for v1:
 * - we only target same-model OpenAI Responses-compatible requests
 * - we only need Pi's current supported message semantics (assistant phase,
 *   reasoning signatures, tool call/result pairing, image blocks)
 * - Pi's shared Responses converter is not publicly exported, so importing it
 *   would require a brittle install-path-specific wrapper
 *
 * The helpers below intentionally mirror Pi's same-model Responses serialization
 * rules closely so later tasks can compare their output against captured
 * before_provider_request payload artifacts.
 */
export type AssistantPhase = "commentary" | "final_answer";

type ResponsesTextInputItem = {
  type: "input_text";
  text: string;
};

type ResponsesImageInputItem = {
  type: "input_image";
  detail: "auto";
  image_url: string;
};

export type ResponsesInputContentItem =
  | ResponsesTextInputItem
  | ResponsesImageInputItem;

export type ResponsesInputMessageItem = {
  role: "user" | "developer" | "system";
  content: ResponsesInputContentItem[] | string;
};

export type ResponsesAssistantOutputItem = {
  type: "message";
  role: "assistant";
  content: Array<{
    type: "output_text";
    text: string;
    annotations: [];
  }>;
  status: "completed";
  id: string;
  phase?: AssistantPhase;
};

export type ResponsesFunctionCallItem = {
  type: "function_call";
  id?: string;
  call_id: string;
  name: string;
  arguments: string;
};

export type ResponsesFunctionCallOutputItem = {
  type: "function_call_output";
  call_id: string;
  output: ResponsesInputContentItem[] | string;
};

export type ResponsesReasoningItem = Record<string, unknown>;

export type ResponsesInputItem =
  | ResponsesInputMessageItem
  | ResponsesAssistantOutputItem
  | ResponsesFunctionCallItem
  | ResponsesFunctionCallOutputItem
  | ResponsesReasoningItem;

export type NativeCompactionRequestBody = {
  model: string;
  input: ResponsesInputItem[];
  instructions: string;
};

export type SerializeResponsesMessagesOptions = {
  instructions?: string;
  includeInstructionsInInput?: boolean;
};

export type ResponsesParityReport = {
  ok: boolean;
  actual: string[];
  expected: string[];
  mismatches: string[];
};

type ParsedTextSignature = {
  id: string;
  phase?: AssistantPhase;
};

const SYNTHETIC_TOOL_RESULT_TEXT = "No result provided";
const TRANSIENT_GOAL_CUSTOM_TYPES = new Set(["goal-continuation", "goal-ui"]);

function sanitizeSurrogates(text: string): string {
  return text.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    "",
  );
}

function isTransientGoalCustomMessage(message: AgentMessage): boolean {
  return Boolean(
    (message as { role?: unknown }).role === "custom" &&
      TRANSIENT_GOAL_CUSTOM_TYPES.has(
        String((message as { customType?: unknown }).customType ?? ""),
      ),
  );
}

export function filterTransientGoalCustomMessages<
  TMessage extends AgentMessage,
>(messages: readonly TMessage[]): TMessage[] {
  return messages.filter((message) => !isTransientGoalCustomMessage(message));
}

export function serializeMessagesToCompactRequest<TApi extends Api>(args: {
  model: Model<TApi>;
  messages: AgentMessage[];
  instructions: string;
}): NativeCompactionRequestBody {
  return {
    model: args.model.id,
    input: serializeMessagesToResponsesInput(args.model, args.messages),
    instructions: sanitizeSurrogates(args.instructions),
  };
}

export function serializeMessagesToResponsesInput<TApi extends Api>(
  model: Model<TApi>,
  messages: AgentMessage[],
  options: SerializeResponsesMessagesOptions = {},
): ResponsesInputItem[] {
  const llmMessages = convertToLlm(filterTransientGoalCustomMessages(messages));
  const transformedMessages = transformMessagesForResponses(llmMessages);
  const input: ResponsesInputItem[] = [];

  if (options.includeInstructionsInInput && options.instructions) {
    input.push({
      role: model.reasoning ? "developer" : "system",
      content: sanitizeSurrogates(options.instructions),
    });
  }

  let messageIndex = 0;
  for (const message of transformedMessages) {
    if (message.role === "user") {
      const item = serializeUserMessage(message, model);
      if (item) {
        input.push(item);
      }
      messageIndex++;
      continue;
    }

    if (message.role === "assistant") {
      const items = serializeAssistantMessage(message, model, messageIndex);
      if (items.length > 0) {
        input.push(...items);
      }
      messageIndex++;
      continue;
    }

    input.push(serializeToolResultMessage(message, model));
    messageIndex++;
  }

  return input;
}

export function createResponsesInputParitySignature(
  input: readonly unknown[],
): string[] {
  return input.map(describeResponsesInputItem);
}

export function compareResponsesInputParity(
  actual: readonly unknown[],
  expected: readonly unknown[],
): ResponsesParityReport {
  const actualSignature = createResponsesInputParitySignature(actual);
  const expectedSignature = createResponsesInputParitySignature(expected);
  const maxLength = Math.max(actualSignature.length, expectedSignature.length);
  const mismatches: string[] = [];

  for (let index = 0; index < maxLength; index++) {
    const actualValue = actualSignature[index];
    const expectedValue = expectedSignature[index];
    if (actualValue !== expectedValue) {
      mismatches.push(
        `index ${index}: expected ${expectedValue ?? "<missing>"}, got ${actualValue ?? "<missing>"}`,
      );
    }
  }

  return {
    ok: mismatches.length === 0,
    actual: actualSignature,
    expected: expectedSignature,
    mismatches,
  };
}

function transformMessagesForResponses(messages: Message[]): Message[] {
  const transformed: Message[] = [];
  let pendingToolCalls: ToolCall[] = [];
  let existingToolResultIds = new Set<string>();

  for (const message of messages) {
    if (message.role === "assistant") {
      if (pendingToolCalls.length > 0) {
        transformed.push(
          ...createSyntheticToolResults(
            pendingToolCalls,
            existingToolResultIds,
          ),
        );
        pendingToolCalls = [];
        existingToolResultIds = new Set<string>();
      }

      if (message.stopReason === "error" || message.stopReason === "aborted") {
        continue;
      }

      const normalizedContent = message.content.filter(
        (block) =>
          block.type !== "thinking" || Boolean(block.thinkingSignature),
      );

      const normalizedAssistantMessage: AssistantMessage = {
        ...message,
        content: normalizedContent,
      };
      transformed.push(normalizedAssistantMessage);

      const toolCalls = normalizedContent.filter(isToolCallBlock);
      if (toolCalls.length > 0) {
        pendingToolCalls = toolCalls;
        existingToolResultIds = new Set<string>();
      }
      continue;
    }

    if (message.role === "toolResult") {
      existingToolResultIds.add(message.toolCallId);
      transformed.push(message);
      continue;
    }

    if (pendingToolCalls.length > 0) {
      transformed.push(
        ...createSyntheticToolResults(pendingToolCalls, existingToolResultIds),
      );
      pendingToolCalls = [];
      existingToolResultIds = new Set<string>();
    }

    transformed.push(message);
  }

  return transformed;
}

function createSyntheticToolResults(
  pendingToolCalls: readonly ToolCall[],
  existingToolResultIds: ReadonlySet<string>,
): ToolResultMessage[] {
  const syntheticResults: ToolResultMessage[] = [];

  for (const toolCall of pendingToolCalls) {
    if (existingToolResultIds.has(toolCall.id)) {
      continue;
    }

    syntheticResults.push({
      role: "toolResult",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      content: [{ type: "text", text: SYNTHETIC_TOOL_RESULT_TEXT }],
      isError: true,
      timestamp: Date.now(),
    });
  }

  return syntheticResults;
}

function serializeUserMessage<TApi extends Api>(
  message: UserMessage,
  model: Model<TApi>,
): ResponsesInputMessageItem | undefined {
  const contentItems = normalizeUserContent(message.content).flatMap((item) =>
    serializeUserContentItem(item, model),
  );
  if (contentItems.length === 0) {
    return undefined;
  }

  return {
    role: "user",
    content: contentItems,
  };
}

function serializeUserContentItem<TApi extends Api>(
  item: TextContent | ImageContent,
  model: Model<TApi>,
): ResponsesInputContentItem[] {
  if (item.type === "text") {
    return [{ type: "input_text", text: sanitizeSurrogates(item.text) }];
  }

  if (!model.input.includes("image")) {
    return [];
  }

  return [
    {
      type: "input_image",
      detail: "auto",
      image_url: `data:${item.mimeType};base64,${item.data}`,
    },
  ];
}

type NativeImageGenerationBlock = {
  type: "image_generation_call";
  item: ResponsesInputItem;
};

function isNativeImageGenerationBlock(
  block: unknown,
): block is NativeImageGenerationBlock {
  return (
    typeof block === "object" &&
    block !== null &&
    "type" in block &&
    block.type === "image_generation_call" &&
    "item" in block
  );
}

function serializeAssistantMessage<TApi extends Api>(
  message: AssistantMessage,
  model: Model<TApi>,
  messageIndex: number,
): ResponsesInputItem[] {
  const items: ResponsesInputItem[] = [];
  let textIndex = 0;
  const sameModel =
    message.provider === model.provider &&
    message.api === model.api &&
    message.model === model.id;

  for (const block of message.content) {
    if (block.type === "thinking") {
      const reasoningItem = sameModel ? parseReasoningItem(block) : undefined;
      if (reasoningItem) {
        items.push(reasoningItem);
      }
      continue;
    }

    if (block.type === "text") {
      const signature = sameModel
        ? parseTextSignature(block.textSignature)
        : undefined;
      items.push({
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: sanitizeSurrogates(block.text),
            annotations: [],
          },
        ],
        status: "completed",
        id: normalizeAssistantMessageId(signature?.id, messageIndex, textIndex),
        phase: signature?.phase,
      });
      textIndex++;
      continue;
    }

    const nativeImage = isNativeImageGenerationBlock(block as unknown)
      ? (block as unknown as NativeImageGenerationBlock)
      : undefined;
    if (nativeImage && sameModel) {
      items.push(nativeImage.item);
      continue;
    }
    if (nativeImage) continue;

    const [callId, rawItemId] = block.id.split("|");
    items.push({
      type: "function_call",
      id: sameModel ? rawItemId : undefined,
      call_id: callId,
      name: block.name,
      arguments: JSON.stringify(block.arguments),
    });
  }

  return items;
}

function serializeToolResultMessage<TApi extends Api>(
  message: ToolResultMessage,
  model: Model<TApi>,
): ResponsesFunctionCallOutputItem {
  const [callId] = message.toolCallId.split("|");
  const textOutput = message.content
    .filter((item): item is TextContent => item.type === "text")
    .map((item) => sanitizeSurrogates(item.text))
    .join("\n");
  const hasImages = message.content.some((item) => item.type === "image");
  const hasText = textOutput.length > 0;

  if (hasImages && model.input.includes("image")) {
    const output: ResponsesInputContentItem[] = [];
    if (hasText) {
      output.push({ type: "input_text", text: textOutput });
    }
    for (const item of message.content) {
      if (item.type !== "image") {
        continue;
      }
      output.push({
        type: "input_image",
        detail: "auto",
        image_url: `data:${item.mimeType};base64,${item.data}`,
      });
    }
    return {
      type: "function_call_output",
      call_id: callId,
      output,
    };
  }

  return {
    type: "function_call_output",
    call_id: callId,
    output: hasText
      ? textOutput
      : hasImages
        ? "(see attached image)"
        : "(no tool output)",
  };
}

function normalizeUserContent(
  content: UserMessage["content"],
): Array<TextContent | ImageContent> {
  return typeof content === "string"
    ? [{ type: "text", text: content }]
    : content;
}

function parseReasoningItem(
  block: ThinkingContent,
): ResponsesReasoningItem | undefined {
  if (!block.thinkingSignature) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(block.thinkingSignature);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    return parsed as ResponsesReasoningItem;
  } catch {
    return undefined;
  }
}

function parseTextSignature(
  signature: string | undefined,
): ParsedTextSignature | undefined {
  if (!signature) {
    return undefined;
  }

  if (!signature.startsWith("{")) {
    return { id: signature };
  }

  try {
    const parsed = JSON.parse(signature);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }

    const record = parsed as Record<string, unknown>;
    if (record.v !== 1 || typeof record.id !== "string") {
      return undefined;
    }

    return {
      id: record.id,
      phase:
        record.phase === "commentary" || record.phase === "final_answer"
          ? record.phase
          : undefined,
    };
  } catch {
    return undefined;
  }
}

function normalizeAssistantMessageId(
  id: string | undefined,
  messageIndex: number,
  textIndex = 0,
): string {
  if (!id) {
    return `msg_${messageIndex}_${textIndex}`;
  }

  if (id.length <= 64) {
    return id;
  }

  return `msg_${createHash("sha1").update(id).digest("hex").slice(0, 12)}`;
}

function isToolCallBlock(
  block: AssistantMessage["content"][number],
): block is ToolCall {
  return block.type === "toolCall";
}

function describeResponsesInputItem(item: unknown): string {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return typeof item;
  }

  const record = item as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : undefined;
  if (type === "message") {
    const phase =
      record.phase === "commentary" || record.phase === "final_answer"
        ? `:${record.phase}`
        : "";
    return `message:${typeof record.role === "string" ? record.role : "unknown"}${phase}`;
  }

  if (type === "function_call") {
    return `function_call:${typeof record.name === "string" ? record.name : "unknown"}`;
  }

  if (type === "function_call_output") {
    return "function_call_output";
  }

  if (type === "reasoning") {
    return "reasoning";
  }

  if (typeof record.role === "string") {
    const content = Array.isArray(record.content)
      ? `[${record.content.length}]`
      : "";
    return `input:${record.role}${content}`;
  }

  return type ? `item:${type}` : "object";
}
