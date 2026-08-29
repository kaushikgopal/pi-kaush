// Model matrix handling for the bench harness.
//
// The default matrix lives in config.mjs; this module resolves the final
// list from CLI/env overrides: repeatable `--model provider/id[:thinking]`
// entries replace the default matrix entirely, `--model-filter` narrows
// whatever matrix is active, and an explicit `--thinking` overrides the
// per-model level. A trailing `:<known-thinking-level>` suffix is parsed
// as the thinking override; a colon followed by anything else stays part
// of the model id.

import { DEFAULT_MODELS } from "./config.mjs";

export const VALID_THINKING = new Set([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

/** Id charset: provider/id letters, digits, and ./_:@+- ; bounded length. */
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@+\-/]{0,127}$/;

/** Throw unless the id is a plausible provider/model identifier. */
export function validateModelId(modelId) {
  const text = String(modelId);
  if (
    text.length === 0 ||
    !MODEL_ID_RE.test(text) ||
    text.includes("//") ||
    text.startsWith("/") ||
    text.endsWith("/")
  ) {
    throw new Error(
      `Invalid model id "${truncateForError(text)}" (allowed characters: ` +
        `letters, digits, / . _ : @ + - ; no empty or leading/trailing ` +
        `segments; length up to 128).`,
    );
  }
  return text;
}

/** Parse "provider/id[:thinking]" into { id, thinking? }. */
export function parseModelSpec(spec) {
  const value = String(spec).trim();
  if (!value) throw new Error("Empty --model value.");
  const colon = value.lastIndexOf(":");
  if (colon > 0) {
    const suffix = value.slice(colon + 1);
    if (VALID_THINKING.has(suffix)) {
      const id = value.slice(0, colon);
      validateModelId(id);
      return { id, thinking: suffix };
    }
  }
  return { id: validateModelId(value), thinking: undefined };
}

/**
 * Resolve the model list. specs override the defaults when non-empty;
 * each spec is a "provider/id[:thinking]" string or an already normalized
 * { id, thinking } object (tests may pass objects directly).
 */
export function resolveModels({ specs = [], filter = "", thinking } = {}) {
  let models =
    specs.length > 0
      ? specs.map(normalizeSpec)
      : DEFAULT_MODELS.map(({ id, thinking: level }) => ({
          id,
          thinking: level,
        }));
  if (filter) {
    const patterns = String(filter)
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    models = models.filter(({ id }) =>
      patterns.some((pattern) => patternIncludes(id, pattern)),
    );
  }
  if (thinking !== undefined) {
    if (!VALID_THINKING.has(String(thinking))) {
      throw new Error(
        `Unknown --thinking "${thinking}" (valid: ${[...VALID_THINKING].join(", ")}).`,
      );
    }
    models = models.map(({ id }) => ({ id, thinking: String(thinking) }));
  }
  // De-duplicate by id; a later --model spec wins over an earlier one.
  const byId = new Map();
  for (const model of models) byId.set(model.id, model);
  return [...byId.values()];
}

function normalizeSpec(spec) {
  if (typeof spec === "string") return parseModelSpec(spec);
  if (
    typeof spec === "object" &&
    spec !== null &&
    typeof spec.id === "string"
  ) {
    validateModelId(spec.id);
    if (
      spec.thinking !== undefined &&
      !VALID_THINKING.has(String(spec.thinking))
    ) {
      throw new Error(
        `Unknown thinking level "${spec.thinking}" for "${spec.id}" ` +
          `(valid: ${[...VALID_THINKING].join(", ")}).`,
      );
    }
    return { id: spec.id, thinking: spec.thinking ?? undefined };
  }
  throw new Error(`Invalid --model value: ${JSON.stringify(spec)}.`);
}

/** Case-insensitive anchored substring/glob match on a model id. */
export function patternIncludes(modelId, pattern) {
  const normalized = String(pattern).toLowerCase();
  if (normalized.includes("*") || normalized.includes("?")) {
    return globMatch(String(modelId).toLowerCase(), normalized);
  }
  return String(modelId).toLowerCase().includes(normalized);
}

/** Minimal anchored glob: * stays within a "/" segment, ** crosses it. */
export function globMatch(value, pattern) {
  let expression = "^";
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index];
    if (character === "*") {
      let count = 1;
      while (pattern[index + 1] === "*") {
        count++;
        index++;
      }
      expression += count >= 2 ? ".*" : "[^/]*";
    } else if (character === "?") {
      expression += "[^/]";
    } else {
      expression += character.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
    }
  }
  expression += "$";
  return new RegExp(expression, "u").test(value);
}

function truncateForError(value) {
  const text = String(value);
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}
