import {
  copyToClipboard,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerShortcut("ctrl+shift+i", {
    description: "Copy the current intercom session ID",
    handler: async (ctx) => {
      const intercomLoaded = pi
        .getCommands()
        .some(
          (command) =>
            command.name === "intercom-id" && command.source === "extension",
        );
      const sessionId = intercomLoaded
        ? process.env.PI_INTERCOM_SESSION_ID?.trim()
        : undefined;
      if (!sessionId) {
        ctx.ui.notify(
          "Intercom session ID unavailable. Check that pi-intercom is loaded.",
          "warning",
        );
        return;
      }

      try {
        await copyToClipboard(sessionId);
        ctx.ui.notify("Intercom session ID copied", "info");
      } catch (error) {
        ctx.ui.notify(
          `Could not copy intercom session ID: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    },
  });
}
