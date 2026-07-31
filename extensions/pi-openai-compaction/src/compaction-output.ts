function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function cloneStructuredValue(value: unknown): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(cloneStructuredValue);
  }
  if (isRecord(value)) {
    const clone: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      clone[key] = cloneStructuredValue(nested);
    }
    return clone;
  }
  throw new Error(
    `Unsupported structured compact output value: ${typeof value}`,
  );
}

function cloneCompactedOutputItem(
  item: Record<string, unknown>,
): Record<string, unknown> | undefined {
  try {
    return cloneStructuredValue(item) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export function shouldKeepCompactedOutputItem(
  item: unknown,
): item is Record<string, unknown> {
  return isRecord(item) && typeof item.type === "string";
}

export function sanitizeCompactedWindow(
  output: readonly unknown[],
): Record<string, unknown>[] {
  const sanitized: Record<string, unknown>[] = [];
  for (const item of output) {
    if (!shouldKeepCompactedOutputItem(item)) continue;
    const cloned = cloneCompactedOutputItem(item);
    if (cloned) sanitized.push(cloned);
  }
  return sanitized;
}
