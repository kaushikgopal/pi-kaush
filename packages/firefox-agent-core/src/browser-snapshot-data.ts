import type { FirefoxBrowserFailure } from "./browser-types.js";
import { fail } from "./browser-types.js";

export type SnapshotRow = {
  indent: number;
  backendRef: string;
  publicRef?: string;
  role: string;
  name: string | null;
  text: string | null;
  label: string | null;
  safeLine: string;
};
export type ParsedSnapshot = {
  rows: SnapshotRow[];
  text: string;
};

const ROW =
  /^(\s*)@e([1-9]\d*)\s+([a-z][a-z0-9-]*)(?:\s+("(?:\\.|[^"\\])*"))?(.*)$/u;
const ATTR = /([a-z][a-z0-9-]*)=("(?:\\.|[^"\\])*"|[^\s]+)/gu;

export function parseSnapshot(text: string): ParsedSnapshot {
  const rows: SnapshotRow[] = [];
  const lines = text.split("\n");
  const output: string[] = [];
  for (const line of lines) {
    if (/^(?:title|url|generation)\s/u.test(line)) continue;
    const match = ROW.exec(line);
    if (!match) {
      output.push(line);
      continue;
    }
    const indent = match[1]?.length ?? 0;
    const backendRef = "@e" + match[2];
    const role = match[3] ?? "unknown";
    const name = parseQuoted(match[4]);
    const tail = match[5] ?? "";
    const attrs = new Map<string, string>();
    for (const attr of tail.matchAll(ATTR)) {
      const key = attr[1];
      const value = attr[2];
      if (key && value) attrs.set(key, parseAttribute(value));
    }
    const label = attrs.get("label") ?? attrs.get("aria-label") ?? null;
    const sensitive = attrs.get("type") === "password";
    const publicName = sensitive ? null : name;
    const publicText = sensitive ? null : (attrs.get("text") ?? name);
    const safeTail = tail.replace(ATTR, (whole, key: string) => {
      return key === "value" || key === "selected" || key === "href"
        ? ""
        : whole;
    });
    const safeLine =
      match[1] +
      backendRef +
      " " +
      role +
      (publicName === null ? "" : " " + JSON.stringify(publicName)) +
      safeTail;
    rows.push({
      indent,
      backendRef,
      role,
      name: publicName,
      text: publicText,
      label,
      safeLine,
    });
    output.push(safeLine);
  }
  return { rows, text: output.join("\n") };
}

function parseQuoted(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "string" ? clean(parsed) : null;
  } catch {
    return null;
  }
}

function parseAttribute(value: string): string {
  const parsed = parseQuoted(value);
  return parsed ?? value;
}

function clean(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

export function matchSnapshotRow(
  row: SnapshotRow,
  criteria: {
    role?: string;
    name?: string;
    text?: string;
    label?: string;
    exact?: boolean;
  },
): boolean {
  const exact = criteria.exact ?? true;
  const compare = (actual: string | null, expected: string | undefined) => {
    if (expected === undefined) return true;
    if (actual === null) return false;
    return exact
      ? actual === expected
      : actual.toLowerCase().includes(expected.toLowerCase());
  };
  if (criteria.role !== undefined && row.role !== criteria.role.toLowerCase())
    return false;
  return (
    compare(row.name, criteria.name) &&
    compare(row.text, criteria.text) &&
    compare(row.label, criteria.label)
  );
}

export function scopedSnapshotText(
  rows: SnapshotRow[],
  ref: string,
): { text: string; rows: SnapshotRow[] } | FirefoxBrowserFailure {
  const index = rows.findIndex((row) => row.publicRef === ref);
  if (index < 0)
    return fail(
      "stale_ref",
      "The reference is not in the current snapshot cache.",
    );
  const root = rows[index]!;
  const selected: SnapshotRow[] = [root];
  for (let cursor = index + 1; cursor < rows.length; cursor += 1) {
    const row = rows[cursor]!;
    if (row.indent <= root.indent) break;
    selected.push(row);
  }
  const text = selected.map((row) => row.safeLine).join("\n");
  return { text, rows: selected };
}

export function fitText(
  text: string,
  maxBytes: number,
): { text: string; truncated: boolean } {
  const encoder = new TextEncoder();
  if (encoder.encode(text).byteLength <= maxBytes)
    return { text, truncated: false };
  let output = "";
  let size = 0;
  for (const character of text) {
    const bytes = encoder.encode(character).byteLength;
    if (size + bytes > maxBytes) break;
    output += character;
    size += bytes;
  }
  return { text: output, truncated: true };
}
