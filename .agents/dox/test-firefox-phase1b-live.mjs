#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { createFirefoxBrowser } from "@pi-kaush/firefox-agent-core";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = "http://127.0.0.1:48765";
const cli = (...args) => JSON.parse(execFileSync("firefox-cli", [...args, "--json"], { encoding: "utf8", timeout: 15_000 }));
const windows = cli("window").windows.filter((window) => !window.private);
assert.equal(windows.length, 1, "Choose an explicit normal window before this smoke test");
const windowId = windows[0].id;
const tabIds = () => cli("tab", "--window", `id:${windowId}`).tabs.map((tab) => tab.id);
const before = tabIds();
const reservation = createServer();
reservation.listen(48765, "127.0.0.1");
await once(reservation, "listening");
await new Promise((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));

const server = spawn(process.execPath, [fileURLToPath(new URL("./test-firefox-container-server.mjs", import.meta.url))], { stdio: "ignore" });
const client = createFirefoxBrowser();
const session = `phase1b-smoke-${process.pid}`;
let ensured = false;
let closed = false;
const extraSessions = [];
try {
  let ready = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const response = await fetch(`${base}/phase0-probe/`, { signal: AbortSignal.timeout(500) });
      if (response.ok) { await response.arrayBuffer(); ready = true; break; }
    } catch {}
    await delay(100);
  }
  assert.ok(ready, "Synthetic fixture did not start");
  const first = await client.sessionEnsure({ session, windowId, url: `${base}/phase0-probe/` });
  assert.ok(first.ok, first.ok ? "" : `Ensure failed: ${first.code}`);
  ensured = true;
  assert.equal(first.container.cookieStoreId, "firefox-default");
  assert.ok(!before.includes(first.tab.id), "The client must create its own tab");
  const again = await client.sessionEnsure({ session });
  assert.ok(again.ok, again.ok ? "" : again.code);
  assert.equal(again.tab.id, first.tab.id);
  const read = await client.read({ session, maxBytes: 512 });
  assert.ok(read.ok, read.ok ? "" : read.code);
  const summary = JSON.stringify(read.result);
  assert.ok(Buffer.byteLength(summary) <= 512);
  assert.ok(!/@e\d+/.test(summary), "Summary must not expose refs");
  assert.ok(read.result.headings.some((heading) => heading.includes("Phase 0 HTML probe")));
  const navigated = await client.go({ session, url: `${base}/phase0-probe/?synthetic=second` });
  assert.ok(navigated.ok, navigated.ok ? "" : navigated.code);
  assert.equal(navigated.tab.id, first.tab.id);
  assert.ok(!navigated.tab.url.includes("?"), "Result URLs must omit query strings");
  const close = await client.sessionClose({ session });
  assert.ok(close.ok, close.ok ? "" : close.code);
  closed = true;
  const missing = await client.read({ session });
  assert.equal(missing.ok, false);
  const parallelNames = [`${session}-a`, `${session}-b`];
  const parallel = await Promise.all(parallelNames.map((name) => client.sessionEnsure({ session: name, windowId, url: `${base}/phase0-probe/` })));
  for (let index = 0; index < parallel.length; index++) {
    if (parallel[index].ok) extraSessions.push(parallelNames[index]);
    assert.ok(parallel[index].ok, parallel[index].ok ? "" : parallel[index].code);
  }
  assert.notEqual(parallel[0].tab.id, parallel[1].tab.id);
  const parallelReads = await Promise.all(parallelNames.map((name) => client.read({ session: name, maxBytes: 512 })));
  assert.ok(parallelReads.every((result) => result.ok));
  for (const name of parallelNames) assert.ok((await client.sessionClose({ session: name })).ok);
  extraSessions.length = 0;

  const directory = await mkdtemp(join(tmpdir(), "pi-firefox-live-loader-"));
  let piTools;
  let piSessionOpen = false;
  const piSession = `${session}-pi`;
  try {
    const loaded = await discoverAndLoadExtensions([fileURLToPath(new URL("../../extensions/pi-firefox/src/index.ts", import.meta.url))], directory, directory);
    assert.deepEqual(loaded.errors, []);
    piTools = loaded.extensions[0].tools;
    const execute = async (name, args) => (await piTools.get(name).definition.execute(`live-${name}`, args, undefined, undefined, {hasUI:false})).structuredContent;
    const piEnsure = await execute("ff_session_ensure", {session:piSession, windowId, url:`${base}/phase0-probe/`});
    assert.ok(piEnsure.ok, piEnsure.ok ? "" : piEnsure.code);
    piSessionOpen = true;
    assert.ok((await execute("ff_read", {session:piSession,maxBytes:512})).ok);
    assert.ok((await execute("ff_go", {session:piSession,url:`${base}/phase0-probe/?from=pi`})).ok);
    assert.ok((await execute("ff_session_close", {session:piSession})).ok);
    piSessionOpen = false;
  } finally {
    if (piSessionOpen) {
      const result = await piTools.get("ff_session_close").definition.execute("live-cleanup", {session:piSession}, undefined, undefined, {hasUI:false});
      console.log(JSON.stringify({piCleanup:result.structuredContent.ok}));
    }
    await rm(directory,{recursive:true,force:true});
  }
  assert.deepEqual(tabIds().sort((a,b) => a-b), [...before].sort((a,b) => a-b));
  console.log(JSON.stringify({ ok: true, probes: ["new-owned-tab", "idempotent-ensure", "verified-default-container", "bounded-ref-free-summary", "targeted-navigation", "safe-url-projection", "owned-close", "closed-session-refusal", "original-tabs-preserved", "independent-session-overlap", "real-pi-loader-session-tools"], summaryBytes: Buffer.byteLength(summary) }));
} finally {
  for (const name of extraSessions) {
    const result = await client.sessionClose({session:name});
    console.log(JSON.stringify({extraSessionCleanup:result.ok}));
  }
  if (ensured && !closed) {
    const cleanup = await client.sessionClose({ session });
    console.log(JSON.stringify({ cleanup: cleanup.ok ? "closed-owned-tab" : cleanup.code }));
  }
  if (server.exitCode === null) {
    const stopped = once(server, "exit");
    server.kill("SIGTERM");
    await stopped;
  }
}
