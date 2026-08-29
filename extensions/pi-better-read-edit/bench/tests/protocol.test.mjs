// Strict protocol parsing: outcome classification, error accounting,
// token/tool metrics, pi identity reporting, and the first-edit tri-state.

import { describe, expect, test } from "vitest";
import {
  analyzeProtocol,
  classifyOutcome,
  computeMetrics,
  reportedIdentity,
  parseStream,
} from "../protocol.mjs";

const j = (value) => JSON.stringify(value);
const usage = {
  input: 10,
  output: 5,
  cacheRead: 2,
  cacheWrite: 0,
  reasoning: 3,
  totalTokens: 15,
  cost: { total: 0.01 },
};
const usage2 = {
  input: 20,
  output: 8,
  cacheRead: 2,
  cacheWrite: 1,
  reasoning: 1,
  totalTokens: 30,
  cost: { total: 0.02 },
};
const identity = { provider: "fake", model: "model" };

function baseLines({ editError = false, lastReason = "stop" } = {}) {
  return [
    j({ type: "session", version: 3, id: "s", cwd: "/tmp/x" }),
    j({ type: "agent_start" }),
    j({ type: "turn_start" }),
    j({
      type: "tool_execution_start",
      toolCallId: "r1",
      toolName: "read",
      args: { path: "a.ts", limit: 40 },
    }),
    j({
      type: "tool_execution_end",
      toolCallId: "r1",
      toolName: "read",
      isError: false,
      result: { details: {} },
    }),
    j({
      type: "message_update",
      message: { role: "assistant", content: [], usage },
      assistantMessageEvent: { type: "text_delta", delta: "" },
    }),
    j({
      type: "tool_execution_start",
      toolCallId: "e1",
      toolName: "edit",
      args: {
        files: [
          {
            path: "a.ts",
            edits: [{ startLine: 1, deleteCount: 1, newLines: ["x"] }],
          },
        ],
      },
    }),
    j({
      type: "tool_execution_end",
      toolCallId: "e1",
      toolName: "edit",
      isError: editError,
      result: editError
        ? { content: [{ type: "text", text: "unseen lines" }], details: {} }
        : { details: {} },
    }),
    j({
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        stopReason: lastReason,
        usage,
        ...identity,
      },
    }),
    j({
      type: "message_update",
      message: { role: "assistant", content: [], usage: usage2 },
      assistantMessageEvent: { type: "text_delta", delta: "done" },
    }),
    j({
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        stopReason: "stop",
        usage: usage2,
        ...identity,
      },
    }),
    j({ type: "agent_end", messages: [], willRetry: false }),
  ];
}

describe("parseStream", () => {
  test("records unparseable lines and unknown event types instead of dropping them", () => {
    const lines = [
      "this is not json",
      j({ type: "mystery_event", weird: true }),
      "",
      j({ type: "session", version: 3 }),
      "42",
    ];
    const { events, parseErrors, unknownTypeCount } = parseStream(lines);
    expect(parseErrors).toHaveLength(2);
    expect(parseErrors[0].truncated).toContain("not json");
    expect(parseErrors[1].reason).toBe("not-an-event");
    expect(unknownTypeCount).toBe(1);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("session");
  });

  test("normal pi events are recognized without dropping", () => {
    const lines = [
      j({ type: "session_start", reason: "startup" }),
      j({ type: "message_start", message: { role: "user", content: "x" } }),
      j({ type: "turn_start", turnIndex: 0 }),
      j({ type: "turn_end", turnIndex: 0 }),
      j({ type: "tool_execution_update", toolCallId: "t", toolName: "read" }),
      j({ type: "thinking_level_select", level: "off" }),
      j({ type: "queue_update", queued: 0 }),
      j({ type: "session_info_changed", name: "x" }),
      j({ type: "model_select", model: { provider: "fake", id: "model" } }),
      j({ type: "text", text: "hello" }),
      j({ type: "session_shutdown", reason: "exit" }),
    ];
    const { events, unknownTypeCount } = parseStream(lines);
    expect(unknownTypeCount).toBe(0);
    expect(
      events
        .map((event) => event.type)
        .sort()
        .join(","),
    ).toBe(
      [
        "message_start",
        "model_select",
        "queue_update",
        "session_info_changed",
        "session_shutdown",
        "session_start",
        "text",
        "thinking_level_select",
        "tool_execution_update",
        "turn_end",
        "turn_start",
      ].join(","),
    );
    const modelSelect = events.find((event) => event.type === "model_select");
    expect(modelSelect).toMatchObject({ provider: "fake", model: "model" });
  });

  test("retains private edit arguments and error text but omits message prose", () => {
    const { events } = parseStream(baseLines({ editError: true }));
    const editStart = events.find(
      (event) => event.type === "tool_execution_start" && event.name === "edit",
    );
    expect(editStart.argsBytes).toBeGreaterThan(0);
    expect(editStart.args.files[0].edits[0].newLines).toEqual(["x"]);
    const editEnd = events.find(
      (event) => event.type === "tool_execution_end" && event.name === "edit",
    );
    expect(editEnd.errorText).toBe("unseen lines");
    const messageEnd = events.find((event) => event.type === "message_end");
    expect(messageEnd.usage.total).toBe(15);
    expect(messageEnd.provider).toBe("fake");
    expect(messageEnd.model).toBe("model");
  });

  test("message_update usage is read from the message (real pi shape) or the event", () => {
    const viaMessage = parseStream([
      j({
        type: "message_update",
        message: { role: "assistant", usage },
      }),
    ]);
    expect(viaMessage.events[0].usage.total).toBe(15);
    const viaEvent = parseStream([
      j({ type: "message_update", usage: usage2 }),
    ]);
    expect(viaEvent.events[0].usage.total).toBe(30);
  });
});

describe("outcome classification", () => {
  test("happy path completes with tokens summed across message_end turns", () => {
    const { events, parseErrors } = parseStream(baseLines());
    const analysis = analyzeProtocol({
      events,
      parseErrors,
      exitCode: 0,
      killReason: null,
    });
    expect(analysis.outcome).toBe("completed");
    expect(analysis.metrics.tokens).toMatchObject({
      total: 45,
      source: "summed",
    });
    expect(analysis.metrics.toolCalls).toMatchObject({
      total: 2,
      read: 1,
      edit: 1,
      errors: 0,
    });
    expect(analysis.metrics.editArgsBytes).toBeGreaterThan(0);
    expect(analysis.metrics.firstEdit).toMatchObject({ status: "success" });
    expect(reportedIdentity(events)).toEqual({
      provider: "fake",
      model: "model",
    });
  });

  test("tool errors are counted and surfaced, not fatal to completion", () => {
    const { events, parseErrors } = parseStream(baseLines({ editError: true }));
    const analysis = analyzeProtocol({
      events,
      parseErrors,
      exitCode: 0,
      killReason: null,
    });
    expect(analysis.outcome).toBe("completed");
    expect(analysis.metrics.toolCalls.errors).toBe(1);
    expect(analysis.metrics.toolCalls.errorTools.edit).toBe(1);
    expect(analysis.metrics.firstEdit.status).toBe("error");
  });

  test("provider retry failure classifies as provider-error and records messages", () => {
    const lines = [
      j({ type: "agent_start" }),
      j({
        type: "auto_retry_start",
        attempt: 1,
        maxAttempts: 1,
        errorMessage: "upstream 429",
      }),
      j({
        type: "auto_retry_end",
        success: false,
        attempt: 1,
        finalError: "gave up",
      }),
    ];
    const { events, parseErrors } = parseStream(lines);
    const analysis = analyzeProtocol({
      events,
      parseErrors,
      exitCode: 0,
      killReason: null,
    });
    expect(analysis.outcome).toBe("provider-error");
    expect(analysis.errors.provider.map((entry) => entry.message)).toEqual([
      "upstream 429",
      "gave up",
    ]);
  });

  test("a retry that recovers is not a permanent provider failure", () => {
    const lines = [
      j({ type: "agent_start" }),
      j({
        type: "auto_retry_start",
        attempt: 1,
        maxAttempts: 2,
        errorMessage: "transient",
      }),
      j({
        type: "auto_retry_end",
        success: false,
        attempt: 1,
        finalError: "transient",
      }),
      j({ type: "auto_retry_start", attempt: 2, maxAttempts: 2 }),
      j({ type: "auto_retry_end", success: true, attempt: 2 }),
      j({
        type: "message_end",
        message: { role: "assistant", content: [], stopReason: "stop", usage },
      }),
      j({ type: "agent_end", messages: [], willRetry: false }),
    ];
    const { events, parseErrors } = parseStream(lines);
    expect(
      analyzeProtocol({ events, parseErrors, exitCode: 0, killReason: null })
        .outcome,
    ).toBe("completed");
  });

  test("only the LAST auto_retry_end decides retry failure", () => {
    const lines = [
      j({ type: "agent_start" }),
      j({ type: "auto_retry_start", attempt: 1, maxAttempts: 2 }),
      j({ type: "auto_retry_end", success: true, attempt: 1 }),
      j({
        type: "auto_retry_start",
        attempt: 2,
        maxAttempts: 2,
        errorMessage: "gone",
      }),
      j({
        type: "auto_retry_end",
        success: false,
        attempt: 2,
        finalError: "gone",
      }),
    ];
    const { events, parseErrors } = parseStream(lines);
    expect(
      analyzeProtocol({ events, parseErrors, exitCode: 0, killReason: null })
        .outcome,
    ).toBe("provider-error");
  });

  test("final lifecycle: the LAST agent_end decides, earlier willRetry is overruled", () => {
    const lines = [
      j({ type: "agent_start" }),
      j({
        type: "message_end",
        message: { role: "assistant", content: [], stopReason: "error", usage },
      }),
      j({ type: "agent_end", messages: [], willRetry: true }),
      j({ type: "agent_start" }),
      j({
        type: "message_end",
        message: { role: "assistant", content: [], stopReason: "stop", usage },
      }),
      j({ type: "agent_end", messages: [], willRetry: false }),
    ];
    const { events, parseErrors } = parseStream(lines);
    expect(
      analyzeProtocol({ events, parseErrors, exitCode: 0, killReason: null })
        .outcome,
    ).toBe("completed");
  });

  test("final assistant stopReason error classifies as assistant-error", () => {
    const lines = [
      j({ type: "agent_start" }),
      j({ type: "message_start", message: { role: "assistant", content: [] } }),
      j({
        type: "message_end",
        message: {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "model blew up",
          usage,
        },
      }),
    ];
    const { events, parseErrors } = parseStream(lines);
    const analysis = analyzeProtocol({
      events,
      parseErrors,
      exitCode: 0,
      killReason: null,
    });
    expect(analysis.outcome).toBe("assistant-error");
    expect(analysis.errors.assistant.map((entry) => entry.message)).toEqual([
      "model blew up",
    ]);
  });

  test("nonzero exit takes precedence even with a completed-looking stream", () => {
    const lines = [
      j({ type: "agent_start" }),
      j({
        type: "message_end",
        message: { role: "assistant", content: [], stopReason: "stop", usage },
      }),
      j({ type: "agent_end", messages: [], willRetry: false }),
    ];
    const { events, parseErrors } = parseStream(lines);
    expect(
      analyzeProtocol({ events, parseErrors, exitCode: 7, killReason: null })
        .outcome,
    ).toBe("process-error");
  });

  test("timeout and max-calls kill reasons classify first", () => {
    const { events, parseErrors } = parseStream(baseLines());
    expect(
      analyzeProtocol({
        events,
        parseErrors,
        exitCode: 0,
        killReason: "timeout",
      }).outcome,
    ).toBe("timeout");
    expect(
      analyzeProtocol({
        events,
        parseErrors,
        exitCode: 0,
        killReason: "max-calls",
      }).outcome,
    ).toBe("tool-call-limit");
    expect(
      analyzeProtocol({
        events,
        parseErrors,
        exitCode: -1,
        killReason: "spawn-error",
      }).outcome,
    ).toBe("process-error");
  });

  test("clean exit without agent_end is no-agent-end", () => {
    const lines = [j({ type: "agent_start" })];
    const { events, parseErrors } = parseStream(lines);
    expect(
      analyzeProtocol({ events, parseErrors, exitCode: 0, killReason: null })
        .outcome,
    ).toBe("no-agent-end");
  });

  test("all-garbage stream classifies as parse-error", () => {
    const { events, parseErrors } = parseStream(["nope", "also-nope"]);
    expect(
      analyzeProtocol({ events, parseErrors, exitCode: 0, killReason: null })
        .outcome,
    ).toBe("parse-error");
    expect(parseErrors).toHaveLength(2);
  });
});

describe("metrics", () => {
  test("first-edit tri-state is none when no edit is attempted", () => {
    const lines = [
      j({
        type: "tool_execution_start",
        toolCallId: "r1",
        toolName: "read",
        args: { path: "a" },
      }),
    ];
    const { events } = parseStream(lines);
    expect(computeMetrics(events).firstEdit).toEqual({
      status: "none",
      argsBytes: 0,
      index: null,
    });
  });

  test("edit started but not finished counts as error (killed mid-edit)", () => {
    const lines = [
      j({
        type: "tool_execution_start",
        toolCallId: "e1",
        toolName: "edit",
        args: { files: [] },
      }),
    ];
    const { events } = parseStream(lines);
    expect(computeMetrics(events).firstEdit.status).toBe("error");
  });

  test("edit argument bytes are measured on the JSON args payload", () => {
    const args = {
      files: [
        {
          path: "a.ts",
          edits: [{ startLine: 3, deleteCount: 1, newLines: ["Z"] }],
        },
      ],
    };
    const lines = [
      j({
        type: "tool_execution_start",
        toolCallId: "e1",
        toolName: "edit",
        args,
      }),
    ];
    const { events } = parseStream(lines);
    const metrics = computeMetrics(events);
    expect(metrics.editArgsBytes).toBe(
      Buffer.byteLength(JSON.stringify(args), "utf8"),
    );
  });

  test("tokens sum across assistant message_end turns", () => {
    const lines = [
      j({
        type: "message_end",
        message: { role: "assistant", content: [], stopReason: "stop", usage },
      }),
      j({
        type: "message_end",
        message: {
          role: "assistant",
          content: [],
          stopReason: "stop",
          usage: usage2,
        },
      }),
      j({
        type: "message_update",
        message: { role: "assistant", content: [], usage: usage2 },
      }),
    ];
    const { events } = parseStream(lines);
    expect(computeMetrics(events).tokens).toMatchObject({
      total: 45,
      source: "summed",
    });
  });

  test("without message_end usage, the last per-message update is the fallback", () => {
    const lines = [
      j({
        type: "message_update",
        message: { role: "assistant", content: [], usage },
      }),
      j({
        type: "message_update",
        message: { role: "assistant", content: [], usage: usage2 },
      }),
    ];
    const { events } = parseStream(lines);
    expect(computeMetrics(events).tokens).toMatchObject({
      total: 30,
      source: "cumulative",
    });
  });

  test("no usage anywhere yields the none record", () => {
    const lines = [j({ type: "message_end", message: { content: [] } })];
    const { events } = parseStream(lines);
    expect(computeMetrics(events).tokens.source).toBe("none");
    expect(computeMetrics(events).tokens.total).toBe(0);
  });

  test("reportedIdentity falls back to null when pi reports nothing", () => {
    const { events } = parseStream([
      j({
        type: "message_end",
        message: { role: "assistant", content: [], stopReason: "stop" },
      }),
    ]);
    expect(reportedIdentity(events)).toBeNull();
  });
});

describe("classifyOutcome stays pure and composable", () => {
  test("killReason and exitCode do not mutate events", () => {
    const { events } = parseStream(baseLines());
    const snapshot = JSON.stringify(events);
    classifyOutcome({
      events,
      parseErrors: [],
      exitCode: 1,
      killReason: "timeout",
    });
    expect(JSON.stringify(events)).toBe(snapshot);
  });
});
