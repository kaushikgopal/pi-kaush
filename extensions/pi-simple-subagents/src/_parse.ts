/**
 * Boundary guards for untrusted JSON and session data. Each name states its
 * acceptance rule so call sites pick the exact semantics they need.
 */

/** A non-null, non-array object. */
export function isPlainRecord(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Any string, including the empty string. */
export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** A string with at least one character; whitespace is not trimmed. */
export function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

export function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

export function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/** An array whose every item is a string; any other item rejects the whole value. */
export function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? (value as string[])
    : undefined;
}

export function oneOf<T extends string>(
  value: unknown,
  options: readonly T[],
): T | undefined {
  return typeof value === "string" &&
    (options as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

/** Human-readable text for a caught value. */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const STALE_CONTEXT_PREFIX = "This extension ctx is stale";

/**
 * Pi invalidates a captured extension ctx after reload or session replacement
 * and then throws a plain Error with this message from every ctx, UI, and
 * `pi` action. Background timers that outlive their session expect it.
 */
export function isStaleContextError(error: unknown): boolean {
  return (
    error instanceof Error && error.message.startsWith(STALE_CONTEXT_PREFIX)
  );
}
