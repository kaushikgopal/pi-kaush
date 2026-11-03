import {
  copyToClipboard,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import intercomHotkey from "../src/index.ts";

vi.mock("@earendil-works/pi-coding-agent", () => ({
  copyToClipboard: vi.fn(),
}));

function setup(intercomLoaded = true) {
  const pi = {
    registerShortcut: vi.fn<ExtensionAPI["registerShortcut"]>(),
    getCommands: vi.fn(() =>
      intercomLoaded ? [{ name: "intercom-id", source: "extension" }] : [],
    ),
  };
  intercomHotkey(pi as unknown as ExtensionAPI);
  const shortcut = pi.registerShortcut.mock.calls[0]?.[1];
  if (!shortcut) throw new Error("Missing intercom shortcut");
  const notify = vi.fn();
  const ctx = { ui: { notify } } as unknown as ExtensionContext;
  return { pi, shortcut, ctx, notify };
}

beforeEach(() => {
  vi.mocked(copyToClipboard).mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

test("copies the active intercom address without changing the editor", async () => {
  vi.stubEnv("PI_INTERCOM_SESSION_ID", "stable-intercom-id");
  const { pi, shortcut, ctx, notify } = setup();
  await shortcut.handler(ctx);
  expect(pi.registerShortcut.mock.calls[0]?.[0]).toBe("ctrl+shift+i");
  expect(copyToClipboard).toHaveBeenCalledWith("stable-intercom-id");
  expect(notify).toHaveBeenCalledWith("Intercom session ID copied", "info");
});

test("copies the current address after the session changes", async () => {
  vi.stubEnv("PI_INTERCOM_SESSION_ID", "first-id");
  const { shortcut, ctx } = setup();
  await shortcut.handler(ctx);
  vi.stubEnv("PI_INTERCOM_SESSION_ID", "second-id");
  await shortcut.handler(ctx);
  expect(vi.mocked(copyToClipboard).mock.calls).toEqual([
    ["first-id"],
    ["second-id"],
  ]);
});

test("does not copy an inherited ID when intercom is not loaded", async () => {
  vi.stubEnv("PI_INTERCOM_SESSION_ID", "inherited-id");
  const { shortcut, ctx, notify } = setup(false);
  await shortcut.handler(ctx);
  expect(copyToClipboard).not.toHaveBeenCalled();
  expect(notify).toHaveBeenCalledWith(
    expect.stringContaining("unavailable"),
    "warning",
  );
});

test("reports a missing identity without replacing the clipboard", async () => {
  vi.stubEnv("PI_INTERCOM_SESSION_ID", "");
  const { shortcut, ctx, notify } = setup();
  await shortcut.handler(ctx);
  expect(copyToClipboard).not.toHaveBeenCalled();
  expect(notify).toHaveBeenCalledWith(
    expect.stringContaining("unavailable"),
    "warning",
  );
});

test("reports clipboard errors instead of claiming success", async () => {
  vi.stubEnv("PI_INTERCOM_SESSION_ID", "current-id");
  vi.mocked(copyToClipboard).mockRejectedValueOnce(
    new Error("Clipboard unavailable"),
  );
  const { shortcut, ctx, notify } = setup();
  await shortcut.handler(ctx);
  expect(notify).toHaveBeenCalledWith(
    "Could not copy intercom session ID: Clipboard unavailable",
    "error",
  );
});
