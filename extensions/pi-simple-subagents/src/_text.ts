/** Pure UTF-8 byte-budget helpers. Truncation never splits a code point. */

export interface Utf8Truncation {
  readonly value: string;
  readonly truncated: boolean;
}

export function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** Strict decode; a buffer that splits a code point decodes to "". */
function decodeUtf8(buffer: Buffer): string {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    return decoder.decode(buffer);
  } catch {
    return "";
  }
}

/** Keeps the first `maxBytes` bytes. */
export function truncateUtf8Head(
  value: string,
  maxBytes: number,
): Utf8Truncation {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return { value, truncated: false };
  for (
    let end = Math.max(0, maxBytes);
    end >= Math.max(0, maxBytes - 3);
    end--
  ) {
    const decoded = decodeUtf8(bytes.subarray(0, end));
    if (decoded || end === 0) return { value: decoded, truncated: true };
  }
  return { value: "", truncated: true };
}

/** Keeps the last `maxBytes` bytes. */
export function truncateUtf8Tail(
  value: string,
  maxBytes: number,
): Utf8Truncation {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return { value, truncated: false };
  const start = Math.max(0, bytes.length - maxBytes);
  for (
    let offset = start;
    offset <= Math.min(bytes.length, start + 3);
    offset++
  ) {
    const decoded = decodeUtf8(bytes.subarray(offset));
    if (decoded || offset === bytes.length)
      return { value: decoded, truncated: true };
  }
  return { value: "", truncated: true };
}

/**
 * Bounds `text` to `maxBytes` including `marker`, which is appended only when
 * the text was cut. Returns "" when the budget cannot hold any text before the marker.
 */
export function truncateUtf8WithMarker(
  text: string,
  maxBytes: number,
  marker: string,
): string {
  if (utf8ByteLength(text) <= maxBytes) return text;
  const room = maxBytes - utf8ByteLength(marker);
  return room > 0 ? `${truncateUtf8Head(text, room).value}${marker}` : "";
}

/**
 * Appends `value` and drops the oldest items until the JSON-encoded total fits
 * `maxBytes`. Returns true when anything was dropped or `value` alone was too large.
 */
export function appendBoundedJsonValue<T>(
  values: T[],
  value: T,
  maxBytes: number,
): boolean {
  const valueBytes = utf8ByteLength(JSON.stringify(value));
  if (valueBytes > maxBytes) return true;

  values.push(value);
  let totalBytes = values.reduce(
    (total, item) => total + utf8ByteLength(JSON.stringify(item)),
    0,
  );
  let truncated = false;
  while (values.length > 0 && totalBytes > maxBytes) {
    const removed = values.shift();
    if (removed !== undefined)
      totalBytes -= utf8ByteLength(JSON.stringify(removed));
    truncated = true;
  }
  return truncated;
}
