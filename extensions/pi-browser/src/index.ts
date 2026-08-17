/**
 * pi-browser — thin Pi-native driver for the user's already-running browser.
 *
 * Tools proxy through a persistent daemon holding the single CDP connection
 * (one consent prompt per daemon lifetime, tabs surviving pi sessions).
 * Covers: navigate, tabs, AX snapshot with actionable [eN] refs, compositor
 * click, framework-safe fill, press_key, scroll, upload_file, wait_for,
 * evaluate, screenshot, network/console capture, run_script, profile pinning,
 * and /browser-status + /browser-profile commands.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCommands } from "./commands.ts";
import { registerCaptureTools } from "./tools/capture.ts";
import { registerInteractionTools } from "./tools/interaction.ts";
import { registerReadTools } from "./tools/read.ts";
import { registerScriptTool } from "./tools/script.ts";
import { registerTabTools } from "./tools/tabs.ts";

export default function piBrowser(pi: ExtensionAPI) {
  registerReadTools(pi);
  registerInteractionTools(pi);
  registerTabTools(pi);
  registerCaptureTools(pi);
  registerScriptTool(pi);
  registerCommands(pi);

  // Owned tabs deliberately survive pi sessions: the daemon owns them and
  // closes them on idle timeout or explicit close, not on session shutdown.
}
