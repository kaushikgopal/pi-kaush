// @ts-nocheck
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import path from "node:path";

const runPiSmoke = process.env.PI_OPENAI_COMPACTION_PI_SMOKE === "1";

describe("pi smoke", () => {
  test.skipIf(!runPiSmoke)(
    "loads from the local package path",
    () => {
      const packageDir = path.resolve(import.meta.dir, "..");
      const pi = path.join(packageDir, "node_modules", ".bin", "pi");
      const result = spawnSync(
        pi,
        [
          "--no-session",
          "--offline",
          "--no-extensions",
          "--no-skills",
          "--no-prompt-templates",
          "-e",
          packageDir,
          "-p",
          "Reply with the single word OK.",
        ],
        { encoding: "utf8" },
      );

      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe("OK");
    },
    30000,
  );
});
