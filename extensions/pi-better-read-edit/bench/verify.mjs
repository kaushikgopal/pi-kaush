// Verification: independently re-derive an arm's metrics and outcomes from
// its stored normalized events, snapshot the fixture start/expected trees
// and the extension source digest to prove determinism and identity, and
// cross-check a published bundle against the private run with exact-file
// set, exact bytes, exact checksums, deep projections, and exact scoring
// evidence. Exits non-zero on any mismatch.

import { readFile, mkdtemp, rm } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyOutcome,
  computeMetrics,
  reportedIdentity,
} from "./protocol.mjs";
import { loadFixtures, materializeFiles } from "./fixtures.mjs";
import { snapshotTree, treeRecord } from "./workspace.mjs";
import {
  buildPublicFiles,
  computeChecksums,
  computePublicBundle,
  serializeJson,
} from "./publish.mjs";
import { digestTreeFiles, extensionRoot, tryJson } from "./util.mjs";

const BUNDLE_FILES = new Set([
  "manifest.json",
  "results.json",
  "report.md",
  "checksums.txt",
]);

/** Run all verification checks for one run directory. */
export async function verifyRun({
  runDir,
  publishedDir,
  fixturesDir,
  io = console,
}) {
  const checks = [];
  const fail = (name, detail) => checks.push({ name, ok: false, detail });
  const pass = (name, detail) => checks.push({ name, ok: true, detail });

  // 1. raw.json parses with the expected schema and has arms.
  const rawPath = join(runDir, "raw.json");
  if (!existsSync(rawPath)) return fail("raw.json", `missing ${rawPath}`);
  const { value: raw, ok: rawOk } = tryJson(await readFile(rawPath, "utf8"));
  if (!rawOk) return fail("raw.json", "not valid JSON");
  if (raw.schema !== "pi-better-read-edit-bench/v1") {
    fail("schema", `unexpected schema "${raw.schema}"`);
  } else {
    pass("schema", raw.schema);
  }
  if (!Array.isArray(raw.arms) || raw.arms.length === 0) {
    return fail("arms", "no arms in raw.json");
  }
  pass("arms", `${raw.arms.length} arm(s)`);

  // 2. manifest.json on disk is byte-identical to the manifest record.
  const manifestPath = join(runDir, "manifest.json");
  const expectedManifestText = `${JSON.stringify(
    pickManifestRecord(raw),
    null,
    2,
  )}\n`;
  if (existsSync(manifestPath)) {
    const diskManifest = await readFile(manifestPath, "utf8");
    if (diskManifest === expectedManifestText) {
      pass("manifest.json", "matches the raw record");
    } else {
      fail("manifest.json", "diverges from the raw record (tampered?)");
    }
  } else {
    fail("manifest.json", "missing");
  }

  // 3. Every arm's stored metrics match a deep recomputation from events.
  let metricMismatches = 0;
  for (const arm of raw.arms) {
    const recomputed = computeMetrics(arm.events ?? []);
    const stored = arm.metrics ?? {};
    const issues = [];
    const reach = (label, recomputedValue, storedValue) => {
      if (JSON.stringify(recomputedValue) !== JSON.stringify(storedValue)) {
        issues.push(
          `${label}: stored=${JSON.stringify(storedValue)} recomputed=${JSON.stringify(recomputedValue)}`,
        );
      }
    };
    reach("tokens", recomputed.tokens, stored.tokens);
    reach("toolCalls", recomputed.toolCalls, stored.toolCalls);
    reach("editArgsBytes", recomputed.editArgsBytes, stored.editArgsBytes);
    reach("readArgsBytes", recomputed.readArgsBytes, stored.readArgsBytes);
    reach("firstEdit", recomputed.firstEdit, stored.firstEdit);
    const recomputedOutcome = classifyOutcome({
      events: arm.events ?? [],
      parseErrors: arm.errors?.parse ?? [],
      unknownTypeCount: arm.errors?.unknownEventTypes ?? 0,
      exitCode: arm.exitCode,
      killReason: arm.killReason ?? null,
    });
    if (recomputedOutcome.outcome !== arm.outcome) {
      issues.push(
        `outcome: stored=${arm.outcome} recomputed=${recomputedOutcome.outcome}`,
      );
    }
    const identity = reportedIdentity(arm.events ?? []);
    if (JSON.stringify(identity) !== JSON.stringify(arm.reported ?? null)) {
      issues.push(
        `reported identity: stored=${JSON.stringify(arm.reported)} recomputed=${JSON.stringify(identity)}`,
      );
    }
    if (arm.reported) {
      const requested = requestedIdentity(arm.model.id);
      if (
        arm.reported.provider !== requested.provider ||
        arm.reported.model !== requested.model
      ) {
        issues.push(
          `reported identity ${JSON.stringify(arm.reported)} != requested ${JSON.stringify(requested)}`,
        );
      }
    }
    if (issues.length > 0) {
      metricMismatches++;
      fail(
        "metrics",
        `${arm.arm}/${arm.fixture}/${arm.model.id}: ${issues.join("; ")}`,
      );
    }
  }
  if (metricMismatches === 0) pass("metrics", "all arms rederive identically");

  // 4. Fixture determinism: descriptor hashes and start/expected trees
  //    still match the manifest facts (re-materialized from disk).
  const facts = raw.fixtureFacts ?? {};
  const names = Object.keys(facts).sort();
  if (names.length > 0) {
    const fixtures = await loadFixtures(names, fixturesDir);
    let fixtureMismatches = 0;
    for (const fixture of fixtures) {
      const storedFacts = facts[fixture.name] ?? {};
      const issues = [];
      if (fixture.descriptorSha256 !== storedFacts.descriptorSha256) {
        issues.push("descriptor sha256 drifted");
      }
      const dir = await mkdtemp(join(tmpdir(), "bench-verify-"));
      try {
        const startDir = join(dir, "start");
        const expectedDir = join(dir, "expected");
        await materializeFiles(startDir, fixture.startFiles);
        await materializeFiles(expectedDir, fixture.expectedFiles);
        const currentStart = treeRecord(await snapshotTree(startDir));
        const currentExpected = treeRecord(await snapshotTree(expectedDir));
        if (
          JSON.stringify(currentStart) !== JSON.stringify(storedFacts.startTree)
        ) {
          issues.push("start tree drifted");
        }
        if (
          JSON.stringify(currentExpected) !==
          JSON.stringify(storedFacts.expectedTree)
        ) {
          issues.push("expected tree drifted");
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
      if (issues.length > 0) {
        fixtureMismatches++;
        fail("fixture-determinism", `${fixture.name}: ${issues.join("; ")}`);
      }
    }
    if (fixtureMismatches === 0)
      pass(
        "fixture-determinism",
        `${names.length} fixture(s): descriptor + start/expected trees unchanged`,
      );
  } else {
    fail("fixture-determinism", "no fixture facts in raw.json");
  }

  // 5. Extension source digest still matches the bench's own src tree.
  const recordedDigest = raw.extension?.sourceDigest;
  const currentDigest = await digestTreeFiles(
    join(extensionRoot(), "src"),
  ).catch(() => null);
  if (recordedDigest && currentDigest === recordedDigest) {
    pass("extension-digest", `src digest ${recordedDigest.slice(0, 12)}…`);
  } else if (!recordedDigest) {
    fail("extension-digest", "raw.json records no extension digest");
  } else {
    fail(
      "extension-digest",
      "bench src tree changed since the run (verify with a matching install)",
    );
  }

  // 6. Published bundle, when present: exact file set, exact bytes,
  //    exact checksums, deep projections, and exact scoring evidence.
  const bundleDir = join(publishedDir, raw.runId);
  if (existsSync(bundleDir)) {
    const onDisk = (await readdir(bundleDir)).sort();
    const expectedNames = [...BUNDLE_FILES].sort();
    if (JSON.stringify(onDisk) !== JSON.stringify(expectedNames)) {
      const missing = expectedNames.filter((name) => !onDisk.includes(name));
      const extras = onDisk.filter((name) => !BUNDLE_FILES.has(name));
      fail(
        "published-file-set",
        `expected exactly ${expectedNames.join(", ")}; ` +
          `${missing.length > 0 ? `missing ${missing.join(", ")}; ` : ""}` +
          `${extras.length > 0 ? `rejected extras ${extras.join(", ")}` : ""}`,
      );
    } else {
      pass("published-file-set", "exactly manifest/results/report/checksums");
    }
    if (onDisk.some((name) => !BUNDLE_FILES.has(name))) {
      fail("published-extras", "unexpected files in bundle (tampering)");
    } else {
      pass("published-extras", "no extra files");
    }

    const publicFiles = buildPublicFiles(raw);
    let contents = {};
    let readOk = true;
    for (const name of expectedNames) {
      if (!existsSync(join(bundleDir, name))) {
        readOk = false;
        continue;
      }
      contents[name] = await readFile(join(bundleDir, name), "utf8");
    }
    if (readOk) {
      // Checksums must match the bundle files AS THEY LIE ON DISK, so any
      // tampering with a hashed file breaks checksums.txt verification.
      const expectedChecksumText = computeChecksums({
        "manifest.json": contents["manifest.json"],
        "results.json": contents["results.json"],
        "report.md": contents["report.md"],
      });
      if (contents["checksums.txt"] === expectedChecksumText) {
        pass("published-checksums", "checksums.txt matches bundle contents");
      } else {
        fail(
          "published-checksums",
          "checksums.txt does not match bundle contents (tampered?)",
        );
      }
      for (const name of ["manifest.json", "results.json", "report.md"]) {
        if (contents[name] === publicFiles[name]) {
          pass(
            `published-${name}`,
            "byte-identical to regeneration from raw.json",
          );
        } else {
          fail(`published-${name}`, "diverges from regeneration from raw.json");
        }
      }
      // Deep projection: the parsed results are exactly sanitizeArm() of
      // each raw arm (allowing key order differences).
      const parsedResults = tryJson(contents["results.json"]).value;
      const serializedExpected = serializeJson(
        computePublicBundle(raw).results,
      );
      const serializedActual = serializeJson(parsedResults);
      if (serializedActual === serializedExpected) {
        pass(
          "published-projection",
          "results.json is the exact allowlist projection",
        );
      } else {
        fail("published-projection", "results.json arms diverge from raw arms");
      }
      // Exact scoring evidence: score/flag consistency + changed-file
      // digests must reconcile with the recorded expected trees.
      const scoringIssues = scoreEvidenceIssues(parsedResults, publicFiles);
      if (scoringIssues.length === 0) {
        pass(
          "published-scoring",
          "treeMatch/score consistent with tree diffs + expected trees",
        );
      } else {
        fail("published-scoring", scoringIssues.join("; "));
      }
    }
  } else {
    pass("published", `no bundle at ${bundleDir} (run not published)`);
  }

  const allOk = checks.every((check) => check.ok);
  io.log("");
  io.log(`Verify ${runDir}`);
  for (const check of checks)
    io.log(
      `  ${check.ok ? "PASS" : "FAIL"}  ${check.name}${check.ok ? "" : ` — ${check.detail}`}`,
    );
  io.log(allOk ? "VERIFY OK" : "VERIFY FAILED");
  return { ok: allOk, checks };
}

/** The manifest record embedded in raw.json (all keys except arms). */
function pickManifestRecord(raw) {
  const record = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key !== "arms") record[key] = value;
  }
  return record;
}

/** Cross-check published scoring evidence against the recorded facts. */
function scoreEvidenceIssues(results, publicFiles) {
  const issues = [];
  const manifest = tryJson(publicFiles["manifest.json"]).value;
  const expectedTrees = manifest?.fixtures ?? {};
  for (const arm of results?.arms ?? []) {
    const diff = arm.treeDiff ?? {};
    const changed = diff.changed ?? [];
    const missing = diff.missing ?? [];
    const extra = diff.extra ?? [];
    const hasDiff =
      changed.length > 0 || missing.length > 0 || extra.length > 0;
    if (arm.treeMatch && hasDiff) {
      issues.push(
        `${arm.arm}/${arm.fixture}/trial${arm.trial}: treeMatch=true but tree diff is non-empty`,
      );
    }
    if (!arm.treeMatch && !hasDiff) {
      issues.push(
        `${arm.arm}/${arm.fixture}/trial${arm.trial}: treeMatch=false with empty diff`,
      );
    }
    if (arm.score !== (arm.treeMatch ? 1 : 0)) {
      issues.push(
        `${arm.arm}/${arm.fixture}/trial${arm.trial}: score=${arm.score} inconsistent with treeMatch`,
      );
    }
    const expectedTree = expectedTrees[arm.fixture]?.expectedTree;
    if (expectedTree) {
      for (const entry of changed) {
        const facts = expectedTree.files?.[entry.path];
        if (!facts) {
          issues.push(
            `${arm.arm}/${arm.fixture}: changed path "${entry.path}" missing from expected tree`,
          );
          continue;
        }
        if (entry.expectedSha256 !== facts.sha256) {
          issues.push(
            `${arm.arm}/${arm.fixture}: expected sha for "${entry.path}" differs from manifest`,
          );
        }
        if (entry.expectedBytes !== facts.bytes) {
          issues.push(
            `${arm.arm}/${arm.fixture}: expected bytes for "${entry.path}" differ from manifest`,
          );
        }
      }
    }
  }
  return issues;
}

/** Split at the first slash because provider model ids may contain slashes. */
export function requestedIdentity(modelId) {
  const id = String(modelId);
  const separator = id.indexOf("/");
  return separator === -1
    ? { provider: null, model: id }
    : { provider: id.slice(0, separator), model: id.slice(separator + 1) };
}
