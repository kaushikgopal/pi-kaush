import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_SUPPORTED_APIS, DEFAULT_SUPPORTED_PROVIDERS } from "./types";
const OPENAI_COMPACT_PATH = "responses/compact";

type DefaultSupportedApi = (typeof DEFAULT_SUPPORTED_APIS)[number];

type RuntimeModel = Model<Api>;

type NativeCompactionFailureReason =
  | "disabled"
  | "missing-model"
  | "unsupported-provider"
  | "unsupported-api"
  | "missing-base-url"
  | "missing-api-key"
  | "unsupported-payload"
  | "payload-model-mismatch";

export type NativeCompactionSupportOptions = {
  enabled?: boolean;
  supportedProviders?: readonly string[];
  supportedApis?: readonly string[];
  model?: RuntimeModel;
  signal?: AbortSignal;
  resolveAuth?: boolean;
};

export type ResponsesCompatibleRequestPayload = {
  model: string;
  input: unknown[];
  instructions?: unknown;
  [key: string]: unknown;
};

export type NativeCompactionRuntime = {
  provider: string;
  api: DefaultSupportedApi;
  apiFamily: DefaultSupportedApi;
  model: string;
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
  compactPath: string;
  compactUrl: string;
  payload?: ResponsesCompatibleRequestPayload;
  currentModel: RuntimeModel;
};

export type NativeCompactionEnvironmentFailure = {
  ok: false;
  reason: NativeCompactionFailureReason;
  provider?: string;
  api?: string;
  model?: string;
  baseUrl?: string;
};

export type NativeCompactionEnvironmentSuccess = {
  ok: true;
  runtime: NativeCompactionRuntime;
};

export type NativeCompactionEnvironmentResolution =
  | NativeCompactionEnvironmentFailure
  | NativeCompactionEnvironmentSuccess;

function normalizeConfiguredSet(
  values: readonly string[] | undefined,
  defaults: readonly string[],
): Set<string> {
  const source = values && values.length > 0 ? values : defaults;
  return new Set(
    source.map((value) => value.trim()).filter((value) => value.length > 0),
  );
}

export function normalizeBaseUrl(
  baseUrl: string | undefined | null,
): string | undefined {
  const normalized = baseUrl?.trim().replace(/\/+$/, "");
  return normalized ? normalized : undefined;
}

export function buildCompactUrl(baseUrl: string): string {
  const normalized = normalizeBaseUrl(baseUrl) ?? baseUrl;
  if (normalized.endsWith("/responses")) {
    return `${normalized}/compact`;
  }
  return `${normalized}/${OPENAI_COMPACT_PATH}`;
}

export function buildCompactPath(): string {
  return OPENAI_COMPACT_PATH;
}

async function resolveRequestAuth(
  ctx: ExtensionContext,
  model: RuntimeModel,
  signal?: AbortSignal,
): Promise<{
  apiKey?: string;
  headers?: Record<string, string>;
  baseUrl?: string;
}> {
  const modelRegistry = ctx.modelRegistry as {
    getApiKeyAndHeaders?: (
      currentModel: RuntimeModel,
    ) => Promise<
      | { ok: true; apiKey?: string; headers?: Record<string, string> }
      | { ok: false; error: string }
    >;
    getProviderAuth?: (
      provider: string,
    ) => Promise<{ auth: { baseUrl?: string } } | undefined>;
  };

  if (typeof modelRegistry.getApiKeyAndHeaders !== "function") {
    return {};
  }

  const authPromise = modelRegistry.getApiKeyAndHeaders(model);
  const providerAuthPromise =
    modelRegistry.getProviderAuth?.(model.provider) ??
    Promise.resolve(undefined);
  const timeoutSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
    : AbortSignal.timeout(15_000);
  const abortPromise = new Promise<never>((_resolve, reject) => {
    timeoutSignal.addEventListener(
      "abort",
      () => reject(new Error("auth resolution aborted")),
      { once: true },
    );
  });
  try {
    const [authResult, providerAuthResult] = await Promise.race([
      Promise.allSettled([authPromise, providerAuthPromise]),
      abortPromise,
    ]);
    const auth =
      authResult.status === "fulfilled" ? authResult.value : undefined;
    const providerAuth =
      providerAuthResult.status === "fulfilled"
        ? providerAuthResult.value
        : undefined;
    return {
      ...(auth?.ok ? { apiKey: auth.apiKey, headers: auth.headers } : {}),
      baseUrl: providerAuth?.auth.baseUrl,
    };
  } catch {
    return {};
  }
}

export function isSupportedApi(api: string): api is DefaultSupportedApi {
  return (DEFAULT_SUPPORTED_APIS as readonly string[]).includes(api);
}

export function isResponsesCompatiblePayload(
  payload: unknown,
): payload is ResponsesCompatibleRequestPayload {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return false;
  }

  const candidate = payload as Record<string, unknown>;
  return typeof candidate.model === "string" && Array.isArray(candidate.input);
}

export function getRuntimeModelDescriptor(model: RuntimeModel | undefined): {
  provider?: string;
  api?: string;
  model?: string;
  baseUrl?: string;
} {
  if (!model) {
    return {};
  }

  return {
    provider: model.provider,
    api: model.api,
    model: model.id,
    baseUrl: normalizeBaseUrl(model.baseUrl),
  };
}

export async function resolveNativeCompactionEnvironment(
  ctx: ExtensionContext,
  options: NativeCompactionSupportOptions = {},
  payload?: unknown,
): Promise<NativeCompactionEnvironmentResolution> {
  if (options.enabled === false) {
    return {
      ok: false,
      reason: "disabled",
    };
  }

  const currentModel = options.model ?? ctx.model;
  const descriptor = getRuntimeModelDescriptor(currentModel);
  if (
    !currentModel ||
    !descriptor.provider ||
    !descriptor.api ||
    !descriptor.model
  ) {
    return {
      ok: false,
      reason: "missing-model",
      ...descriptor,
    };
  }

  const supportedProviders = normalizeConfiguredSet(
    options.supportedProviders,
    DEFAULT_SUPPORTED_PROVIDERS,
  );
  if (!supportedProviders.has(descriptor.provider)) {
    return {
      ok: false,
      reason: "unsupported-provider",
      ...descriptor,
    };
  }

  const supportedApis = normalizeConfiguredSet(
    options.supportedApis,
    DEFAULT_SUPPORTED_APIS,
  );
  if (!isSupportedApi(descriptor.api) || !supportedApis.has(descriptor.api)) {
    return {
      ok: false,
      reason: "unsupported-api",
      ...descriptor,
    };
  }

  let requestPayload: ResponsesCompatibleRequestPayload | undefined;
  if (payload !== undefined) {
    if (!isResponsesCompatiblePayload(payload)) {
      return {
        ok: false,
        reason: "unsupported-payload",
        ...descriptor,
      };
    }

    if (payload.model !== descriptor.model) {
      return {
        ok: false,
        reason: "payload-model-mismatch",
        ...descriptor,
      };
    }

    requestPayload = payload;
  }

  const {
    apiKey,
    headers,
    baseUrl: authBaseUrl,
  } = options.resolveAuth === false
    ? {}
    : await resolveRequestAuth(ctx, currentModel, options.signal);
  const baseUrl = normalizeBaseUrl(authBaseUrl) ?? descriptor.baseUrl;
  if (!baseUrl) {
    return {
      ok: false,
      reason: "missing-base-url",
      ...descriptor,
    };
  }
  const hasRequestAuthHeader = Object.entries(headers ?? {}).some(
    ([key, value]) =>
      (key.toLowerCase() === "authorization" ||
        key.toLowerCase() === "cf-aig-authorization") &&
      typeof value === "string" &&
      value.trim().length > 0,
  );
  if (options.resolveAuth !== false && !apiKey && !hasRequestAuthHeader) {
    return {
      ok: false,
      reason: "missing-api-key",
      ...descriptor,
    };
  }

  return {
    ok: true,
    runtime: {
      provider: descriptor.provider,
      api: descriptor.api,
      apiFamily: descriptor.api,
      model: descriptor.model,
      baseUrl,
      apiKey,
      headers,
      compactPath: buildCompactPath(),
      compactUrl: buildCompactUrl(baseUrl),
      payload: requestPayload,
      currentModel,
    },
  };
}
