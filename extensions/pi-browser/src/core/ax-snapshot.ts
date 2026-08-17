/**
 * Raw-CDP accessibility snapshot: compact outline with actionable [eN] refs.
 *
 * Refs hold a backendDOMNodeId and re-resolve to fresh coordinates at action
 * time, so they survive SPA re-renders between snapshot and click. They go
 * stale on navigation (cleared via clearRefs) or when the node is detached —
 * the interaction layer turns that into a "re-snapshot" error.
 */

import type { CDPSession } from "puppeteer-core";

export interface SnapshotNode {
  nodeId: string;
  parentId?: string;
  childIds?: string[];
  ignored?: boolean;
  role?: { value?: string };
  name?: { value?: string };
  value?: { value?: unknown };
  backendDOMNodeId?: number;
}

export interface BuiltRef {
  id: string;
  backendNodeId: number;
  role: string;
  name: string;
}

export interface BuiltOutline {
  text: string;
  refs: BuiltRef[];
  truncated: boolean;
}

const INTERACTIVE = new Set([
  "link",
  "button",
  "textbox",
  "searchbox",
  "combobox",
  "listbox",
  "option",
  "checkbox",
  "radio",
  "switch",
  "slider",
  "spinbutton",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "treeitem",
]);

/** Roles rendered as plain structure; uninteresting wrappers are transparent. */
const SKIP = new Set(["InlineTextBox", "LineBreak", "none", "generic"]);

/** Ref store: eN -> node identity, valid until navigation or DOM detach. */
const refStore = new Map<string, BuiltRef>();
let refSeq = 0;

export const resolveRef = (id: string): BuiltRef | undefined =>
  refStore.get(id);

export const clearRefs = (): void => {
  refStore.clear();
};

export const refCount = (): number => refStore.size;

const valueText = (node: SnapshotNode): string => {
  const v = node.value?.value;
  return typeof v === "string" || typeof v === "number" ? String(v) : "";
};

/** Pure outline builder (unit-tested without a browser). */
export const buildOutline = (
  nodes: SnapshotNode[],
  maxLines: number,
  startSeq: number,
): BuiltOutline => {
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const roots = nodes.filter((n) => !n.parentId || !byId.has(n.parentId));
  const lines: string[] = [];
  const refs: BuiltRef[] = [];
  let seq = startSeq;
  let truncated = false;

  const walk = (node: SnapshotNode, depth: number): void => {
    if (lines.length >= maxLines) {
      truncated = true;
      return;
    }
    if (node.ignored) {
      for (const id of node.childIds ?? []) {
        const child = byId.get(id);
        if (child) walk(child, depth);
      }
      return;
    }

    const role = node.role?.value ?? "";
    const name = (node.name?.value ?? "").trim();
    const value = valueText(node);
    let line: string | null = null;

    if (INTERACTIVE.has(role) && node.backendDOMNodeId !== undefined) {
      const id = `e${++seq}`;
      refs.push({ id, backendNodeId: node.backendDOMNodeId, role, name });
      line = `[${id}] ${role}${name ? ` "${name}"` : ""}${value && value !== name ? ` = "${value}"` : ""}`;
    } else if (role === "StaticText") {
      line = name ? `"${name}"` : null;
    } else if (!SKIP.has(role) && (name || role === "RootWebArea")) {
      line = `${role}${name ? ` "${name}"` : ""}`;
    }

    const childDepth = line === null ? depth : depth + 1;
    if (line !== null) lines.push(`${"  ".repeat(depth)}${line}`);
    for (const id of node.childIds ?? []) {
      const child = byId.get(id);
      if (child) walk(child, childDepth);
    }
  };

  for (const root of roots) walk(root, 0);
  if (truncated) lines.push(`… truncated at ${maxLines} lines`);
  return { text: lines.join("\n"), refs, truncated };
};

export interface SnapshotOptions {
  maxLines?: number;
  /** Mutation diffs take before/after snapshots that must not re-register refs. */
  register?: boolean;
}

export const takeSnapshot = async (
  client: CDPSession,
  options: SnapshotOptions = {},
): Promise<string> => {
  const { nodes } = await client.send("Accessibility.getFullAXTree");
  const built = buildOutline(
    nodes as SnapshotNode[],
    options.maxLines ?? 400,
    refSeq,
  );
  refSeq += built.refs.length;
  if (options.register !== false) {
    for (const ref of built.refs) refStore.set(ref.id, ref);
  }
  return built.text;
};
