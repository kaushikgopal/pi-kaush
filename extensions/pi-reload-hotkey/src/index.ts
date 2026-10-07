import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("reload-hotkey", {
    description: "Reload Pi resources",
    handler: (_args, ctx) => ctx.reload(),
  });

  pi.registerShortcut("ctrl+shift+r", {
    description: "Reload Pi resources",
    handler: () => {
      // Only command contexts expose reload; dispatch locally, not to the model.
      pi.sendUserMessage("/reload-hotkey", { expandPromptTemplates: true });
    },
  });
}
