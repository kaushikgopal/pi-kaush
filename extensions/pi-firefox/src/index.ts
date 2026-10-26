import { createFirefoxClient } from "@pi-kaush/firefox-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerFirefoxStatus } from "./register.ts";

export default function firefoxExtension(pi: ExtensionAPI): void {
  registerFirefoxStatus(pi, createFirefoxClient);
}
