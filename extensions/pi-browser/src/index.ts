/**
 * pi-browser — thin Pi-native driver for the user's already-running browser.
 *
 * Attaches over CDP (puppeteer-core) to the running Helium/Chrome with the
 * user's real profile, logins, and cookies. WP2: actionable [eN] refs,
 * compositor interaction, framework-safe fills, tab ownership, post-mutation
 * page-change diffs. Profile pinning and network/console buffers land next.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { closeForShutdown } from "./core/connection.ts";
import { registerInteractionTools } from "./tools/interaction.ts";
import { registerReadTools } from "./tools/read.ts";
import { registerTabTools } from "./tools/tabs.ts";

export default function piBrowser(pi: ExtensionAPI) {
  registerReadTools(pi);
  registerInteractionTools(pi);
  registerTabTools(pi);

  pi.on("session_shutdown", async () => {
    await closeForShutdown();
  });
}
