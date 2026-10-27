import { describe, expect, it, vi } from "vitest";
import { createFirefoxBrowser } from "../src/index.js";
import type { FirefoxClientTransport } from "../src/types.js";

function fixtureTransport(
  options: {
    replaceOnOpen?: boolean;
    missingContainer?: boolean;
    waitFails?: boolean;
    preexisting?: boolean;
    badDoctor?: boolean;
    replacementContainerId?: string;
    ambiguousReplacement?: boolean;
    badSnapshotTarget?: boolean;
    failedOpen?: boolean;
    expireDuringWait?: boolean;
  } = {},
) {
  const calls: string[][] = [];
  let windows: Array<Record<string, unknown>> = [{ id: 7, private: false }];
  let tabs: Array<Record<string, unknown>> = options.preexisting
    ? [
        {
          id: 12,
          windowId: 7,
          url: "about:blank",
          private: false,
          cookieStoreId: "firefox-default",
        },
      ]
    : [];
  let createdCount = 0;
  const transport: FirefoxClientTransport = async (_binary, args) => {
    calls.push([...args]);
    if (args[0] === "--version") return ok("0.4.1");
    if (args[0] === "doctor") {
      if (options.badDoctor) return ok("not-json");
      return ok(
        JSON.stringify({
          nativeHostManifest: { status: "installed" },
          extensionConnection: { status: "connected" },
        }),
      );
    }
    if (args[0] === "window") return ok(JSON.stringify({ windows }));
    if (args[0] === "tab" && args[1] === "--window")
      return ok(JSON.stringify({ tabs }));
    if (args[0] === "tab" && args[1] === "new") {
      createdCount += 1;
      if (!options.preexisting) {
        tabs = [
          {
            id: 12,
            windowId: 7,
            url: "about:blank",
            private: false,
            ...(options.missingContainer
              ? {}
              : { cookieStoreId: "firefox-default" }),
          },
        ];
      }
      return ok(JSON.stringify({ target: { tabId: 12, windowId: 7 } }));
    }
    if (args[0] === "open") {
      expect(args).toContain("--tab");
      expect(args.some((arg) => arg === "id:12" || arg === "id:13")).toBe(true);
      expect(args).toContain("--window");
      expect(args).toContain("id:7");
      const target = args[1]!;
      if (options.replaceOnOpen) {
        const replacement = (id: number) => ({
          id,
          windowId: 7,
          url: target,
          private: false,
          cookieStoreId: options.replacementContainerId ?? "firefox-default",
        });
        tabs = options.ambiguousReplacement
          ? [replacement(13), replacement(14)]
          : [replacement(13)];
      } else {
        tabs = tabs.map((tab) =>
          tab.id === 12 ? { ...tab, url: target } : tab,
        );
      }
      if (options.failedOpen)
        return {
          stdout: "",
          stderr: "synthetic failure after navigation",
          exitCode: 1,
        };
      return ok(
        JSON.stringify({
          target: { tabId: options.replaceOnOpen ? 13 : 12, windowId: 7 },
          url: target,
          loadState: "unknown",
        }),
      );
    }
    if (args[0] === "wait") {
      if (options.expireDuringWait)
        vi.setSystemTime(new Date("2026-01-01T00:03:00Z"));
      expect(args).toContain("--load");
      expect(args).toContain("domcontentloaded");
      expect(args).toContain("--tab");
      expect(args.some((arg) => arg === "id:12" || arg === "id:13")).toBe(true);
      if (options.waitFails) return { stdout: "", stderr: "", exitCode: 1 };
      return ok(
        JSON.stringify({ kind: "load-state", matched: true, elapsedMs: 1 }),
      );
    }
    if (args[0] === "get" && args[1] === "title")
      return ok(
        JSON.stringify({
          target: { tabId: options.replaceOnOpen ? 13 : 12, windowId: 7 },
          kind: "title",
          value: "Page title",
        }),
      );
    if (args[0] === "snapshot")
      return ok(
        JSON.stringify({
          target: {
            tabId: options.badSnapshotTarget
              ? 999
              : options.replaceOnOpen
                ? 13
                : 12,
            windowId: options.badSnapshotTarget ? 999 : 7,
          },
          text: '@e1 heading "Home" level=1\n@e2 textbox "secret-value"',
          truncated: false,
        }),
      );
    if (args[0] === "tab" && args[1] === "close") {
      const id = Number(args[2]?.slice(3));
      tabs = tabs.filter((tab) => tab.id !== id);
      return ok(JSON.stringify({ closedTabId: id }));
    }
    return { stdout: "", stderr: "", exitCode: 1 };
  };
  return {
    transport,
    calls,
    get createdCount() {
      return createdCount;
    },
    setWindows(value: Array<Record<string, unknown>>) {
      windows = value;
    },
    setTabs(value: Array<Record<string, unknown>>) {
      tabs = value;
    },
  };
}

function ok(stdout: string) {
  return { stdout, stderr: "", exitCode: 0 };
}

describe("Firefox owned browser sessions", () => {
  it("creates a verified seed tab and uses explicit selectors for navigation", async () => {
    const fixture = fixtureTransport();
    const browser = createFirefoxBrowser({ transport: fixture.transport });
    const result = await browser.sessionEnsure({
      session: "work",
      url: "https://example.com/private?q=secret",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tab).toEqual({
      id: 12,
      windowId: 7,
      url: "https://example.com/private",
    });
    expect(result.container).toEqual({
      cookieStoreId: "firefox-default",
      name: null,
      evidence: "verified",
    });
    expect(
      fixture.calls.some(
        (args) =>
          args[0] === "open" &&
          args.includes("--tab") &&
          args.includes("id:12"),
      ),
    ).toBe(true);
  });

  it("keeps ensure idempotent and rejects a different URL without navigation", async () => {
    const fixture = fixtureTransport();
    const browser = createFirefoxBrowser({ transport: fixture.transport });
    await browser.sessionEnsure({
      session: "work",
      url: "https://example.com/one",
    });
    const before = fixture.calls.filter((args) => args[0] === "open").length;
    const mismatch = await browser.sessionEnsure({
      session: "work",
      url: "https://example.com/two?token=synthetic-secret",
    });
    expect(mismatch).toMatchObject({ ok: false, code: "session_url_mismatch" });
    expect(JSON.stringify(mismatch)).not.toContain("synthetic-secret");
    const same = await browser.sessionEnsure({
      session: "work",
      url: "https://example.com/one",
    });
    expect(same.ok).toBe(true);
    expect(fixture.calls.filter((args) => args[0] === "open")).toHaveLength(
      before,
    );
    expect(fixture.createdCount).toBe(1);
  });

  it("rejects privileged and credential-bearing navigation before CLI use", async () => {
    const fixture = fixtureTransport();
    const browser = createFirefoxBrowser({ transport: fixture.transport });
    const invalid = await browser.sessionEnsure({
      session: "work",
      url: "https://user:pass@example.com",
    });
    expect(invalid).toMatchObject({ ok: false, code: "invalid_input" });
    expect(
      await browser.sessionEnsure({ session: "unsafe\u001bname" }),
    ).toMatchObject({ ok: false, code: "invalid_input" });
    expect(fixture.calls).toEqual([]);
  });

  it("requires an explicit normal window when the browser has several", async () => {
    const fixture = fixtureTransport();
    fixture.setWindows([
      { id: 7, private: false },
      { id: 8, private: false },
    ]);
    const browser = createFirefoxBrowser({ transport: fixture.transport });
    const result = await browser.sessionEnsure({ session: "work" });
    expect(result).toMatchObject({
      ok: false,
      code: "window_selection_required",
    });
    expect(fixture.createdCount).toBe(0);
    const selected = await browser.sessionEnsure({
      session: "work",
      windowId: 7,
    });
    expect(selected.ok).toBe(true);
  });

  it("does not retry creation when container metadata is missing", async () => {
    const fixture = fixtureTransport({ missingContainer: true });
    const browser = createFirefoxBrowser({ transport: fixture.transport });
    const first = await browser.sessionEnsure({ session: "work" });
    expect(first).toMatchObject({ ok: false, code: "tab_verification_failed" });
    const second = await browser.sessionEnsure({ session: "work" });
    expect(second).toMatchObject({ ok: false, code: "mutation_uncertain" });
    expect(fixture.createdCount).toBe(1);
  });

  it("keeps replacement pending until the exact candidate is confirmed", async () => {
    const fixture = fixtureTransport({
      replaceOnOpen: true,
      replacementContainerId: "firefox-work",
    });
    const browser = createFirefoxBrowser({ transport: fixture.transport });
    const first = await browser.sessionEnsure({
      session: "work",
      url: "https://example.com/",
    });
    expect(first).toMatchObject({ ok: false, code: "confirmation_required" });
    if (first.ok || !first.confirmation) return;
    const originalId = first.confirmation.id;
    first.confirmation.candidate.id = 999;
    first.confirmation.container.cookieStoreId = "spoofed";
    const repeated = await browser.sessionEnsure({
      session: "work",
      url: "https://example.com/",
    });
    expect(repeated).toMatchObject({
      ok: false,
      confirmation: {
        id: originalId,
        candidate: { id: 13 },
        container: { cookieStoreId: "firefox-work" },
      },
    });
    expect(fixture.createdCount).toBe(1);
    const confirmed = await browser.confirmReplacement({
      session: "work",
      confirmationId: originalId,
    });
    expect(confirmed).toMatchObject({
      ok: true,
      tab: { id: 13 },
      container: { cookieStoreId: "firefox-work" },
    });
    const adoptedRead = await browser.read({ session: "work" });
    expect(adoptedRead).toMatchObject({
      ok: true,
      container: { cookieStoreId: "firefox-work" },
    });
    const closed = await browser.sessionClose({ session: "work" });
    expect(closed).toMatchObject({ ok: true, result: { closed: true } });
  });

  it("confirms a replacement that matches an explicit destination container", async () => {
    const fixture = fixtureTransport({
      replaceOnOpen: true,
      replacementContainerId: "firefox-work",
    });
    const browser = createFirefoxBrowser({ transport: fixture.transport });
    const pending = await browser.sessionEnsure({
      session: "work",
      url: "https://example.com/",
      containerId: "firefox-work",
    });
    expect(pending).toMatchObject({
      ok: false,
      code: "confirmation_required",
      confirmation: { container: { cookieStoreId: "firefox-work" } },
    });
  });

  it("rejects a replacement that conflicts with the explicit destination container", async () => {
    const fixture = fixtureTransport({
      replaceOnOpen: true,
      replacementContainerId: "firefox-personal",
    });
    const browser = createFirefoxBrowser({ transport: fixture.transport });
    const result = await browser.sessionEnsure({
      session: "work",
      url: "https://example.com/",
      containerId: "firefox-work",
    });
    expect(result).toMatchObject({ ok: false, code: "container_conflict" });
    expect("confirmation" in result).toBe(false);
  });

  it("fails closed when health output has an unknown shape", async () => {
    const fixture = fixtureTransport({ badDoctor: true });
    const browser = createFirefoxBrowser({ transport: fixture.transport });
    const result = await browser.sessionEnsure({ session: "work" });
    expect(result).toMatchObject({
      ok: false,
      code: "invalid_doctor_response",
    });
    expect(fixture.calls.some((args) => args[0] === "window")).toBe(false);
  });

  it("does not adopt a tab ID that existed before seed creation", async () => {
    const fixture = fixtureTransport({ preexisting: true });
    const browser = createFirefoxBrowser({ transport: fixture.transport });
    const result = await browser.sessionEnsure({ session: "work" });
    expect(result).toMatchObject({
      ok: false,
      code: "tab_verification_failed",
    });
    expect(fixture.createdCount).toBe(1);
    expect(await browser.read({ session: "work" })).toMatchObject({
      ok: false,
      code: "mutation_uncertain",
    });
  });

  it("stops when multiple new tabs match a replacement URL", async () => {
    const fixture = fixtureTransport({
      replaceOnOpen: true,
      ambiguousReplacement: true,
    });
    const browser = createFirefoxBrowser({ transport: fixture.transport });
    const result = await browser.sessionEnsure({
      session: "work",
      url: "https://example.com/",
    });
    expect(result).toMatchObject({ ok: false, code: "replacement_ambiguous" });
    expect("confirmation" in result).toBe(false);
  });

  it("revalidates a replacement candidate after its confirmation is issued", async () => {
    const fixture = fixtureTransport({ replaceOnOpen: true });
    const browser = createFirefoxBrowser({ transport: fixture.transport });
    const pending = await browser.sessionEnsure({
      session: "work",
      url: "https://example.com/",
    });
    if (pending.ok || !pending.confirmation)
      throw new Error("Expected pending replacement");
    fixture.setTabs([
      {
        id: 13,
        windowId: 7,
        url: "https://other.example/",
        private: false,
        cookieStoreId: "firefox-default",
      },
    ]);
    const result = await browser.confirmReplacement({
      session: "work",
      confirmationId: pending.confirmation.id,
    });
    expect(result).toMatchObject({ ok: false, code: "candidate_changed" });
  });

  it("serializes same-session ensure and navigation in FIFO order", async () => {
    const fixture = fixtureTransport();
    const browser = createFirefoxBrowser({ transport: fixture.transport });
    const first = browser.sessionEnsure({
      session: "work",
      url: "https://example.com/first",
    });
    const second = browser.go({
      session: "work",
      url: "https://example.com/second",
    });
    const [ensured, navigated] = await Promise.all([first, second]);
    expect(ensured.ok).toBe(true);
    expect(navigated.ok).toBe(true);
    const urls = fixture.calls
      .filter((args) => args[0] === "open")
      .map((args) => args[1]);
    expect(urls).toEqual([
      "https://example.com/first",
      "https://example.com/second",
    ]);
  });

  it("does not report ready or replay navigation when public wait fails", async () => {
    const fixture = fixtureTransport({ waitFails: true });
    const browser = createFirefoxBrowser({ transport: fixture.transport });
    const first = await browser.sessionEnsure({
      session: "work",
      url: "https://example.com/",
    });
    expect(first).toMatchObject({ ok: false, code: "navigation_not_ready" });
    const second = await browser.go({
      session: "work",
      url: "https://example.com/next",
    });
    expect(second).toMatchObject({ ok: false, code: "mutation_uncertain" });
    expect(fixture.calls.filter((args) => args[0] === "open")).toHaveLength(1);
  });

  it("rejects a changed container before reads", async () => {
    const fixture = fixtureTransport();
    const browser = createFirefoxBrowser({ transport: fixture.transport });
    await browser.sessionEnsure({ session: "work" });
    fixture.setTabs([
      {
        id: 12,
        windowId: 7,
        url: "about:blank",
        private: false,
        cookieStoreId: "another-container",
      },
    ]);
    const result = await browser.read({ session: "work" });
    expect(result).toMatchObject({ ok: false, code: "container_conflict" });
  });

  it("expires a short-lived, session-bound replacement confirmation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    try {
      const fixture = fixtureTransport({ replaceOnOpen: true });
      const browser = createFirefoxBrowser({ transport: fixture.transport });
      const pending = await browser.sessionEnsure({
        session: "work",
        url: "https://example.com/",
      });
      if (pending.ok || !pending.confirmation)
        throw new Error("Expected pending replacement");
      vi.setSystemTime(new Date("2026-01-01T00:03:00Z"));
      const result = await browser.confirmReplacement({
        session: "work",
        confirmationId: pending.confirmation.id,
      });
      expect(result).toMatchObject({ ok: false, code: "confirmation_expired" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not call the CLI for a pre-cancelled operation", async () => {
    const fixture = fixtureTransport();
    const browser = createFirefoxBrowser({ transport: fixture.transport });
    const controller = new AbortController();
    controller.abort();
    const result = await browser.sessionEnsure(
      { session: "work" },
      { signal: controller.signal },
    );
    expect(result).toMatchObject({ ok: false, code: "aborted" });
    expect(fixture.calls).toEqual([]);
  });

  it("reads only a compact safe summary", async () => {
    const fixture = fixtureTransport();
    const browser = createFirefoxBrowser({ transport: fixture.transport });
    await browser.sessionEnsure({
      session: "work",
      url: "https://example.com/",
    });
    const result = await browser.read({ session: "work" });
    expect(result).toMatchObject({
      ok: true,
      result: {
        title: "Page title",
        headings: ["Home"],
        controls: { textbox: 1 },
      },
    });
    expect(JSON.stringify(result)).not.toMatch(/secret-value|@e\d|\?token=/u);
  });
  it("rejects snapshot data for a different target", async () => {
    const fixture = fixtureTransport({ badSnapshotTarget: true });
    const browser = createFirefoxBrowser({ transport: fixture.transport });
    await browser.sessionEnsure({ session: "work" });
    const result = await browser.read({ session: "work" });
    expect(result).toMatchObject({ ok: false, code: "target_mismatch" });
    expect(JSON.stringify(result)).not.toContain("Home");
  });

  it("checks explicit window and container expectations before returning pending confirmation", async () => {
    const fixture = fixtureTransport({
      replaceOnOpen: true,
      replacementContainerId: "firefox-work",
    });
    const browser = createFirefoxBrowser({ transport: fixture.transport });
    await browser.sessionEnsure({
      session: "work",
      url: "https://example.com/",
    });
    expect(
      await browser.sessionEnsure({
        session: "work",
        containerId: "firefox-personal",
      }),
    ).toMatchObject({ ok: false, code: "container_conflict" });
    expect(
      await browser.sessionEnsure({ session: "work", windowId: 8 }),
    ).toMatchObject({ ok: false, code: "window_conflict" });
    expect(
      await browser.sessionEnsure({
        session: "work",
        url: "https://example.com/other",
      }),
    ).toMatchObject({ ok: false, code: "session_url_mismatch" });
    expect(fixture.createdCount).toBe(1);
  });

  it("blocks another navigation after a nonzero exit with an uncertain mutation outcome", async () => {
    const fixture = fixtureTransport({ failedOpen: true });
    const browser = createFirefoxBrowser({ transport: fixture.transport });
    const first = await browser.sessionEnsure({
      session: "work",
      url: "https://example.com/",
    });
    expect(first).toMatchObject({ ok: false, code: "mutation_uncertain" });
    expect(
      await browser.go({ session: "work", url: "https://example.com/again" }),
    ).toMatchObject({ ok: false, code: "mutation_uncertain" });
    expect(fixture.calls.filter((args) => args[0] === "open")).toHaveLength(1);
  });
  it("reopens an externally closed owned binding only through explicit ensure", async () => {
    const fixture = fixtureTransport();
    const browser = createFirefoxBrowser({ transport: fixture.transport });
    expect((await browser.sessionEnsure({ session: "work" })).ok).toBe(true);
    fixture.setTabs([]);
    expect(await browser.read({ session: "work" })).toMatchObject({
      ok: false,
      code: "owned_tab_missing",
    });
    expect((await browser.sessionEnsure({ session: "work" })).ok).toBe(true);
    expect(fixture.createdCount).toBe(2);
  });

  it("does not read a default blank seed as an explicitly requested nondefault container", async () => {
    const fixture = fixtureTransport();
    const browser = createFirefoxBrowser({ transport: fixture.transport });
    expect(
      await browser.sessionEnsure({
        session: "work",
        containerId: "firefox-work",
      }),
    ).toMatchObject({ ok: false, code: "container_conflict" });
    expect(await browser.read({ session: "work" })).toMatchObject({
      ok: false,
      code: "container_conflict",
    });
    expect((await browser.sessionClose({ session: "work" })).ok).toBe(true);
  });
  it("checks confirmation expiry again after asynchronous readiness validation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    try {
      const fixture = fixtureTransport({
        replaceOnOpen: true,
        expireDuringWait: true,
      });
      const browser = createFirefoxBrowser({ transport: fixture.transport });
      const pending = await browser.sessionEnsure({
        session: "work",
        url: "https://example.com/",
      });
      if (pending.ok || !pending.confirmation)
        throw new Error("Expected pending replacement");
      expect(
        await browser.confirmReplacement({
          session: "work",
          confirmationId: pending.confirmation.id,
        }),
      ).toMatchObject({ ok: false, code: "confirmation_expired" });
    } finally {
      vi.useRealTimers();
    }
  });
});
