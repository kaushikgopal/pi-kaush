import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  createFirefoxAutomation,
  FIREFOX_TOOLS,
  type FirefoxAutomationContext,
  type FirefoxAutomationResult,
  type FirefoxReplacementConfirmation,
} from "@pi-kaush/firefox-agent-core";

type Automation = ReturnType<typeof createFirefoxAutomation>;
type AutomationFactory = typeof createFirefoxAutomation;
type PiIdentityContext = Pick<ExtensionToolContext, "cwd" | "sessionManager">;

const OUTPUT_SCHEMA = Type.Unsafe({
  oneOf: [
    {
      type: "object",
      properties: {
        ok: { const: true },
        result: {},
        session: { type: "string" },
        tab: {},
        container: {},
        warnings: { type: "array", items: { type: "string" } },
      },
      required: ["ok", "result"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        ok: { const: false },
        code: { type: "string" },
        message: { type: "string" },
        recovery: {},
        confirmation: {},
        result: {},
        session: { type: "string" },
        tab: {},
        container: {},
        warnings: { type: "array", items: { type: "string" } },
      },
      required: ["ok", "code", "message"],
      additionalProperties: false,
    },
  ],
});

const MAX_MODEL_TEXT_BYTES = 8_000;
const TRUNCATION_NOTE =
  "Model-facing JSON is truncated. The details and structuredContent fields retain the complete core result.";

function modelFacingJson(result: FirefoxAutomationResult): string {
  const serialized = JSON.stringify(result);
  if (Buffer.byteLength(serialized, "utf8") <= MAX_MODEL_TEXT_BYTES) {
    return serialized;
  }

  const base = {
    truncated: true,
    note: TRUNCATION_NOTE,
    originalBytes: Buffer.byteLength(serialized, "utf8"),
    preview: "",
  };
  let preview = Array.from(serialized).slice(0, 2048);
  while (true) {
    const text = JSON.stringify({ ...base, preview: preview.join("") });
    if (Buffer.byteLength(text, "utf8") <= MAX_MODEL_TEXT_BYTES) return text;
    if (preview.length === 0) return JSON.stringify(base);
    preview = preview.slice(0, Math.floor(preview.length / 2));
  }
}

function replacementPrompt(candidate: FirefoxReplacementConfirmation): string {
  return [
    "Firefox reported a possible replacement for an owned tab.",
    "Approve this exact candidate? The core will revalidate it before adoption.",
    "",
    JSON.stringify(candidate, null, 2),
  ].join("\n");
}

export function registerFirefoxAutomation(
  pi: ExtensionAPI,
  createAutomation: AutomationFactory = createFirefoxAutomation,
): void {
  const automations = new Map<string, Automation>();

  function getAutomation(context: PiIdentityContext): Automation {
    const sessionId = context.sessionManager.getSessionId();
    const key = JSON.stringify([context.cwd, sessionId]);
    let automation = automations.get(key);
    if (!automation) {
      automation = createAutomation({ cwd: context.cwd, agentId: sessionId });
      automations.set(key, automation);
    }
    return automation;
  }

  async function execute(
    name: string,
    input: Record<string, unknown>,
    context: ExtensionToolContext,
    signal?: AbortSignal,
  ): Promise<FirefoxAutomationResult> {
    const automation = getAutomation(context);
    const operationSignal = signal ?? context.signal;
    const automationContext: FirefoxAutomationContext = {
      ...(operationSignal ? { signal: operationSignal } : {}),
      ...(context.hasUI
        ? {
            approveReplacement: (candidate) =>
              context.ui.confirm(
                "Confirm Firefox tab replacement",
                replacementPrompt(candidate),
                operationSignal ? { signal: operationSignal } : undefined,
              ),
          }
        : {}),
    };
    return automation.execute(name, input, automationContext);
  }

  for (const descriptor of FIREFOX_TOOLS) {
    pi.registerTool({
      name: descriptor.name,
      label: descriptor.name,
      description: descriptor.description,
      exposure: "direct",
      annotations: {
        readOnlyHint: descriptor.readOnly,
        destructiveHint: !descriptor.readOnly,
        idempotentHint: descriptor.readOnly,
        openWorldHint: descriptor.name !== "ff_status",
      },
      parameters: Type.Unsafe(descriptor.parameters),
      outputSchema: OUTPUT_SCHEMA,
      async execute(_toolCallId, params, signal, _onUpdate, context) {
        const result = await execute(
          descriptor.name,
          params as Record<string, unknown>,
          context,
          signal,
        );
        return {
          content: [{ type: "text", text: modelFacingJson(result) }],
          details: result,
          structuredContent: result,
          isError: result.ok === false,
        };
      },
    });
  }

  const commands: Array<{
    name: string;
    description: string;
    tool: string;
  }> = [
    {
      name: "firefox-status",
      description: "Show the core Firefox status result",
      tool: "ff_status",
    },
    {
      name: "firefox-session",
      description: "List core Firefox session results",
      tool: "ff_session_list",
    },
    {
      name: "firefox-container",
      description: "List core Firefox container results",
      tool: "ff_container_list",
    },
  ];

  for (const command of commands) {
    pi.registerCommand(command.name, {
      description: command.description,
      async handler(_args, context: ExtensionCommandContext) {
        if (!context.hasUI) return;
        const result = await getAutomation(context).execute(
          command.tool,
          {},
          context.signal ? { signal: context.signal } : {},
        );
        context.ui.notify(
          modelFacingJson(result),
          result.ok === false ? "warning" : "info",
        );
      },
    });
  }
}
