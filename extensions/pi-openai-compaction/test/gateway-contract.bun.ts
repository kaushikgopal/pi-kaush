// @ts-nocheck
import { executeNativeCompaction } from "../src/compact-client";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const LIVE = process.env.PI_OPENAI_COMPACTION_LIVE === "1";
const PROVIDER = process.env.PI_OPENAI_COMPACTION_PROVIDER ?? "openai";
const MODEL = process.env.PI_OPENAI_COMPACTION_MODEL ?? "gpt-5.4";
const MODELS_PATH =
  process.env.PI_MODELS_PATH ?? join(homedir(), ".pi", "agent", "models.json");

type ProviderConfig = {
  baseUrl?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  models?: Array<{ id?: string }>;
};

type ModelsConfig = {
  providers?: Record<string, ProviderConfig>;
};

type ResponseEnvelope = {
  object?: string;
  output?: Array<Record<string, unknown>>;
};

function expandEnv(value: string): string {
  return value.replace(
    /\$([A-Z_][A-Z0-9_]*)/g,
    (_match, name: string) => process.env[name] ?? "",
  );
}

function loadProvider(): Required<Pick<ProviderConfig, "baseUrl">> &
  ProviderConfig {
  const config = JSON.parse(readFileSync(MODELS_PATH, "utf8")) as ModelsConfig;
  const provider = config.providers?.[PROVIDER];
  if (!provider?.baseUrl)
    throw new Error(`Provider ${PROVIDER} is missing a base URL`);
  if (!provider.models?.some((model) => model.id === MODEL))
    throw new Error(`Model ${MODEL} is not configured for ${PROVIDER}`);
  return { ...provider, baseUrl: provider.baseUrl.replace(/\/+$/, "") };
}

function buildHeaders(provider: ProviderConfig): Headers {
  const headers = new Headers({
    accept: "application/json",
    "content-type": "application/json",
  });
  for (const [name, value] of Object.entries(provider.headers ?? {})) {
    const expanded = expandEnv(value);
    if (!expanded)
      throw new Error(
        `Header ${name} references an unset environment variable`,
      );
    headers.set(name, expanded);
  }
  const apiKey = provider.apiKey ? expandEnv(provider.apiKey) : undefined;
  if (apiKey && !headers.has("authorization"))
    headers.set("authorization", `Bearer ${apiKey}`);
  return headers;
}

async function postJson(
  url: string,
  headers: Headers,
  body: unknown,
): Promise<ResponseEnvelope> {
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!response.ok)
    throw new Error(`Gateway request failed with HTTP ${response.status}`);
  const parsed = await response.json();
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Gateway returned a non-object response");
  return parsed as ResponseEnvelope;
}

function hasEncryptedItem(
  output: ResponseEnvelope["output"],
  type: string,
): boolean {
  return Boolean(
    output?.some(
      (item) =>
        item.type === type &&
        typeof item.encrypted_content === "string" &&
        item.encrypted_content.length > 0,
    ),
  );
}

function outputText(output: ResponseEnvelope["output"]): string {
  return (output ?? [])
    .flatMap((item) => (Array.isArray(item.content) ? item.content : []))
    .filter(
      (item): item is Record<string, unknown> =>
        Boolean(item) && typeof item === "object" && !Array.isArray(item),
    )
    .filter(
      (item) => item.type === "output_text" && typeof item.text === "string",
    )
    .map((item) => item.text as string)
    .join("\n")
    .trim();
}

test.skipIf(!LIVE)(
  "Gateway compacts encrypted reasoning and replays the canonical window",
  async () => {
    const provider = loadProvider();
    const headers = buildHeaders(provider);
    const responsesUrl = `${provider.baseUrl}/responses`;
    const compactUrl = `${responsesUrl}/compact`;
    const initialInput = [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: "Synthetic protocol test: red is 7 and blue is 11. Compute red multiplied by blue plus 5 internally. Reply only with READY and retain the checksum.",
          },
        ],
      },
    ];

    const initial = await postJson(responsesUrl, headers, {
      model: MODEL,
      store: false,
      stream: false,
      include: ["reasoning.encrypted_content"],
      reasoning: { effort: "low" },
      input: initialInput,
    });
    expect(initial.object).toBe("response");
    expect(hasEncryptedItem(initial.output, "reasoning")).toBe(true);

    const compacted = await executeNativeCompaction({
      runtime: {
        provider: PROVIDER,
        api: "openai-responses",
        apiFamily: "openai-responses",
        model: MODEL,
        baseUrl: provider.baseUrl,
        headers: Object.fromEntries(headers.entries()),
        compactPath: "responses/compact",
        compactUrl,
        currentModel: {
          id: MODEL,
          name: MODEL,
          provider: PROVIDER,
          api: "openai-responses",
          baseUrl: provider.baseUrl,
          reasoning: true,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 272_000,
          maxTokens: 128_000,
        },
      },
      request: {
        model: MODEL,
        instructions: "Preserve durable conversation state for continuation.",
        input: [...initialInput, ...(initial.output ?? [])],
      },
    });
    expect(compacted.ok).toBe(true);
    if (!compacted.ok)
      throw new Error(`Native compact failed: ${compacted.reason}`);
    expect(hasEncryptedItem(compacted.compactedWindow, "compaction")).toBe(
      true,
    );

    const replay = await postJson(responsesUrl, headers, {
      model: MODEL,
      store: false,
      stream: false,
      include: ["reasoning.encrypted_content"],
      input: [
        ...compacted.compactedWindow,
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: "What checksum did you compute? Reply with only the number.",
            },
          ],
        },
      ],
    });
    expect(replay.object).toBe("response");
    expect(outputText(replay.output)).toBe("82");
  },
  60_000,
);
