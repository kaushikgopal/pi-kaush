import { lstat, mkdir, open } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname } from "node:path";

export type FirefoxDiagnosticEvent = {
  event: "tool" | "error" | "adoption" | "version" | "cleanup";
  operation?: string;
  session?: string;
  tabId?: number;
  containerId?: string;
  domain?: string;
  code?: string;
  durationMs?: number;
};
export function createFirefoxLogger(options: {
  path: string;
  level: "off" | "error" | "debug";
}) {
  return async (event: FirefoxDiagnosticEvent): Promise<boolean> => {
    if (
      options.level === "off" ||
      (options.level === "error" && event.event !== "error")
    )
      return true;
    const safe = {
      at: new Date().toISOString(),
      event: event.event,
      ...(event.operation && /^[a-z_]{1,64}$/.test(event.operation)
        ? { operation: event.operation }
        : {}),
      ...(event.session ? { session: clean(event.session, 80) } : {}),
      ...(Number.isSafeInteger(event.tabId) ? { tabId: event.tabId } : {}),
      ...(event.containerId
        ? { containerId: clean(event.containerId, 200) }
        : {}),
      ...(event.domain ? { domain: domainOnly(event.domain) } : {}),
      ...(event.code && /^[a-z_]{1,64}$/.test(event.code)
        ? { code: event.code }
        : {}),
      ...(Number.isFinite(event.durationMs)
        ? { durationMs: Math.max(0, Math.round(event.durationMs!)) }
        : {}),
    };
    try {
      await mkdir(dirname(options.path), { recursive: true, mode: 0o700 });
      try {
        const existing = await lstat(options.path);
        if (
          !existing.isFile() ||
          existing.isSymbolicLink() ||
          (existing.mode & 0o077) !== 0 ||
          existing.size > 5_000_000
        )
          return false;
      } catch (error) {
        if (!isMissing(error)) return false;
      }
      const parent = await lstat(dirname(options.path));
      if (!parent.isDirectory() || parent.isSymbolicLink()) return false;
      const handle = await open(
        options.path,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_APPEND |
          (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      try {
        const stat = await handle.stat();
        if (
          !stat.isFile() ||
          (stat.mode & 0o077) !== 0 ||
          stat.size > 5_000_000 ||
          (process.getuid && stat.uid !== process.getuid())
        )
          return false;
        await handle.writeFile(JSON.stringify(safe) + "\n");
        return true;
      } finally {
        await handle.close();
      }
    } catch {
      return false;
    }
  };
}
function clean(value: string, limit: number): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, limit);
}
function domainOnly(value: string): string {
  try {
    return new URL(
      value.includes("://") ? value : `https://${value}`,
    ).hostname.slice(0, 253);
  } catch {
    return "unknown";
  }
}
function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
