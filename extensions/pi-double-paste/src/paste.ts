import { createHash } from "node:crypto";

export const BRACKETED_PASTE_START = "\x1b[200~";
export const BRACKETED_PASTE_END = "\x1b[201~";
export const LONG_PASTE_MAX_LINES = 10;
export const LONG_PASTE_MAX_CHARS = 1_000;

export function extractBracketedPaste(data: string): string | undefined {
  if (
    !data.startsWith(BRACKETED_PASTE_START) ||
    !data.endsWith(BRACKETED_PASTE_END)
  ) {
    return undefined;
  }

  return data.slice(BRACKETED_PASTE_START.length, -BRACKETED_PASTE_END.length);
}

export function normalizePaste(text: string): string {
  const decoded = text.replace(/\x1b\[(\d+);5u/g, (match, code: string) => {
    const codePoint = Number(code);
    if (codePoint >= 97 && codePoint <= 122)
      return String.fromCharCode(codePoint - 96);
    if (codePoint >= 65 && codePoint <= 90)
      return String.fromCharCode(codePoint - 64);
    return match;
  });

  return decoded
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\t/g, "    ")
    .split("")
    .filter((character) => character === "\n" || character.charCodeAt(0) >= 32)
    .join("");
}

export function isLongPaste(text: string): boolean {
  return (
    text.split("\n").length > LONG_PASTE_MAX_LINES ||
    text.length > LONG_PASTE_MAX_CHARS
  );
}

export function fingerprint(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
