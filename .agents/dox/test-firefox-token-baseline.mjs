#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { summarizeSnapshot } from "../../packages/firefox-agent-core/src/summary.ts";

const execFileAsync = promisify(execFile);
const SNAPSHOT_CAP_BYTES = 60_000;
const FIXTURE_HOST = "127.0.0.1";
const pages = [
  {
    kind: "form",
    path: "/form/",
    title: "Synthetic contact form",
    body: `<form aria-labelledby="form-title">
      <h2 id="form-title">Send a test note</h2>
      <label>Display name <input name="display-name" autocomplete="off"></label>
      <label>Test note <textarea name="test-note" rows="3"></textarea></label>
      <label>Topic <select name="topic"><option>General test</option><option>Follow-up test</option></select></label>
      <label><input type="checkbox" name="copy"> Keep a local test copy</label>
      <button type="button">Preview test note</button>
    </form>
    <p>No form submission or account data is used.</p>`,
  },
  {
    kind: "list",
    path: "/list/",
    title: "Synthetic project list",
    body: `<section aria-labelledby="projects-title">
      <h2 id="projects-title">Test projects</h2>
      <ul>
        <li><a href="#alpha">Alpha fixture</a> — Review the sample layout.</li>
        <li><a href="#bravo">Bravo fixture</a> — Check the synthetic status.</li>
        <li><a href="#charlie">Charlie fixture</a> — Compare the sample rows.</li>
        <li><a href="#delta">Delta fixture</a> — Read the test description.</li>
        <li><a href="#echo">Echo fixture</a> — Inspect the mock schedule.</li>
        <li><a href="#foxtrot">Foxtrot fixture</a> — Confirm the sample category.</li>
        <li><a href="#golf">Golf fixture</a> — View the test summary.</li>
        <li><a href="#hotel">Hotel fixture</a> — Check the final mock item.</li>
      </ul>
      <p>All entries are synthetic and have no external destinations.</p>
    </section>`,
  },
  {
    kind: "article",
    path: "/article/",
    title: "Synthetic field guide article",
    body: `<article>
      <p><strong>Fixture article</strong> · Synthetic editorial content</p>
      <h2>A small guide to sample pages</h2>
      <p>This paragraph describes a fictional field guide. It uses plain text to model a typical article page without external images, scripts, accounts, or tracking.</p>
      <h3>First section</h3>
      <p>The first section has enough content to compare visible text snapshots. It includes a short explanation, a citation label, and one link to another section.</p>
      <blockquote><p>“A useful fixture is safe, local, and easy to remove.”</p></blockquote>
      <h3>Second section</h3>
      <p>The second section adds a little more structure. The content remains fictional and does not include real people or personal data.</p>
      <p><a href="#summary">Read the synthetic summary</a></p>
      <h2 id="summary">Summary</h2>
      <p>Four page shapes provide a compact baseline for snapshot size comparisons.</p>
    </article>`,
  },
  {
    kind: "dialog",
    path: "/dialog/",
    title: "Synthetic confirmation dialog",
    body: `<section aria-labelledby="dialog-section">
      <h2 id="dialog-section">Review a sample decision</h2>
      <p>This page presents a static dialog fixture. It does not change settings or submit data.</p>
      <dialog open aria-labelledby="dialog-title" aria-describedby="dialog-copy">
        <h3 id="dialog-title">Save this synthetic draft?</h3>
        <p id="dialog-copy">The draft contains fixture text only. No data will be sent.</p>
        <button type="button">Keep editing</button>
        <button type="button">Discard fixture</button>
      </dialog>
    </section>`,
  },
];

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://${FIXTURE_HOST}`);
  const page = pages.find((candidate) => candidate.path === url.pathname);
  if (request.method !== "GET" || !page) {
    response.writeHead(404, {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'",
    });
    response.end("Synthetic fixture route not found.");
    return;
  }
  page.requests = (page.requests ?? 0) + 1;
  const body = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${page.title}</title>
</head>
<body>
  <main>
    <h1>${page.title}</h1>
    ${page.body}
  </main>
</body>
</html>`;
  page.htmlBytes = Buffer.byteLength(body, "utf8");
  response.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
  });
  response.end(body);
});

let tempDir;
let ownedTabId;
let windowId;
let originalTabIds = [];
let originalWindowIds = [];
let serverStarted = false;
const counts = {
  windowList: 0,
  tabList: 0,
  tabCreate: 0,
  tabClose: 0,
  navigation: 0,
  navigationWait: 0,
  snapshotVerbose: 0,
  snapshotCompact: 0,
  snapshotScopedDepth7: 0,
  screenshot: 0,
  summarizeSnapshot: 0,
};
let report;
let fatalError;
const cleanup = {
  ownedTabCloseAttempted: false,
  ownedTabAbsentAfterCleanup: null,
  originalTabIdsUnchanged: null,
  originalNormalWindowIdsUnchanged: null,
  fixtureStopped: false,
  screenshotTempRemoved: null,
};

async function cli(name, args, counter) {
  if (counter) counts[counter] += 1;
  let stdout;
  try {
    ({ stdout } = await execFileAsync("firefox-cli", [...args, "--json"], {
      encoding: "utf8",
      timeout: 20_000,
      maxBuffer: 8 * 1024 * 1024,
    }));
  } catch (error) {
    const code = typeof error?.code === "number" ? error.code : "unknown";
    throw new Error(`firefox-cli ${name} failed (exit ${code})`);
  }
  try {
    return { value: JSON.parse(stdout), bytes: Buffer.byteLength(stdout, "utf8") };
  } catch {
    throw new Error(`firefox-cli ${name} returned invalid JSON`);
  }
}

async function listWindows() {
  const result = (await cli("window list", ["window"], "windowList")).value;
  if (!Array.isArray(result.windows)) throw new Error("Firefox window list is unavailable");
  return result.windows;
}

async function listTabs() {
  const result = (await cli("tab list", ["tab", "--window", `id:${windowId}`], "tabList")).value;
  if (!Array.isArray(result.tabs)) throw new Error("Firefox tab list is unavailable");
  return result.tabs;
}

function sameIds(actual, expected) {
  return actual.length === expected.length
    && [...actual].sort((a, b) => a - b).every((id, index) => id === [...expected].sort((a, b) => a - b)[index]);
}

async function assertOwnedTab(expectedPath, allowBlankTransition = false) {
  const tabs = await listTabs();
  const ids = tabs.map((tab) => tab.id);
  const expectedIds = [...originalTabIds, ownedTabId];
  if (!sameIds(ids, expectedIds)) {
    throw new Error("Owned tab set changed unexpectedly; stop without adopting another tab");
  }
  const tab = tabs.find((candidate) => candidate.id === ownedTabId);
  if (!tab || tab.windowId !== windowId || tab.private === true) {
    throw new Error("Owned tab is no longer confirmed in the test window");
  }
  if (expectedPath !== undefined) {
    let current;
    try {
      current = new URL(tab.url);
    } catch {
      throw new Error("Owned tab URL changed unexpectedly");
    }
    const expected = new URL(expectedPath, fixtureBase);
    if (current.origin !== expected.origin || current.pathname !== expected.pathname) {
      if (allowBlankTransition && tab.url === "about:blank") return tab;
      throw new Error(`Owned tab URL mismatch (fixtureOriginMatch=${current.origin === expected.origin}, fixturePathMatch=${current.pathname === expected.pathname}, blank=${tab.url === "about:blank"})`);
    }
  }
  return tab;
}

async function snapshot(name, flags, counter) {
  const result = await cli(name, [
    "snapshot",
    ...flags,
    "--max-output",
    String(SNAPSHOT_CAP_BYTES),
    "--window",
    `id:${windowId}`,
    "--tab",
    `id:${ownedTabId}`,
  ], counter);
  await assertOwnedTab(currentPage.path);
  if (typeof result.value.text !== "string" || typeof result.value.truncated !== "boolean") {
    throw new Error(`Snapshot ${name} did not match the documented result shape`);
  }
  return {
    responseBytes: result.bytes,
    textBytes: Buffer.byteLength(result.value.text, "utf8"),
    truncated: result.value.truncated,
    refCount: Array.isArray(result.value.refs) ? result.value.refs.length : null,
    text: result.value.text,
  };
}

let currentPage;
let fixtureBase;

try {
  const listen = new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, FIXTURE_HOST, resolve);
  });
  await listen;
  serverStarted = true;
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Loopback fixture did not bind");
  fixtureBase = `http://${FIXTURE_HOST}:${address.port}`;

  const normalWindows = (await listWindows()).filter((window) => !window.private);
  if (normalWindows.length !== 1) {
    throw new Error("Expected exactly one normal Firefox window; stop without using the active window");
  }
  windowId = normalWindows[0].id;
  originalWindowIds = normalWindows.map((window) => window.id);
  const before = await listTabs();
  if (before.some((tab) => tab.windowId !== windowId || tab.private === true)) {
    throw new Error("The selected normal window returned an unexpected tab");
  }
  originalTabIds = before.map((tab) => tab.id);

  const created = (await cli("create about:blank tab", [
    "tab",
    "new",
    "about:blank",
    "--window",
    `id:${windowId}`,
  ], "tabCreate")).value;
  const afterCreate = await listTabs();
  const beforeSet = new Set(originalTabIds);
  const additions = afterCreate.filter((tab) => !beforeSet.has(tab.id));
  const removedOriginals = originalTabIds.filter((id) => !afterCreate.some((tab) => tab.id === id));
  if (additions.length !== 1 || removedOriginals.length !== 0) {
    throw new Error("Could not prove one newly created tab; stop without adopting a tab");
  }
  ownedTabId = additions[0].id;
  if (ownedTabId === undefined || beforeSet.has(ownedTabId)) {
    throw new Error("New tab ID is not distinct from the original tabs");
  }
  const reportedTarget = created.target;
  const reportedTabId = reportedTarget?.tabId ?? reportedTarget?.id;
  if (reportedTabId !== undefined && reportedTabId !== ownedTabId) {
    throw new Error("CLI creation result did not match the new tab ID");
  }
  const blank = await assertOwnedTab();
  if (blank.url !== "about:blank") {
    throw new Error("Newly created tab did not remain about:blank; stop without adopting it");
  }

  const pageResults = [];
  for (const page of pages) {
    currentPage = page;
    const pageUrl = new URL(page.path, fixtureBase).href;
    const opened = (await cli("targeted navigation", [
      "open",
      pageUrl,
      "--window",
      `id:${windowId}`,
      "--tab",
      `id:${ownedTabId}`,
    ], "navigation")).value;
    await assertOwnedTab(page.path, true);
    const navigationWait = (await cli("navigation load wait", [
      "wait", "--load", "domcontentloaded", "--timeout", "10000",
      "--window", `id:${windowId}`, "--tab", `id:${ownedTabId}`,
    ], "navigationWait")).value;
    if (navigationWait.matched !== true) throw new Error("Targeted navigation load wait did not match");
    const afterWait = await assertOwnedTab(page.path, true);
    if (afterWait.url === "about:blank") {
      let returnedRoute = false;
      let returnedBlank = false;
      if (typeof opened.url === "string") {
        returnedBlank = opened.url === "about:blank";
        try {
          const returned = new URL(opened.url);
          const expected = new URL(pageUrl);
          returnedRoute = returned.origin === expected.origin && returned.pathname === expected.pathname;
        } catch {}
      }
      const targetId = opened.target?.tabId ?? opened.target?.id;
      throw new Error(`Navigation did not reach the fixture (resultRouteMatch=${returnedRoute}, resultBlank=${returnedBlank}, resultTargetMatches=${targetId === ownedTabId}, fixtureRequests=${page.requests ?? 0})`);
    }
    await assertOwnedTab(page.path);

    const verbose = await snapshot("verbose", ["--verbose"], "snapshotVerbose");
    const compact = await snapshot("compact", ["--compact"], "snapshotCompact");
    const scoped = await snapshot(
      "scoped depth-7",
      ["--compact", "--selector", "main", "--depth", "7"],
      "snapshotScopedDepth7",
    );
    counts.summarizeSnapshot += 1;
    const summary = summarizeSnapshot({
      title: page.title,
      text: scoped.text,
      truncated: scoped.truncated,
      maxBytes: 4_000,
    });
    const summaryJson = JSON.stringify(summary);
    const summaryBytes = Buffer.byteLength(summaryJson, "utf8");
    const helperOutputBytes = Buffer.byteLength(summaryJson, "utf8");

    pageResults.push({
      kind: page.kind,
      fixtureHtmlBytes: page.htmlBytes,
      verbose: {
        responseBytes: verbose.responseBytes,
        responseTokensBytesDiv4: Math.round(verbose.responseBytes / 4),
        textBytes: verbose.textBytes,
        textTokensBytesDiv4: Math.round(verbose.textBytes / 4),
        capBytes: SNAPSHOT_CAP_BYTES,
        truncated: verbose.truncated,
        refs: verbose.refCount,
      },
      compact: {
        responseBytes: compact.responseBytes,
        responseTokensBytesDiv4: Math.round(compact.responseBytes / 4),
        textBytes: compact.textBytes,
        textTokensBytesDiv4: Math.round(compact.textBytes / 4),
        capBytes: SNAPSHOT_CAP_BYTES,
        truncated: compact.truncated,
        refs: compact.refCount,
      },
      scopedDepth7: {
        responseBytes: scoped.responseBytes,
        responseTokensBytesDiv4: Math.round(scoped.responseBytes / 4),
        textBytes: scoped.textBytes,
        textTokensBytesDiv4: Math.round(scoped.textBytes / 4),
        capBytes: SNAPSHOT_CAP_BYTES,
        truncated: scoped.truncated,
        refs: scoped.refCount,
      },
      summarizeSnapshot: {
        outputBytes: summaryBytes,
        outputTokensBytesDiv4: Math.round(helperOutputBytes / 4),
        truncated: summary.truncated,
        headings: summary.headings.length,
        controls: summary.controls,
        dialogs: summary.dialogs.length,
      },
    });
  }

  currentPage = pages.find((page) => page.kind === "dialog");
  await assertOwnedTab(currentPage.path);
  tempDir = await mkdtemp(join(tmpdir(), "pi-firefox-token-baseline-"));
  const screenshotPath = join(tempDir, "synthetic-dialog.png");
  const shot = (await cli("owned-tab screenshot", [
    "screenshot",
    screenshotPath,
    "--window",
    `id:${windowId}`,
    "--tab",
    `id:${ownedTabId}`,
  ], "screenshot")).value;
  await assertOwnedTab(currentPage.path);
  const screenshotStat = await stat(screenshotPath);
  const screenshotBytes = screenshotStat.size;
  const png = await readFile(screenshotPath);
  if (png.length < 24 || png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
    throw new Error("Screenshot output is not a PNG file");
  }
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (typeof shot.bytes === "number" && shot.bytes !== screenshotBytes) {
    throw new Error("Screenshot CLI byte count does not match its file");
  }
  if (typeof shot.width === "number" && shot.width !== width) {
    throw new Error("Screenshot CLI width does not match its file");
  }
  if (typeof shot.height === "number" && shot.height !== height) {
    throw new Error("Screenshot CLI height does not match its file");
  }

  const fixtureRequests = Object.fromEntries(pages.map((page) => [page.kind, page.requests ?? 0]));
  const savedOwnedTabId = ownedTabId;
  const closeResult = await cli("close confirmed test tab", [
    "tab",
    "close",
    `id:${savedOwnedTabId}`,
    "--window",
    `id:${windowId}`,
  ], "tabClose");
  if (closeResult.value.closedTabId !== undefined && closeResult.value.closedTabId !== savedOwnedTabId) {
    throw new Error("Firefox CLI closed a tab other than the confirmed test tab");
  }
  ownedTabId = undefined;
  const afterClose = await listTabs();
  const sameOriginalTabs = sameIds(afterClose.map((tab) => tab.id), originalTabIds);
  const currentNormalWindowIds = (await listWindows())
    .filter((window) => !window.private)
    .map((window) => window.id);
  const sameNormalWindowIds = sameIds(currentNormalWindowIds, originalWindowIds);
  if (!sameOriginalTabs || !sameNormalWindowIds) {
    throw new Error("Original Firefox window or tab IDs changed during the test");
  }

  const screenshot = {
    width,
    height,
    bytes: screenshotBytes,
    theoreticalBase64Bytes: 4 * Math.ceil(screenshotBytes / 3),
  };
  report = {
    ok: true,
    runtime: {
      nodeMajor: Number(process.versions.node.split(".")[0]),
      helperImport: "direct TypeScript import; Node 26 dev-only requirement",
      firefoxCli: "0.4.1",
    },
    isolation: {
      uniqueNormalWindow: true,
      newAboutBlankTabProvedByIdDelta: true,
      targetedNavigationKeptTabId: true,
      privatePagesAccessed: false,
      originalTabIdsUnchanged: sameOriginalTabs,
      originalNormalWindowIdsUnchanged: sameNormalWindowIds,
      ownedTabClosed: true,
    },
    pages: pageResults,
    screenshot,
    fixtureRequests,
    calls: {
      ...counts,
      cliTotal: Object.values(counts).reduce((sum, count) => sum + count, 0) - counts.summarizeSnapshot,
      helperTotal: counts.summarizeSnapshot,
      totalWithHelper: Object.values(counts).reduce((sum, count) => sum + count, 0),
    },
  };
} catch (error) {
  fatalError = error instanceof Error ? error.message : "Unknown baseline failure";
} finally {
  if (ownedTabId !== undefined && windowId !== undefined) {
    try {
      const tabs = await listTabs();
      const ownedTabPresent = tabs.some((tab) => tab.id === ownedTabId && tab.windowId === windowId && !tab.private);
      if (ownedTabPresent) {
        cleanup.ownedTabCloseAttempted = true;
        await cli("close confirmed test tab during cleanup", [
          "tab",
          "close",
          `id:${ownedTabId}`,
          "--window",
          `id:${windowId}`,
        ], "tabClose");
      }
      const afterCleanup = await listTabs();
      cleanup.ownedTabAbsentAfterCleanup = !afterCleanup.some((tab) => tab.id === ownedTabId);
      cleanup.originalTabIdsUnchanged = sameIds(afterCleanup.map((tab) => tab.id), originalTabIds);
      cleanup.originalNormalWindowIdsUnchanged = sameIds(
        (await listWindows()).filter((window) => !window.private).map((window) => window.id),
        originalWindowIds,
      );
    } catch {
      // Keep cleanup scoped to the exact confirmed ID; never adopt a replacement tab.
    }
  }
  if (serverStarted) {
    await new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
    cleanup.fixtureStopped = true;
  }
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    cleanup.screenshotTempRemoved = true;
  }
}

if (fatalError) {
  const totalCalls = Object.values(counts).reduce((sum, count) => sum + count, 0);
  console.error(JSON.stringify({
    ok: false,
    error: fatalError,
    baselinePagesCompleted: report?.pages.length ?? 0,
    fixtureRequestsObserved: currentPage?.requests ?? 0,
    calls: { ...counts, cliTotal: totalCalls - counts.summarizeSnapshot, helperTotal: counts.summarizeSnapshot, totalWithHelper: totalCalls },
    cleanup,
  }));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify(report));
}
