import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default async function firefoxExtension(
  pi: ExtensionAPI,
): Promise<void> {
  try {
    createRequire(import.meta.url).resolve("@pi-kaush/firefox-agent-core");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "MODULE_NOT_FOUND")
      throw error;

    const checkout = fileURLToPath(new URL("../../../", import.meta.url));
    const warning = [
      "Firefox tools are unavailable because the core dependency is missing or not built.",
      `In the checkout at ${checkout}, run:`,
      "npm install",
      "npm run build --workspace @pi-kaush/firefox-agent-core",
      "Then run /reload or restart Pi.",
    ].join("\n");
    pi.on("session_start", (_event, context) => {
      if (context.hasUI) context.ui.notify(warning, "warning");
      else console.error(warning);
    });
    return;
  }

  const { registerFirefoxAutomation } = await import("./register.ts");
  registerFirefoxAutomation(pi);
}
