import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createDoublePasteHandler } from "./double-paste.ts";

export default function piExpandDoublePaste(pi: ExtensionAPI): void {
  let unsubscribe: (() => void) | undefined;

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;

    unsubscribe?.();
    const handler = createDoublePasteHandler(ctx.ui, {
      warn: (message) => ctx.ui.notify(message, "warning"),
    });
    unsubscribe = ctx.ui.onTerminalInput(handler);
  });

  pi.on("session_shutdown", () => {
    unsubscribe?.();
    unsubscribe = undefined;
  });
}

export { createDoublePasteHandler } from "./double-paste.ts";
export {
  BRACKETED_PASTE_END,
  BRACKETED_PASTE_START,
  extractBracketedPaste,
  fingerprint,
  isLongPaste,
  normalizePaste,
} from "./paste.ts";
