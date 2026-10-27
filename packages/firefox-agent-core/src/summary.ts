export type FirefoxPageSummary = {
  title: string;
  headings: string[];
  controls: Record<string, number>;
  dialogs: string[];
  truncated: boolean;
};

const DEFAULT_MAX_BYTES = 4_000;
const MAX_TITLE_BYTES = 256;
const MAX_TITLE_SCAN_CHARS = 1_024;
const MAX_LABEL_BYTES = 128;
const MAX_HEADINGS = 24;
const MAX_DIALOGS = 12;
const MAX_SCAN_CHARS = 256_000;
const MAX_SCAN_LINES = 5_000;
const CONTROL_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "checkbox",
  "radio",
  "combobox",
  "slider",
  "switch",
  "menuitem",
  "tab",
]);
const UTF8 = new TextEncoder();

// Summary-first, ref-free page reading follows surf-cli's pattern: https://github.com/nicobailon/surf-cli
export function summarizeSnapshot(input: {
  text: string;
  title: string;
  truncated: boolean;
  maxBytes?: number;
}): FirefoxPageSummary {
  const maxBytes = input.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!Number.isInteger(maxBytes) || maxBytes < 256) {
    throw new RangeError("maxBytes must be an integer of at least 256");
  }

  const rawTitle =
    typeof input.title === "string"
      ? input.title.slice(0, MAX_TITLE_SCAN_CHARS)
      : "";
  const title = limitUtf8(cleanText(rawTitle), MAX_TITLE_BYTES);
  const summary: FirefoxPageSummary = {
    title: title.value,
    headings: [],
    controls: {},
    dialogs: [],
    truncated:
      input.truncated ||
      title.truncated ||
      rawTitle.length < input.title.length,
  };

  const text = typeof input.text === "string" ? input.text : "";
  const boundedText = text.slice(0, MAX_SCAN_CHARS);
  if (text.length > boundedText.length) summary.truncated = true;

  let offset = 0;
  let scannedLines = 0;
  while (offset < boundedText.length && scannedLines < MAX_SCAN_LINES) {
    const newline = boundedText.indexOf("\n", offset);
    const end = newline === -1 ? boundedText.length : newline;
    const line = boundedText.slice(offset, end);
    offset = newline === -1 ? boundedText.length : newline + 1;
    scannedLines += 1;

    const entry = parseCompactEntry(line);
    if (entry === null) continue;

    if (CONTROL_ROLES.has(entry.role)) {
      summary.controls[entry.role] = (summary.controls[entry.role] ?? 0) + 1;
    } else if (entry.role === "heading" && entry.name !== undefined) {
      appendBoundedLabel(summary.headings, entry.name, MAX_HEADINGS, summary);
    } else if (entry.role === "dialog" && entry.name !== undefined) {
      appendBoundedLabel(summary.dialogs, entry.name, MAX_DIALOGS, summary);
    }
  }
  if (offset < boundedText.length) summary.truncated = true;

  return fitSerializedBudget(summary, maxBytes);
}

function parseCompactEntry(
  line: string,
): { role: string; name?: string } | null {
  const match =
    /^\s{0,64}@e[1-9]\d*\s+([a-z][a-z0-9-]*)(?:\s+("(?:\\.|[^"\\])*"))?(?:\s+.*)?$/u.exec(
      line,
    );
  if (match === null || match[1] === undefined) return null;

  let name: string | undefined;
  if (match[2] !== undefined) {
    try {
      const parsed: unknown = JSON.parse(match[2]);
      if (typeof parsed === "string") name = cleanText(parsed);
    } catch {
      // A malformed label is not summary data.
    }
  }
  return { role: match[1], ...(name === undefined ? {} : { name }) };
}

function appendBoundedLabel(
  labels: string[],
  rawLabel: string,
  limit: number,
  summary: FirefoxPageSummary,
): void {
  if (labels.length >= limit) {
    summary.truncated = true;
    return;
  }
  const label = limitUtf8(rawLabel, MAX_LABEL_BYTES);
  labels.push(label.value);
  if (label.truncated) summary.truncated = true;
}

function cleanText(value: string): string {
  return wellFormed(value)
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function wellFormed(value: string): string {
  let result = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    result +=
      codePoint !== undefined && codePoint >= 0xd800 && codePoint <= 0xdfff
        ? "\ufffd"
        : character;
  }
  return result;
}

function limitUtf8(
  value: string,
  maxBytes: number,
): { value: string; truncated: boolean } {
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const characterBytes = UTF8.encode(character).byteLength;
    if (bytes + characterBytes > maxBytes) {
      return { value: result, truncated: true };
    }
    result += character;
    bytes += characterBytes;
  }
  return { value: result, truncated: false };
}

function fitSerializedBudget(
  summary: FirefoxPageSummary,
  maxBytes: number,
): FirefoxPageSummary {
  if (serializedBytes(summary) <= maxBytes) return summary;

  summary.truncated = true;
  while (summary.dialogs.length > 0 && serializedBytes(summary) > maxBytes) {
    summary.dialogs.pop();
  }
  while (summary.headings.length > 0 && serializedBytes(summary) > maxBytes) {
    summary.headings.pop();
  }
  while (summary.title.length > 0 && serializedBytes(summary) > maxBytes) {
    summary.title = Array.from(summary.title).slice(0, -1).join("");
  }
  if (serializedBytes(summary) > maxBytes) {
    throw new RangeError("maxBytes is too small for the summary");
  }
  return summary;
}

function serializedBytes(summary: FirefoxPageSummary): number {
  return UTF8.encode(JSON.stringify(summary)).byteLength;
}
