// Public bundle generation: strict allowlist projection of a private run.
//
// The published bundle under bench/published/<runId>/ contains ONLY:
//   manifest.json   run metadata, model matrix, expected fixture trees
//   results.json    per-arm metrics + tree diffs (relative paths only)
//   report.md       polished markdown derived from results.json
//   checksums.txt   sha256 of the three files above
//
// Everything else in the private raw record — protocol events, assistant
// prose, provider/assistant error strings, stderr tails, absolute paths,
// extension path, agent-dir layout details, secrets — is omitted, never
// scrubbed-after-the-fact. Tree diffs keep the per-file byte counts and
// sha256 digests so scoring can be re-verified exactly without leaking
// file contents. Publish never runs git and never uploads.

import { rename as renameFile, rm } from "node:fs/promises";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { sha256Hex, sortKeys, validateRunId } from "./util.mjs";
import { generateReport } from "./report.mjs";

/** Canonical JSON serialization shared by publish and verify. */
export function serializeJson(value) {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

/** Allowlisted projection of one arm result. Pure + deterministic. */
export function sanitizeArm(arm) {
  const clean = {
    arm: arm.arm,
    model: arm.model.id,
    thinking: arm.model.thinking,
    fixture: arm.fixture,
    trial: arm.trial,
    outcome: arm.outcome,
    exitCode: arm.exitCode,
    wallMs: arm.wallMs,
    treeMatch: arm.tree.match,
    score: arm.tree.score,
    treeDiff: {
      missing: [...arm.tree.missing],
      extra: [...arm.tree.extra],
      changed: arm.tree.changed.map(
        ({
          path,
          actualSha256,
          expectedSha256,
          actualBytes,
          expectedBytes,
        }) => ({
          path,
          actualSha256,
          expectedSha256,
          actualBytes,
          expectedBytes,
        }),
      ),
    },
    metrics: {
      tokens: pickNumbers(arm.metrics.tokens, [
        "input",
        "output",
        "cacheRead",
        "cacheWrite",
        "reasoning",
        "total",
        "costTotal",
        "source",
      ]),
      toolCalls: pickNumbers(arm.metrics.toolCalls, [
        "total",
        "read",
        "edit",
        "errors",
      ]),
      toolCallsByTool: pickNumbers(arm.metrics.toolCalls.byName),
      editArgsBytes: arm.metrics.editArgsBytes,
      readArgsBytes: arm.metrics.readArgsBytes,
      firstEdit: { status: arm.metrics.firstEdit.status },
    },
  };
  if (arm.reported) {
    clean.reported = {
      provider: arm.reported.provider ?? null,
      model: arm.reported.model,
    };
  }
  return clean;
}

/** Allowlisted projection of the run manifest. Pure + deterministic. */
export function sanitizeManifest(manifest) {
  return {
    schema: manifest.schema,
    runId: manifest.runId,
    createdAt: manifest.startedAt,
    config: {
      models: manifest.models.map(({ id, thinking }) => ({ id, thinking })),
      fixtures: Array.isArray(manifest.fixtures)
        ? [...manifest.fixtures]
        : Object.keys(manifest.fixtures ?? {}).sort(),
      trials: manifest.trials,
      seed: manifest.seed,
      timeoutMs: manifest.timeoutMs,
      maxCalls: manifest.maxCalls,
      piVersion: manifest.piVersion ?? null,
      piBin: (manifest.piBin ?? "").split(/[\\/]/).pop() || null,
      agentDirMode: manifest.agentDirMode ?? "copied-config",
      copiedConfigFiles: [...(manifest.copiedConfigFiles ?? [])],
      settingsForced: manifest.settingsForced ?? true,
    },
    fixtures: Object.fromEntries(
      Object.entries(manifest.fixtureFacts ?? {}).map(([name, facts]) => [
        name,
        {
          descriptorSha256: facts.descriptorSha256,
          startTree: facts.startTree,
          expectedTree: facts.expectedTree,
        },
      ]),
    ),
  };
}

/**
 * Compute the full public bundle from a private raw record.
 * Returns { manifest, results, report } where report is markdown.
 */
export function computePublicBundle(raw) {
  const manifest = sanitizeManifest(raw);
  const results = {
    schema: raw.schema,
    arms: raw.arms.map(sanitizeArm),
  };
  const report = generateReport({ manifest, results });
  return { manifest, results, report };
}

/** Build the checksum list for bundle files (name -> content). */
export function computeChecksums(files) {
  const sortedNames = Object.keys(files).sort();
  return (
    sortedNames.map((name) => `${sha256Hex(files[name])}  ${name}`).join("\n") +
    "\n"
  );
}

/** Sanitized file map ready to write under published/<runId>/. */
export function buildPublicFiles(raw) {
  const { manifest, results, report } = computePublicBundle(raw);
  return {
    "manifest.json": serializeJson(manifest),
    "results.json": serializeJson(results),
    "report.md": report,
  };
}

/**
 * Write the bundle into publishedDir/<runId>/ and return written paths.
 * The bundle is staged in a sibling temp dir and atomically renamed into
 * place, so readers never see a partial bundle and a concurrent re-publish
 * cannot block this one. An existing bundle for the same run is replaced
 * atomically (publish is idempotent).
 */
export async function writePublished({
  publishedDir,
  runId,
  raw,
  io = console,
}) {
  if (!validateRunId(runId)) {
    throw new Error(
      `Invalid run id "${runId}" (letters/digits/._- , alphanumeric start).`,
    );
  }
  const dir = join(publishedDir, runId);
  await mkdir(publishedDir, { recursive: true });
  const stagingDir = await mkdtemp(join(publishedDir, `.${runId}.staging-`));
  const contents = buildPublicFiles(raw);
  try {
    for (const [name, content] of Object.entries(contents)) {
      await writeFile(join(stagingDir, name), content);
    }
    const checksums = computeChecksums(contents);
    await writeFile(join(stagingDir, "checksums.txt"), checksums);
    if (existsSync(dir)) {
      await rm(dir, { recursive: true, force: true });
    }
    await renameFile(stagingDir, dir);
    const written = [...Object.keys(contents).sort(), "checksums.txt"];
    io.log(`Published ${written.length} files to ${dir}`);
    for (const name of written) io.log(`  ${name}`);
    return { dir, written, checksums };
  } finally {
    if (existsSync(stagingDir)) {
      await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

/** Serialize the report to a target path (private runs/<runId>/ by default). */
export async function writeReport({ output, report, io = console }) {
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, report, "utf8");
  io.log(`Report written to ${output}`);
  return output;
}

function pickNumbers(entry, keys = null) {
  if (typeof entry !== "object" || entry === null) return {};
  const picked = {};
  for (const [key, value] of Object.entries(entry)) {
    if (keys && !keys.includes(key)) continue;
    if (
      typeof value === "number" ||
      typeof value === "string" ||
      typeof value === "boolean"
    ) {
      picked[key] = value;
    }
  }
  return picked;
}
