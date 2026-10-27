import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerFirefoxAutomation } from "./register.ts";

export default function firefoxExtension(pi: ExtensionAPI): void {
  registerFirefoxAutomation(pi);
}
