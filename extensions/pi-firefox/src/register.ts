import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type {
  createFirefoxClient,
  FirefoxStatusResult,
} from "@pi-kaush/firefox-core";

type FirefoxClientFactory = typeof createFirefoxClient;

const outputSchema = Type.Union([
  Type.Object(
    {
      ok: Type.Literal(true),
      result: Type.Object(
        {
          cliVersion: Type.String(),
          supportedVersion: Type.String(),
          versionMatches: Type.Boolean(),
          nativeHost: Type.Union([
            Type.Literal("installed"),
            Type.Literal("missing"),
            Type.Literal("stale"),
            Type.Literal("invalid"),
          ]),
          connection: Type.Union([
            Type.Literal("connected"),
            Type.Literal("not-approved"),
            Type.Literal("version-mismatch"),
            Type.Literal("pairing-mismatch"),
            Type.Literal("disconnected"),
          ]),
          warnings: Type.Array(Type.String()),
        },
        { additionalProperties: false },
      ),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ok: Type.Literal(false),
      code: Type.String(),
      message: Type.String(),
      recovery: Type.Union([
        Type.Object(
          {
            command: Type.String(),
            args: Type.Array(Type.String()),
          },
          { additionalProperties: false },
        ),
        Type.Null(),
      ]),
    },
    { additionalProperties: false },
  ),
]);

const MAX_SUMMARY_LENGTH = 1800;
const MAX_WARNING_COUNT = 4;

function clip(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

function summarizeStatus(status: FirefoxStatusResult): string {
  if (!status.ok) {
    const recovery = status.recovery
      ? `\nRecovery command: ${JSON.stringify([status.recovery.command, ...status.recovery.args])}`
      : "";
    return clip(
      `Firefox status error: ${status.code}\n${status.message}${recovery}`,
      MAX_SUMMARY_LENGTH,
    );
  }

  const lines = [
    `Firefox CLI: ${clip(status.result.cliVersion, 100)} (supported: ${clip(status.result.supportedVersion, 100)})`,
    `Version matches: ${status.result.versionMatches}`,
    `Native host: ${status.result.nativeHost}`,
    `Connection: ${status.result.connection}`,
  ];

  for (const warning of status.result.warnings.slice(0, MAX_WARNING_COUNT)) {
    lines.push(`Warning: ${clip(warning, 240)}`);
  }
  if (status.result.warnings.length > MAX_WARNING_COUNT) {
    lines.push(
      `Additional warnings omitted: ${status.result.warnings.length - MAX_WARNING_COUNT}`,
    );
  }

  return clip(lines.join("\n"), MAX_SUMMARY_LENGTH);
}

export function registerFirefoxStatus(
  pi: ExtensionAPI,
  createClient: FirefoxClientFactory,
): void {
  let client: ReturnType<FirefoxClientFactory> | undefined;
  const getClient = () => (client ??= createClient());

  pi.registerTool({
    name: "ff_status",
    label: "Firefox Status",
    description:
      "Check Firefox CLI, native host, and connection status without changing setup.",
    exposure: "direct",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    parameters: Type.Object({}, { additionalProperties: false }),
    outputSchema,
    async execute(_toolCallId, _params, signal) {
      const status = await getClient().status(signal ? { signal } : undefined);
      return {
        content: [{ type: "text", text: summarizeStatus(status) }],
        details: status,
        structuredContent: status,
        isError: !status.ok,
      };
    },
  });

  pi.registerCommand("firefox-status", {
    description: "Show Firefox CLI and native host status",
    async handler(_args, ctx) {
      if (!ctx.hasUI) return;

      const status = await getClient().status();
      ctx.ui.notify(summarizeStatus(status), status.ok ? "info" : "warning");
    },
  });
}
