import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPersistentFirefoxBrowser } from "../src/persistent.js";
import { createFirefoxStateStore } from "../src/state-store.js";
import type { TabInfo } from "../src/browser-types.js";
import type { FirefoxClientTransport } from "../src/types.js";

const temporaryDirectories: string[] = [];

async function newStatePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "firefox-persistent-test-"));
  temporaryDirectories.push(directory);
  return join(directory, "state.json");
}

function fixture() {
  const calls: string[][] = [];
  const windows = [{ id: 7, private: false }];
  let tabs: TabInfo[] = [];
  let nextId = 12;
  let abortController: AbortController | undefined;
  const transport: FirefoxClientTransport = async (_binary, args) => {
    calls.push([...args]);
    if (args[0] === "--version") return ok("0.4.1");
    if (args[0] === "doctor")
      return ok(
        JSON.stringify({
          nativeHostManifest: { status: "installed" },
          extensionConnection: { status: "connected" },
        }),
      );
    if (args[0] === "window") return ok(JSON.stringify({ windows }));
    if (args[0] === "tab" && args[1] === "--window")
      return ok(JSON.stringify({ tabs }));
    if (args[0] === "tab" && args[1] === "new") {
      const windowSelector = args[args.indexOf("--window") + 1] ?? "id:7";
      const windowId = Number(windowSelector.slice(3));
      const id = nextId++;
      tabs.push({
        id,
        windowId,
        url: "about:blank",
        private: false,
        cookieStoreId: "firefox-default",
      });
      return ok(JSON.stringify({ target: { tabId: id, windowId } }));
    }
    if (args[0] === "open") {
      const url = args[1]!;
      const tabSelector = args[args.indexOf("--tab") + 1]!;
      const windowSelector = args[args.indexOf("--window") + 1]!;
      const tabId = Number(tabSelector.slice(3));
      const windowId = Number(windowSelector.slice(3));
      if (url === "https://routed.example/start") {
        const replacementId = nextId++;
        tabs = tabs
          .filter((tab) => tab.id !== tabId)
          .concat({
            id: replacementId,
            windowId,
            url,
            private: false,
            cookieStoreId: "firefox-container-2",
          });
        return ok(
          JSON.stringify({
            target: { tabId, windowId },
            url,
            loadState: "unknown",
          }),
        );
      }
      tabs = tabs.map((tab) =>
        tab.id === tabId ? { ...tab, url, windowId } : tab,
      );
      if (abortController) {
        abortController.abort();
        abortController = undefined;
        return { stdout: "", stderr: "", exitCode: null, error: "aborted" };
      }
      return ok(
        JSON.stringify({
          target: { tabId, windowId },
          url,
          loadState: "unknown",
        }),
      );
    }
    if (args[0] === "wait")
      return ok(
        JSON.stringify({ kind: "load-state", matched: true, elapsedMs: 1 }),
      );
    if (args[0] === "tab" && args[1] === "close") {
      const tabId = Number(args[2]?.slice(3));
      tabs = tabs.filter((tab) => tab.id !== tabId);
      return ok(JSON.stringify({ closedTabId: tabId }));
    }
    return { stdout: "", stderr: "", exitCode: 1 };
  };
  return {
    calls,
    transport,
    get tabs() {
      return [...tabs];
    },
    abortNextOpen(controller: AbortController) {
      abortController = controller;
    },
    redirectTab(tabId: number, url: string) {
      tabs = tabs.map((tab) => (tab.id === tabId ? { ...tab, url } : tab));
    },
    get openCount() {
      return calls.filter((args) => args[0] === "open").length;
    },
    get createCount() {
      return calls.filter((args) => args[0] === "tab" && args[1] === "new")
        .length;
    },
  };
}

function makeBrowser(
  statePath: string,
  testFixture: ReturnType<typeof fixture>,
  epoch: () => Promise<string | null>,
  agentId = "agent-a",
  namespace = "/repo/project",
) {
  return createPersistentFirefoxBrowser({
    statePath,
    namespace,
    agentId,
    getEpoch: epoch,
    transport: testFixture.transport,
  });
}

function ok(stdout: string) {
  return { stdout, stderr: "", exitCode: 0 };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("persistent Firefox browser sessions", () => {
  it("rehydrates an exact same-epoch tab across client instances", async () => {
    const statePath = await newStatePath();
    const f = fixture();
    const epoch = async () => "browser-epoch-1";
    const first = makeBrowser(statePath, f, epoch);
    const created = await first.sessionEnsure({
      session: "work",
      url: "https://example.com/one",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const tabId = created.tab.id;
    const opens = f.openCount;

    const restarted = makeBrowser(statePath, f, epoch);
    const reused = await restarted.sessionEnsure({
      session: "work",
      url: "https://example.com/one",
    });
    expect(reused.ok).toBe(true);
    if (!reused.ok) return;
    expect(reused.tab.id).toBe(tabId);
    expect(f.createCount).toBe(1);
    expect(f.openCount).toBe(opens);
  });

  it("requires a full URL after an epoch change stripped a query", async () => {
    const statePath = await newStatePath();
    const f = fixture();
    let epochValue = "browser-epoch-1";
    const getEpoch = async () => epochValue;
    const first = makeBrowser(statePath, f, getEpoch);
    const originalUrl =
      "https://example.com/private?secret=not-persisted#section";
    const created = await first.sessionEnsure({
      session: "work",
      url: originalUrl,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const oldTabId = created.tab.id;
    const serialized = await readFile(statePath, "utf8");
    expect(serialized).not.toContain("secret=not-persisted");
    expect(serialized).not.toContain("#section");

    const sameEpochRestart = makeBrowser(statePath, f, getEpoch);
    const reused = await sameEpochRestart.sessionEnsure({
      session: "work",
      url: originalUrl,
    });
    expect(reused.ok).toBe(true);
    if (!reused.ok) return;
    expect(reused.tab.id).toBe(oldTabId);
    expect(f.createCount).toBe(1);

    epochValue = "browser-epoch-2";
    const restarted = makeBrowser(statePath, f, getEpoch);
    const denied = await restarted.sessionEnsure({ session: "work" });
    expect(denied).toMatchObject({ ok: false, code: "session_url_required" });
    expect(f.createCount).toBe(1);

    const recreated = await restarted.sessionEnsure({
      session: "work",
      url: originalUrl,
    });
    expect(recreated.ok).toBe(true);
    if (!recreated.ok) return;
    expect(recreated.tab.id).not.toBe(oldTabId);
    expect(f.createCount).toBe(2);
  });

  it("merges independent session entries and scopes them by agent", async () => {
    const statePath = await newStatePath();
    const f = fixture();
    const epoch = async () => "browser-epoch-1";
    const first = makeBrowser(statePath, f, epoch);
    const second = makeBrowser(statePath, f, epoch);
    const [one, two] = await Promise.all([
      first.sessionEnsure({ session: "one", url: "https://example.com/one" }),
      second.sessionEnsure({ session: "two", url: "https://example.com/two" }),
    ]);
    expect(one.ok).toBe(true);
    expect(two.ok).toBe(true);

    const firstList = await first.sessionList();
    const secondList = await second.sessionList();
    expect(
      firstList.ok && firstList.result.map((item) => item.session).sort(),
    ).toEqual(["one", "two"]);
    expect(
      secondList.ok && secondList.result.map((item) => item.session).sort(),
    ).toEqual(["one", "two"]);
    const cleanup = await first.sessionCleanup({ idleAfterMs: 1 });
    expect(cleanup).toMatchObject({ ok: true, result: { dryRun: true } });

    const otherAgent = makeBrowser(statePath, f, epoch, "agent-b");
    const isolated = await otherAgent.sessionList();
    expect(isolated).toMatchObject({ ok: true, result: [] });
    const isolatedCleanup = await otherAgent.sessionCleanup({ idleAfterMs: 1 });
    expect(isolatedCleanup).toMatchObject({
      ok: true,
      result: { dryRun: true, eligible: [], closed: [] },
    });
  });

  it("keeps an in-flight marker after an aborted mutation and blocks replay", async () => {
    const statePath = await newStatePath();
    const f = fixture();
    const epoch = async () => "browser-epoch-1";
    const first = makeBrowser(statePath, f, epoch);
    const controller = new AbortController();
    f.abortNextOpen(controller);
    const uncertain = await first.sessionEnsure(
      { session: "work", url: "https://example.com/after-abort" },
      { signal: controller.signal },
    );
    expect(uncertain).toMatchObject({ ok: false, code: "mutation_uncertain" });
    const creates = f.createCount;
    const opens = f.openCount;

    const restarted = makeBrowser(statePath, f, epoch);
    const blocked = await restarted.sessionEnsure({
      session: "work",
      url: "https://example.com/after-abort",
    });
    expect(blocked).toMatchObject({ ok: false, code: "mutation_uncertain" });
    expect(f.createCount).toBe(creates);
    expect(f.openCount).toBe(opens);

    const recovered = await restarted.recoverSession({ session: "work" });
    expect(recovered).toMatchObject({ ok: true, recovered: true });
    expect(f.createCount).toBe(creates);
    expect(f.openCount).toBe(opens);
  });

  it("keeps local replacement confirmation through listing and rejects a changed destination", async () => {
    const statePath = await newStatePath();
    const f = fixture();
    const browser = makeBrowser(statePath, f, async () => "browser-epoch-1");
    const created = await browser.sessionEnsure({ session: "work" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const oldTabId = created.tab.id;

    const navigation = await browser.go({
      session: "work",
      url: "https://routed.example/start",
      containerId: "firefox-container-2",
    });
    expect(navigation).toMatchObject({
      ok: false,
      code: "confirmation_required",
    });
    if (!("confirmation" in navigation) || !navigation.confirmation) return;
    const { id: confirmationId, candidate } = navigation.confirmation;

    const listed = await browser.sessionList({ session: "work" });
    expect(listed.ok && listed.result[0]?.state).toBe("confirmation_pending");

    f.redirectTab(candidate.id, "https://unexpected.example/actual");
    const confirmed = await browser.confirmReplacement({
      session: "work",
      confirmationId,
    });
    expect(confirmed).toMatchObject({ ok: false, code: "candidate_changed" });
    const after = await browser.sessionList({ session: "work" });
    expect(after.ok && after.result[0]?.tab.id).toBe(oldTabId);
    expect(after.ok && after.result[0]?.tab.id).not.toBe(candidate.id);
  });

  it("reconciles a committed marker before a new session operation", async () => {
    const statePath = await newStatePath();
    const f = fixture();
    const epoch = async () => "browser-epoch-1";
    const first = makeBrowser(statePath, f, epoch);
    const created = await first.sessionEnsure({
      session: "work",
      url: "https://example.com/one",
    });
    expect(created.ok).toBe(true);

    const hash = (value: string) =>
      createHash("sha256").update(value, "utf8").digest("hex");
    const prefix = `firefox-session:v1:${hash(JSON.stringify(["/repo/project", "agent-a"]))}:`;
    const entryKey = prefix + hash("work");
    const markerKey = `${entryKey}:inflight`;
    const store = createFirefoxStateStore({ path: statePath });
    await store.withEntry(entryKey, async (entry) => ({
      entry: {
        ...(entry as Record<string, unknown>),
        completedOperationId: "committed-op",
      },
      result: undefined,
    }));
    await store.withEntry(markerKey, async () => ({
      entry: {
        version: 1,
        epoch: "browser-epoch-1",
        operationId: "committed-op",
      },
      result: undefined,
    }));

    const restarted = makeBrowser(statePath, f, epoch);
    const reused = await restarted.sessionEnsure({
      session: "work",
      url: "https://example.com/one",
    });
    expect(reused.ok).toBe(true);
    expect(f.createCount).toBe(1);
    expect(await store.list()).not.toHaveProperty(markerKey);
  });

  it("requires recovery after a pending replacement crosses a client restart", async () => {
    const statePath = await newStatePath();
    const f = fixture();
    const epoch = async () => "browser-epoch-1";
    const first = makeBrowser(statePath, f, epoch);
    await first.sessionEnsure({ session: "work" });
    const navigation = await first.go({
      session: "work",
      url: "https://routed.example/start",
      containerId: "firefox-container-2",
    });
    expect(navigation).toMatchObject({
      ok: false,
      code: "confirmation_required",
    });
    if (!("confirmation" in navigation) || !navigation.confirmation) return;
    const candidateId = navigation.confirmation.candidate.id;

    const restarted = makeBrowser(statePath, f, epoch);
    const blocked = await restarted.sessionEnsure({ session: "work" });
    expect(blocked).toMatchObject({ ok: false, code: "owned_tab_missing" });
    const confirmation = await restarted.confirmReplacement({
      session: "work",
      confirmationId: navigation.confirmation.id,
    });
    expect(confirmation).toMatchObject({
      ok: false,
      code: "mutation_uncertain",
    });
    expect(f.createCount).toBe(1);
    expect(f.tabs.some((tab) => tab.id === candidateId)).toBe(true);
  });

  it("fails closed when the browser epoch is unknown", async () => {
    const statePath = await newStatePath();
    const f = fixture();
    const browser = makeBrowser(statePath, f, async () => null);

    const result = await browser.sessionEnsure({ session: "work" });
    expect(result).toMatchObject({ ok: false, code: "browser_epoch_unknown" });
    expect(f.createCount).toBe(0);
  });

  it("lists only owned sessions and does not replace active bindings", async () => {
    const statePath = await newStatePath();
    const f = fixture();
    const epoch = async () => "browser-epoch-1";
    const browser = makeBrowser(statePath, f, epoch);
    const result = await browser.sessionEnsure({
      session: "work",
      url: "https://example.com/page",
    });
    expect(result.ok).toBe(true);
    const listed = await browser.sessionList({ session: "work" });
    expect(listed.ok && listed.result).toHaveLength(1);
    if (result.ok && listed.ok)
      expect(listed.result[0]?.tab.id).toBe(result.tab.id);
  });
});
