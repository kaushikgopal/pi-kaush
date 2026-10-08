import {
  createEditToolDefinition,
  createReadToolDefinition,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import registerOutputCeiling from "./context/output-ceiling.ts";
import registerEditTool from "./edit/tool.ts";
import registerReadTool from "./read/tool.ts";
import {
  NESTED_HASHLINE_ENTRY_TYPE,
  recordsInDetails,
} from "./hashline/registry.ts";
import { HashlineSnapshotStore } from "./hashline/snapshot-store.ts";
import { useBuiltinReadEdit, type ModelIdentity } from "./model-routing.ts";
import { loadBetterReadEditSettings } from "./settings.ts";

export default function piBetterReadEdit(pi: ExtensionAPI): void {
  const snapshots = new HashlineSnapshotStore();
  const registerBetterTools = () => {
    registerReadTool(pi, snapshots);
    registerEditTool(pi, snapshots);
  };
  const routeTools = (
    ctx: ExtensionContext,
    model: ModelIdentity | undefined,
  ) => {
    const loaded = loadBetterReadEditSettings(ctx);
    if (ctx.hasUI) {
      for (const warning of loaded.warnings) ctx.ui.notify(warning, "warning");
    }
    if (useBuiltinReadEdit(model, loaded.settings)) {
      pi.registerTool(createReadToolDefinition(ctx.cwd));
      pi.registerTool(createEditToolDefinition(ctx.cwd));
    } else {
      registerBetterTools();
    }
  };

  // Keep the default deterministic before session/model events establish a route.
  registerBetterTools();
  if (typeof pi.on !== "function") return;
  registerOutputCeiling(pi);
  pi.on("tool_result", (event) => {
    if (
      event.parentToolCallId === undefined ||
      event.isError !== false ||
      (event.toolName !== "read" && event.toolName !== "edit")
    ) {
      return;
    }
    const anchors = recordsInDetails(event.details);
    if (anchors.length === 0) return;
    // Nested results never enter the transcript; persist anchors before the
    // calling script resumes so its next edit can use them on this branch.
    pi.appendEntry(NESTED_HASHLINE_ENTRY_TYPE, { hashlineAnchors: anchors });
  });
  pi.on("session_start", (_event, ctx) => routeTools(ctx, ctx.model));
  pi.on("model_select", (event, ctx) => routeTools(ctx, event.model));
}
