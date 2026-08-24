import { createHash } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  ImageContent,
  TextContent,
  ThinkingContent,
  ToolCall,
} from "@earendil-works/pi-ai";
import {
  DELETION_MARKER_PATTERN,
  type CompactionSource,
  type LineKind,
  type Transcript,
  type TranscriptLine,
  type SummaryProvenance,
} from "./types.ts";

const KEEP_CONTEXT_OPEN = "<keepContext>";
const KEEP_CONTEXT_CLOSE = "</keepContext>";
const INLINE_KEEP_CONTEXT = /^<keepContext>.*<\/keepContext>$/;

export interface BuildTranscriptOptions {
  protectedContext?: boolean;
  previousSummaryProvenance?: SummaryProvenance;
}

type ContentPart = TextContent | ImageContent;
type AssistantPart = TextContent | ThinkingContent | ToolCall;
type MessageRecord = Record<string, unknown> & { role?: unknown };
interface KeepContextState {
  depth: number;
}

/** A deterministic estimate that remains useful for very large or minified lines. */
export function estimateLineTokens(text: string): number {
  return Math.max(1, Math.ceil(Buffer.byteLength(text, "utf8") / 4));
}

export function digestText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function buildTranscript(
  source: CompactionSource,
  options: BuildTranscriptOptions = {},
): Transcript {
  const builder = new TranscriptBuilder(options.protectedContext === true);

  if (source.previousSummary !== undefined) {
    builder.previousSummary(
      source.previousSummary,
      options.previousSummaryProvenance,
    );
  }

  for (const message of source.messagesToSummarize) {
    builder.message(message);
  }
  for (const message of source.turnPrefixMessages) {
    builder.message(message);
  }
  return builder.finish();
}

class TranscriptBuilder {
  readonly #lines: TranscriptLine[] = [];
  readonly #protectedContextEnabled: boolean;

  constructor(protectedContextEnabled: boolean) {
    this.#protectedContextEnabled = protectedContextEnabled;
  }

  structure(text: string): void {
    this.#push(text, "structure", true);
  }

  previousSummary(text: string, provenance?: SummaryProvenance): void {
    const valid =
      provenance !== undefined && provenance.digest === digestText(text);
    const protectedLines = new Set(valid ? provenance.protectedLines : []);
    const markerLines = new Set(valid ? provenance.markerLines : []);
    const structureLines = new Set(valid ? provenance.structureLines : []);
    for (const [index, line] of text.split("\n").entries()) {
      const lineNumber = index + 1;
      const marker =
        markerLines.has(lineNumber) &&
        parseSafeDeletionMarker(line) !== undefined;
      if (valid) {
        this.#push(
          line,
          marker
            ? "marker"
            : structureLines.has(lineNumber)
              ? "structure"
              : "content",
          protectedLines.has(lineNumber),
        );
      } else {
        this.#push(escapeReservedLine(line), "content", false);
      }
    }
  }

  text(
    text: string,
    options: {
      trustedKeepContext: boolean;
      keepState?: KeepContextState;
    },
  ): void {
    const keepState = options.keepState ?? { depth: 0 };

    for (const line of text.split("\n")) {
      let protectedLine = false;
      if (this.#protectedContextEnabled && options.trustedKeepContext) {
        const tagLine = line.endsWith("\r") ? line.slice(0, -1) : line;
        if (tagLine === KEEP_CONTEXT_OPEN) {
          keepState.depth += 1;
          protectedLine = true;
        } else if (tagLine === KEEP_CONTEXT_CLOSE) {
          protectedLine = true;
          keepState.depth = Math.max(0, keepState.depth - 1);
        } else if (INLINE_KEEP_CONTEXT.test(tagLine)) {
          protectedLine = true;
        } else {
          protectedLine = keepState.depth > 0;
        }
      }

      this.#push(escapeReservedLine(line), "content", protectedLine);
    }
  }

  message(message: AgentMessage): void {
    const record = message as unknown as MessageRecord;
    switch (record.role) {
      case "user":
        this.#contentMessage("user", record.content, true);
        return;
      case "assistant":
        this.#assistantMessage(record);
        return;
      case "toolResult":
        this.#toolResultMessage(record);
        return;
      case "bashExecution":
        if (record.excludeFromContext !== true)
          this.#bashExecutionMessage(record);
        return;
      case "custom":
        this.#customMessage(record);
        return;
      case "branchSummary":
        this.#summaryMessage("branchSummary", record, "summary", {
          fromId: record.fromId,
        });
        return;
      case "compactionSummary":
        this.#summaryMessage("compactionSummary", record, "summary", {
          tokensBefore: record.tokensBefore,
        });
        return;
      default:
        this.#unknownMessage(record);
    }
  }

  finish(): Transcript {
    const text = this.#lines.map((line) => line.text).join("\n");
    return {
      lines: this.#lines,
      text,
      numberedText: this.#lines
        .map((line) => `${line.id}→${line.text}`)
        .join("\n"),
      estimatedTokens: this.#lines.reduce(
        (total, line) => total + line.estimatedTokens,
        0,
      ),
      protectedLines: this.#lines
        .filter((line) => line.protected)
        .map((line) => line.id),
    };
  }

  #contentMessage(
    role: string,
    content: unknown,
    trustedKeepContext: boolean,
    metadata: Record<string, unknown> = {},
  ): void {
    this.structure(openRecord("message", { role, ...metadata }));
    this.#content(content, trustedKeepContext);
    this.structure("[/verbatim:message]");
  }

  #assistantMessage(message: MessageRecord): void {
    this.structure(
      openRecord("message", {
        api: message.api,
        model: message.model,
        provider: message.provider,
        responseModel: message.responseModel,
        role: "assistant",
        stopReason: message.stopReason,
      }),
    );

    const content = Array.isArray(message.content) ? message.content : [];
    for (const part of content as AssistantPart[]) {
      if (part.type === "text") {
        this.#field("text", part.text, false);
      } else if (part.type === "thinking") {
        this.structure(
          openRecord("field", {
            name: "thinking",
            redacted: part.redacted === true,
          }),
        );
        this.text(part.thinking, { trustedKeepContext: false });
        this.structure("[/verbatim:field]");
      } else if (part.type === "toolCall") {
        this.structure(
          openRecord("tool-call", { id: part.id, name: part.name }),
        );
        this.text(stableJson(part.arguments), { trustedKeepContext: false });
        this.structure("[/verbatim:tool-call]");
      } else {
        this.structure("[verbatim:unknown-part]");
        this.text(stableJson(part), { trustedKeepContext: false });
        this.structure("[/verbatim:unknown-part]");
      }
    }

    if (typeof message.errorMessage === "string") {
      this.#field("errorMessage", message.errorMessage, false);
    }
    this.structure("[/verbatim:message]");
  }

  #toolResultMessage(message: MessageRecord): void {
    this.structure(
      openRecord("message", {
        isError: message.isError === true,
        role: "toolResult",
        toolCallId: message.toolCallId,
        toolName: message.toolName,
      }),
    );
    this.#content(message.content, false);
    this.structure("[/verbatim:message]");
  }

  #bashExecutionMessage(message: MessageRecord): void {
    this.structure(
      openRecord("message", {
        cancelled: message.cancelled === true,
        excludeFromContext: message.excludeFromContext === true,
        exitCode: message.exitCode,
        role: "bashExecution",
        truncated: message.truncated === true,
      }),
    );
    if (typeof message.command === "string") {
      this.#field("command", message.command, false);
    }
    if (typeof message.output === "string") {
      this.#field("output", message.output, false);
    }
    this.structure("[/verbatim:message]");
  }

  #customMessage(message: MessageRecord): void {
    this.#contentMessage(
      "custom",
      message.content,
      message.customType === "verbatim-compaction-context",
      {
        customType: message.customType,
        display: message.display === true,
      },
    );
  }

  #summaryMessage(
    role: string,
    message: MessageRecord,
    fieldName: string,
    metadata: Record<string, unknown>,
  ): void {
    this.structure(openRecord("message", { role, ...metadata }));
    const summary = message[fieldName];
    if (typeof summary === "string") {
      this.#field(fieldName, summary, false);
    }
    this.structure("[/verbatim:message]");
  }

  #unknownMessage(message: MessageRecord): void {
    const {
      content,
      details: _details,
      timestamp: _timestamp,
      ...metadata
    } = message;
    this.structure(
      openRecord("message", {
        ...metadata,
        role: typeof message.role === "string" ? message.role : "unknown",
      }),
    );
    if (content !== undefined) {
      this.#content(content, false);
    }
    this.structure("[/verbatim:message]");
  }

  #content(content: unknown, trustedKeepContext: boolean): void {
    const keepState: KeepContextState = { depth: 0 };
    if (typeof content === "string") {
      this.#field("content", content, trustedKeepContext, keepState);
      return;
    }
    if (!Array.isArray(content)) {
      return;
    }

    for (const part of content as ContentPart[]) {
      if (part.type === "text") {
        this.#field("text", part.text, trustedKeepContext, keepState);
      } else if (part.type === "image") {
        this.#image(part);
      } else {
        this.structure(openRecord("unknown-part", part));
      }
    }
  }

  #field(
    name: string,
    value: string,
    trustedKeepContext: boolean,
    keepState?: KeepContextState,
  ): void {
    this.structure(openRecord("field", { name }));
    this.text(value, {
      trustedKeepContext,
      ...(keepState === undefined ? {} : { keepState }),
    });
    this.structure("[/verbatim:field]");
  }

  #image(image: ImageContent): void {
    this.structure(
      openRecord("image", {
        dataCharacters: image.data.length,
        mimeType: image.mimeType,
        sha256: createHash("sha256").update(image.data, "utf8").digest("hex"),
      }),
    );
  }

  #push(text: string, kind: LineKind, protectedLine: boolean): void {
    this.#lines.push({
      id: this.#lines.length + 1,
      text,
      kind,
      protected: protectedLine,
      estimatedTokens: estimateLineTokens(text),
    });
  }
}

function openRecord(name: string, value: unknown): string {
  return `[verbatim:${name} ${stableJson(value)}]`;
}

function stableJson(
  value: unknown,
  ancestors: Set<object> = new Set(),
): string {
  if (value === null) return "null";
  if (typeof value === "string") return safeJsonString(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number")
    return Number.isFinite(value) ? String(value) : "null";
  if (typeof value === "bigint") return safeJsonString(`${value}n`);
  if (typeof value !== "object") return "null";

  if (ancestors.has(value)) {
    throw new TypeError("Cannot serialize a cyclic transcript value");
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => stableJson(item, ancestors)).join(",")}]`;
    }

    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .filter((key) => {
        const item = record[key];
        return (
          item !== undefined &&
          typeof item !== "function" &&
          typeof item !== "symbol"
        );
      })
      .sort()
      .map(
        (key) => `${safeJsonString(key)}:${stableJson(record[key], ancestors)}`,
      );
    return `{${entries.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

export function parseSafeDeletionMarker(line: string): number | undefined {
  const match = DELETION_MARKER_PATTERN.exec(line);
  if (match === null || match[1]?.startsWith("0")) return undefined;
  const count = Number(match[1]);
  return Number.isSafeInteger(count) && count > 0 ? count : undefined;
}

function escapeReservedLine(line: string): string {
  if (
    line.includes("<summary>") ||
    line.includes("</summary>") ||
    line.includes("[verbatim:") ||
    line.includes("[/verbatim:") ||
    DELETION_MARKER_PATTERN.test(line)
  ) {
    return `[verbatim:escaped-line ${stableJson({ text: line })}]`;
  }
  return line;
}

function safeJsonString(value: string): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e");
}
