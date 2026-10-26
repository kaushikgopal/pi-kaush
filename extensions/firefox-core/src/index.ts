import { parseCliVersion, parseDoctorOutput } from "./parsers.js";
import { runFirefoxCli } from "./transport.js";
import type {
  FirefoxClientTransport,
  FirefoxStatusResult,
  FirefoxTransportOptions,
  FirefoxTransportResult,
} from "./types.js";

export type { FirefoxStatusResult } from "./types.js";

export const SUPPORTED_FIREFOX_CLI_VERSION = "0.4.1";

const DEFAULT_BINARY_PATH = "firefox-cli";
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_OUTPUT_BYTES = 64_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 10_000_000;

export interface FirefoxClientOptions {
  binaryPath?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  transport?: FirefoxClientTransport;
}

export function createFirefoxClient(options: FirefoxClientOptions = {}) {
  const validated = validateOptions(options);
  return {
    async status(
      statusOptions: { signal?: AbortSignal } = {},
    ): Promise<FirefoxStatusResult> {
      if (!validated.ok) return validated.error;

      const signal = statusOptions.signal;
      if (signal?.aborted)
        return failure("aborted", "The status check was cancelled.");

      const transport = validated.value.transport ?? runFirefoxCli;
      const transportOptions: FirefoxTransportOptions = {
        timeoutMs: validated.value.timeoutMs,
        maxOutputBytes: validated.value.maxOutputBytes,
        ...(signal ? { signal } : {}),
      };

      const versionResult = await invoke(
        transport,
        validated.value.binaryPath,
        ["--version"],
        transportOptions,
      );
      if (!versionResult.ok) return versionResult.error;
      if (versionResult.value.exitCode !== 0) {
        return failure(
          "cli_command_failed",
          "Firefox CLI version check failed.",
        );
      }
      const cliVersion = parseCliVersion(versionResult.value.stdout);
      if (!cliVersion) {
        return failure(
          "invalid_cli_version",
          "Firefox CLI returned an invalid version.",
        );
      }

      const doctorResult = await invoke(
        transport,
        validated.value.binaryPath,
        ["doctor", "--json"],
        transportOptions,
      );
      if (!doctorResult.ok) return doctorResult.error;
      if (
        doctorResult.value.exitCode !== 0 &&
        doctorResult.value.exitCode !== 1
      ) {
        return failure(
          "cli_command_failed",
          "Firefox CLI status check failed.",
        );
      }

      const doctor = parseDoctorOutput(doctorResult.value.stdout);
      if (!doctor) {
        return failure(
          "invalid_doctor_response",
          "Firefox CLI returned invalid status data.",
        );
      }

      const versionMatches = cliVersion === SUPPORTED_FIREFOX_CLI_VERSION;
      return {
        ok: true,
        result: {
          cliVersion,
          supportedVersion: SUPPORTED_FIREFOX_CLI_VERSION,
          versionMatches,
          nativeHost: doctor.nativeHost,
          connection: doctor.connection,
          warnings: versionMatches
            ? []
            : [
                `Supported firefox-cli version is ${SUPPORTED_FIREFOX_CLI_VERSION}; detected ${cliVersion}.`,
              ],
        },
      };
    },
  };
}

type ValidatedOptions =
  | {
      ok: true;
      value: {
        binaryPath: string;
        timeoutMs: number;
        maxOutputBytes: number;
        transport?: FirefoxClientTransport;
      };
    }
  | { ok: false; error: FirefoxStatusResult };

function validateOptions(options: FirefoxClientOptions): ValidatedOptions {
  if (typeof options !== "object" || options === null) {
    return {
      ok: false,
      error: failure("invalid_options", "Firefox client options are invalid."),
    };
  }

  const { binaryPath, timeoutMs, maxOutputBytes, transport } = options;
  if (
    binaryPath !== undefined &&
    (typeof binaryPath !== "string" || !binaryPath.trim())
  ) {
    return {
      ok: false,
      error: failure("invalid_options", "Firefox client options are invalid."),
    };
  }
  if (
    timeoutMs !== undefined &&
    !isBoundedInteger(timeoutMs, 1, MAX_TIMEOUT_MS)
  ) {
    return {
      ok: false,
      error: failure("invalid_options", "Firefox client options are invalid."),
    };
  }
  if (
    maxOutputBytes !== undefined &&
    !isBoundedInteger(maxOutputBytes, 1, MAX_OUTPUT_BYTES)
  ) {
    return {
      ok: false,
      error: failure("invalid_options", "Firefox client options are invalid."),
    };
  }
  if (transport !== undefined && typeof transport !== "function") {
    return {
      ok: false,
      error: failure("invalid_options", "Firefox client options are invalid."),
    };
  }

  return {
    ok: true,
    value: {
      binaryPath: binaryPath ?? DEFAULT_BINARY_PATH,
      timeoutMs: timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxOutputBytes: maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      ...(transport ? { transport } : {}),
    },
  };
}

function isBoundedInteger(
  value: number,
  minimum: number,
  maximum: number,
): boolean {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

async function invoke(
  transport: FirefoxClientTransport,
  binaryPath: string,
  args: readonly string[],
  options: FirefoxTransportOptions,
): Promise<
  | { ok: true; value: FirefoxTransportResult }
  | { ok: false; error: FirefoxStatusResult }
> {
  let result: FirefoxTransportResult;
  try {
    result = await transport(binaryPath, args, options);
  } catch {
    return {
      ok: false,
      error: failure(
        "cli_transport_failed",
        "Firefox CLI could not be started.",
      ),
    };
  }

  if (
    typeof result !== "object" ||
    result === null ||
    typeof result.stdout !== "string" ||
    typeof result.stderr !== "string" ||
    !(
      result.exitCode === null ||
      (Number.isSafeInteger(result.exitCode) && result.exitCode >= 0)
    ) ||
    (result.error !== undefined && !isTransportError(result.error))
  ) {
    return {
      ok: false,
      error: failure(
        "cli_transport_failed",
        "Firefox CLI returned an invalid process result.",
      ),
    };
  }

  if (
    Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) >
    options.maxOutputBytes
  ) {
    return {
      ok: false,
      error: failure(
        "output_limit",
        "Firefox CLI output exceeded the configured limit.",
      ),
    };
  }

  if (result.error) {
    return { ok: false, error: transportFailure(result.error) };
  }

  if (options.signal?.aborted) {
    return {
      ok: false,
      error: failure("aborted", "The status check was cancelled."),
    };
  }

  return { ok: true, value: result };
}

function isTransportError(
  reason: unknown,
): reason is NonNullable<FirefoxTransportResult["error"]> {
  return (
    reason === "not-found" ||
    reason === "permission-denied" ||
    reason === "spawn-failed" ||
    reason === "timeout" ||
    reason === "aborted" ||
    reason === "output-limit"
  );
}

function transportFailure(
  reason: NonNullable<FirefoxTransportResult["error"]>,
): FirefoxStatusResult {
  switch (reason) {
    case "not-found":
      return failure("cli_not_found", "Firefox CLI executable was not found.");
    case "permission-denied":
      return failure(
        "cli_permission_denied",
        "Firefox CLI executable cannot be run.",
      );
    case "timeout":
      return failure("timeout", "Firefox CLI status check timed out.");
    case "aborted":
      return failure("aborted", "The status check was cancelled.");
    case "output-limit":
      return failure(
        "output_limit",
        "Firefox CLI output exceeded the configured limit.",
      );
    case "spawn-failed":
      return failure("cli_spawn_failed", "Firefox CLI could not be started.");
  }
}

function failure(code: string, message: string): FirefoxStatusResult {
  return { ok: false, code, message, recovery: null };
}
