import type { BetterReadEditSettings } from "./settings.ts";

export type ModelIdentity = {
  provider: string;
  id: string;
};

/**
 * Match an anchored, case-insensitive portable glob. A single star and question
 * mark stay within one slash-delimited segment; two or more stars cross slashes.
 * All other characters are literals.
 */
export function matchesPortableModelGlob(
  value: string,
  pattern: string,
): boolean {
  let expression = "^";
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index]!;
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
      expression += escapeRegularExpression(character);
    }
  }
  expression += "$";
  return new RegExp(expression, "iu").test(value);
}

export function modelMatchesAvoidlist(
  model: ModelIdentity | undefined,
  patterns: readonly string[],
): boolean {
  if (!model) return false;
  const fullId = `${model.provider}/${model.id}`;
  return patterns.some(
    (pattern) =>
      matchesPortableModelGlob(fullId, pattern) ||
      matchesPortableModelGlob(model.id, pattern),
  );
}

export function useBuiltinReadEdit(
  model: ModelIdentity | undefined,
  settings: BetterReadEditSettings,
): boolean {
  return modelMatchesAvoidlist(model, settings.avoidModels);
}

function escapeRegularExpression(character: string): string {
  return /[\\^$.*+?()[\]{}|]/u.test(character) ? `\\${character}` : character;
}
