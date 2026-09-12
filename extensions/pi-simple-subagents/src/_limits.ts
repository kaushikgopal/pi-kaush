import * as fs from "node:fs";

export const HARD_MAX_DELEGATION_DEPTH = 2;
export const HARD_MAX_CHILDREN_PER_CALL = 5;
export const HARD_MAX_CONCURRENCY_PER_SESSION = 5;
export const HARD_MAX_CHILD_EXECUTION_MS = 7 * 24 * 60 * 60 * 1000;

export interface SubagentLimitsConfig {
  version: 1;
  maxDepth: number;
  maxChildrenPerCall: number;
  maxConcurrency: number;
  maxRuntimeMs: number;
  maxInactivityMs: number;
  persistChildSessions: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
  throw new Error(`Invalid subagent limits: ${message}`);
}

function boundedInteger(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  ) {
    fail(`"${name}" must be an integer from ${minimum} through ${maximum}`);
  }
  return value as number;
}

export function parseSubagentLimits(value: unknown): SubagentLimitsConfig {
  if (!isRecord(value)) fail("root must be an object");
  if (value.version !== 1) fail('"version" must be 1');

  const maxDepth = boundedInteger(
    value.maxDepth,
    "maxDepth",
    1,
    HARD_MAX_DELEGATION_DEPTH,
  );
  const maxChildrenPerCall = boundedInteger(
    value.maxChildrenPerCall ?? value.maxChildrenPerSession,
    "maxChildrenPerCall",
    1,
    HARD_MAX_CHILDREN_PER_CALL,
  );
  const maxConcurrency = boundedInteger(
    value.maxConcurrency,
    "maxConcurrency",
    1,
    HARD_MAX_CONCURRENCY_PER_SESSION,
  );
  const maxRuntimeMs = boundedInteger(
    value.maxRuntimeMs,
    "maxRuntimeMs",
    0,
    HARD_MAX_CHILD_EXECUTION_MS,
  );
  const maxInactivityMs = boundedInteger(
    value.maxInactivityMs,
    "maxInactivityMs",
    0,
    HARD_MAX_CHILD_EXECUTION_MS,
  );
  if (
    value.persistChildSessions !== undefined &&
    typeof value.persistChildSessions !== "boolean"
  ) {
    fail('"persistChildSessions" must be a boolean');
  }
  const persistChildSessions = value.persistChildSessions ?? true;

  return {
    version: 1,
    maxDepth,
    maxChildrenPerCall,
    maxConcurrency,
    maxRuntimeMs,
    maxInactivityMs,
    persistChildSessions,
  };
}

export function loadSubagentLimits(filePath: string): SubagentLimitsConfig {
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    throw new Error(
      `Failed to read subagent limits at ${filePath}: ${error instanceof Error ? error.message : error}`,
    );
  }

  try {
    return parseSubagentLimits(JSON.parse(content));
  } catch (error) {
    if (error instanceof SyntaxError)
      throw new Error(
        `Invalid JSON in subagent limits at ${filePath}: ${error.message}`,
      );
    throw error;
  }
}
