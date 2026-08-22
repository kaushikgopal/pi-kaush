import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerEditTool from "./edit/tool.ts";
import registerReadTool from "./read/tool.ts";
import { HashlineSnapshotStore } from "./hashline/snapshot-store.ts";

export default function piBetterReadEdit(pi: ExtensionAPI): void {
  const snapshots = new HashlineSnapshotStore();
  registerReadTool(pi, snapshots);
  registerEditTool(pi, snapshots);
}
