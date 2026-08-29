// Shared helpers for the pi-better-read-edit bench harness.
//
// Zero runtime dependencies: everything here is plain Node/Bun standard
// library. Keep this module free of side effects so every function stays
// unit-testable.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";

/** Absolute path of the bench/ directory (works under Node and Bun). */
export function benchDir() {
  return dirname(fileURLToPath(import.meta.url));
}

/** Absolute path of the extension root (parent of bench/). */
export function extensionRoot() {
  return join(benchDir(), "..");
}

/** SHA-256 hex digest of a string or byte buffer. */
export function sha256Hex(input) {
  return createHash("sha256").update(input).digest("hex");
}

/** UTF-8 byte length of a string. */
export function byteLength(value) {
  return Buffer.byteLength(String(value), "utf8");
}

/** Middle-safe truncation that keeps both ends of a long line for context. */
export function truncate(value, maxLength) {
  const text = String(value);
  if (text.length <= maxLength) return text;
  const headLength = Math.ceil(maxLength / 2);
  return `${text.slice(0, headLength)}…${text.slice(-headLength)}`;
}

/** Deterministic 32-bit PRNG (mulberry32). Same seed, same sequence. */
export function mulberry32(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stable, filesystem-safe label for a model id (provider/id -> id). */
export function modelSlug(modelId) {
  const segments = String(modelId).split("/");
  return segments[segments.length - 1].replace(/[^A-Za-z0-9._-]+/g, "-");
}

/** ISO timestamp with collatable dashes, used as run directory name. */
export function runIdNow(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

/** ISO timestamp for human-readable records. */
export function isoNow(date = new Date()) {
  return date.toISOString();
}

/**
 * Run IDs double as directory basenames under runs/ and published/:
 * alphanumeric start (no hidden dotfiles), no slashes or path traversal,
 * bounded length.
 */
export function validateRunId(runId) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(String(runId));
}

/**
 * Assert that a target path stays inside a base directory after resolving.
 * Throws on traversal or when the target escapes the base.
 */
export function assertPathWithin(base, target) {
  const resolvedBase = resolve(base);
  const resolvedTarget = resolve(target);
  const rel = relative(resolvedBase, resolvedTarget);
  if (
    rel === "" ||
    rel.startsWith("..") ||
    resolve(resolvedBase, rel) !== resolvedTarget
  ) {
    throw new Error(`Refusing path outside its base: ${resolvedTarget}`);
  }
  return resolvedTarget;
}

/**
 * Normalize a path override: expand a leading ~ (or bare "~") and make it
 * absolute. Empty/undefined values pass through untouched.
 */
export function normalizePath(value) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return value;
  }
  let text = String(value).trim();
  if (text === "~") return homedir();
  if (text.startsWith("~/")) text = join(homedir(), text.slice(2));
  if (text.startsWith("~\\")) text = join(homedir(), text.slice(2));
  return resolve(text);
}

/**
 * Deterministic digest of a whole file tree: sorted relative paths joined
 * with the file contents, hashed as one NUL-separated stream. Path
 * separators normalize to "/" so the digest is platform-stable.
 */
export async function digestTreeFiles(rootDir) {
  const entries = await walkFiles(rootDir);
  const hash = createHash("sha256");
  for (const relPath of entries) {
    hash.update(relPath.replaceAll("\\", "/"));
    hash.update("\0");
    hash.update(await readFile(join(rootDir, relPath)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

/** Walk a directory recursively, returning sorted relative file paths. */
async function walkFiles(rootDir) {
  const files = [];
  const stack = [""];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = await readdir(join(rootDir, current), {
      withFileTypes: true,
    });
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const relPath = current === "" ? entry.name : `${current}/${entry.name}`;
      if (entry.isDirectory()) stack.push(relPath);
      else if (entry.isFile()) files.push(relPath);
    }
  }
  return files.sort((a, b) => (a < b ? -1 : 1));
}

/** Check whether a pid still refers to a live process (ESRCH => dead). */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

/** Median of a numeric array; undefined for empty input. */
export function median(values) {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Mean of a numeric array; undefined for empty input. */
export function mean(values) {
  if (values.length === 0) return undefined;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Guarded JSON parse: returns { ok, value, error } instead of throwing. */
export function tryJson(value) {
  try {
    return { ok: true, value: JSON.parse(value), error: undefined };
  } catch (error) {
    return { ok: false, value: undefined, error };
  }
}

/** Sort object keys recursively for stable stringification. */
export function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, entry]) => [key, sortKeys(entry)]),
    );
  }
  return value;
}
