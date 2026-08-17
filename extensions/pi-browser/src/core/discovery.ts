/**
 * CDP discovery for the already-running browser.
 *
 * Reads `DevToolsActivePort` from known user-data dirs. Chromium writes this
 * file when remote debugging is live (helium://inspect/#remote-debugging or
 * --remote-debugging-port). The /json/version HTTP endpoint is not assumed:
 * newer Chromium builds 404 it when debugging is toggled via chrome://inspect,
 * so the WebSocket URL is built from the file contents directly.
 */

import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import net from "node:net";

export type DiscoveredEndpoint = {
  readonly wsUrl: string;
  readonly userDataDir: string;
};

const PROBE_TIMEOUT_MS = 1_000;

export const userDataDirCandidates = (): ReadonlyArray<string> => {
  const dirs: string[] = [];
  const envOverride = process.env["CHROME_USER_DATA_DIR"];
  if (envOverride) dirs.push(envOverride);
  if (process.platform === "darwin") {
    const support = join(homedir(), "Library", "Application Support");
    dirs.push(
      join(support, "net.imput.helium"),
      join(support, "Google/Chrome"),
      join(support, "Chromium"),
      join(support, "BraveSoftware/Brave-Browser"),
      join(support, "Microsoft Edge"),
    );
  } else if (process.platform === "linux") {
    const config = join(homedir(), ".config");
    dirs.push(
      join(config, "helium"),
      join(config, "google-chrome"),
      join(config, "chromium"),
      join(config, "BraveSoftware/Brave-Browser"),
      join(config, "microsoft-edge"),
    );
  }
  return dirs;
};

/** Parse the two-line DevToolsActivePort file: port, then browser ws path. */
export const parsePortFile = (
  raw: string,
): { port: number; path: string } | null => {
  const lines = raw.trim().split("\n");
  if (lines.length < 2) return null;
  const port = Number(lines[0]?.trim());
  const path = lines[1]?.trim();
  if (!Number.isInteger(port) || port <= 0 || port >= 65536 || !path)
    return null;
  return { port, path };
};

const isPortLive = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const sock = netConnect(port);
    let settled = false;
    const finish = (live: boolean): void => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(live);
    };
    sock.setTimeout(PROBE_TIMEOUT_MS, () => finish(false));
    sock.once("error", () => finish(false));
    sock.once("connect", () => finish(true));
  });

const netConnect = (port: number): net.Socket =>
  net.connect({ host: "127.0.0.1", port });

export class DiscoveryError extends Error {
  constructor(
    message: string,
    readonly searchedDirs: ReadonlyArray<string>,
  ) {
    super(message);
    this.name = "DiscoveryError";
  }
}

/**
 * Find a live browser CDP endpoint. Prefers the most recently written
 * DevToolsActivePort when several browsers expose one.
 */
export const discoverEndpoint = async (): Promise<DiscoveredEndpoint> => {
  const dirs = userDataDirCandidates();
  const candidates: Array<{
    port: number;
    path: string;
    mtimeMs: number;
    userDataDir: string;
  }> = [];
  for (const base of dirs) {
    const portFile = join(base, "DevToolsActivePort");
    let raw: string;
    let mtimeMs = 0;
    try {
      raw = await readFile(portFile, "utf8");
      try {
        mtimeMs = (await stat(portFile)).mtimeMs;
      } catch {
        // mtime only orders candidates; absence is not fatal
      }
    } catch {
      continue;
    }
    const parsed = parsePortFile(raw);
    if (parsed) candidates.push({ ...parsed, mtimeMs, userDataDir: base });
  }

  // One entry per port, freshest file wins (a relaunched browser rewrites it).
  const byPort = new Map<number, (typeof candidates)[number]>();
  for (const c of candidates) {
    const prev = byPort.get(c.port);
    if (!prev || c.mtimeMs > prev.mtimeMs) byPort.set(c.port, c);
  }
  const unique = [...byPort.values()];

  const liveCandidates = await Promise.all(
    unique.map(async (c) => ((await isPortLive(c.port)) ? c : null)),
  );
  for (const c of liveCandidates) {
    if (c)
      return {
        wsUrl: `ws://127.0.0.1:${c.port}${c.path}`,
        userDataDir: c.userDataDir,
      };
  }

  const found =
    unique.length > 0
      ? `Found DevToolsActivePort in ${unique.map((c) => c.userDataDir).join(", ")} but no port answers.`
      : `No DevToolsActivePort found in: ${dirs.join(", ")}.`;
  throw new DiscoveryError(
    `${found} Enable remote debugging first: open helium://inspect/#remote-debugging (or chrome://inspect for Chrome/Brave/Edge), tick the checkbox, and click Allow.`,
    dirs,
  );
};
