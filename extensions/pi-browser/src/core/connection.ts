/**
 * Lazy puppeteer connection to the running browser, tab ownership, and
 * profile pinning.
 *
 * Only tabs this extension created are controlled or closed. When a profile
 * pin is set, every owned tab descends from a sentinel window seeded inside
 * the pinned profile via the browser's own command line — tabs never land in
 * whichever profile window happens to be focused.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import puppeteer, {
  type Browser,
  type CDPSession,
  type Page,
  type Target,
} from "puppeteer-core";
import { clearRefs } from "./ax-snapshot.ts";
import { attachCapture } from "./capture.ts";
import { discoverEndpoint, type DiscoveredEndpoint } from "./discovery.ts";
import {
  executableFor,
  loadPin,
  savePin,
  clearPin,
  type ProfilePin,
} from "./profile.ts";

let browser: Browser | null = null;
let endpoint: DiscoveredEndpoint | null = null;
let current: Page | null = null;
const ownedPages = new Set<Page>();
const clients = new Map<Page, CDPSession>();
const pinState: { loaded: boolean; pin: ProfilePin | null } = {
  loaded: false,
  pin: null,
};

export const currentPin = (): ProfilePin | null => {
  if (!pinState.loaded) {
    pinState.loaded = true;
    pinState.pin = loadPin();
  }
  return pinState.pin;
};

/** Set or clear the pin. Owned tabs close: they may be in the wrong profile. */
export const setPin = async (pin: ProfilePin | null): Promise<void> => {
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
};

export const getBrowser = async (): Promise<Browser> => {
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
  return next;
};

export const connectionInfo = (): {
  connected: boolean;
  userDataDir: string | null;
  ownedTabs: number;
  pin: ProfilePin | null;
} => ({
  connected: browser?.connected ?? false,
  userDataDir: endpoint?.userDataDir ?? null,
  ownedTabs: [...ownedPages].filter((p) => !p.isClosed()).length,
  pin: currentPin(),
});

/** One cached raw-CDP client per page for snapshot/interaction/capture domains. */
export const cdpFor = async (page: Page): Promise<CDPSession> => {
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

/**
 * Seed a window inside the pinned profile by handing the browser's own
 * executable a sentinel file:// page; ProcessSingleton forwards it to the
 * running instance. The sentinel becomes the first owned pinned tab.
 */
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
  writeFileSync(sentinelPath, "<title>pi-browser sentinel</title>");
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
    rmSync(sentinelPath, { force: true });
  }
};

/**
 * New tab in the pinned profile: window.open from a live owned pinned page —
 * the only CDP-reachable way to create a tab in a non-default browser
 * context. Re-seeds the sentinel window if every pinned tab is gone.
 */
const newPinnedPage = async (pin: ProfilePin): Promise<Page> => {
  let opener = [...ownedPages].find((p) => !p.isClosed());
  if (!opener) opener = await seedPinnedPage(pin);
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

/** The live current tab, creating one on first use. */
export const getPage = async (): Promise<Page> => {
  if (current && !current.isClosed()) return current;
  for (const page of ownedPages) {
    if (!page.isClosed()) {
      current = page;
      return page;
    }
  }
  return newPage();
};

export const newPage = async (url?: string): Promise<Page> => {
  const pin = currentPin();
  let page: Page;
  if (pin) {
    page = await newPinnedPage(pin);
  } else {
    page = trackPage(await (await getBrowser()).newPage());
  }
  current = page;
  if (url) await page.goto(url, { waitUntil: "load", timeout: 30_000 });
  return page;
};

export interface ListedPage {
  index: number;
  url: string;
  title: string;
  owned: boolean;
  active: boolean;
}

/** Every page in the attached context; non-owned pages are read-only. */
export const listPages = async (): Promise<ListedPage[]> => {
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

/** Switch the current tab (owned tabs only) and bring it to the front. */
export const switchPage = async (match: {
  index?: number;
  url?: string;
}): Promise<Page> => {
  const page = await findOwned(match);
  await page.bringToFront();
  current = page;
  return page;
};

/** Close an owned tab (default: current). Refuses the user's tabs. */
export const closePage = async (
  match: { index?: number; url?: string } = {},
): Promise<string> => {
  const page =
    match.index === undefined && match.url === undefined
      ? await getPage()
      : await findOwned(match);
  const url = page.url();
  await page.close();
  ownedPages.delete(page);
  if (current === page) current = null;
  return url;
};

/** Close owned tabs and detach. Never closes the user's browser or their tabs. */
export const closeForShutdown = async (): Promise<void> => {
  for (const page of [...ownedPages]) {
    try {
      if (!page.isClosed()) await page.close();
    } catch {
      // tab already gone; nothing to release
    }
  }
  ownedPages.clear();
  clients.clear();
  current = null;
  if (browser?.connected) browser.disconnect();
  browser = null;
};
