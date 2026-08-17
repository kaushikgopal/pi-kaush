/**
 * Lazy puppeteer connection to the running browser, plus tab ownership.
 *
 * Only tabs this extension created are controlled or closed. Everything else
 * in the user's browser is out of bounds.
 */

import puppeteer, {
  type Browser,
  type CDPSession,
  type Page,
} from "puppeteer-core";
import { clearRefs } from "./ax-snapshot.ts";
import { discoverEndpoint } from "./discovery.ts";

let browser: Browser | null = null;
let current: Page | null = null;
const ownedPages = new Set<Page>();
const clients = new Map<Page, CDPSession>();

export const getBrowser = async (): Promise<Browser> => {
  if (browser?.connected) return browser;
  const endpoint = await discoverEndpoint();
  const next = await puppeteer.connect({
    browserWSEndpoint: endpoint.wsUrl,
    defaultViewport: null,
  });
  next.on("disconnected", () => {
    browser = null;
    current = null;
    ownedPages.clear();
    clients.clear();
    clearRefs();
  });
  browser = next;
  return next;
};

/** One cached raw-CDP client per page for snapshot/interaction domains. */
export const cdpFor = async (page: Page): Promise<CDPSession> => {
  const cached = clients.get(page);
  if (cached) return cached;
  const client = await page.createCDPSession();
  clients.set(page, client);
  page.once("close", () => clients.delete(page));
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
  const b = await getBrowser();
  const page = trackPage(await b.newPage());
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
