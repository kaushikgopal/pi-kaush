import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

type ProcessIdentity = { uid: number; start: string; state?: string };

async function processIdentity(pid: number): Promise<ProcessIdentity | null> {
  if (process.platform === "linux") {
    try {
      const [statText, statusText] = await Promise.all([
        readFile(`/proc/${pid}/stat`, "utf8"),
        readFile(`/proc/${pid}/status`, "utf8"),
      ]);
      const closeParen = statText.lastIndexOf(")");
      const fields = statText
        .slice(closeParen + 1)
        .trim()
        .split(/\s+/u);
      const state = fields[0];
      const start = fields[19];
      const uid = /^Uid:\s+(\d+)/mu.exec(statusText)?.[1];
      if (!state || !start || !uid) return null;
      return { uid: Number(uid), start, state };
    } catch {
      return null;
    }
  }

  if (process.platform === "darwin") {
    try {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const run = promisify(execFile);
      const { stdout } = await run(
        "ps",
        ["-o", "uid=", "-o", "lstart=", "-p", String(pid)],
        { timeout: 2_000, maxBuffer: 8_192 },
      );
      const match = /^\s*(\d+)\s+(.+?)\s*$/u.exec(stdout);
      if (!match?.[1] || !match[2]) return null;
      return { uid: Number(match[1]), start: match[2] };
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Returns an opaque epoch for one same-user Firefox process.
 * This metadata does not authorize browser control or expose browser data.
 */
export async function getLocalFirefoxEpoch(): Promise<string | null> {
  if (process.platform !== "linux" && process.platform !== "darwin")
    return null;
  const currentUid =
    typeof process.getuid === "function" ? process.getuid() : null;
  if (currentUid === null) return null;

  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const run = promisify(execFile);
    const { stdout } = await run("pgrep", ["-x", "firefox"], {
      timeout: 2_000,
      maxBuffer: 8_192,
    });
    const pids = [
      ...new Set(
        stdout
          .trim()
          .split(/\s+/u)
          .filter((value) => /^\d+$/u.test(value))
          .map(Number),
      ),
    ];
    if (pids.length === 0) return null;

    const identities = (
      await Promise.all(
        pids.map(async (pid) => {
          const identity = await processIdentity(pid);
          return identity?.uid === currentUid &&
            identity.state !== "Z" &&
            identity.state !== "X"
            ? { pid, start: identity.start }
            : null;
        }),
      )
    ).filter(
      (value): value is { pid: number; start: string } => value !== null,
    );

    if (identities.length !== 1) return null;
    const only = identities[0]!;
    return createHash("sha256")
      .update(`firefox-main\0${only.pid}\0${only.start}`, "utf8")
      .digest("hex");
  } catch {
    return null;
  }
}
