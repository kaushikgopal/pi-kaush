import {
  createEditToolDefinition,
  createReadToolDefinition,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import registerEditTool from "./edit/tool.ts";
import registerReadTool from "./read/tool.ts";
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
  pi.on("session_start", (_event, ctx) => routeTools(ctx, ctx.model));
  pi.on("model_select", (event, ctx) => routeTools(ctx, event.model));
}
