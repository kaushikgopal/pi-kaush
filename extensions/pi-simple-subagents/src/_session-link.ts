/**
 * Links a finished child session file to its parent session so Pi's resume
 * tree nests the child under the session that spawned it.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Sets `parentSession` in a pi session header to the parent's session file.
 * Best effort: returns an error description, or undefined on success or when
 * there is nothing to do. Only safe when no process is writing the file;
 * callers run it after the child exited.
 */
export function linkSessionParent(
  sessionFile: string | undefined,
  parentSessionFile: string | undefined,
): string | undefined {
  if (!sessionFile || !parentSessionFile) return undefined;
  if (!existsSync(sessionFile))
    return `Session file is missing: ${sessionFile}`;
  let content: string;
  try {
    content = readFileSync(sessionFile, "utf-8");
  } catch (error) {
    return `Could not read session file: ${errorText(error)}`;
  }
  const newlineAt = content.indexOf("\n");
  const head = newlineAt === -1 ? content : content.slice(0, newlineAt);
  const rest = newlineAt === -1 ? "" : content.slice(newlineAt);
  let header: Record<string, unknown>;
  try {
    header = JSON.parse(head) as Record<string, unknown>;
  } catch {
    return `Session file does not start with a JSON header: ${sessionFile}`;
  }
  if (header?.type !== "session")
    return `Not a pi session file: ${sessionFile}`;
  if (header.parentSession === parentSessionFile) return undefined;
  header.parentSession = path.resolve(parentSessionFile);
  try {
    writeFileSync(sessionFile, `${JSON.stringify(header)}${rest}`, "utf-8");
  } catch (error) {
    return `Could not write session file: ${errorText(error)}`;
  }
  return undefined;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
