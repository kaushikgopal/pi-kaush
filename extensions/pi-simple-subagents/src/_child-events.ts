/**
 * Parses child Pi messages and `--mode json` events once at the boundary, so
 * bounded runs and managed workers read usage, model, and text the same way.
 */
import {
  finiteNumber,
  isPlainRecord,
  nonEmptyString,
  stringValue,
} from "./_parse.ts";
import type { TurnUsage } from "./_usage.ts";

export interface ChildMessage {
  readonly role: string;
  /** Text parts in order; string content is a single part. */
  readonly textParts: readonly string[];
  readonly hasToolCall: boolean;
  readonly toolName?: string;
  readonly details?: unknown;
  readonly usage?: TurnUsage;
  /** `provider/model`, or the bare model when no provider was reported. */
  readonly model?: string;
  readonly stopReason?: string;
  readonly errorMessage?: string;
  /** The original message, for traces that keep Pi's full shape. */
  readonly raw: unknown;
}

export type ChildEvent =
  | { readonly _tag: "session"; readonly sessionId: string }
  | { readonly _tag: "messageEnd"; readonly message: ChildMessage }
  | { readonly _tag: "toolResultEnd"; readonly message: ChildMessage }
  | { readonly _tag: "other" };

const OTHER: ChildEvent = { _tag: "other" };

function parseTurnUsage(value: unknown): TurnUsage | undefined {
  if (!isPlainRecord(value)) return undefined;
  const count = (field: unknown) => finiteNumber(field) ?? 0;
  const cost = isPlainRecord(value.cost) ? count(value.cost.total) : 0;
  const contextTokens = finiteNumber(value.totalTokens);
  return {
    input: count(value.input),
    output: count(value.output),
    cacheRead: count(value.cacheRead),
    cacheWrite: count(value.cacheWrite),
    cost,
    ...(contextTokens !== undefined && contextTokens > 0
      ? { contextTokens }
      : {}),
  };
}

function textParts(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) =>
    isPlainRecord(part) && part.type === "text" && typeof part.text === "string"
      ? [part.text]
      : [],
  );
}

/** Parses a Pi agent message; undefined when it has no string role. */
export function parseChildMessage(value: unknown): ChildMessage | undefined {
  if (!isPlainRecord(value)) return undefined;
  const role = nonEmptyString(value.role);
  if (!role) return undefined;
  const modelId = nonEmptyString(value.model);
  const provider = nonEmptyString(value.provider);
  const usage = parseTurnUsage(value.usage);
  const toolName = stringValue(value.toolName);
  const stopReason = stringValue(value.stopReason);
  const errorMessage = stringValue(value.errorMessage);
  return {
    role,
    textParts: textParts(value.content),
    hasToolCall:
      Array.isArray(value.content) &&
      value.content.some(
        (part) => isPlainRecord(part) && part.type === "toolCall",
      ),
    ...(toolName !== undefined ? { toolName } : {}),
    ...(value.details !== undefined ? { details: value.details } : {}),
    ...(usage ? { usage } : {}),
    ...(modelId
      ? { model: provider ? `${provider}/${modelId}` : modelId }
      : {}),
    ...(stopReason !== undefined ? { stopReason } : {}),
    ...(errorMessage !== undefined ? { errorMessage } : {}),
    raw: value,
  };
}

/** Parses one decoded `--mode json` event. */
export function parseChildEvent(event: unknown): ChildEvent {
  if (!isPlainRecord(event)) return OTHER;
  if (event.type === "session") {
    const sessionId = nonEmptyString(event.id);
    return sessionId ? { _tag: "session", sessionId } : OTHER;
  }
  if (event.type !== "message_end" && event.type !== "tool_result_end")
    return OTHER;
  const message = parseChildMessage(event.message);
  if (!message) return OTHER;
  return event.type === "message_end"
    ? { _tag: "messageEnd", message }
    : { _tag: "toolResultEnd", message };
}

/** Parses one stdout line; blank or malformed lines are `other`. */
export function parseChildEventLine(line: string): ChildEvent {
  if (!line.trim()) return OTHER;
  try {
    return parseChildEvent(JSON.parse(line) as unknown);
  } catch {
    return OTHER;
  }
}

/** A tool call or tool result: evidence the child may have caused side effects. */
export function isDelegatedToolActivity(message: ChildMessage): boolean {
  return (
    message.role === "toolResult" ||
    (message.role === "assistant" && message.hasToolCall)
  );
}
