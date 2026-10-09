import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSubagent } from "./subagent.ts";

// Persisted /agent mode moved to the standalone @pi-kaush/pi-agent-mode
// package; this extension now owns delegated subagent execution and profiles
// only. There must never be two /agent registrations.
export default function (pi: ExtensionAPI) {
  registerSubagent(pi);
}
