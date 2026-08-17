/**
 * pi-browser daemon — the single persistent CDP connection to the running
 * browser. Chromium asks consent per debugging connection; one daemon means
 * one consent prompt per daemon lifetime instead of one per pi session, CLI
 * call, or probe. Also owns tab continuity: owned tabs persist across pi
 * sessions, so pinned-profile windows are seeded once, not per session.
 *
 * Transport: Unix socket, newline-delimited JSON { id, method, params } ->
 * { id, ok, result | error }. Owner-only (0600). Idle-stops after 30 min
 * without requests, closing owned tabs first.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import {
  chmodSync,
  existsSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import net from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import puppeteer, {
  type Browser,
  type CDPSession,
  type Page,
  type Target,
} from "puppeteer-core";
import { clearRefs } from "./core/ax-snapshot.ts";
import {
  attachCapture,
  queryConsole,
  queryNetwork,
  type ConsoleQuery,
  type NetworkQuery,
} from "./core/capture.ts";
import { discoverEndpoint, type DiscoveredEndpoint } from "./core/discovery.ts";
import {
  executableFor,
  loadPin,
  savePin,
  clearPin,
  type ProfilePin,
} from "./core/profile.ts";

const SOCKET_PATH =
  process.env["PI_BROWSER_SOCKET"] ??
  `/tmp/pi-browser-daemon-${process.getuid?.() ?? 0}.sock`;
const IDLE_TIMEOUT_MS = 30 * 60_000;
const SESSIONS_PATH = join(
  process.env["PI_CODING_AGENT_DIR"] ?? join(homedir(), ".pi", "agent"),
  "pi-browser-cli.json",
);
const AsyncFunction = Object.getPrototypeOf(async function () {})
  .constructor as new (
  ...args: string[]
) => (...fnArgs: unknown[]) => Promise<unknown>;

const log = (...args: unknown[]): void =>
  console.error("[pi-browser-daemon]", ...args);

// ---------------------------------------------------------------- browser state

let browser: Browser | null = null;
let endpoint: DiscoveredEndpoint | null = null;
let current: Page | null = null;
const ownedPages = new Set<Page>();
const clients = new Map<Page, CDPSession>();
const pinState: { loaded: boolean; pin: ProfilePin | null } = {
  loaded: false,
  pin: null,
};

const currentPin = (): ProfilePin | null => {
  if (!pinState.loaded) {
    pinState.loaded = true;
    pinState.pin = loadPin();
  }
  return pinState.pin;
};

const getBrowser = async (): Promise<Browser> => {
  if (browser?.connected) return browser;
  endpoint = await discoverEndpoint();
  const next = await puppeteer.connect({
    browserWSEndpoint: endpoint.wsUrl,
    defaultViewport: null,
  });
  next.on("disconnected", () => {
    browser = null;
    endpoint = null;
    current = null;
    ownedPages.clear();
    clients.clear();
    clearRefs();
  });
  browser = next;
  log("connected to", endpoint.userDataDir);
  return next;
};

const cdpFor = async (page: Page): Promise<CDPSession> => {
  const cached = clients.get(page);
  if (cached) return cached;
  const client = await page.createCDPSession();
  clients.set(page, client);
  page.once("close", () => clients.delete(page));
  await attachCapture(page, client);
  return client;
};

const trackPage = (page: Page): Page => {
  ownedPages.add(page);
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) clearRefs();
  });
  page.once("close", () => {
    ownedPages.delete(page);
    if (current === page) current = null;
  });
  return page;
};

const PIN_PROFILE_MISMATCH = (
  pin: ProfilePin,
  discovered: string | null,
): string | null =>
  discovered && pin.userDataDir !== discovered
    ? `pin is for ${pin.userDataDir} but the discovered browser uses ${discovered} — run /browser-profile to re-pin`
    : null;

const seedPinnedPage = async (pin: ProfilePin): Promise<Page> => {
  const mismatch = PIN_PROFILE_MISMATCH(pin, endpoint?.userDataDir ?? null);
  if (mismatch) throw new Error(mismatch);
  const executable = executableFor(pin.userDataDir);
  if (!executable)
    throw new Error(
      `cannot find the browser executable for ${pin.userDataDir}`,
    );
  const b = await getBrowser();
  const uuid = randomUUID();
  const sentinelPath = `${tmpdir()}/pi-browser-sentinel-${uuid}.html`;
  fs.writeFileSync(
    sentinelPath,
    '<title>pi-browser working tab</title><body style="font:14px sans-serif;color:#666;padding:2em">pi-browser seeded this tab to attach to the pinned profile. It is reused as the working tab and closed on cleanup. Safe to close.</body>',
  );
  const sentinelUrl = `file://${sentinelPath}`;
  const child = spawn(
    executable,
    [`--profile-directory=${pin.profileDirectory}`, sentinelUrl],
    {
      detached: true,
      stdio: "ignore",
    },
  );
  child.unref();
  try {
    const target = await b.waitForTarget(
      (t: Target) => t.url().includes(uuid),
      { timeout: 20_000 },
    );
    const page = await target.page();
    if (!page) throw new Error("sentinel target has no attachable page");
    return trackPage(page);
  } catch (error) {
    throw new Error(
      `couldn't open a window in profile "${pin.label}" — open that profile from the browser's profile menu once, then retry (${(error as Error).message})`,
    );
  } finally {
    fs.rmSync(sentinelPath, { force: true });
  }
};

const newPinnedPage = async (pin: ProfilePin): Promise<Page> => {
  const opener = [...ownedPages].find((p) => !p.isClosed());
  if (!opener) return seedPinnedPage(pin);
  const b = await getBrowser();
  const openerTarget = opener.target();
  await opener.evaluate(() => {
    window.open("about:blank", "_blank");
  });
  const target = await b.waitForTarget(
    (t: Target) => t.type() === "page" && t.opener() === openerTarget,
    {
      timeout: 15_000,
    },
  );
  const page = await target.page();
  if (!page) throw new Error("new pinned tab has no attachable page");
  return trackPage(page);
};

const getPage = async (): Promise<Page> => {
  if (current && !current.isClosed()) return current;
  for (const page of ownedPages) {
    if (!page.isClosed()) {
      current = page;
      return page;
    }
  }
  return newPage();
};

const newPage = async (url?: string): Promise<Page> => {
  const pin = currentPin();
  let page: Page;
  if (pin) page = await newPinnedPage(pin);
  else page = trackPage(await (await getBrowser()).newPage());
  current = page;
  if (url) await page.goto(url, { waitUntil: "load", timeout: 30_000 });
  return page;
};

interface ListedPage {
  index: number;
  url: string;
  title: string;
  owned: boolean;
  active: boolean;
}

const listPages = async (): Promise<ListedPage[]> => {
  const b = await getBrowser();
  const pages = await b.pages();
  return Promise.all(
    pages.map(async (page, index) => ({
      index,
      url: page.url(),
      title: await page.title().catch(() => ""),
      owned: ownedPages.has(page),
      active: page === current,
    })),
  );
};

const findOwned = async (match: {
  index?: number;
  url?: string;
}): Promise<Page> => {
  const listed = await listPages();
  const owned = listed.filter((p) => p.owned);
  const hit =
    match.index !== undefined
      ? owned.find((p) => p.index === match.index)
      : match.url !== undefined
        ? owned.find((p) => p.url.includes(match.url ?? ""))
        : undefined;
  if (!hit) {
    const choices =
      owned.map((p) => `${p.index}: ${p.url}`).join("\n") || "(none)";
    throw new Error(
      `no owned tab matches ${JSON.stringify(match)} — owned tabs:\n${choices}`,
    );
  }
  const pages = await (await getBrowser()).pages();
  const page = pages[hit.index];
  if (!page) throw new Error(`tab index ${hit.index} no longer exists`);
  if (!ownedPages.has(page))
    throw new Error(`tab ${hit.index} is not owned by pi-browser`);
  return page;
};

// ---------------------------------------------------------------- CLI sessions

interface SessionRec {
  targetId: string;
  readOnly: boolean;
  createdAt: string;
}

const sessions = new Map<string, SessionRec>();

const loadSessions = (): void => {
  try {
    const raw = JSON.parse(readFileSync(SESSIONS_PATH, "utf8")) as {
      sessions?: Record<string, SessionRec>;
    };
    for (const [name, rec] of Object.entries(raw.sessions ?? {}))
      sessions.set(name, rec);
  } catch {
    // no session file yet
  }
};

const persistSessions = (): void => {
  mkdirSync(dirname(SESSIONS_PATH), { recursive: true, mode: 0o700 });
  writeFileSync(
    SESSIONS_PATH,
    JSON.stringify({ sessions: Object.fromEntries(sessions) }, null, 2) + "\n",
    { mode: 0o600 },
  );
};

const targetIdOf = (target: Target): string | null =>
  (target as unknown as { _targetId?: string })._targetId ?? null;

const findTargetById = async (
  b: Browser,
  id: string,
): Promise<Target | null> => {
  for (const target of await b.targets()) {
    if (targetIdOf(target) === id) return target;
  }
  return null;
};

// ---------------------------------------------------------------- run_script

const assertScriptAllowed = async (path: string): Promise<string> => {
  const { isAbsolute, resolve, sep } = await import("node:path");
  if (!isAbsolute(path))
    throw new Error(`script path must be absolute: ${path}`);
  const real = await fs.promises.realpath(path).catch(() => {
    throw new Error(`script not found: ${path}`);
  });
  const roots = [fs.realpathSync(tmpdir()), fs.realpathSync(process.cwd())];
  const extra = process.env["PI_BROWSER_SCRIPT_DIR"];
  if (extra) roots.push(resolve(extra));
  if (!roots.some((root) => real === root || real.startsWith(root + sep))) {
    throw new Error(
      `script must live under ${roots.join(", ")} — or PI_BROWSER_SCRIPT_DIR: ${path}`,
    );
  }
  return real;
};

const runScript = async (params: {
  path: string;
  params?: unknown;
  timeoutMs?: number;
}): Promise<unknown> => {
  const real = await assertScriptAllowed(params.path);
  const page = await getPage();
  const client = await cdpFor(page);
  const timeoutMs = Math.min(params.timeoutMs ?? 60_000, 600_000);
  const mod = (await import(pathToFileURL(real).href)) as { default?: unknown };
  if (typeof mod.default !== "function")
    throw new Error("script must export default async function(ctx)");
  const result = await Promise.race([
    (
      mod.default as (ctx: {
        page: Page;
        client: CDPSession;
        params: unknown;
      }) => Promise<unknown>
    )({
      page,
      client,
      params: params.params,
    }),
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error(`script timed out after ${timeoutMs}ms`)),
        timeoutMs,
      ),
    ),
  ]);
  return result;
};

// ---------------------------------------------------------------- method handlers

const handle = async (
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> => {
  switch (method) {
    case "status": {
      return {
        connected: browser?.connected ?? false,
        userDataDir: endpoint?.userDataDir ?? null,
        ownedTabs: [...ownedPages].filter((p) => !p.isClosed()).length,
        pin: currentPin(),
        daemonPid: process.pid,
      };
    }
    case "getPin":
      return currentPin();
    case "setPin": {
      const pin = (params["pin"] as ProfilePin | null) ?? null;
      if (pin) await savePin(pin);
      else await clearPin();
      pinState.loaded = true;
      pinState.pin = pin;
      for (const page of [...ownedPages]) {
        try {
          if (!page.isClosed()) await page.close();
        } catch {
          // tab already gone
        }
      }
      ownedPages.clear();
      clients.clear();
      current = null;
      clearRefs();
      return { pin };
    }
    case "getCurrent": {
      const page = await getPage();
      return { url: page.url(), title: await page.title() };
    }
    case "goto": {
      const page = await getPage();
      await page.goto(String(params["url"]), {
        waitUntil: "load",
        timeout: 30_000,
      });
      return { url: page.url(), title: await page.title() };
    }
    case "newPage": {
      const page = await newPage(params["url"] as string | undefined);
      return { url: page.url(), title: await page.title().catch(() => "") };
    }
    case "listPages":
      return listPages();
    case "switchPage": {
      const page = await findOwned(params as { index?: number; url?: string });
      await page.bringToFront();
      current = page;
      return { url: page.url(), title: await page.title().catch(() => "") };
    }
    case "closePage": {
      const page = await findOwned(params as { index?: number; url?: string });
      const url = page.url();
      await page.close();
      ownedPages.delete(page);
      if (current === page) current = null;
      return { closed: url };
    }
    case "closeCurrent": {
      const page = await getPage();
      const url = page.url();
      await page.close();
      ownedPages.delete(page);
      if (current === page) current = null;
      return { closed: url };
    }
    case "bringToFront": {
      const page = await getPage();
      await page.bringToFront();
      return { url: page.url() };
    }
    case "evaluate": {
      const page = await getPage();
      return page.evaluate(String(params["expression"]));
    }
    case "cdp": {
      const page = await getPage();
      const client = await cdpFor(page);
      return (client.send as (m: string, p?: object) => Promise<unknown>)(
        String(params["method"]),
        (params["params"] as object) ?? {},
      );
    }
    case "networkQuery": {
      const page = await getPage();
      const client = await cdpFor(page);
      return queryNetwork(client, page, params as unknown as NetworkQuery);
    }
    case "consoleQuery": {
      const page = await getPage();
      await cdpFor(page);
      return queryConsole(page, params as unknown as ConsoleQuery);
    }
    case "runScript":
      return runScript(
        params as { path: string; params?: unknown; timeoutMs?: number },
      );
    case "sessionNew": {
      const name = String(params["name"] ?? "");
      if (!name) throw new Error("sessionNew needs a name");
      if (sessions.has(name))
        throw new Error(`session "${name}" already exists`);
      const page = await newPage();
      const id = targetIdOf(page.target());
      if (!id) throw new Error("could not read the new tab's target id");
      const rec: SessionRec = {
        targetId: id,
        readOnly: !!params["readOnly"],
        createdAt: new Date().toISOString(),
      };
      sessions.set(name, rec);
      persistSessions();
      return { session: name, ...rec };
    }
    case "sessionList": {
      const b = await getBrowser();
      const out: Record<string, SessionRec & { alive: boolean }> = {};
      for (const [name, rec] of sessions) {
        out[name] = {
          ...rec,
          alive: !!(await findTargetById(b, rec.targetId)),
        };
      }
      return out;
    }
    case "sessionDelete": {
      const name = String(params["name"] ?? "");
      const rec = sessions.get(name);
      if (!rec) throw new Error(`no session "${name}"`);
      const b = await getBrowser();
      const target = await findTargetById(b, rec.targetId);
      if (target) {
        const page = await target.page().catch(() => null);
        await page?.close().catch(() => {});
      }
      sessions.delete(name);
      persistSessions();
      return { deleted: name, tabClosed: !!target };
    }
    case "execute": {
      const page = await getPage();
      const client = await cdpFor(page);
      const code = String(params["code"] ?? "");
      if (!code.trim()) throw new Error("execute needs code");
      const fn = new AsyncFunction("page", "client", "fs", "params", code);
      return (await fn(page, client, fs, params["params"])) ?? null;
    }
    case "sessionExecute": {
      const name = String(params["name"] ?? "");
      const rec = sessions.get(name);
      if (!rec) throw new Error(`no session "${name}" — create it first`);
      const b = await getBrowser();
      const target = await findTargetById(b, rec.targetId);
      if (!target)
        throw new Error(
          `session "${name}" tab is gone (browser restarted or tab closed) — recreate the session`,
        );
      const page = await target.page();
      if (!page) throw new Error(`session "${name}" tab is not attachable`);
      const client = await cdpFor(page);
      const code = String(params["code"] ?? "");
      if (!code.trim()) throw new Error("sessionExecute needs code");
      const fn = new AsyncFunction("page", "client", "fs", "params", code);
      return (await fn(page, client, fs, params["params"])) ?? null;
    }
    case "stop": {
      setTimeout(() => shutdown("stop requested"), 50);
      return { stopping: true };
    }
    default:
      throw new Error(`unknown method: ${method}`);
  }
};

// ---------------------------------------------------------------- server

const closeOwnedAndExit = async (reason: string): Promise<void> => {
  log("shutting down:", reason);
  for (const page of [...ownedPages]) {
    try {
      if (!page.isClosed()) await page.close();
    } catch {
      // tab already gone
    }
  }
  ownedPages.clear();
  if (browser?.connected) browser.disconnect();
  try {
    unlinkSync(SOCKET_PATH);
  } catch {
    // already gone
  }
  process.exit(0);
};

let idleTimer: NodeJS.Timeout | null = null;
const resetIdle = (): void => {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    void closeOwnedAndExit("idle timeout");
  }, IDLE_TIMEOUT_MS);
};

const shutdown = (reason: string): void => {
  void closeOwnedAndExit(reason);
};

const main = async (): Promise<void> => {
  loadSessions();
  if (existsSync(SOCKET_PATH)) {
    // Stale socket from a dead daemon.
    try {
      unlinkSync(SOCKET_PATH);
    } catch {
      // in use; another daemon owns it
    }
  }
  const server = net.createServer((sock) => {
    let buffer = "";
    sock.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line.trim()) continue;
        resetIdle();
        void (async () => {
          let id = 0;
          try {
            const req = JSON.parse(line) as {
              id?: number;
              method?: string;
              params?: Record<string, unknown>;
            };
            id = req.id ?? 0;
            if (!req.method) throw new Error("missing method");
            const result = await handle(req.method, req.params ?? {});
            sock.write(JSON.stringify({ id, ok: true, result }) + "\n");
          } catch (error) {
            sock.write(
              JSON.stringify({
                id,
                ok: false,
                error: error instanceof Error ? error.message : String(error),
              }) + "\n",
            );
          }
        })();
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(SOCKET_PATH, () => resolve());
  });
  chmodSync(SOCKET_PATH, 0o600);
  resetIdle();
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  log(`listening on ${SOCKET_PATH} (pid ${process.pid})`);
};

void main();
