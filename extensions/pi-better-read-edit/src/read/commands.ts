import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type CommandRunner = Pick<ExtensionAPI, "exec">;

const COMMAND_STDOUT_CAP = 2 * 1024 * 1024;
const COMMAND_STDERR_CAP = 64 * 1024;

export async function findCommand(
  runner: CommandRunner,
  names: readonly string[],
  signal?: AbortSignal,
): Promise<string | undefined> {
  for (const name of names) {
    const result = await runner
      .exec("which", [name], {
        ...(signal ? { signal } : {}),
        timeout: 3_000,
      })
      .catch(() => undefined);
    if (result?.code === 0 && !result.killed && result.stdout.trim()) {
      return result.stdout.trim().split("\n", 1)[0];
    }
  }
  return undefined;
}

export async function requireCommand(
  runner: CommandRunner,
  names: readonly string[],
  installHint: string,
  signal?: AbortSignal,
): Promise<string> {
  const command = await findCommand(runner, names, signal);
  if (!command) throw new Error(`${names[0]} is not installed. ${installHint}`);
  return command;
}

export async function runCommand(
  _runner: CommandRunner,
  command: string,
  args: readonly string[],
  options: { signal?: AbortSignal; timeout?: number; cwd?: string } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = Buffer.allocUnsafe(COMMAND_STDOUT_CAP);
    const stderr = Buffer.allocUnsafe(COMMAND_STDERR_CAP);
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(stdout.subarray(0, stdoutBytes).toString("utf8"));
    };
    const failForCap = (stream: "stdout" | "stderr", cap: number) => {
      child.kill("SIGKILL");
      finish(
        new Error(`${command} ${stream} exceeded the ${cap}-byte safety cap.`),
      );
    };

    child.stdout.on("data", (chunk: Buffer) => {
      if (stdoutBytes + chunk.byteLength > COMMAND_STDOUT_CAP) {
        failForCap("stdout", COMMAND_STDOUT_CAP);
      } else {
        chunk.copy(stdout, stdoutBytes);
        stdoutBytes += chunk.byteLength;
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderrBytes + chunk.byteLength > COMMAND_STDERR_CAP) {
        failForCap("stderr", COMMAND_STDERR_CAP);
      } else {
        chunk.copy(stderr, stderrBytes);
        stderrBytes += chunk.byteLength;
      }
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code, signal) => {
      if (settled) return;
      if (code !== 0) {
        const detail = stderr.subarray(0, stderrBytes).toString("utf8").trim();
        finish(
          new Error(
            `${command} failed${signal ? ` with signal ${signal}` : ` with exit code ${code}`}${detail ? `: ${detail}` : ""}`,
          ),
        );
        return;
      }
      finish();
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error(`${command} timed out.`));
    }, options.timeout ?? 30_000);
    timer.unref();
  });
}
