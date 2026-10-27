import type { FirefoxClientTransport } from "./types.js";

export type FirefoxBrowserTab = { id: number; windowId: number; url: string };
export type FirefoxVerifiedContainer = {
  cookieStoreId: string;
  name: string | null;
  evidence: "verified";
};
export type FirefoxReplacementConfirmation = {
  id: string;
  session: string;
  previousTabId: number;
  candidate: FirefoxBrowserTab;
  container: FirefoxVerifiedContainer;
  expiresAt: string;
};
export type FirefoxBrowserFailure = {
  ok: false;
  code: string;
  message: string;
  recovery: { command: string; args: string[] } | null;
  confirmation?: FirefoxReplacementConfirmation;
};
export type FirefoxBrowserResult<T> =
  | {
      ok: true;
      session: string;
      tab: FirefoxBrowserTab;
      container: FirefoxVerifiedContainer;
      result: T;
      warnings: string[];
    }
  | FirefoxBrowserFailure;
export type FirefoxBrowserOptions = {
  binaryPath?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  settleTimeoutMs?: number;
  containerNames?: Record<string, string>;
  transport?: FirefoxClientTransport;
};

export type BrowserConfig = {
  binaryPath: string;
  timeoutMs: number;
  maxOutputBytes: number;
  settleTimeoutMs: number;
  containerNames: Record<string, string>;
  transport?: FirefoxClientTransport;
};
export type BrowserSession = {
  tabId: number;
  windowId: number;
  cookieStoreId: string;
  expectedContainerId?: string;
  expectedUrl: string;
  closed: boolean;
  uncertain: boolean;
  pending?: PendingReplacement;
  lastUsedAtMs?: number;
  documentEpoch?: number;
};
export type PendingReplacement = {
  publicValue: FirefoxReplacementConfirmation;
  candidateUrl: string;
  candidateContainerId: string;
  expectedContainerId?: string;
  expiresAtMs: number;
};
export function cloneConfirmation(
  value: FirefoxReplacementConfirmation,
): FirefoxReplacementConfirmation {
  return {
    id: value.id,
    session: value.session,
    previousTabId: value.previousTabId,
    candidate: { ...value.candidate },
    container: { ...value.container },
    expiresAt: value.expiresAt,
  };
}
export type WindowInfo = { id: number; private: boolean };
export type TabInfo = {
  id: number;
  windowId: number;
  url: string;
  private: boolean;
  active?: boolean;
  cookieStoreId?: string;
};

export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 64_000;
export const DEFAULT_SETTLE_TIMEOUT_MS = 2_000;
export const MAX_SUMMARY_BYTES = 16_000;
const MAX_SESSION_LENGTH = 80;
const MAX_SETTLE_TIMEOUT_MS = 30_000;

export function validateOptions(
  options: FirefoxBrowserOptions,
):
  | { ok: true; value: BrowserConfig }
  | { ok: false; error: FirefoxBrowserFailure } {
  if (!record(options))
    return {
      ok: false,
      error: fail("invalid_options", "Firefox browser options are invalid."),
    };
  const {
    binaryPath,
    timeoutMs,
    maxOutputBytes,
    settleTimeoutMs,
    containerNames,
    transport,
  } = options;
  if (
    (binaryPath !== undefined &&
      (typeof binaryPath !== "string" || !binaryPath.trim())) ||
    (timeoutMs !== undefined && !boundedInt(timeoutMs, 1, 120_000)) ||
    (maxOutputBytes !== undefined &&
      !boundedInt(maxOutputBytes, 1, 10_000_000)) ||
    (settleTimeoutMs !== undefined &&
      !boundedInt(settleTimeoutMs, 1, MAX_SETTLE_TIMEOUT_MS)) ||
    (transport !== undefined && typeof transport !== "function") ||
    (containerNames !== undefined &&
      (!record(containerNames) ||
        Object.values(containerNames).some(
          (name) => typeof name !== "string" || name.length > 120,
        )))
  )
    return {
      ok: false,
      error: fail("invalid_options", "Firefox browser options are invalid."),
    };

  return {
    ok: true,
    value: {
      binaryPath: binaryPath ?? "firefox-cli",
      timeoutMs: timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxOutputBytes: maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      settleTimeoutMs: settleTimeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS,
      containerNames: { ...containerNames },
      ...(transport ? { transport } : {}),
    },
  };
}

export function validateEnsureInput(input: {
  session: string;
  url?: string;
  containerId?: string;
  windowId?: number;
}): FirefoxBrowserFailure | null {
  if (
    !input ||
    !validSession(input.session) ||
    (input.url !== undefined && !validUrl(input.url)) ||
    (input.containerId !== undefined && !validContainer(input.containerId)) ||
    (input.windowId !== undefined && !isId(input.windowId))
  )
    return fail("invalid_input", "Browser session input is invalid.");
  return null;
}
export function validateGoInput(input: {
  session: string;
  url: string;
  containerId?: string;
}): FirefoxBrowserFailure | null {
  if (
    !input ||
    !validSession(input.session) ||
    !validUrl(input.url) ||
    (input.containerId !== undefined && !validContainer(input.containerId))
  )
    return fail("invalid_input", "Browser navigation input is invalid.");
  return null;
}
export function validateReadInput(input: {
  session: string;
  maxBytes?: number;
}): FirefoxBrowserFailure | null {
  if (
    !input ||
    !validSession(input.session) ||
    (input.maxBytes !== undefined &&
      !boundedInt(input.maxBytes, 256, MAX_SUMMARY_BYTES))
  )
    return fail("invalid_input", "Browser read input is invalid.");
  return null;
}
export function validSession(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= MAX_SESSION_LENGTH &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}
function validContainer(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 200 &&
    !/[\u0000-\u001f]/.test(value)
  );
}
export function validUrl(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length > 4_096 ||
    /[\u0000-\u0020]/.test(value)
  )
    return false;
  if (value === "about:blank") return true;
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      Boolean(url.hostname) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}
export function sameUrl(actual: string, expected: string): boolean {
  try {
    return new URL(actual).href === new URL(expected).href;
  } catch {
    return actual === expected;
  }
}
export function safeUrl(value: string): string {
  if (value === "about:blank") return value;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:")
      return "about:blank";
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.href;
  } catch {
    return "about:blank";
  }
}
export function boundedInt(value: number, min: number, max: number): boolean {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}
export function isId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function fail(
  code: string,
  message: string,
  recovery: FirefoxBrowserFailure["recovery"] = null,
): FirefoxBrowserFailure {
  return { ok: false, code, message, recovery };
}
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
