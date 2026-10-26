import { spawn } from "node:child_process";
import type {
  FirefoxTransportOptions,
  FirefoxTransportResult,
} from "./types.js";

const FORCE_KILL_DELAY_MS = 250;

export function runFirefoxCli(
  binaryPath: string,
  args: readonly string[],
  options: FirefoxTransportOptions,
): Promise<FirefoxTransportResult> {
  return new Promise((resolve) => {
    if (options.signal?.aborted) {
      resolve({ stdout: "", stderr: "", exitCode: null, error: "aborted" });
      return;
    }

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let capturedBytes = 0;
    let failure: FirefoxTransportResult["error"];
    let settled = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;

    let child;
    try {
      child = spawn(binaryPath, [...args], {
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      resolve({
        stdout: "",
        stderr: "",
        exitCode: null,
        error: "spawn-failed",
      });
      return;
    }

    const cleanup = () => {
      clearTimeout(timeoutTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      options.signal?.removeEventListener("abort", onAbort);
    };

    const finish = (result: FirefoxTransportResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const stop = (reason: NonNullable<FirefoxTransportResult["error"]>) => {
      if (settled || failure) return;
      failure = reason;
      try {
        child.kill("SIGTERM");
      } catch {
        // The close event still decides when the child has stopped.
      }
      forceKillTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // The close event still decides when the child has stopped.
        }
      }, FORCE_KILL_DELAY_MS);
    };

    const onAbort = () => stop("aborted");

    const capture = (target: Buffer[], chunk: Buffer | string) => {
      if (failure) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      capturedBytes += bytes.byteLength;
      if (capturedBytes > options.maxOutputBytes) {
        stop("output-limit");
        return;
      }
      target.push(bytes);
    };

    const timeoutTimer = setTimeout(() => stop("timeout"), options.timeoutMs);

    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (chunk: Buffer | string) =>
      capture(stdout, chunk),
    );
    child.stderr?.on("data", (chunk: Buffer | string) =>
      capture(stderr, chunk),
    );
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        finish({ stdout: "", stderr: "", exitCode: null, error: "not-found" });
      } else if (error.code === "EACCES" || error.code === "EPERM") {
        finish({
          stdout: "",
          stderr: "",
          exitCode: null,
          error: "permission-denied",
        });
      } else {
        finish({
          stdout: "",
          stderr: "",
          exitCode: null,
          error: "spawn-failed",
        });
      }
    });
    child.on("close", (exitCode: number | null) => {
      if (failure) {
        finish({ stdout: "", stderr: "", exitCode: null, error: failure });
        return;
      }
      finish({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        exitCode,
      });
    });

    if (options.signal?.aborted) onAbort();
  });
}
