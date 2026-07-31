// @ts-nocheck
import { afterEach, expect, mock, test } from "bun:test";
import { executeNativeCompaction } from "../src/compact-client";
import {
  buildCompactUrl,
  resolveNativeCompactionEnvironment,
} from "../src/runtime";

const baseModel = {
  provider: "openai",
  api: "openai-responses",
  id: "gpt-5-mini",
  name: "gpt-5-mini",
  baseUrl: "https://api.openai.com/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100000,
  maxTokens: 1000,
};

let serializerImportCounter = 0;

async function loadSerializerModule() {
  mock.module("@earendil-works/pi-coding-agent", () => ({
    convertToLlm: (messages: unknown[]) => messages,
  }));
  return import(`../src/serializer.ts?unit=${serializerImportCounter++}`);
}

async function loadPayloadRewriteModule() {
  mock.module("@earendil-works/pi-coding-agent", () => ({
    convertToLlm: (messages: unknown[]) => messages,
  }));
  return import(`../src/payload-rewrite.ts?unit=${serializerImportCounter++}`);
}

afterEach(() => {
  serializerImportCounter = 0;
  mock.restore();
});

test("buildCompactUrl appends the standalone compact path", () => {
  expect(buildCompactUrl("https://api.openai.com/v1")).toBe(
    "https://api.openai.com/v1/responses/compact",
  );
  expect(buildCompactUrl("https://api.openai.com/v1/responses")).toBe(
    "https://api.openai.com/v1/responses/compact",
  );
});

test("resolveNativeCompactionEnvironment accepts authorization header without apiKey", async () => {
  const resolution = await resolveNativeCompactionEnvironment({
    model: {
      provider: "openai",
      api: "openai-responses",
      id: "gpt-5-mini",
      baseUrl: "https://api.openai.com/v1",
    },
    modelRegistry: {
      async getApiKeyAndHeaders() {
        return {
          ok: true,
          apiKey: undefined,
          headers: { authorization: "Bearer header-token" },
        };
      },
    },
  } as never);

  expect(resolution).toEqual({
    ok: true,
    runtime: expect.objectContaining({
      provider: "openai",
      api: "openai-responses",
      model: "gpt-5-mini",
      baseUrl: "https://api.openai.com/v1",
      apiKey: undefined,
      headers: { authorization: "Bearer header-token" },
    }),
  });
});

test("executeNativeCompaction propagates resolved request headers", async () => {
  let fetchArgs: { url?: string; init?: RequestInit } = {};
  globalThis.fetch = mock(
    async (url: string | URL | Request, init?: RequestInit) => {
      fetchArgs = { url: String(url), init };
      return new Response(
        JSON.stringify({
          object: "response.compaction",
          output: [{ type: "compaction", encrypted_content: "opaque" }],
          usage: {
            input_tokens: 100,
            input_tokens_details: { cached_tokens: 25 },
            output_tokens: 10,
            output_tokens_details: { reasoning_tokens: 4 },
            total_tokens: 110,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  ) as unknown as typeof fetch;

  const result = await executeNativeCompaction({
    runtime: {
      provider: "openai",
      api: "openai-responses",
      apiFamily: "openai-responses",
      model: baseModel.id,
      baseUrl: baseModel.baseUrl,
      apiKey: "test-key",
      headers: {
        "x-test-runtime-header": "resolved",
        authorization: "Bearer resolved-header-token",
      },
      compactPath: "responses/compact",
      compactUrl: buildCompactUrl(baseModel.baseUrl),
      currentModel: baseModel as never,
    },
    request: {
      model: baseModel.id,
      instructions: "compact this",
      input: [
        { role: "user", content: [{ type: "input_text", text: "hello" }] },
      ],
    },
  });

  expect(result.ok).toBe(true);
  expect(fetchArgs.url).toBe("https://api.openai.com/v1/responses/compact");
  const headers = new Headers(fetchArgs.init?.headers);
  expect(headers.get("x-test-runtime-header")).toBe("resolved");
  expect(headers.get("authorization")).toBe("Bearer resolved-header-token");
  expect(headers.get("content-type")).toBe("application/json");
  if (!result.ok) throw new Error("Expected native compaction success");
  expect(result.usage).toEqual(
    expect.objectContaining({
      input: 75,
      output: 10,
      cacheRead: 25,
      cacheWrite: 0,
      reasoning: 4,
      totalTokens: 110,
    }),
  );
});

test("executeNativeCompaction rejects output without an encrypted compaction item", async () => {
  globalThis.fetch = mock(
    async () =>
      new Response(
        JSON.stringify({
          object: "response.compaction",
          output: [{ type: "message", role: "assistant", content: [] }],
        }),
        { status: 200 },
      ),
  ) as unknown as typeof fetch;

  const result = await executeNativeCompaction({
    runtime: {
      provider: "openai",
      api: "openai-responses",
      apiFamily: "openai-responses",
      model: baseModel.id,
      baseUrl: baseModel.baseUrl,
      apiKey: "test-key",
      compactPath: "responses/compact",
      compactUrl: buildCompactUrl(baseModel.baseUrl),
      currentModel: baseModel as never,
    },
    request: { model: baseModel.id, input: [], instructions: "compact" },
  });

  expect(result).toEqual({
    ok: false,
    reason: "malformed-response",
    status: 200,
  });
});

test("executeNativeCompaction retries one retryable response", async () => {
  let attempts = 0;
  globalThis.fetch = mock(async () => {
    attempts++;
    if (attempts === 1)
      return new Response("retry", {
        status: 503,
        headers: { "retry-after": "0" },
      });
    return new Response(
      JSON.stringify({
        object: "response.compaction",
        output: [{ type: "compaction", encrypted_content: "opaque" }],
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;

  const result = await executeNativeCompaction({
    runtime: {
      provider: "openai",
      api: "openai-responses",
      apiFamily: "openai-responses",
      model: baseModel.id,
      baseUrl: baseModel.baseUrl,
      apiKey: "test-key",
      compactPath: "responses/compact",
      compactUrl: buildCompactUrl(baseModel.baseUrl),
      currentModel: baseModel as never,
    },
    request: { model: baseModel.id, input: [], instructions: "compact" },
  });

  expect(result.ok).toBe(true);
  expect(attempts).toBe(2);
});

test("executeNativeCompaction does not retain an error response body", async () => {
  globalThis.fetch = mock(
    async () => new Response("sensitive upstream body", { status: 400 }),
  ) as unknown as typeof fetch;
  const result = await executeNativeCompaction({
    runtime: {
      provider: "openai",
      api: "openai-responses",
      apiFamily: "openai-responses",
      model: baseModel.id,
      baseUrl: baseModel.baseUrl,
      apiKey: "test-key",
      compactPath: "responses/compact",
      compactUrl: buildCompactUrl(baseModel.baseUrl),
      currentModel: baseModel as never,
    },
    request: { model: baseModel.id, input: [], instructions: "compact" },
  });

  expect(result).toEqual({ ok: false, reason: "non-2xx", status: 400 });
});

test("compaction input drops transient goal continuation and UI custom messages", async () => {
  const { filterTransientGoalCustomMessages } = await loadSerializerModule();
  const messages = filterTransientGoalCustomMessages([
    {
      role: "user",
      content: [{ type: "text", text: "keep me" }],
      timestamp: 1,
    },
    {
      role: "custom",
      customType: "goal-continuation",
      content: "drop me",
      display: false,
      timestamp: 2,
    },
    {
      role: "custom",
      customType: "goal-ui",
      content: "drop me too",
      display: true,
      timestamp: 3,
    },
    {
      role: "custom",
      customType: "other-extension",
      content: "keep custom",
      display: false,
      timestamp: 4,
    },
  ] as never);

  expect(
    messages.map(
      (message) =>
        (message as { role?: string; customType?: string }).customType ??
        message.role,
    ),
  ).toEqual(["user", "other-extension"]);
});

test("native replay live tail drops transient goal continuation and UI custom entries", async () => {
  const { collectLiveTailMessages } = await loadPayloadRewriteModule();
  const messages = collectLiveTailMessages([
    {
      type: "message",
      id: "user-1",
      timestamp: "2026-01-01T00:00:00.000Z",
      message: { role: "user", content: "keep" },
    },
    {
      type: "custom_message",
      id: "goal-1",
      timestamp: "2026-01-01T00:00:01.000Z",
      customType: "goal-continuation",
      content: "drop",
      display: false,
    },
    {
      type: "custom_message",
      id: "goal-ui-1",
      timestamp: "2026-01-01T00:00:02.000Z",
      customType: "goal-ui",
      content: "drop",
      display: true,
    },
    {
      type: "custom_message",
      id: "other-1",
      timestamp: "2026-01-01T00:00:03.000Z",
      customType: "other-extension",
      content: "keep",
      display: false,
    },
  ] as never);

  expect(
    messages.map(
      (message) =>
        (message as { role?: string; customType?: string }).customType ??
        message.role,
    ),
  ).toEqual(["user", "other-extension"]);
});

test("serializer gives multiple unsigned assistant text blocks unique fallback ids", async () => {
  const { serializeMessagesToResponsesInput } = await loadSerializerModule();
  const input = serializeMessagesToResponsesInput(
    baseModel as never,
    [
      {
        role: "assistant",
        provider: baseModel.provider,
        api: baseModel.api,
        model: baseModel.id,
        stopReason: "stop",
        content: [
          { type: "text", text: "one" },
          { type: "text", text: "two" },
        ],
        timestamp: 2,
      },
    ] as never,
  );

  expect(input.map((item) => (item as { id?: string }).id)).toEqual([
    "msg_0_0",
    "msg_0_1",
  ]);
});

test("serializer drops model-bound reasoning and item ids from foreign model history", async () => {
  const { serializeMessagesToResponsesInput } = await loadSerializerModule();
  const input = serializeMessagesToResponsesInput(
    baseModel as never,
    [
      {
        role: "assistant",
        provider: baseModel.provider,
        api: baseModel.api,
        model: "gpt-foreign",
        stopReason: "toolUse",
        content: [
          {
            type: "thinking",
            thinking: "private",
            thinkingSignature: JSON.stringify({
              type: "reasoning",
              id: "rs_foreign",
              encrypted_content: "opaque",
            }),
          },
          {
            type: "text",
            text: "foreign text",
            textSignature: JSON.stringify({ v: 1, id: "msg_foreign" }),
          },
          {
            type: "toolCall",
            id: "call_foreign|fc_foreign",
            name: "read",
            arguments: {},
          },
        ],
        timestamp: 2,
      },
    ] as never,
  );

  expect(
    input.some((item) => (item as { type?: string }).type === "reasoning"),
  ).toBe(false);
  expect((input[0] as { id?: string }).id).toBe("msg_0_0");
  expect((input[1] as { id?: string }).id).toBeUndefined();
});

test("serializer preserves native image generation output items", async () => {
  const { serializeMessagesToResponsesInput } = await loadSerializerModule();
  const imageCall = {
    type: "image_generation_call",
    item: {
      type: "image_generation_call",
      id: "ig_1",
      status: "completed",
      result: null,
    },
  };
  const input = serializeMessagesToResponsesInput(
    baseModel as never,
    [
      {
        role: "assistant",
        provider: baseModel.provider,
        api: baseModel.api,
        model: baseModel.id,
        stopReason: "stop",
        content: [imageCall],
        timestamp: 2,
      },
    ] as never,
  );

  expect(input).toEqual([imageCall.item]);
});

test("serializer sanitizes unpaired surrogates in instructions and message content", async () => {
  const {
    serializeMessagesToCompactRequest,
    serializeMessagesToResponsesInput,
  } = await loadSerializerModule();
  const invalid = "\ud800Hello\udc00";
  const request = serializeMessagesToCompactRequest({
    model: baseModel as never,
    instructions: `Prefix ${invalid}`,
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: invalid }],
        timestamp: 1,
      },
      {
        role: "assistant",
        provider: baseModel.provider,
        api: baseModel.api,
        model: baseModel.id,
        stopReason: "stop",
        content: [
          {
            type: "text",
            text: invalid,
            textSignature: JSON.stringify({ v: 1, id: "msg_1" }),
          },
        ],
        timestamp: 2,
      },
      {
        role: "toolResult",
        toolCallId: "call_1|fc_call_1",
        toolName: "read",
        isError: false,
        content: [{ type: "text", text: invalid }],
        timestamp: 3,
      },
    ],
  });

  expect(JSON.stringify(request.instructions)).not.toContain("\\ud800");
  expect(JSON.stringify(request.input)).not.toContain("\\ud800");
  expect(JSON.stringify(request.input)).not.toContain("\\udc00");

  const inputOnly = serializeMessagesToResponsesInput(
    baseModel as never,
    [
      {
        role: "user",
        content: [{ type: "text", text: invalid }],
        timestamp: 1,
      },
    ] as never,
  );
  expect(JSON.stringify(inputOnly)).not.toContain("\\ud800");
  expect(JSON.stringify(inputOnly)).not.toContain("\\udc00");
});
