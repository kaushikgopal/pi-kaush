// npm-package smoke: pack the extension tarball and verify (a) the exact
// runtime file set is shipped (bench runtime + fixtures + docs + Makefile,
// no tests/runs), and (b) the packaged CLI at least prints help and its
// dry-run plans correctly from an installed copy. No model calls.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { extensionRoot } from "../util.mjs";

const rootsToRemove = [];

afterEach(async () => {
  await Promise.all(
    rootsToRemove
      .splice(0)
      .map((path) =>
        rm(path, { recursive: true, force: true }).catch(() => {}),
      ),
  );
});

function haveNpm() {
  try {
    execFileSync("npm", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Pack the extension and extract it; returns the extracted package dir. */
async function packAndExtract() {
  const work = await mkdtemp(join(tmpdir(), "bench-pack-"));
  rootsToRemove.push(work);
  const result = execFileSync("npm", ["pack", "--json", "--ignore-scripts"], {
    cwd: extensionRoot(),
    encoding: "utf8",
  });
  const [pack] = JSON.parse(result);
  const tarball = join(extensionRoot(), pack.filename);
  rootsToRemove.push(tarball);
  const extract = join(work, "extract");
  await mkdir(extract, { recursive: true });
  execFileSync("tar", ["-xzf", tarball, "-C", extract]);
  const packageDir = join(extract, "package");
  return { packageDir, filename: pack.filename, size: pack.size };
}

const RUNTIME_BENCH = [
  "bench/cli.mjs",
  "bench/config.mjs",
  "bench/fixtures.mjs",
  "bench/isolation.mjs",
  "bench/journal.mjs",
  "bench/models.mjs",
  "bench/orchestrator.mjs",
  "bench/protocol.mjs",
  "bench/publish.mjs",
  "bench/report.mjs",
  "bench/runner.mjs",
  "bench/scheduler.mjs",
  "bench/scoring.mjs",
  "bench/util.mjs",
  "bench/verify.mjs",
  "bench/workspace.mjs",
  "bench/README.md",
  "bench/published/README.md",
  "bench/fixtures/two-splices.json",
  "bench/fixtures/repeated-context.json",
  "bench/fixtures/two-files.json",
  "bench/fixtures/large-delete.json",
  "Makefile",
];

describe("npm package packing", () => {
  test.skipIf(!haveNpm())(
    "tarball ships bench runtime but never tests/runs",
    async () => {
      const { packageDir } = await packAndExtract();
      const files = walk(packageDir);
      for (const name of RUNTIME_BENCH) {
        expect(files).toContain(name);
      }
      expect(files.some((name) => name.startsWith("bench/tests/"))).toBe(false);
      expect(files.some((name) => name.startsWith("bench/runs/"))).toBe(false);
      expect(files.some((name) => name.startsWith("bench/published/run"))).toBe(
        false,
      );
      expect(existsSync(join(packageDir, "src", "index.ts"))).toBe(true);
    },
  );

  test.skipIf(!haveNpm())(
    "packaged CLI prints help and dry-runs cleanly",
    async () => {
      const { packageDir } = await packAndExtract();

      const help = spawnSync("node", ["bench/cli.mjs", "--help"], {
        cwd: packageDir,
        encoding: "utf8",
      });
      expect(help.status).toBe(0);
      expect(help.stdout).toContain("pi-better-read-edit bench");

      const agentDir = join(packageDir, "..", "fake-agent");
      await mkdir(agentDir, { recursive: true });
      for (const name of ["auth.json", "models.json", "models-store.json"]) {
        await writeFile(join(agentDir, name), "{}");
      }
      const work = join(packageDir, "..", "work");
      const dry = spawnSync(
        "node",
        [
          "bench/cli.mjs",
          "--dry-run",
          "--model",
          "fake/model:off",
          "--fixture",
          "two-splices",
          "--run-id",
          "smoke",
          "--agent-dir",
          agentDir,
          "--runs-dir",
          join(work, "runs"),
          "--published-dir",
          join(work, "published"),
        ],
        { cwd: packageDir, encoding: "utf8" },
      );
      expect(dry.status).toBe(0, dry.stderr);
      expect(dry.stdout).toContain("DRY RUN");
      expect(dry.stdout).toContain("--mode json");
      expect(dry.stdout).toContain("(0600)");
    },
  );
});

function walk(root) {
  const files = [];
  const stack = [""];
  while (stack.length > 0) {
    const current = stack.pop();
    const here = join(root, current);
    for (const entry of readdirSync(here, { withFileTypes: true })) {
      const rel = current === "" ? entry.name : `${current}/${entry.name}`;
      if (entry.isDirectory()) stack.push(rel);
      else files.push(rel);
    }
  }
  return files;
}
