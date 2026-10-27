import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createFirefoxAutomation,
  FIREFOX_TOOLS,
  type FirefoxRuntimeConfig,
} from "../src/index.js";
import type { FirefoxClientTransport } from "../src/types.js";
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "firefox-automation-"));
  directories.push(directory);
  const config: FirefoxRuntimeConfig = {
    binaryPath: "fake",
    timeoutMs: 1000,
    maxOutputBytes: 128000,
    summaryMaxBytes: 4000,
    scopedMaxBytes: 16000,
    settleTimeoutMs: 5,
    statePath: join(directory, "state.json"),
    screenshotDir: join(directory, "screenshots"),
    logPath: join(directory, "events.jsonl"),
    logLevel: "debug",
    namespace: "test",
    agentId: "agent",
    defaultSession: "default",
    defaultContainerId: null,
    containerNames: { "firefox-container-2": "Work" },
  };
  let next = 10;
  let generation = 0;
  let writes = 0;
  let transportHook: ((args: readonly string[]) => Promise<void>) | undefined;
  const tabs: Array<{
    id: number;
    windowId: number;
    url: string;
    cookieStoreId: string;
    private: boolean;
  }> = [];
  const calls: string[][] = [];
  const transport: FirefoxClientTransport = async (_binary, args) => {
    calls.push([...args]);
    await transportHook?.(args);
    const response = (value: unknown) => ({
      stdout: JSON.stringify(value),
      stderr: "",
      exitCode: 0,
    });
    const id = Number(args[args.indexOf("--tab") + 1]?.replace("id:", ""));
    const tab = tabs.find((tab) => tab.id === id);
    const target = () => ({
      tabId: id,
      windowId: 7,
      cookieStoreId: tab?.cookieStoreId,
      url: tab?.url,
    });
    if (args[0] === "--version")
      return { stdout: "0.4.1", stderr: "", exitCode: 0 };
    if (args[0] === "doctor")
      return response({
        nativeHostManifest: { status: "installed" },
        extensionConnection: { status: "connected" },
      });
    if (args[0] === "window")
      return response({ windows: [{ id: 7, private: false }] });
    if (args[0] === "tab" && args[1] === "--window") return response({ tabs });
    if (args[0] === "tab" && args[1] === "new") {
      const tab = {
        id: next++,
        windowId: 7,
        url: "about:blank",
        cookieStoreId: "firefox-default",
        private: false,
      };
      tabs.push(tab);
      writes++;
      return response({ target: { tabId: tab.id, windowId: 7 } });
    }
    if (args[0] === "open" && tab) {
      tab.url = args[1]!;
      writes++;
      if (tab.url.includes("/routed")) {
        tabs.splice(tabs.indexOf(tab), 1, {
          ...tab,
          id: next++,
          cookieStoreId: "firefox-container-2",
        });
      }
      return response({ target: target(), url: args[1] });
    }
    if (args[0] === "wait")
      return response({ target: target(), matched: true, elapsedMs: 1 });
    if (args[0] === "network")
      return response({ action: "list", ok: true, requests: [] });
    if (args[0] === "get" && args[1] === "title")
      return response({ target: target(), value: "Fixture" });
    if (args[0] === "snapshot")
      return response({
        target: target(),
        generationId: `g${++generation}`,
        text: 'title "Fixture"\n@e1 heading "Fixture" level=1\n@e2 textbox "Name"\n@e3 button "Save"\n@e4 status "Total"',
        truncated: false,
      });
    if (args[0] === "get" && args[1] === "text")
      return response({
        target: target(),
        value: args[2] === "@e4" ? "12.50" : "Visible text",
        truncated: false,
      });
    if (args[0] === "ref")
      return response({
        target: target(),
        element: { ref: args[1], generationId: args[3] },
      });
    if (["click", "fill", "select", "press", "scroll"].includes(args[0]!)) {
      writes++;
      return response({ target: target(), ok: true, action: args[0] });
    }
    if (args[0] === "tab" && args[1] === "close") {
      const closedId = Number(args[2]?.replace("id:", ""));
      const index = tabs.findIndex((tab) => tab.id === closedId);
      if (index >= 0) tabs.splice(index, 1);
      writes++;
      return response({ closedTabId: closedId });
    }
    return { stdout: "", stderr: "unexpected", exitCode: 1 };
  };
  const coordinationPath = join(directory, "browser-activity.json");
  const create = (
    automationConfig: FirefoxRuntimeConfig = config,
    cwd?: string,
  ) =>
    createFirefoxAutomation({
      config: automationConfig,
      transport,
      getEpoch: async () => "epoch-1",
      coordinationPath,
      ...(cwd ? { cwd } : {}),
    });
  return {
    config,
    directory,
    create,
    calls,
    tabs,
    writes: () => writes,
    setTransportHook(hook: (args: readonly string[]) => Promise<void>) {
      transportHook = hook;
    },
  };
}
describe("Firefox automation facade", () => {
  it("resolves workflow files from the caller working directory", async () => {
    const f = await fixture();
    await writeFile(
      join(f.directory, "workflow.json"),
      JSON.stringify([{ type: "read" }]),
    );
    const result = await f
      .create(f.config, f.directory)
      .execute("ff_do", { dryRun: true, workflowFile: "workflow.json" });
    expect(result).toMatchObject({
      ok: true,
      result: { plannedOperations: 1 },
    });
    expect(f.calls).toHaveLength(0);
  });

  it("uses the configured default container as an expectation", async () => {
    const f = await fixture();
    f.config.defaultContainerId = "firefox-container-2";
    const result = await f
      .create()
      .execute(
        "ff_session_ensure",
        { session: "configured", url: "https://example.test/routed" },
        { approveReplacement: async () => true },
      );
    expect(result).toMatchObject({
      ok: true,
      container: { cookieStoreId: "firefox-container-2" },
    });
  });

  it("checks catalog schemas before any backend call", async () => {
    const f = await fixture();
    const app = f.create();
    for (const args of [
      { session: 42, url: "https://example.test/" },
      { session: "ok", url: 4 },
      { session: "ok", url: "https://example.test/", unexpected: true },
    ])
      expect(await app.execute("ff_go", args)).toMatchObject({
        ok: false,
        code: "invalid_input",
      });
    expect(f.calls).toHaveLength(0);
    expect(await app.execute("ff_cookie", {})).toMatchObject({ ok: false });
    expect(new Set(FIREFOX_TOOLS.map((tool) => tool.name)).size).toBe(
      FIREFOX_TOOLS.length,
    );
  });
  it("dry-runs a write workflow without backend or filesystem effects", async () => {
    const f = await fixture();
    const result = await f.create().execute("ff_do", {
      dryRun: true,
      allowWrite: true,
      steps: [
        { type: "navigate", url: "https://example.test/" },
        { type: "click", ref: "e1" },
      ],
    });
    expect(result).toMatchObject({
      ok: true,
      result: { dryRun: true, plannedOperations: 2, outcomes: [] },
    });
    expect(f.calls).toHaveLength(0);
    expect(await readdir(f.directory)).toEqual([]);
  });
  it("coordinates clients with distinct state paths and cancels blocked writers", async () => {
    const f = await fixture();
    const otherConfig: FirefoxRuntimeConfig = {
      ...f.config,
      statePath: join(f.directory, "alternate", "state.json"),
      logPath: join(f.directory, "alternate", "events.jsonl"),
    };
    const first = f.create();
    const second = f.create(otherConfig);
    expect(f.config.statePath).not.toBe(otherConfig.statePath);
    await expect(
      first.execute("ff_session_ensure", {
        session: "reader",
        url: "https://example.test/reader",
      }),
    ).resolves.toMatchObject({ ok: true });
    let entered!: () => void;
    const readerEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const readerBlock = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = false;
    f.setTransportHook(async () => {
      if (!held) {
        held = true;
        entered();
        await readerBlock;
      }
    });
    const reader = first.execute("ff_network", { session: "reader" });
    await readerEntered;
    const createdTabCount = () =>
      f.calls.filter((args) => args[0] === "tab" && args[1] === "new").length;
    const beforeWriter = createdTabCount();
    const controller = new AbortController();
    const blockedWriter = second.execute(
      "ff_session_ensure",
      { session: "cancelled", url: "https://example.test/cancelled" },
      { signal: controller.signal },
    );
    try {
      await delay(30);
      expect(createdTabCount()).toBe(beforeWriter);
      controller.abort();
      await expect(blockedWriter).resolves.toMatchObject({
        ok: false,
        code: "aborted",
      });
      expect(createdTabCount()).toBe(beforeWriter);
    } finally {
      release();
    }
    await expect(reader).resolves.toMatchObject({ ok: true });
    await expect(
      second.execute("ff_session_ensure", {
        session: "after-cancel",
        url: "https://example.test/after-cancel",
      }),
    ).resolves.toMatchObject({ ok: true });
  }, 15000);
  it("persists scoped sessions and lists all names by default", async () => {
    const f = await fixture();
    const app = f.create();
    for (const session of ["one", "two"])
      expect(
        await app.execute("ff_session_ensure", {
          session,
          url: `https://example.test/${session}?token=secret`,
        }),
      ).toMatchObject({ ok: true, session });
    const listed = await app.execute("ff_session_list");
    expect(listed.ok).toBe(true);
    expect(
      Array.isArray(listed.result) &&
        listed.result.map((value) =>
          typeof value === "object" && value !== null && !Array.isArray(value)
            ? value.session
            : null,
        ),
    ).toEqual(["one", "two"]);
    const writes = f.writes();
    expect(
      await f.create().execute("ff_session_ensure", { session: "one" }),
    ).toMatchObject({ ok: true, session: "one" });
    expect(f.writes()).toBe(writes);
    expect(await readFile(f.config.statePath, "utf8")).not.toContain(
      "token=secret",
    );
    expect(await readFile(f.config.logPath, "utf8")).not.toContain(
      "token=secret",
    );
  });
  it("keeps typed extraction explicit and source-backed", async () => {
    const f = await fixture();
    const app = f.create();
    await app.execute("ff_session_ensure", {
      session: "one",
      url: "https://example.test/",
    });
    const extracted = await app.execute("ff_extract", {
      session: "one",
      fields: {
        total: {
          type: "number",
          selector: { role: "status", name: "Total", exact: true },
        },
        title: { type: "text" },
      },
    });
    expect(extracted).toMatchObject({
      ok: true,
      session: "one",
      result: {
        total: { status: "extracted", value: 12.5 },
        title: { status: "extracted", value: "Fixture" },
      },
    });
    expect(JSON.stringify(extracted)).toContain('"ref":"e');
  });
  it("requires human approval and releases browser-wide exclusion during the dialog", async () => {
    const f = await fixture();
    const app = f.create();
    let prompts = 0;
    const result = await app.execute(
      "ff_session_ensure",
      {
        session: "work",
        url: "https://example.test/routed",
        containerId: "firefox-container-2",
      },
      {
        approveReplacement: async (candidate) => {
          prompts++;
          expect(candidate.container.cookieStoreId).toBe("firefox-container-2");
          expect(
            await app.execute("ff_session_ensure", {
              session: "other",
              url: "https://example.test/other",
            }),
          ).toMatchObject({ ok: true });
          return true;
        },
      },
    );
    expect(prompts).toBe(1);
    expect(result).toMatchObject({
      ok: true,
      session: "work",
      container: { cookieStoreId: "firefox-container-2" },
    });
  });
  it("does not repeat writes inside a failed workflow", async () => {
    const f = await fixture();
    const app = f.create();
    await app.execute("ff_session_ensure", {
      session: "one",
      url: "https://example.test/",
    });
    const before = f.writes();
    const result = await app.execute("ff_do", {
      session: "one",
      allowWrite: true,
      onError: "continue",
      steps: [
        { type: "fill", ref: "e999", value: "demo" },
        { type: "navigate", url: "https://example.test/other" },
      ],
    });
    expect(result.ok).toBe(false);
    expect(f.writes()).toBe(before);
  });
});
