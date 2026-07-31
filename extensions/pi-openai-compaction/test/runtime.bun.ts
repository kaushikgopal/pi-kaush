// @ts-nocheck
import { describe, expect, test } from "bun:test";
import { resolveNativeCompactionEnvironment } from "../src/runtime";

describe("resolveNativeCompactionEnvironment", () => {
  test("uses getApiKeyAndHeaders to resolve request auth", async () => {
    const resolution = await resolveNativeCompactionEnvironment({
      model: {
        provider: "openai",
        api: "openai-responses",
        id: "gpt-5.4",
        baseUrl: "https://example.com/v1",
      },
      modelRegistry: {
        async getApiKeyAndHeaders(model: { provider: string; id: string }) {
          if (model.provider !== "openai" || model.id !== "gpt-5.4") {
            return { ok: false, error: "unexpected model" };
          }
          return {
            ok: true,
            apiKey: "sk-openai",
            headers: {
              "x-test-request-header": "present",
            },
          };
        },
      },
    } as any);

    expect(resolution).toEqual({
      ok: true,
      runtime: expect.objectContaining({
        provider: "openai",
        api: "openai-responses",
        model: "gpt-5.4",
        baseUrl: "https://example.com/v1",
        apiKey: "sk-openai",
        headers: {
          "x-test-request-header": "present",
        },
        compactPath: "responses/compact",
        compactUrl: "https://example.com/v1/responses/compact",
      }),
    });
  });

  test("accepts Gateway authorization headers and uses the effective auth base URL", async () => {
    const resolution = await resolveNativeCompactionEnvironment({
      model: {
        provider: "instacart-openai",
        api: "openai-responses",
        id: "gpt-5.6-luna",
        baseUrl: "https://model-config.example/v1",
      },
      modelRegistry: {
        async getApiKeyAndHeaders() {
          return {
            ok: true,
            apiKey: undefined,
            headers: { "cf-aig-authorization": "gateway-token" },
          };
        },
        async getProviderAuth() {
          return { auth: { baseUrl: "https://effective-gateway.example/v1" } };
        },
      },
    } as any);

    expect(resolution).toEqual({
      ok: true,
      runtime: expect.objectContaining({
        baseUrl: "https://effective-gateway.example/v1",
        compactUrl: "https://effective-gateway.example/v1/responses/compact",
        headers: { "cf-aig-authorization": "gateway-token" },
      }),
    });
  });

  test("resolveAuth false validates payloads without resolving credentials", async () => {
    const resolution = await resolveNativeCompactionEnvironment(
      {
        model: {
          provider: "openai",
          api: "openai-responses",
          id: "gpt-5.4",
          baseUrl: "https://example.com/v1",
        },
        modelRegistry: {
          getApiKeyAndHeaders: async () => {
            throw new Error("must not resolve auth");
          },
        },
      } as any,
      { resolveAuth: false },
      { model: "gpt-5.4", input: [] },
    );

    expect(resolution.ok).toBe(true);
  });

  test("returns missing-api-key when request auth resolves without an api key", async () => {
    const resolution = await resolveNativeCompactionEnvironment({
      model: {
        provider: "openai",
        api: "openai-responses",
        id: "gpt-5.4",
        baseUrl: "https://example.com/v1",
      },
      modelRegistry: {
        async getApiKeyAndHeaders() {
          return {
            ok: true,
            apiKey: undefined,
            headers: {
              "x-test-request-header": "present",
            },
          };
        },
      },
    } as any);

    expect(resolution).toEqual({
      ok: false,
      reason: "missing-api-key",
      provider: "openai",
      api: "openai-responses",
      model: "gpt-5.4",
      baseUrl: "https://example.com/v1",
    });
  });

  test("honors configured supportedProviders for OpenAI-compatible proxies", async () => {
    const resolution = await resolveNativeCompactionEnvironment(
      {
        model: {
          provider: "custom-litellm",
          api: "openai-responses",
          id: "gpt-5.4",
          baseUrl: "https://proxy.example.com/v1",
        },
        modelRegistry: {
          async getApiKeyAndHeaders(model: { provider: string; id: string }) {
            if (model.provider !== "custom-litellm" || model.id !== "gpt-5.4") {
              return { ok: false, error: "unexpected model" };
            }
            return {
              ok: true,
              apiKey: "sk-custom-litellm",
              headers: {
                "x-proxy-header": "proxy-value",
              },
            };
          },
        },
      } as any,
      {
        supportedProviders: ["custom-litellm"],
        supportedApis: ["openai-responses"],
      },
    );

    expect(resolution).toEqual({
      ok: true,
      runtime: expect.objectContaining({
        provider: "custom-litellm",
        api: "openai-responses",
        model: "gpt-5.4",
        baseUrl: "https://proxy.example.com/v1",
        apiKey: "sk-custom-litellm",
        headers: {
          "x-proxy-header": "proxy-value",
        },
        compactPath: "responses/compact",
        compactUrl: "https://proxy.example.com/v1/responses/compact",
      }),
    });
  });
});
