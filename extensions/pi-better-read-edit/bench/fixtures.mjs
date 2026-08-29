// Fixture loading and deterministic workspace materialization.
//
// A fixture is a checked-in descriptor under bench/fixtures/<name>.json.
// Its start tree and expected final tree are either explicit byte-exact
// file maps or produced by a registered deterministic generator. Two
// materializations of the same fixture always produce identical bytes, so
// scoring is exact and reproducible.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { sha256Hex } from "./util.mjs";
import { tryJson } from "./util.mjs";

/**
 * Deterministic generator for the large-delete fixture: a records file with
 * `lines` array entries. The task deletes the block of entries whose ids
 * fall in [deleteStartId, deleteStartId + deleteCount).
 */
export function generateLargeDelete({
  lines = 2000,
  deleteStartId = 1000,
  deleteCount = 500,
} = {}) {
  const header = ["/* bench fixture: large-delete */", "const records = ["];
  const footer = ["];"];
  const rows = [];
  for (let id = 0; id < lines; id++) {
    rows.push(
      `  { id: ${id}, label: "record-${String(id).padStart(4, "0")}" },`,
    );
  }
  const kept = rows.filter((_, index) => {
    return index < deleteStartId || index >= deleteStartId + deleteCount;
  });
  return {
    startFiles: {
      "records.js": [...header, ...rows, ...footer, ""].join("\n"),
    },
    expectedFiles: {
      "records.js": [...header, ...kept, ...footer, ""].join("\n"),
    },
  };
}

const GENERATORS = {
  "large-delete": (args) => generateLargeDelete(args ?? {}),
};

/** All fixture names that exist on disk. */
export async function fixtureNames(fixturesDir) {
  const { readdir } = await import("node:fs/promises");
  const names = await readdir(fixturesDir);
  return names
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -".json".length))
    .sort();
}
/** Load and validate one fixture descriptor into a normalized Fixture. */
export async function loadFixture(name, fixturesDir) {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new Error(`Invalid fixture name "${name}".`);
  }
  const filePath = join(fixturesDir, `${name}.json`);
  const raw = await readFile(filePath, "utf8");
  const { value: def, ok, error } = tryJson(raw);
  if (!ok) throw new Error(`Cannot parse fixture ${filePath}: ${error}`);
  const fixture = buildFixture(def, name);
  fixture.descriptorSha256 = sha256Hex(raw);
  return fixture;
}

/** Load several fixtures; unknown names raise a clear error. */
export async function loadFixtures(names, fixturesDir) {
  const loaded = [];
  for (const name of names) loaded.push(await loadFixture(name, fixturesDir));
  return loaded;
}

/** Normalize + validate a parsed descriptor. */

export function buildFixture(def, expectedName) {
  if (typeof def !== "object" || def === null) {
    throw new Error(`Fixture ${expectedName}: descriptor must be an object.`);
  }
  const name = def.name;
  if (name !== expectedName) {
    throw new Error(
      `Fixture ${expectedName}: descriptor name "${name}" does not match file name.`,
    );
  }
  const prompt = typeof def.prompt === "string" ? def.prompt : "";
  if (prompt.trim().length === 0) {
    throw new Error(`Fixture ${name}: missing non-empty prompt.`);
  }
  const description =
    typeof def.description === "string" ? def.description : "";

  let startFiles;
  let expectedFiles;
  if (def.generator) {
    const generator = GENERATORS[def.generator.kind];
    if (!generator) {
      throw new Error(
        `Fixture ${name}: unknown generator "${def.generator.kind}" ` +
          `(known: ${Object.keys(GENERATORS).join(", ")}).`,
      );
    }
    const generated = generator(def.generator.args);
    startFiles = generated.startFiles;
    expectedFiles = generated.expectedFiles;
  } else {
    startFiles = def.files;
    expectedFiles = def.expectedFiles;
  }

  const start = validateFileMap(startFiles, `Fixture ${name} start`);
  const expected = validateFileMap(expectedFiles, `Fixture ${name} expected`);
  const descriptorSha256 = null; // filled by loadFixture from the file bytes

  return {
    name,
    description,
    prompt,
    startFiles: start,
    expectedFiles: expected,
    generator: def.generator ?? null,
  };
}
function validateFileMap(files, label) {
  if (typeof files !== "object" || files === null || Array.isArray(files)) {
    throw new Error(
      `${label}: expected an object of relative path -> content.`,
    );
  }
  const entries = Object.entries(files);
  if (entries.length === 0) throw new Error(`${label}: no files.`);
  const result = {};
  for (const [path, content] of entries) {
    if (typeof content !== "string") {
      throw new Error(`${label}: "${path}" content must be a string.`);
    }
    if (path.split("/").some((part) => part === ".." || part === "")) {
      throw new Error(`${label}: invalid relative path "${path}".`);
    }
    result[path] = content;
  }
  return result;
}

/** Write a file map into a directory (creating parents). Returns rel paths. */
export async function materializeFiles(rootDir, files) {
  const written = [];
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(rootDir, path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content, "utf8");
    written.push(path);
  }
  return written;
}

/** Sorted relative paths for a file map. */
export function fixturePaths(fixture) {
  return Object.keys(fixture.startFiles).sort();
}

/** Validate a loaded fixture set against the default names (triage). */
export function filterFixtureNames(names, available) {
  const unknown = names.filter((name) => !available.includes(name));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown fixture(s): ${unknown.join(", ")} (available: ${available.join(", ")}).`,
    );
  }
  return names;
}
