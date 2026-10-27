import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFirefoxBrowser } from "../src/index.js";
import { createFirefoxBrowserInternal } from "../src/sessions.js";
import type { FirefoxClientTransport } from "../src/types.js";

function fixture() {
  const calls: string[][] = [];
  let tabs: Array<Record<string, unknown>> = [];
  let text =
    'title "Fixture"\nurl https://example.test/page?token=hidden\ngeneration g1\n@e1 heading "Start" level=1\n@e2 textbox "Email address" type=text\n@e3 button "Save"\n@e4 textbox "private-value" type=password';
  let generation = 0;
  let failClick = false;
  let stale = false;
  let mismatchScreenshotSelection = false;
  const transport: FirefoxClientTransport = async (_binaryPath, args) => {
    calls.push([...args]);
    if (args[0] === "--version") return ok("0.4.1");
    if (args[0] === "doctor")
      return ok(
        JSON.stringify({
          nativeHostManifest: { status: "installed" },
          extensionConnection: { status: "connected" },
        }),
      );
    if (args[0] === "window")
      return ok(JSON.stringify({ windows: [{ id: 7, private: false }] }));
    if (args[0] === "tab" && args[1] === "--window")
      return ok(JSON.stringify({ tabs }));
    if (args[0] === "tab" && args[1] === "new") {
      tabs = [
        {
          id: 12,
          windowId: 7,
          url: "about:blank",
          private: false,
          active: true,
          cookieStoreId: "firefox-default",
        },
      ];
      return ok(JSON.stringify({ target: { tabId: 12, windowId: 7 } }));
    }
    if (args[0] === "open") {
      tabs = tabs.map((tab) =>
        tab.id === 12 ? { ...tab, url: args[1] } : tab,
      );
      return ok(
        JSON.stringify({ target: { tabId: 12, windowId: 7 }, url: args[1] }),
      );
    }
    if (args[0] === "wait" && args.includes("--load"))
      return ok(
        JSON.stringify({ target: target(), matched: true, elapsedMs: 1 }),
      );
    if (args[0] === "get" && args[1] === "title")
      return ok(
        JSON.stringify({ target: target(), kind: "title", value: "Fixture" }),
      );
    if (args[0] === "snapshot") {
      generation += 1;
      return ok(
        JSON.stringify({
          target: target(),
          generationId: "g" + generation,
          text,
          refs: 3,
          truncated: false,
        }),
      );
    }
    if (args[0] === "ref") {
      if (stale)
        return { stdout: "", stderr: "REF_NOT_FOUND: stale", exitCode: 1 };
      return ok(
        JSON.stringify({
          target: target(),
          element: { ref: args[1], generationId: args[3], role: "button" },
        }),
      );
    }
    if (args[0] === "get" && args[1] === "text")
      return ok(
        JSON.stringify({
          target: target(),
          value: "Visible page text",
          truncated: false,
        }),
      );
    if (["fill", "select", "press", "scroll"].includes(args[0]!))
      return ok(
        JSON.stringify({ target: target(), action: args[0], ok: true }),
      );
    if (args[0] === "click") {
      if (failClick)
        return { stdout: "", stderr: "failed after click", exitCode: 1 };
      text = '@e1 heading "Saved" level=1\n@e2 button "Continue"';
      return ok(
        JSON.stringify({ target: target(), action: "click", ok: true }),
      );
    }
    if (args[0] === "wait" && args.includes("--text"))
      return ok(
        JSON.stringify({ target: target(), matched: true, elapsedMs: 5 }),
      );
    if (args[0] === "screenshot") {
      if (mismatchScreenshotSelection) {
        tabs = [
          { ...tabs[0], active: false },
          {
            id: 13,
            windowId: 7,
            url: "https://other.test/",
            private: false,
            active: true,
            cookieStoreId: "firefox-default",
          },
        ];
      }
      return ok(
        JSON.stringify({
          target: target(),
          path: args[1],
          format: "png",
          activation: { tabActivated: false, windowFocused: false },
        }),
      );
    }
    if (args[0] === "network")
      return ok(
        JSON.stringify({
          action: "list",
          ok: true,
          requests: [
            {
              id: "1",
              url: "https://api.example.test/data?token=hidden#top",
              method: "GET",
              type: "xmlhttprequest",
              statusCode: 200,
            },
            {
              id: "2",
              url: "https://api.example.test/other",
              method: "POST",
              type: "fetch",
              statusCode: 500,
            },
            {
              id: "3",
              url: "https://api.example.test/third",
              method: "GET",
              type: "xmlhttprequest",
              statusCode: 200,
            },
          ],
        }),
      );
    if (args[0] === "tab" && args[1] === "close") {
      tabs = [];
      return ok(JSON.stringify({ closedTabId: 12 }));
    }
    return { stdout: "", stderr: "unexpected", exitCode: 1 };
  };
  function target() {
    return { tabId: 12, windowId: 7, cookieStoreId: "firefox-default" };
  }
  return {
    calls,
    transport,
    setText(value: string) {
      text = value;
    },
    setFailClick(value: boolean) {
      failClick = value;
    },
    setStale(value: boolean) {
      stale = value;
    },
    setScreenshotSelectionMismatch(value: boolean) {
      mismatchScreenshotSelection = value;
    },
  };
}

function ok(stdout: string) {
  return { stdout, stderr: "", exitCode: 0 };
}

function publicRef(text: string, row: string): string {
  const line = text.split("\n").find((entry) => entry.includes(row));
  const ref = line?.match(/\be[0-9]{1,64}\b/u)?.[0];
  if (!ref) throw new Error(`No public ref found for ${row}.`);
  return ref;
}

function browserWithSessions(f: ReturnType<typeof fixture>, names: string[]) {
  return createFirefoxBrowserInternal(
    { transport: f.transport },
    {
      sessionState: new Map(
        names.map((session) => [
          session,
          {
            tabId: 12,
            windowId: 7,
            cookieStoreId: "firefox-default",
            expectedUrl: "https://example.test/page",
            closed: false,
            uncertain: false,
          },
        ]),
      ),
    },
  );
}

async function ready(f: ReturnType<typeof fixture>) {
  const browser = createFirefoxBrowser({ transport: f.transport });
  const result = await browser.sessionEnsure({
    session: "owned",
    url: "https://example.test/page",
  });
  expect(result.ok).toBe(true);
  return browser;
}

describe("browser feature layer", () => {
  it("returns capped wrapper refs and excludes editable values", async () => {
    const f = fixture();
    const browser = await ready(f);
    const snapshot = await browser.snapshot({
      session: "owned",
      mode: "full",
      maxBytes: 1024,
    });
    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) return;
    const startRef = publicRef(snapshot.result.text, 'heading "Start"');
    expect(snapshot.result.text).toContain(`${startRef} heading`);
    expect(snapshot.result.text).not.toContain("@e1");
    expect(snapshot.result.text).not.toContain("private-value");
    expect(snapshot.result.text).not.toContain("token=hidden");
    const emailRef = publicRef(snapshot.result.text, 'textbox "Email address"');
    expect(snapshot.result.text).toContain(
      `${emailRef} textbox "Email address"`,
    );
    expect(snapshot.result.refs).toBe(4);
    expect(snapshot.result.generation).toBe("g1");
    const scoped = await browser.snapshot({
      session: "owned",
      mode: "scoped",
      ref: startRef,
    });
    expect(scoped).toMatchObject({
      ok: true,
      result: {
        mode: "scoped",
        generation: "g1",
        text: expect.stringContaining(`${startRef} heading`),
      },
    });
    expect(JSON.stringify(scoped)).not.toContain("@e1");
  });

  it("locates one local semantic match and rejects duplicate matches", async () => {
    const f = fixture();
    const browser = await ready(f);
    const save = await browser.locate({
      session: "owned",
      role: "button",
      name: "Save",
    });
    expect(save).toMatchObject({
      ok: true,
      result: { role: "button", name: "Save" },
    });
    const email = await browser.locate({
      session: "owned",
      role: "textbox",
      name: "Email address",
    });
    expect(email).toMatchObject({
      ok: true,
      result: { name: "Email address" },
    });
    if (save.ok && email.ok) expect(save.result.ref).not.toBe(email.result.ref);
    f.setText('@e1 button "Save"\n@e2 button "Save"');
    await expect(
      browser.locate({ session: "owned", role: "button", name: "Save" }),
    ).resolves.toMatchObject({
      ok: false,
      code: "ambiguous_match",
    });
  });

  it("blocks refs across loaded session caches", async () => {
    const f = fixture();
    await ready(f);
    const browser = browserWithSessions(f, ["owned", "other"]);
    const first = await browser.snapshot({ session: "owned", mode: "full" });
    expect(first.ok).toBe(true);
    const oldRef = publicRef(
      first.ok ? first.result.text : "",
      'button "Save"',
    );
    const second = await browser.snapshot({ session: "other", mode: "full" });
    expect(second.ok).toBe(true);
    const otherRef = publicRef(
      second.ok ? second.result.text : "",
      'button "Save"',
    );
    expect(otherRef).not.toBe(oldRef);
    await expect(
      browser.act({
        session: "other",
        action: "click",
        ref: oldRef,
        noDiff: true,
      }),
    ).resolves.toMatchObject({ ok: false, code: "stale_ref" });
  });

  it("blocks refs from another browser client with a fresh cache", async () => {
    const f = fixture();
    await ready(f);
    const firstBrowser = browserWithSessions(f, ["owned"]);
    const first = await firstBrowser.snapshot({
      session: "owned",
      mode: "full",
    });
    expect(first.ok).toBe(true);
    const oldRef = publicRef(
      first.ok ? first.result.text : "",
      'button "Save"',
    );
    const secondBrowser = browserWithSessions(f, ["owned"]);
    const second = await secondBrowser.snapshot({
      session: "owned",
      mode: "full",
    });
    expect(second.ok).toBe(true);
    const newRef = publicRef(
      second.ok ? second.result.text : "",
      'button "Save"',
    );
    expect(newRef).not.toBe(oldRef);
    await expect(
      secondBrowser.act({
        session: "owned",
        action: "click",
        ref: oldRef,
        noDiff: true,
      }),
    ).resolves.toMatchObject({ ok: false, code: "stale_ref" });
  });

  it("validates generation-bound refs before actions and returns compact changes", async () => {
    const f = fixture();
    const browser = await ready(f);
    const snapshot = await browser.snapshot({ session: "owned", mode: "full" });
    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) return;
    const saveRef = publicRef(snapshot.result.text, 'button "Save"');
    const result = await browser.act({
      session: "owned",
      action: "click",
      ref: saveRef,
    });
    expect(result).toMatchObject({
      ok: true,
      result: {
        action: "click",
        ref: saveRef,
        diff: {
          added: expect.arrayContaining([expect.stringContaining("Continue")]),
        },
      },
    });
    expect(
      f.calls.some(
        (args) =>
          args[0] === "ref" &&
          args.includes("--generation") &&
          args.includes("g1"),
      ),
    ).toBe(true);
    expect(f.calls.filter((args) => args[0] === "click")).toHaveLength(1);
  });

  it("routes fill, key, scroll, and select through the owned tab lane", async () => {
    const f = fixture();
    const browser = await ready(f);
    const snapshot = await browser.snapshot({ session: "owned", mode: "full" });
    expect(snapshot.ok).toBe(true);
    const saveRef = publicRef(
      snapshot.ok ? snapshot.result.text : "",
      'button "Save"',
    );
    const fill = await browser.act({
      session: "owned",
      action: "fill",
      ref: saveRef,
      value: "A sample",
      noDiff: true,
    });
    const select = await browser.act({
      session: "owned",
      action: "select",
      ref: saveRef,
      value: "basic",
      noDiff: true,
    });
    const key = await browser.act({
      session: "owned",
      action: "key",
      key: "Enter",
      noDiff: true,
    });
    const scroll = await browser.act({
      session: "owned",
      action: "scroll",
      direction: "down",
      amount: 120,
      noDiff: true,
    });
    expect([fill, select, key, scroll].every((result) => result.ok)).toBe(true);
    expect(
      f.calls.some(
        (args) =>
          args[0] === "fill" &&
          args[1] === "@e3" &&
          args[2] === "A sample" &&
          args.includes("--generation"),
      ),
    ).toBe(true);
    expect(
      f.calls.some(
        (args) =>
          args[0] === "select" && args[1] === "@e3" && args[2] === "basic",
      ),
    ).toBe(true);
    expect(
      f.calls.some(
        (args) =>
          args[0] === "press" && args[1] === "Enter" && args.includes("--tab"),
      ),
    ).toBe(true);
    expect(
      f.calls.some(
        (args) =>
          args[0] === "scroll" &&
          args[1] === "down" &&
          args[2] === "120" &&
          args.includes("--tab"),
      ),
    ).toBe(true);
  });

  it("invalidates public refs after owned navigation without reusing their names", async () => {
    const f = fixture();
    const browser = await ready(f);
    const first = await browser.snapshot({ session: "owned", mode: "full" });
    expect(first.ok).toBe(true);
    const oldRef = publicRef(
      first.ok ? first.result.text : "",
      'button "Save"',
    );
    await expect(
      browser.go({ session: "owned", url: "https://example.test/next" }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      browser.act({
        session: "owned",
        action: "click",
        ref: oldRef,
        noDiff: true,
      }),
    ).resolves.toMatchObject({ ok: false, code: "stale_ref" });
    const next = await browser.snapshot({ session: "owned", mode: "full" });
    expect(next).toMatchObject({ ok: true, result: { generation: "g2" } });
    if (next.ok)
      expect(next.result.text).toContain(
        publicRef(next.result.text, "heading"),
      );
    expect(f.calls.filter((args) => args[0] === "click")).toHaveLength(0);
  });

  it("returns stale_ref without acting and marks failed mutations uncertain", async () => {
    const f = fixture();
    const browser = await ready(f);
    const snapshot = await browser.snapshot({ session: "owned", mode: "full" });
    expect(snapshot.ok).toBe(true);
    const saveRef = publicRef(
      snapshot.ok ? snapshot.result.text : "",
      'button "Save"',
    );
    f.setStale(true);
    await expect(
      browser.act({
        session: "owned",
        action: "click",
        ref: saveRef,
        noDiff: true,
      }),
    ).resolves.toMatchObject({
      ok: false,
      code: "stale_ref",
    });
    expect(f.calls.filter((args) => args[0] === "click")).toHaveLength(0);
    f.setStale(false);
    f.setFailClick(true);
    await expect(
      browser.act({
        session: "owned",
        action: "click",
        ref: saveRef,
        noDiff: true,
      }),
    ).resolves.toMatchObject({
      ok: false,
      code: "mutation_uncertain",
    });
    expect(f.calls.filter((args) => args[0] === "click")).toHaveLength(1);
  });

  it("reads visible text, waits on explicit content and scrubs bounded network summaries", async () => {
    const f = fixture();
    const browser = await ready(f);
    await expect(
      browser.readText({ session: "owned", maxBytes: 256 }),
    ).resolves.toMatchObject({
      ok: true,
      result: { text: "Visible page text", maxBytes: 256 },
    });
    await expect(
      browser.wait({ session: "owned", text: "Ready", timeoutMs: 1000 }),
    ).resolves.toMatchObject({
      ok: true,
      result: { matched: true, elapsedMs: 5 },
    });
    const network = await browser.network({
      session: "owned",
      method: "GET",
      urlsOnly: true,
      maxEntries: 1,
    });
    expect(network).toMatchObject({
      ok: true,
      result: {
        entries: [{ url: "https://api.example.test/data" }],
        truncated: true,
        retentionMs: 30_000,
        cursor: null,
      },
    });
    expect(JSON.stringify(network)).not.toContain("hidden");
    await expect(
      browser.network({ session: "owned", cursor: "older" }),
    ).resolves.toMatchObject({
      ok: false,
      code: "unsupported_capability",
    });
  });

  it("lists only owned sessions and defaults cleanup to a revalidated dry run", async () => {
    const f = fixture();
    const browser = await ready(f);
    const sessions = await browser.sessionList({});
    expect(sessions).toMatchObject({
      ok: true,
      result: [{ session: "owned", state: "open", tab: { id: 12 } }],
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const before = await browser.sessionList({ session: "owned" });
    const cleanup = await browser.sessionCleanup({ idleAfterMs: 1 });
    expect(cleanup).toMatchObject({
      ok: true,
      result: {
        dryRun: true,
        eligible: [
          { session: "owned", tabId: 12, containerId: "firefox-default" },
        ],
        closed: [],
      },
    });
    const after = await browser.sessionList({ session: "owned" });
    expect(before.ok && after.ok).toBe(true);
    if (before.ok && after.ok)
      expect(after.result[0]?.lastUsedAt).toBe(before.result[0]?.lastUsedAt);
    const actual = await browser.sessionCleanup({
      idleAfterMs: 1,
      dryRun: false,
    });
    expect(actual).toMatchObject({
      ok: true,
      result: {
        eligible: [{ session: "owned", containerId: "firefox-default" }],
        closed: ["owned"],
      },
    });
    expect(
      f.calls.filter((args) => args[0] === "tab" && args[1] === "close"),
    ).toHaveLength(1);
  });

  it("closes only idle, revalidated owned tabs when dry-run is disabled", async () => {
    const f = fixture();
    const browser = await ready(f);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const result = await browser.sessionCleanup({
      idleAfterMs: 1,
      dryRun: false,
    });
    expect(result).toMatchObject({
      ok: true,
      result: {
        dryRun: false,
        eligible: [
          { session: "owned", tabId: 12, containerId: "firefox-default" },
        ],
        closed: ["owned"],
        failures: [],
      },
    });
    expect(
      f.calls.filter((args) => args[0] === "tab" && args[1] === "close"),
    ).toHaveLength(1);
  });

  it("discards a screenshot when the selected tab changed during capture", async () => {
    const f = fixture();
    const directory = await mkdtemp(join(tmpdir(), "firefox-feature-test-"));
    const outputPath = join(directory, "wrong-target.png");
    let captureDirectory = "";
    const screenshotTransport: FirefoxClientTransport = async (
      binary,
      args,
      options,
    ) => {
      if (args[0] === "screenshot") {
        captureDirectory = dirname(args[1]!);
        await writeFile(args[1]!, "png");
      }
      return f.transport(binary, args, options);
    };
    const browser = createFirefoxBrowser({ transport: screenshotTransport });
    await browser.sessionEnsure({
      session: "owned",
      url: "https://example.test/page",
    });
    f.setScreenshotSelectionMismatch(true);
    await expect(
      browser.screenshot({
        session: "owned",
        outputPath,
        fullResolution: true,
      }),
    ).resolves.toMatchObject({
      ok: false,
      code: "screenshot_target_changed",
    });
    await expect(stat(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(captureDirectory)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await rm(directory, { recursive: true, force: true });
  });

  it("preserves an existing screenshot output file", async () => {
    const f = fixture();
    const directory = await mkdtemp(join(tmpdir(), "firefox-feature-test-"));
    const outputPath = join(directory, "existing.png");
    await writeFile(outputPath, "existing content");
    const screenshotTransport: FirefoxClientTransport = async (
      binary,
      args,
      options,
    ) => {
      if (args[0] === "screenshot") await writeFile(args[1]!, "capture");
      return f.transport(binary, args, options);
    };
    const browser = createFirefoxBrowser({ transport: screenshotTransport });
    await browser.sessionEnsure({
      session: "owned",
      url: "https://example.test/page",
    });
    await expect(
      browser.screenshot({
        session: "owned",
        outputPath,
        fullResolution: true,
      }),
    ).resolves.toMatchObject({ ok: false, code: "file_exists" });
    expect(await readFile(outputPath, "utf8")).toBe("existing content");
    await rm(directory, { recursive: true, force: true });
  });

  it("preserves a file created at the output path during capture", async () => {
    const f = fixture();
    const directory = await mkdtemp(join(tmpdir(), "firefox-feature-test-"));
    const outputPath = join(directory, "raced.png");
    const screenshotTransport: FirefoxClientTransport = async (
      binary,
      args,
      options,
    ) => {
      if (args[0] === "screenshot") {
        await writeFile(args[1]!, "capture");
        await writeFile(outputPath, "created during capture");
      }
      return f.transport(binary, args, options);
    };
    const browser = createFirefoxBrowser({ transport: screenshotTransport });
    await browser.sessionEnsure({
      session: "owned",
      url: "https://example.test/page",
    });
    await expect(
      browser.screenshot({
        session: "owned",
        outputPath,
        fullResolution: true,
      }),
    ).resolves.toMatchObject({ ok: false, code: "file_exists" });
    expect(await readFile(outputPath, "utf8")).toBe("created during capture");
    await rm(directory, { recursive: true, force: true });
  });

  it("cleans private capture files after backend errors", async () => {
    const f = fixture();
    const directory = await mkdtemp(join(tmpdir(), "firefox-feature-test-"));
    const outputPath = join(directory, "failed.png");
    let captureDirectory = "";
    const screenshotTransport: FirefoxClientTransport = async (
      binary,
      args,
      options,
    ) => {
      if (args[0] === "screenshot") {
        captureDirectory = dirname(args[1]!);
        await writeFile(args[1]!, "capture");
        return { stdout: "", stderr: "capture failed", exitCode: 1 };
      }
      return f.transport(binary, args, options);
    };
    const browser = createFirefoxBrowser({ transport: screenshotTransport });
    await browser.sessionEnsure({
      session: "owned",
      url: "https://example.test/page",
    });
    await expect(
      browser.screenshot({
        session: "owned",
        outputPath,
        fullResolution: true,
      }),
    ).resolves.toMatchObject({ ok: false });
    await expect(stat(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(captureDirectory)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await rm(directory, { recursive: true, force: true });
  });

  it("writes a file-only screenshot and reports tab selection", async () => {
    const f = fixture();
    const directory = await mkdtemp(join(tmpdir(), "firefox-feature-test-"));
    const outputPath = join(directory, "missing", "nested", "page.png");
    await chmod(directory, 0o755);
    let captureDirectory = "";
    let captureDirectoryMode = 0;
    const screenshotTransport: FirefoxClientTransport = async (
      binary,
      args,
      options,
    ) => {
      if (args[0] === "screenshot") {
        captureDirectory = dirname(args[1]!);
        captureDirectoryMode = (await stat(captureDirectory)).mode & 0o777;
        await writeFile(args[1]!, "png");
      }
      return f.transport(binary, args, options);
    };
    const browser = createFirefoxBrowser({ transport: screenshotTransport });
    await browser.sessionEnsure({
      session: "owned",
      url: "https://example.test/page",
    });
    const result = await browser.screenshot({
      session: "owned",
      outputPath,
      fullResolution: true,
    });
    expect(result).toMatchObject({
      ok: true,
      result: {
        path: outputPath,
        format: "png",
        resized: false,
        selected: true,
        fullPage: false,
      },
    });
    const file = await stat(outputPath);
    expect(file.mode & 0o777).toBe(0o600);
    expect(captureDirectoryMode).toBe(0o700);
    expect((await stat(directory)).mode & 0o777).toBe(0o755);
    expect(
      (await stat(join(directory, "missing", "nested"))).mode & 0o777,
    ).toBe(0o700);
    await expect(stat(captureDirectory)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await rm(directory, { recursive: true, force: true });
  });
});
