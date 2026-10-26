import type { FirefoxStatusResultSuccess } from "./types.js";

const NATIVE_HOST_STATUSES = [
  "installed",
  "missing",
  "stale",
  "invalid",
] as const;
const CONNECTION_STATUSES = [
  "connected",
  "not-approved",
  "version-mismatch",
  "pairing-mismatch",
  "disconnected",
] as const;

type NativeHostStatus = (typeof NATIVE_HOST_STATUSES)[number];
type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

export function parseCliVersion(stdout: string): string | null {
  const value = stdout.trim();
  if (
    value.length > 32 ||
    !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(value)
  ) {
    return null;
  }

  return value;
}

export function parseDoctorOutput(
  stdout: string,
): Pick<
  FirefoxStatusResultSuccess["result"],
  "nativeHost" | "connection"
> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;

  const manifest = parsed.nativeHostManifest;
  const connection = parsed.extensionConnection;
  if (!isRecord(manifest) || !isRecord(connection)) return null;

  const manifestStatus = parseNativeHostStatus(manifest.status);
  const connectionStatus = parseConnectionStatus(connection.status);
  if (!manifestStatus || !connectionStatus) return null;

  const registration = parsed.nativeHostRegistration;
  let registrationStatus: NativeHostStatus | undefined;
  if (registration !== undefined) {
    if (!isRecord(registration)) return null;
    registrationStatus =
      parseNativeHostStatus(registration.status) ?? undefined;
    if (!registrationStatus) return null;
  }

  return {
    nativeHost: combineNativeHostStatuses(
      registrationStatus
        ? [manifestStatus, registrationStatus]
        : [manifestStatus],
    ),
    connection: connectionStatus,
  };
}

function combineNativeHostStatuses(
  statuses: NativeHostStatus[],
): NativeHostStatus {
  if (statuses.includes("invalid")) return "invalid";
  if (statuses.includes("missing")) return "missing";
  if (statuses.includes("stale")) return "stale";
  return "installed";
}

function parseNativeHostStatus(value: unknown): NativeHostStatus | null {
  return isOneOf(NATIVE_HOST_STATUSES, value) ? value : null;
}

function parseConnectionStatus(value: unknown): ConnectionStatus | null {
  return isOneOf(CONNECTION_STATUSES, value) ? value : null;
}

function isOneOf<const Values extends readonly string[]>(
  values: Values,
  value: unknown,
): value is Values[number] {
  return typeof value === "string" && values.includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
