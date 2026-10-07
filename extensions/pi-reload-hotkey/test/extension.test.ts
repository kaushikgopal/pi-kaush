import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { expect, test, vi } from "vitest";
import reloadHotkey from "../src/index.ts";

function setup() {
  const pi = {
    registerCommand: vi.fn<ExtensionAPI["registerCommand"]>(),
    registerShortcut: vi.fn<ExtensionAPI["registerShortcut"]>(),
    sendUserMessage: vi.fn<ExtensionAPI["sendUserMessage"]>(),
  };
  // SAFETY: the extension uses only these three public API methods.
  reloadHotkey(pi as unknown as ExtensionAPI);
  const command = pi.registerCommand.mock.calls[0]?.[1];
  const shortcut = pi.registerShortcut.mock.calls[0]?.[1];
  if (!command || !shortcut) throw new Error("Missing reload registrations");
  return { pi, command, shortcut };
}

test("Ctrl+Shift+R dispatches a local command without touching the editor", async () => {
  const { pi, shortcut } = setup();
  expect(pi.registerShortcut.mock.calls[0]?.[0]).toBe("ctrl+shift+r");
  expect(pi.registerCommand.mock.calls[0]?.[0]).toBe("reload-hotkey");

  // SAFETY: the shortcut does not access its context; any access fails this test.
  await shortcut.handler({} as ExtensionContext);

  expect(pi.sendUserMessage).toHaveBeenCalledWith("/reload-hotkey", {
    expandPromptTemplates: true,
  });
});

test("the command waits for Pi's reload and sends no model message", async () => {
  const { pi, command } = setup();
  let completeReload: (() => void) | undefined;
  let finished = false;
  const reloaded = new Promise<void>((resolve) => {
    completeReload = resolve;
  });
  const ctx = { reload: () => reloaded };
  // SAFETY: the command accesses only reload on its command context.
  const result = Promise.resolve(
    command.handler("", ctx as ExtensionCommandContext),
  ).then(() => {
    finished = true;
  });

  await Promise.resolve();
  expect(finished).toBe(false);
  if (!completeReload) throw new Error("Missing reload completion");
  completeReload();
  await result;
  expect(finished).toBe(true);
  expect(pi.sendUserMessage).not.toHaveBeenCalled();
});

test("reload errors propagate to Pi without retrying or sending a prompt", async () => {
  const { pi, command } = setup();
  const error = new Error("Reload failed");
  const ctx = { reload: (): Promise<void> => Promise.reject(error) };
  // SAFETY: the command accesses only reload on its command context.
  await expect(
    command.handler("", ctx as ExtensionCommandContext),
  ).rejects.toBe(error);
  expect(pi.sendUserMessage).not.toHaveBeenCalled();
});
