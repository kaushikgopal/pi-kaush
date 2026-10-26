import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
  createFirefoxClient,
  FirefoxStatusResult,
} from "@pi-kaush/firefox-core";
import { describe, expect, test, vi } from "vitest";
import { registerFirefoxStatus } from "../src/register.ts";

type SchemaLike = {
  anyOf?: SchemaLike[];
  additionalProperties?: boolean;
  properties?: Record<string, unknown>;
};

type ToolLike = {
  name: string;
  parameters?: SchemaLike;
  outputSchema?: SchemaLike;
  execute: (
    toolCallId: string,
    params: Record<string, never>,
    signal?: AbortSignal,
  ) => Promise<{
    content: Array<{ type: string; text?: string }>;
    details: unknown;
    structuredContent?: unknown;
    isError?: boolean;
  }>;
};

type CommandLike = {
  description?: string;
  handler: (args: string, ctx: never) => Promise<void>;
};

function createHarness(
  createClient: typeof createFirefoxClient,
  withBrowserResources = false,
) {
  const tools = new Map<string, ToolLike>();
  const commands = new Map<string, CommandLike>();
  const browserTool = { name: "browser_snapshot" } as ToolLike;
  const browserCommand: CommandLike = { handler: async () => {} };
  if (withBrowserResources) {
    tools.set("browser_snapshot", browserTool);
    commands.set("browser-status", browserCommand);
  }

  const pi = {
    registerTool(tool: ToolLike) {
      tools.set(tool.name, tool);
    },
    registerCommand(name: string, command: CommandLike) {
      commands.set(name, command);
    },
  };

  registerFirefoxStatus(pi as unknown as ExtensionAPI, createClient);
  return { tools, commands, browserTool, browserCommand };
}

function successResult(): FirefoxStatusResult {
  return {
    ok: true,
    result: {
      cliVersion: "0.4.1",
      supportedVersion: "0.4.1",
      versionMatches: true,
      nativeHost: "installed",
      connection: "connected",
      warnings: [],
    },
  };
}

function errorResult(): FirefoxStatusResult {
  return {
    ok: false,
    code: "not_approved",
    message: "Firefox has not approved the native host.",
    recovery: { command: "firefox-cli", args: ["connect"] },
  };
}

describe("Firefox status adapter registration", () => {
  test("registers only the direct status tool and its command", () => {
    const harness = createHarness(() => ({
      status: async () => successResult(),
    }));

    expect([...harness.tools.keys()]).toEqual(["ff_status"]);
    expect([...harness.commands.keys()]).toEqual(["firefox-status"]);
    expect(harness.tools.get("ff_status")?.parameters).toMatchObject({
      type: "object",
      properties: {},
      additionalProperties: false,
    });
    expect(harness.tools.get("ff_status")?.outputSchema?.anyOf).toHaveLength(2);
    expect(
      harness.tools
        .get("ff_status")
        ?.outputSchema?.anyOf?.map((branch) => branch.additionalProperties),
    ).toEqual([false, false]);
  });

  test("creates the client only when the tool runs and preserves structured success", async () => {
    const result = successResult();
    const status = vi.fn(async () => result);
    const createClient = vi.fn(() => ({ status }));
    const harness = createHarness(createClient);

    expect(createClient).not.toHaveBeenCalled();
    const toolResult = await harness.tools
      .get("ff_status")!
      .execute("call-1", {});

    expect(createClient).toHaveBeenCalledOnce();
    expect(toolResult.structuredContent).toBe(result);
    expect(toolResult.details).toBe(result);
    expect(toolResult.isError).toBe(false);
    expect(toolResult.content[0]?.text).toContain("Connection: connected");
  });

  test("marks a core error as an error and preserves its payload", async () => {
    const result = errorResult();
    const harness = createHarness(() => ({
      status: async () => result,
    }));

    const toolResult = await harness.tools
      .get("ff_status")!
      .execute("call-1", {});

    expect(toolResult.isError).toBe(true);
    expect(toolResult.structuredContent).toBe(result);
    expect(toolResult.details).toBe(result);
    expect(toolResult.content[0]?.text).toContain("not_approved");
    expect(toolResult.content[0]?.text).toContain('["firefox-cli","connect"]');
  });

  test("passes the tool cancellation signal to the core client", async () => {
    let receivedSignal: AbortSignal | undefined;
    const harness = createHarness(() => ({
      status: async (options) => {
        receivedSignal = options?.signal;
        return successResult();
      },
    }));
    const controller = new AbortController();

    await harness.tools
      .get("ff_status")!
      .execute("call-1", {}, controller.signal);

    expect(receivedSignal).toBe(controller.signal);
  });

  test("coexists with browser tools and commands without replacing them", () => {
    const harness = createHarness(
      () => ({
        status: async () => successResult(),
      }),
      true,
    );

    expect(harness.tools.get("browser_snapshot")).toBe(harness.browserTool);
    expect(harness.tools.has("ff_status")).toBe(true);
    expect(harness.commands.get("browser-status")).toBe(harness.browserCommand);
    expect(harness.commands.has("firefox-status")).toBe(true);
  });

  test("does not force UI in a headless command context", async () => {
    const createClient = vi.fn(() => ({
      status: async () => successResult(),
    }));
    const harness = createHarness(createClient);
    const notify = vi.fn();
    const context = {
      hasUI: false,
      ui: { notify },
    };

    await harness.commands.get("firefox-status")!.handler("", context as never);

    expect(createClient).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });
});
