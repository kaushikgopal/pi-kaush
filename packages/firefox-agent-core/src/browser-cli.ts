import { parseCliVersion, parseDoctorOutput } from "./parsers.js";
import { runFirefoxCli } from "./transport.js";
import type {
  FirefoxBrowserFailure,
  BrowserConfig,
  TabInfo,
  WindowInfo,
} from "./browser-types.js";
import type {
  FirefoxTransportOptions,
  FirefoxTransportResult,
} from "./types.js";
import { fail, isId, record } from "./browser-types.js";

type CommandResult =
  | { ok: true; value: FirefoxTransportResult }
  | { ok: false; error: FirefoxBrowserFailure };
type JsonResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: FirefoxBrowserFailure };

export function createBrowserCli(config: BrowserConfig) {
  let healthReady = false;
  let healthWarnings: string[] = [];

  async function cli(
    args: readonly string[],
    signal?: AbortSignal,
  ): Promise<CommandResult> {
    let result: FirefoxTransportResult;
    try {
      result = await (config.transport ?? runFirefoxCli)(
        config.binaryPath,
        args,
        {
          timeoutMs: config.timeoutMs,
          maxOutputBytes: config.maxOutputBytes,
          ...(signal ? { signal } : {}),
        } satisfies FirefoxTransportOptions,
      );
    } catch {
      return {
        ok: false,
        error: fail(
          "cli_transport_failed",
          "Firefox CLI could not be started.",
        ),
      };
    }
    if (
      !result ||
      typeof result.stdout !== "string" ||
      typeof result.stderr !== "string" ||
      !(
        result.exitCode === null ||
        (Number.isSafeInteger(result.exitCode) && result.exitCode >= 0)
      )
    )
      return {
        ok: false,
        error: fail(
          "cli_transport_failed",
          "Firefox CLI returned an invalid process result.",
        ),
      };
    if (
      Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) >
      config.maxOutputBytes
    )
      return {
        ok: false,
        error: fail(
          "output_limit",
          "Firefox CLI output exceeded the configured limit.",
        ),
      };
    if (result.error) {
      const codes: Record<
        NonNullable<FirefoxTransportResult["error"]>,
        [string, string]
      > = {
        "not-found": ["cli_not_found", "Firefox CLI executable was not found."],
        "permission-denied": [
          "cli_permission_denied",
          "Firefox CLI executable cannot be run.",
        ],
        "spawn-failed": [
          "cli_spawn_failed",
          "Firefox CLI could not be started.",
        ],
        timeout: ["timeout", "Firefox CLI command timed out."],
        aborted: ["aborted", "The browser operation was cancelled."],
        "output-limit": [
          "output_limit",
          "Firefox CLI output exceeded the configured limit.",
        ],
      };
      if (!Object.hasOwn(codes, result.error))
        return {
          ok: false,
          error: fail(
            "cli_transport_failed",
            "Firefox CLI returned an invalid process result.",
          ),
        };
      const [code, message] = codes[result.error];
      return { ok: false, error: fail(code, message) };
    }
    if (signal?.aborted)
      return {
        ok: false,
        error: fail("aborted", "The browser operation was cancelled."),
      };
    return { ok: true, value: result };
  }

  async function jsonCommand(
    args: readonly string[],
    signal?: AbortSignal,
  ): Promise<JsonResult> {
    const result = await cli(args, signal);
    if (!result.ok) return result;
    if (result.value.exitCode !== 0) {
      const stderr = result.value.stderr;
      if (/\bREF_NOT_FOUND\b/u.test(stderr))
        return {
          ok: false,
          error: fail(
            "stale_ref",
            "Firefox no longer resolves this reference.",
          ),
        };
      if (/\bUNSUPPORTED_CAPABILITY\b/u.test(stderr))
        return {
          ok: false,
          error: fail(
            "unsupported_capability",
            "Firefox does not support this operation.",
          ),
        };
      if (/\bSCRIPT_INJECTION_(?:FAILED|BLOCKED)\b/u.test(stderr))
        return {
          ok: false,
          error: fail(
            "script_injection_blocked",
            "Firefox could not access this page.",
          ),
        };
      if (/\bPERMISSION_DENIED\b/u.test(stderr))
        return {
          ok: false,
          error: fail("permission_denied", "Firefox denied this operation."),
        };
      if (/\bTIMEOUT\b/u.test(stderr))
        return {
          ok: false,
          error: fail("timeout", "Firefox command timed out."),
        };
      return {
        ok: false,
        error: fail("cli_command_failed", "Firefox CLI command failed."),
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.value.stdout);
    } catch {
      return {
        ok: false,
        error: fail(
          "invalid_cli_response",
          "Firefox CLI returned invalid browser data.",
        ),
      };
    }
    if (!record(parsed))
      return {
        ok: false,
        error: fail(
          "invalid_cli_response",
          "Firefox CLI returned invalid browser data.",
        ),
      };
    return { ok: true, value: parsed };
  }

  async function ensureHealth(
    signal?: AbortSignal,
  ): Promise<FirefoxBrowserFailure | { ok: true }> {
    if (healthReady) return { ok: true };
    const version = await cli(["--version"], signal);
    if (!version.ok) return version.error;
    if (version.value.exitCode !== 0)
      return fail("cli_command_failed", "Firefox CLI version check failed.");
    const cliVersion = parseCliVersion(version.value.stdout);
    if (!cliVersion)
      return fail(
        "invalid_cli_version",
        "Firefox CLI returned an invalid version.",
      );
    const doctor = await cli(["doctor", "--json"], signal);
    if (!doctor.ok) return doctor.error;
    if (doctor.value.exitCode !== 0 && doctor.value.exitCode !== 1)
      return fail("cli_command_failed", "Firefox CLI health check failed.");
    const status = parseDoctorOutput(doctor.value.stdout);
    if (!status)
      return fail(
        "invalid_doctor_response",
        "Firefox CLI returned an unknown health response.",
      );
    if (status.connection !== "connected")
      return fail(
        "cli_unavailable",
        "Firefox CLI is not connected to Firefox.",
        {
          command: "firefox-cli",
          args: ["doctor", "--json"],
        },
      );
    healthWarnings =
      cliVersion === "0.4.1"
        ? []
        : [`Supported firefox-cli version is 0.4.1; detected ${cliVersion}.`];
    healthReady = true;
    return { ok: true };
  }

  async function listWindows(
    signal?: AbortSignal,
  ): Promise<
    | { ok: true; value: WindowInfo[] }
    | { ok: false; error: FirefoxBrowserFailure }
  > {
    const response = await jsonCommand(["window", "--json"], signal);
    if (!response.ok) return response;
    if (!Array.isArray(response.value.windows)) return invalidData();
    const windows: WindowInfo[] = [];
    for (const item of response.value.windows) {
      if (!record(item) || !isId(item.id) || typeof item.private !== "boolean")
        return invalidData();
      windows.push({ id: item.id, private: item.private });
    }
    return { ok: true, value: windows };
  }

  async function listTabs(
    windowId: number,
    signal?: AbortSignal,
  ): Promise<
    { ok: true; value: TabInfo[] } | { ok: false; error: FirefoxBrowserFailure }
  > {
    const response = await jsonCommand(
      ["tab", "--window", `id:${windowId}`, "--json"],
      signal,
    );
    if (!response.ok) return response;
    if (!Array.isArray(response.value.tabs)) return invalidData();
    const tabs: TabInfo[] = [];
    for (const item of response.value.tabs) {
      if (
        !record(item) ||
        !isId(item.id) ||
        !isId(item.windowId) ||
        typeof item.url !== "string" ||
        typeof item.private !== "boolean" ||
        (item.active !== undefined && typeof item.active !== "boolean") ||
        (item.cookieStoreId !== undefined &&
          typeof item.cookieStoreId !== "string")
      )
        return invalidData();
      tabs.push({
        id: item.id,
        windowId: item.windowId,
        url: item.url,
        private: item.private,
        ...(typeof item.active === "boolean" ? { active: item.active } : {}),
        ...(typeof item.cookieStoreId === "string"
          ? { cookieStoreId: item.cookieStoreId }
          : {}),
      });
    }
    return { ok: true, value: tabs };
  }

  return {
    cli,
    jsonCommand,
    ensureHealth,
    listWindows,
    listTabs,
    getWarnings: () => [...healthWarnings],
  };
}

function invalidData(): { ok: false; error: FirefoxBrowserFailure } {
  return {
    ok: false,
    error: fail(
      "invalid_cli_response",
      "Firefox CLI returned invalid browser data.",
    ),
  };
}
