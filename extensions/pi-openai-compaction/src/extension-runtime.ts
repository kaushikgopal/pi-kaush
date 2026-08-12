import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  BeforeProviderRequestEvent,
  ExtensionAPI,
  ExtensionContext,
  SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { executeNativeCompaction } from "./compact-client";
import { sanitizeCompactedWindow } from "./compaction-output";
import { resolveLatestNativeCompactionEntry } from "./details-store";
import {
  normalizeNativeCompactedWindowForReplay,
  rewriteResponsesPayloadWithNativeReplay,
  serializeLiveTailToResponsesInput,
} from "./payload-rewrite";
import {
  createPortableSummary,
  findActivePortableSummaryEntry,
  hasActivePortableSummary,
  PORTABLE_SUMMARY_MESSAGE_TYPE,
  projectPortableSummary,
  type PortableSummaryState,
} from "./portable-summary";
import { resolveNativeCompactionEnvironment } from "./runtime";
import {
  serializeMessagesToCompactRequest,
  type ResponsesInputItem,
} from "./serializer";
import { loadExtensionSettings } from "./settings";
import {
  createNativeCompactionDetails,
  createNativeCompactionShimResult,
  isNativeCompactionDetails,
  NATIVE_COMPACTION_DISPLAY_MESSAGE_TYPE,
  NATIVE_COMPACTION_DISPLAY_TEXT,
  type NativeCompactionIdentity,
  type NativeCompactionRequestMeta,
} from "./types";

let restoringPreviousModel = false;

function hasSameNativeCompactionIdentity(
  left: NativeCompactionIdentity,
  right: NativeCompactionIdentity,
): boolean {
  return (
    left.provider === right.provider &&
    left.api === right.api &&
    left.model === right.model &&
    left.baseUrl === right.baseUrl
  );
}

async function restoreModel(
  pi: ExtensionAPI,
  model: Model<Api>,
): Promise<boolean> {
  restoringPreviousModel = true;
  try {
    return await pi.setModel(model);
  } finally {
    restoringPreviousModel = false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function buildCompactionRequestMeta(
  event: SessionBeforeCompactEvent,
): NativeCompactionRequestMeta {
  const requestMeta: NativeCompactionRequestMeta = {
    tokensBefore: event.preparation.tokensBefore,
    previousSummaryPresent: Boolean(event.preparation.previousSummary),
  };

  if (event.reason) {
    requestMeta.reason = event.reason;
  }
  if (typeof event.willRetry === "boolean") {
    requestMeta.willRetry = event.willRetry;
  }

  return requestMeta;
}

type SessionContextMessages = AgentMessage[];

function getSessionContextMessages(
  ctx: ExtensionContext,
  branchEntries = ctx.sessionManager.getBranch(),
): SessionContextMessages {
  const sessionManager =
    ctx.sessionManager as ExtensionContext["sessionManager"] & {
      buildSessionContext(): { messages: AgentMessage[] };
    };
  return projectPortableSummary(
    sessionManager.buildSessionContext().messages,
    branchEntries,
  );
}

function isNonStopAssistantLeaf(
  message: SessionContextMessages[number] | undefined,
): boolean {
  return Boolean(
    message &&
      message.role === "assistant" &&
      "stopReason" in message &&
      (message as { stopReason?: unknown }).stopReason !== "stop",
  );
}

function buildMessagesForNativeCompaction(
  event: SessionBeforeCompactEvent,
  messages: SessionContextMessages,
): SessionContextMessages {
  if (event.reason !== "overflow" || event.willRetry !== true) {
    return messages;
  }

  const lastMessage = messages[messages.length - 1];
  if (!isNonStopAssistantLeaf(lastMessage)) {
    return messages;
  }

  return messages.slice(0, -1) as SessionContextMessages;
}

function getSessionId(ctx: ExtensionContext): string | undefined {
  try {
    const sessionId = ctx.sessionManager.getSessionId();
    const normalized = sessionId?.trim();
    return normalized ? normalized : undefined;
  } catch {
    return undefined;
  }
}

function cloneCompactedWindow(
  window: readonly unknown[],
): ResponsesInputItem[] | undefined {
  if (!window.every(isRecord)) return undefined;
  return window.map((item) => structuredClone(item) as ResponsesInputItem);
}

function isNativeCompactionDisplayMessage(message: unknown): boolean {
  return (
    isRecord(message) &&
    message.role === "custom" &&
    message.customType === NATIVE_COMPACTION_DISPLAY_MESSAGE_TYPE
  );
}

function buildCompactionTriggerGuidance(
  reason: SessionBeforeCompactEvent["reason"],
  willRetry: boolean,
): string | undefined {
  if (reason === "threshold") {
    return "This is threshold auto-compaction. Preserve durable progress, current task state, file paths, tool results, and next steps while reducing older context.";
  }

  if (reason === "overflow" && willRetry) {
    return "This is context-overflow recovery and Pi will retry the aborted turn after compaction. Preserve enough state to retry the active user request, but do not treat the overflow/error assistant leaf as completed progress.";
  }

  if (reason === "overflow") {
    return "This is context-overflow compaction after a completed assistant response. Preserve completed assistant output, durable progress, file paths, tool results, and next steps.";
  }

  return undefined;
}

function buildCompactionInstructions(
  systemPrompt: string,
  customInstructions: string | undefined,
  reason: SessionBeforeCompactEvent["reason"],
  willRetry: boolean,
): string {
  const guidance = customInstructions?.trim();
  const triggerGuidance = buildCompactionTriggerGuidance(reason, willRetry);
  const sections = [systemPrompt];

  if (triggerGuidance) {
    sections.push(`Compaction trigger guidance:\n${triggerGuidance}`);
  }

  if (guidance) {
    sections.push(
      `Additional user guidance for this manual /compact request:\n${guidance}`,
    );
  }

  return sections.join("\n\n");
}

async function handleSessionBeforeCompact(
  event: SessionBeforeCompactEvent,
  piContext: ExtensionContext,
) {
  const branchEntries = piContext.sessionManager.getBranch();
  const activeNative = resolveLatestNativeCompactionEntry(branchEntries);
  const portableSummaryActive = hasActivePortableSummary(branchEntries);
  const { settings } = loadExtensionSettings(piContext.cwd);
  if (!settings.enabled)
    return activeNative.ok && !portableSummaryActive
      ? { cancel: true }
      : undefined;
  if (event.signal.aborted) return { cancel: true };

  const resolution = await resolveNativeCompactionEnvironment(piContext, {
    enabled: settings.enabled,
    supportedProviders: settings.supportedProviders,
    supportedApis: settings.supportedApis,
    signal: event.signal,
  });
  if (!resolution.ok)
    return activeNative.ok && !portableSummaryActive
      ? { cancel: true }
      : undefined;

  const runtime = resolution.runtime;
  const instructions = buildCompactionInstructions(
    piContext.getSystemPrompt(),
    event.customInstructions,
    event.reason,
    event.willRetry,
  );
  const latestNativeCompaction = resolveLatestNativeCompactionEntry(
    branchEntries,
    {
      provider: runtime.provider,
      api: runtime.api,
      model: runtime.model,
      baseUrl: runtime.baseUrl,
    },
  );
  if (activeNative.ok && !portableSummaryActive && !latestNativeCompaction.ok)
    return { cancel: true };

  let request: ReturnType<typeof serializeMessagesToCompactRequest>;
  if (latestNativeCompaction.ok && !portableSummaryActive) {
    const details = latestNativeCompaction.entry.details;
    const compactedWindow = isNativeCompactionDetails(details)
      ? cloneCompactedWindow(
          normalizeNativeCompactedWindowForReplay(details.compactedWindow) ??
            [],
        )
      : undefined;
    if (!compactedWindow) return { cancel: true };

    request = {
      model: runtime.currentModel.id,
      input: [
        ...compactedWindow,
        ...serializeLiveTailToResponsesInput({
          model: runtime.currentModel,
          entries: branchEntries.slice(latestNativeCompaction.index + 1),
        }),
      ],
      instructions,
    };
  } else {
    request = serializeMessagesToCompactRequest({
      model: runtime.currentModel,
      messages: buildMessagesForNativeCompaction(
        event,
        getSessionContextMessages(piContext, branchEntries),
      ),
      instructions,
    });
  }

  const compactResult = await executeNativeCompaction({
    runtime,
    request,
    signal: event.signal,
  });
  if (!compactResult.ok) {
    if (compactResult.reason === "aborted") return { cancel: true };
    if (latestNativeCompaction.ok && !portableSummaryActive) {
      let portable: Awaited<ReturnType<typeof createPortableSummary>>;
      try {
        portable = await createPortableSummary({
          runtime,
          model: runtime.currentModel,
          compactionEntry: latestNativeCompaction.entry,
          branchEntries,
          includeTail: true,
          signal: event.signal,
        });
      } catch {
        return { cancel: true };
      }
      if (!portable.ok) return { cancel: true };
      return {
        compaction: {
          summary: portable.state.summary,
          firstKeptEntryId: event.preparation.firstKeptEntryId,
          tokensBefore: event.preparation.tokensBefore,
        },
      };
    }
    return undefined;
  }

  const compactedWindow = sanitizeCompactedWindow(
    compactResult.compactedWindow,
  );
  if (compactedWindow.length === 0) return undefined;

  let details: ReturnType<typeof createNativeCompactionDetails>;
  try {
    details = createNativeCompactionDetails({
      provider: runtime.provider,
      api: runtime.api,
      model: runtime.model,
      baseUrl: runtime.baseUrl,
      compactedWindow,
      compactResponseId: compactResult.compactResponseId,
      createdAt: compactResult.createdAt,
      requestMeta: buildCompactionRequestMeta(event),
    });
  } catch {
    return undefined;
  }

  return {
    compaction: createNativeCompactionShimResult({
      firstKeptEntryId: event.preparation.firstKeptEntryId,
      tokensBefore: event.preparation.tokensBefore,
      usage: compactResult.usage,
      details,
    }),
  };
}

async function handleBeforeProviderRequest(
  event: BeforeProviderRequestEvent,
  ctx: ExtensionContext,
) {
  const { settings } = loadExtensionSettings(ctx.cwd);
  if (!settings.enabled) return undefined;

  const resolution = await resolveNativeCompactionEnvironment(
    ctx,
    {
      enabled: settings.enabled,
      supportedProviders: settings.supportedProviders,
      supportedApis: settings.supportedApis,
      signal: ctx.signal,
      resolveAuth: false,
    },
    event.payload,
  );
  if (!resolution.ok) return undefined;

  const runtime = resolution.runtime;
  const payload = runtime.payload;
  if (!payload) return undefined;

  const branchEntries = ctx.sessionManager.getBranch();
  if (hasActivePortableSummary(branchEntries)) return undefined;

  const latestNativeCompaction = resolveLatestNativeCompactionEntry(
    branchEntries,
    {
      provider: runtime.provider,
      api: runtime.api,
      model: runtime.model,
      baseUrl: runtime.baseUrl,
    },
  );
  if (!latestNativeCompaction.ok) return undefined;

  const rewrite = rewriteResponsesPayloadWithNativeReplay({
    model: runtime.currentModel,
    payload,
    branchEntries,
    compactionEntry: latestNativeCompaction.entry,
  });
  return rewrite.ok ? rewrite.rewrittenPayload : undefined;
}

type PortableMaterializationResult =
  | { ok: true; status: "created" | "already-portable" | "not-needed" }
  | { ok: false; reason: string };

async function materializePortableSummary(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  sourceModel: Model<Api>,
): Promise<PortableMaterializationResult> {
  const sessionId = getSessionId(ctx);
  const leafId = ctx.sessionManager.getLeafId();
  const branchEntries = ctx.sessionManager.getBranch();
  const existingPortable = findActivePortableSummaryEntry(branchEntries);
  if (existingPortable?.contextVisible)
    return { ok: true, status: "already-portable" };

  let state: PortableSummaryState;
  let status: "created" | "already-portable" = "created";
  if (existingPortable) {
    state = existingPortable.state;
    status = "already-portable";
  } else {
    const latestNative = resolveLatestNativeCompactionEntry(branchEntries);
    if (!latestNative.ok) return { ok: true, status: "not-needed" };

    const { settings } = loadExtensionSettings(ctx.cwd);
    const resolution = await resolveNativeCompactionEnvironment(ctx, {
      enabled: true,
      supportedProviders: settings.supportedProviders,
      supportedApis: settings.supportedApis,
      model: sourceModel,
      signal: ctx.signal,
    });
    if (!resolution.ok) return { ok: false, reason: resolution.reason };

    const runtime = resolution.runtime;
    const details = latestNative.entry.details;
    if (!isNativeCompactionDetails(details))
      return { ok: false, reason: "invalid-checkpoint" };
    if (!hasSameNativeCompactionIdentity(details, runtime)) {
      return { ok: false, reason: "source-identity-mismatch" };
    }

    let portable: Awaited<ReturnType<typeof createPortableSummary>>;
    try {
      portable = await createPortableSummary({
        runtime,
        model: runtime.currentModel,
        compactionEntry: latestNative.entry,
        branchEntries,
        includeTail: true,
        signal: ctx.signal,
      });
    } catch {
      return { ok: false, reason: "portable-summary-error" };
    }
    if (!portable.ok) return { ok: false, reason: portable.reason };
    state = portable.state;
  }

  if (
    sessionId !== getSessionId(ctx) ||
    leafId !== ctx.sessionManager.getLeafId()
  ) {
    return { ok: false, reason: "session-branch-changed" };
  }
  try {
    pi.sendMessage(
      {
        customType: PORTABLE_SUMMARY_MESSAGE_TYPE,
        content: `Portable conversation checkpoint. This supersedes any earlier OpenAI native compaction marker.\n\n${state.summary}`,
        display: false,
        details: state,
      },
      { triggerTurn: false },
    );
  } catch {
    return { ok: false, reason: "portable-state-write-failed" };
  }
  const persisted = findActivePortableSummaryEntry(
    ctx.sessionManager.getBranch(),
  );
  if (
    !persisted?.contextVisible ||
    persisted.state.sourceCompactionEntryId !== state.sourceCompactionEntryId
  ) {
    return { ok: false, reason: "portable-state-write-failed" };
  }
  return { ok: true, status };
}

async function handleModelSelect(
  event: { model: Model<Api>; previousModel: Model<Api> | undefined },
  ctx: ExtensionContext,
  pi: ExtensionAPI,
): Promise<void> {
  if (restoringPreviousModel || !event.previousModel) return;
  if (!ctx.isIdle()) {
    const restored = await restoreModel(pi, event.previousModel);
    if (ctx.hasUI) {
      ctx.ui.notify(
        restored
          ? "Model change cancelled while the agent was busy."
          : "Model change cancelled; restore the previous model before continuing.",
        "error",
      );
    }
    return;
  }
  const branchEntries = ctx.sessionManager.getBranch();
  const latestNative = resolveLatestNativeCompactionEntry(branchEntries);
  if (!latestNative.ok) return;
  const latestDetails = latestNative.entry.details;
  if (!isNativeCompactionDetails(latestDetails)) return;

  const { settings } = loadExtensionSettings(ctx.cwd);
  const target = await resolveNativeCompactionEnvironment(ctx, {
    enabled: settings.enabled,
    supportedProviders: settings.supportedProviders,
    supportedApis: settings.supportedApis,
    model: event.model,
    signal: ctx.signal,
  });
  if (
    target.ok &&
    hasSameNativeCompactionIdentity(latestDetails, target.runtime)
  ) {
    return;
  }

  const result = await materializePortableSummary(pi, ctx, event.previousModel);
  if (result.ok) return;

  const restored = await restoreModel(pi, event.previousModel);
  if (ctx.hasUI) {
    ctx.ui.notify(
      restored
        ? `Model change cancelled: portable compaction failed (${result.reason}).`
        : `Portable compaction failed (${result.reason}); restore the previous model before continuing.`,
      "error",
    );
  }
}

async function handleSessionStart(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): Promise<void> {
  const branchEntries = ctx.sessionManager.getBranch();
  const existingPortable = findActivePortableSummaryEntry(branchEntries);
  if (existingPortable?.contextVisible) return;
  const latestNative = resolveLatestNativeCompactionEntry(branchEntries);
  if (
    !latestNative.ok ||
    !isNativeCompactionDetails(latestNative.entry.details)
  )
    return;
  const details = latestNative.entry.details;
  const { settings } = loadExtensionSettings(ctx.cwd);
  const target = await resolveNativeCompactionEnvironment(ctx, {
    enabled: settings.enabled,
    supportedProviders: settings.supportedProviders,
    supportedApis: settings.supportedApis,
    signal: ctx.signal,
  });
  if (
    !existingPortable &&
    target.ok &&
    hasSameNativeCompactionIdentity(details, target.runtime)
  ) {
    return;
  }

  const sourceModel = ctx.modelRegistry.find(details.provider, details.model);
  if (!sourceModel || sourceModel.api !== details.api) {
    if (ctx.hasUI)
      ctx.ui.notify(
        "Native checkpoint source model is unavailable; restore it before continuing.",
        "error",
      );
    return;
  }
  const sourceResolution = await resolveNativeCompactionEnvironment(ctx, {
    enabled: true,
    supportedProviders: settings.supportedProviders,
    supportedApis: settings.supportedApis,
    model: sourceModel,
    signal: ctx.signal,
  });
  if (
    !sourceResolution.ok ||
    !hasSameNativeCompactionIdentity(details, sourceResolution.runtime)
  ) {
    if (ctx.hasUI)
      ctx.ui.notify(
        "Native checkpoint source model is unavailable; restore it before continuing.",
        "error",
      );
    return;
  }
  const result = await materializePortableSummary(pi, ctx, sourceModel);
  if (result.ok) return;

  const restored = await restoreModel(pi, sourceModel);
  if (ctx.hasUI) {
    ctx.ui.notify(
      restored
        ? `Portable compaction failed (${result.reason}); restored the checkpoint source model.`
        : `Portable compaction failed (${result.reason}); restore the checkpoint source model before continuing.`,
      "error",
    );
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("native-compaction-detach", {
    description:
      "Convert the active OpenAI checkpoint into portable Pi context",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();
      if (!ctx.model) {
        if (ctx.hasUI)
          ctx.ui.notify(
            "No active model is available for portable compaction.",
            "error",
          );
        return;
      }
      const result = await materializePortableSummary(
        pi,
        ctx,
        ctx.model as Model<Api>,
      );
      if (!ctx.hasUI) return;
      if (!result.ok) {
        ctx.ui.notify(
          `Portable compaction failed (${result.reason}).`,
          "error",
        );
      } else if (result.status === "created") {
        ctx.ui.notify(
          "Native checkpoint converted to portable Pi context.",
          "info",
        );
      } else if (result.status === "already-portable") {
        ctx.ui.notify("This branch already has portable Pi context.", "info");
      } else {
        ctx.ui.notify("No active native checkpoint needs conversion.", "info");
      }
    },
  });

  pi.on("session_start", (_event, ctx) => handleSessionStart(pi, ctx));
  pi.on("session_tree", (_event, ctx) => handleSessionStart(pi, ctx));
  pi.on("session_before_compact", handleSessionBeforeCompact);
  pi.on("before_provider_request", handleBeforeProviderRequest);
  pi.on("model_select", (event, ctx) => handleModelSelect(event, ctx, pi));
  pi.on("session_compact", async (event, ctx) => {
    if (
      !event.fromExtension ||
      !isNativeCompactionDetails(event.compactionEntry.details)
    )
      return;
    if (ctx.hasUI) {
      ctx.ui.notify(NATIVE_COMPACTION_DISPLAY_TEXT, "info");
    }
  });
  pi.on("context", async (event, ctx) => ({
    messages: projectPortableSummary(
      event.messages,
      ctx.sessionManager.getBranch(),
    ).filter((message) => !isNativeCompactionDisplayMessage(message)),
  }));
}
