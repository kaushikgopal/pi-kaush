export type FirefoxStatusResultSuccess = {
  ok: true;
  result: {
    cliVersion: string;
    supportedVersion: string;
    versionMatches: boolean;
    nativeHost: "installed" | "missing" | "stale" | "invalid";
    connection:
      | "connected"
      | "not-approved"
      | "version-mismatch"
      | "pairing-mismatch"
      | "disconnected";
    warnings: string[];
  };
};

export type FirefoxStatusResultError = {
  ok: false;
  code: string;
  message: string;
  recovery: { command: string; args: string[] } | null;
};

export type FirefoxStatusResult =
  | FirefoxStatusResultSuccess
  | FirefoxStatusResultError;

export interface FirefoxTransportOptions {
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
}

export interface FirefoxTransportResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  error?:
    | "not-found"
    | "permission-denied"
    | "spawn-failed"
    | "timeout"
    | "aborted"
    | "output-limit";
}

export type FirefoxClientTransport = (
  binaryPath: string,
  args: readonly string[],
  options: FirefoxTransportOptions,
) => Promise<FirefoxTransportResult>;
