import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import {
  createFirefoxAutomation,
  FIREFOX_TOOLS,
  type FirefoxAutomationContext,
  type FirefoxAutomationResult,
  type FirefoxReplacementConfirmation,
} from "@pi-kaush/firefox-agent-core";
import { describe, expect, test, vi } from "vitest";
import { registerFirefoxAutomation } from "../src/register.ts";

type AutomationExecute = (
  name: string,
  input: Record<string, unknown>,
  context?: FirefoxAutomationContext,
) => Promise<FirefoxAutomationResult>;
type AutomationFactory = typeof createFirefoxAutomation;
type Confirm = (
  title: string,
  message: string,
  options?: { signal?: AbortSignal },
) => Promise<boolean>;
type Notify = (message: string, level?: string) => void;
type ToolResult = {
  content: Array<{ type: string; text?: string }>;
  details: unknown;
  structuredContent?: unknown;
  isError?: boolean;
};
type ToolLike = {
  name: string;
  parameters: Record<string, unknown>;
  outputSchema: {
    oneOf?: Array<{ additionalProperties?: boolean }>;
  };
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: unknown,
    context?: ExtensionToolContext,
  ) => Promise<ToolResult>;
};
type CommandLike = {
  description: string;
  handler: (args: string, context: ExtensionCommandContext) => Promise<void>;
};

function createHarness(createAutomation: AutomationFactory) {
  const tools = new Map<string, ToolLike>();
  const commands = new Map<string, CommandLike>();
  const pi = {
    registerTool(definition: unknown) {
      const tool = definition as ToolLike;
      tools.set(tool.name, tool);
    },
    registerCommand(name: string, command: CommandLike) {
      commands.set(name, command);
    },
  };
  registerFirefoxAutomation(pi as unknown as ExtensionAPI, createAutomation);
  return { tools, commands };
}

function createContext(
  options: {
    cwd?: string;
    sessionId?: string;
    hasUI?: boolean;
    confirm?: Confirm;
    notify?: Notify;
    signal?: AbortSignal;
  } = {},
): ExtensionToolContext & ExtensionCommandContext {
  const confirm = options.confirm ?? vi.fn(async () => true);
  const notify = options.notify ?? vi.fn();
  return {
    cwd: options.cwd ?? "/synthetic/project",
    hasUI: options.hasUI ?? true,
    signal: options.signal,
    sessionManager: {
      getSessionId: () => options.sessionId ?? "pi-session-a",
    },
    ui: {
      confirm,
      notify,
    },
  } as unknown as ExtensionToolContext & ExtensionCommandContext;
}

function port(
  implementation: AutomationExecute = async () => ({
    ok: true,
    result: { ready: true },
  }),
) {
  return { execute: vi.fn(implementation) };
}

function factoryFor(automation: ReturnType<typeof port>) {
  return vi.fn(() => automation) as unknown as AutomationFactory;
}

function runTool(
  harness: ReturnType<typeof createHarness>,
  name: string,
  input: Record<string, unknown> = {},
  context = createContext(),
  signal?: AbortSignal,
) {
  return harness.tools
    .get(name)!
    .execute(`test-${name}`, input, signal, undefined, context);
}

function candidate(): FirefoxReplacementConfirmation {
  return {
    id: "confirmation-123",
    session: "docs",
    previousTabId: 17,
    candidate: {
      id: 28,
      windowId: 3,
      url: "https://example.test/synthetic",
    },
    container: {
      cookieStoreId: "firefox-default",
      name: "default",
      evidence: "verified",
    },
    expiresAt: "2030-01-01T00:00:00.000Z",
  };
}

describe("Firefox automation adapter", () => {
  test("registers every public catalog tool with unsafe input schemas and a closed result envelope", () => {
    const createAutomation = vi.fn(() =>
      port(),
    ) as unknown as AutomationFactory;
    const harness = createHarness(createAutomation);

    expect([...harness.tools.keys()]).toEqual(
      FIREFOX_TOOLS.map((descriptor) => descriptor.name),
    );
    expect([...harness.commands.keys()]).toEqual([
      "firefox-status",
      "firefox-session",
      "firefox-container",
    ]);
    expect(createAutomation).not.toHaveBeenCalled();

    for (const descriptor of FIREFOX_TOOLS) {
      const tool = harness.tools.get(descriptor.name)!;
      expect(tool.parameters).toMatchObject({
        type: "object",
        properties: descriptor.parameters.properties,
        additionalProperties: false,
      });
      expect(tool.outputSchema.oneOf).toHaveLength(2);
      expect(
        tool.outputSchema.oneOf?.map((branch) => branch.additionalProperties),
      ).toEqual([false, false]);
    }
    expect(FIREFOX_TOOLS.some((tool) => tool.name.includes("approve"))).toBe(
      false,
    );
    expect(FIREFOX_TOOLS.some((tool) => tool.name.includes("confirm"))).toBe(
      false,
    );
  });

  test("creates automation lazily and caches by cwd plus Pi session ID", async () => {
    const automation = port();
    const createAutomation = factoryFor(automation);
    const harness = createHarness(createAutomation);
    const first = createContext();

    expect(createAutomation).not.toHaveBeenCalled();
    await runTool(harness, "ff_status", {}, first);
    await runTool(harness, "ff_status", {}, first);
    expect(createAutomation).toHaveBeenCalledOnce();
    expect(createAutomation).toHaveBeenCalledWith({
      cwd: "/synthetic/project",
      agentId: "pi-session-a",
    });

    await runTool(
      harness,
      "ff_status",
      {},
      createContext({ cwd: "/synthetic/other" }),
    );
    await runTool(
      harness,
      "ff_status",
      {},
      createContext({ sessionId: "pi-session-b" }),
    );
    expect(createAutomation).toHaveBeenCalledTimes(3);
  });

  test("passes core results through unchanged and marks only failures as errors", async () => {
    const success: FirefoxAutomationResult = {
      ok: true,
      result: { cliVersion: "0.4.1", warnings: [] },
    };
    const partialWorkflow: FirefoxAutomationResult = {
      ok: false,
      code: "workflow_failed",
      message: "Workflow stopped after one completed operation.",
      recovery: null,
      result: {
        plannedOperations: 2,
        outcomes: [{ path: "steps[0]", type: "read", ok: true }],
      },
    };
    const automation = port(async (name) =>
      name === "ff_do" ? partialWorkflow : success,
    );
    const harness = createHarness(factoryFor(automation));

    const status = await runTool(harness, "ff_status");
    expect(status.details).toBe(success);
    expect(status.structuredContent).toBe(success);
    expect(status.isError).toBe(false);
    expect(JSON.parse(status.content[0]!.text!)).toEqual(success);

    const workflow = await runTool(harness, "ff_do", { dryRun: true });
    expect(workflow.details).toBe(partialWorkflow);
    expect(workflow.structuredContent).toBe(partialWorkflow);
    expect(workflow.isError).toBe(true);
    expect(JSON.parse(workflow.content[0]!.text!)).toEqual(partialWorkflow);
  });

  test("keeps oversized model text valid JSON and labels its preview as truncated", async () => {
    const result: FirefoxAutomationResult = {
      ok: true,
      result: { text: "é".repeat(12_000) },
    };
    const harness = createHarness(factoryFor(port(async () => result)));

    const response = await runTool(harness, "ff_read");
    const text = response.content[0]!.text!;
    const parsed = JSON.parse(text);

    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(8_000);
    expect(parsed.truncated).toBe(true);
    expect(parsed.note).toContain("structuredContent");
    expect(typeof parsed.preview).toBe("string");
    expect(response.structuredContent).toBe(result);
    expect(response.details).toBe(result);
  });

  test("asks the UI to approve the exact replacement candidate and forwards cancellation", async () => {
    const replacement: FirefoxAutomationResult = {
      ok: false,
      code: "confirmation_required",
      message: "Replacement needs approval.",
      confirmation: candidate(),
      recovery: null,
    };
    const automationExecute = vi.fn<AutomationExecute>(
      async (_name, _input, context) => {
        await context?.approveReplacement?.(candidate());
        return replacement;
      },
    );
    const automation = { execute: automationExecute };
    const harness = createHarness(
      vi.fn(() => automation) as unknown as AutomationFactory,
    );
    const controller = new AbortController();
    const confirm = vi.fn(async () => false);
    const context = createContext({ confirm });

    const response = await runTool(
      harness,
      "ff_go",
      { session: "docs", url: "https://example.test/next" },
      context,
      controller.signal,
    );

    expect(automationExecute).toHaveBeenCalledWith(
      "ff_go",
      { session: "docs", url: "https://example.test/next" },
      expect.objectContaining({
        signal: controller.signal,
        approveReplacement: expect.any(Function),
      }),
    );
    expect(confirm).toHaveBeenCalledOnce();
    expect(confirm).toHaveBeenCalledWith(
      "Confirm Firefox tab replacement",
      expect.stringContaining(JSON.stringify(candidate(), null, 2)),
      { signal: controller.signal },
    );
    expect(response.isError).toBe(true);
    expect(response.structuredContent).toBe(replacement);
  });

  test("does not provide an approval callback when the context has no UI", async () => {
    let received: FirefoxAutomationContext | undefined;
    const replacement: FirefoxAutomationResult = {
      ok: false,
      code: "confirmation_required",
      message: "A human must approve the replacement.",
      confirmation: candidate(),
      recovery: null,
    };
    const automation = port(async (_name, _input, context) => {
      received = context;
      return replacement;
    });
    const harness = createHarness(factoryFor(automation));
    const confirm = vi.fn(async () => true);

    const response = await runTool(
      harness,
      "ff_session_ensure",
      { session: "docs" },
      createContext({ hasUI: false, confirm }),
    );

    expect(received?.approveReplacement).toBeUndefined();
    expect(confirm).not.toHaveBeenCalled();
    expect(response.isError).toBe(true);
    expect(response.structuredContent).toBe(replacement);
  });

  test("passes an abort signal into the core API and replacement dialog", async () => {
    const automation = port(async (_name, _input, context) => {
      await context?.approveReplacement?.(candidate());
      return {
        ok: false,
        code: "aborted",
        message: "Cancelled.",
        recovery: null,
      };
    });
    const harness = createHarness(factoryFor(automation));
    const controller = new AbortController();
    const confirm = vi.fn(async () => false);

    await runTool(
      harness,
      "ff_go",
      { session: "docs", url: "https://example.test/next" },
      createContext({ confirm }),
      controller.signal,
    );

    expect(automation.execute).toHaveBeenCalledWith(
      "ff_go",
      expect.any(Object),
      expect.objectContaining({ signal: controller.signal }),
    );
    expect(confirm).toHaveBeenCalledWith(
      "Confirm Firefox tab replacement",
      expect.any(String),
      { signal: controller.signal },
    );
  });

  test("commands display the core result without adapter business logic", async () => {
    const results: Record<string, FirefoxAutomationResult> = {
      ff_status: { ok: true, result: { status: "connected" } },
      ff_session_list: { ok: true, result: [{ session: "docs" }] },
      ff_container_list: {
        ok: true,
        result: { containers: [], complete: false },
      },
    };
    const automation = port(async (name) => results[name]!);
    const harness = createHarness(factoryFor(automation));
    const notify = vi.fn<Notify>();
    const context = createContext({ notify });

    const commands: Array<[string, string]> = [
      ["firefox-status", "ff_status"],
      ["firefox-session", "ff_session_list"],
      ["firefox-container", "ff_container_list"],
    ];
    for (const [commandName, toolName] of commands) {
      await harness.commands.get(commandName)!.handler("", context);
      expect(automation.execute).toHaveBeenLastCalledWith(toolName, {}, {});
      const call = notify.mock.calls.at(-1)!;
      expect(call[0]).toBe(JSON.stringify(results[toolName]));
      expect(call[1]).toBe("info");
    }
  });

  test("headless status command does not create an automation client", async () => {
    const createAutomation = vi.fn(() =>
      port(),
    ) as unknown as AutomationFactory;
    const harness = createHarness(createAutomation);

    await harness.commands
      .get("firefox-status")!
      .handler("", createContext({ hasUI: false }));

    expect(createAutomation).not.toHaveBeenCalled();
  });
});
