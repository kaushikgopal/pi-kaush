import { describe, expect, test } from "vitest";
import {
  isDelegatedToolActivity,
  parseChildEvent,
  parseChildEventLine,
  parseChildMessage,
} from "../src/_child-events.ts";
import { addTurnUsage, emptyUsage } from "../src/_usage.ts";

function message(value: unknown) {
  const parsed = parseChildMessage(value);
  if (!parsed) throw new Error("test message did not parse");
  return parsed;
}

describe("child session correlation", () => {
  test("extracts only JSON session header ids", () => {
    expect(parseChildEvent({ type: "session", id: "child-session" })).toEqual({
      _tag: "session",
      sessionId: "child-session",
    });
    expect(parseChildEvent({ type: "message_end", id: "entry-id" })._tag).toBe(
      "other",
    );
    expect(parseChildEvent({ type: "session", id: 42 })._tag).toBe("other");
    expect(parseChildEvent({ type: "session", id: "" })._tag).toBe("other");
  });

  test("treats blank and malformed lines as other events", () => {
    expect(parseChildEventLine("   ")._tag).toBe("other");
    expect(parseChildEventLine("{not json")._tag).toBe("other");
    expect(parseChildEventLine('{"type":"session","id":"s1"}')).toEqual({
      _tag: "session",
      sessionId: "s1",
    });
  });
});

describe("profile fallback safety", () => {
  test("only treats actual delegated tool activity as a side-effect boundary", () => {
    expect(
      isDelegatedToolActivity(
        message({ role: "assistant", content: [{ type: "text" }] }),
      ),
    ).toBe(false);
    expect(
      isDelegatedToolActivity(
        message({ role: "assistant", content: [{ type: "toolCall" }] }),
      ),
    ).toBe(true);
    expect(
      isDelegatedToolActivity(message({ role: "toolResult", content: [] })),
    ).toBe(true);
  });
});

describe("child message parsing", () => {
  test("reads text, model, and usage from an assistant message end", () => {
    const event = parseChildEventLine(
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          provider: "anthropic",
          model: "claude",
          content: [
            { type: "text", text: "first" },
            { type: "toolCall", name: "read" },
            { type: "text", text: "second" },
          ],
          usage: {
            input: 10,
            output: 5,
            cacheRead: 2,
            cacheWrite: 1,
            totalTokens: 18,
            cost: { total: 0.25 },
          },
          stopReason: "toolUse",
        },
      }),
    );
    expect(event._tag).toBe("messageEnd");
    if (event._tag !== "messageEnd") return;
    expect(event.message).toMatchObject({
      role: "assistant",
      textParts: ["first", "second"],
      hasToolCall: true,
      model: "anthropic/claude",
      stopReason: "toolUse",
      usage: {
        input: 10,
        output: 5,
        cacheRead: 2,
        cacheWrite: 1,
        cost: 0.25,
        contextTokens: 18,
      },
    });
  });

  test("uses the bare model when no provider is reported and accepts string content", () => {
    expect(
      message({ role: "user", model: "m", provider: "", content: "hello" }),
    ).toMatchObject({ model: "m", textParts: ["hello"] });
  });

  test("keeps the last context size when a turn reports none", () => {
    const usage = emptyUsage();
    addTurnUsage(
      usage,
      message({ role: "assistant", usage: { input: 1, totalTokens: 50 } })
        .usage,
    );
    addTurnUsage(
      usage,
      message({ role: "assistant", usage: { input: 2, totalTokens: 0 } }).usage,
    );
    addTurnUsage(usage, message({ role: "assistant" }).usage);
    expect(usage).toMatchObject({ turns: 3, input: 3, contextTokens: 50 });
  });

  test("distinguishes tool result ends from message ends", () => {
    expect(
      parseChildEvent({
        type: "tool_result_end",
        message: { role: "toolResult", toolName: "yield", details: {} },
      })._tag,
    ).toBe("toolResultEnd");
    expect(parseChildEvent({ type: "message_end", message: {} })._tag).toBe(
      "other",
    );
  });
});
