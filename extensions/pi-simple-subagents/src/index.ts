import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const extensionDir = dirname(fileURLToPath(import.meta.url));

// Persisted /agent mode moved to the standalone @pi-kaush/pi-agent-mode
// package; this extension now owns delegated subagent execution and profiles
// only. There must never be two /agent registrations.
export default async function (pi: ExtensionAPI) {
	if (existsSync(join(extensionDir, "subagent.ts"))) {
		const { registerSubagent } = await import("./subagent.ts");
		registerSubagent(pi);
	}
}
