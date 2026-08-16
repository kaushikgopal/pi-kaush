import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  EXPECT_SCRIPT,
  extensionName,
  isWelcomeScreenPath,
  median,
  parseStartupTiming,
  renderBenchmarkReport,
} from "./startup-benchmark";

const HAS_EXPECT =
  spawnSync("expect", ["-v"], { stdio: "ignore" }).status === 0;

describe("Pi startup benchmark parsing", () => {
  test("parses main totals and extension import timings from PTY output", () => {
    const timing = parseStartupTiming(`\x1b[2Jwelcome\r
--- Startup Timings: main ---\r
  parseArgs: 3ms\r
  interactiveMode.init: 5361ms\r
  TOTAL: 6687ms\r
-----------------------------\r
\r
--- Startup Timings: extensions ---\r
  /tmp/extensions/welcome-screen.ts module import: 3ms\r
  /tmp/extensions/welcome-screen.ts factory: 1ms\r
  /tmp/node_modules/@ff-labs/pi-fff/src/index.ts module import: 44ms\r
  /tmp/node_modules/@ff-labs/pi-fff/src/index.ts factory: 2ms\r
  TOTAL: 50ms\r
-----------------------------------\r
`);

    expect(timing.totalMs).toBe(6687);
    expect(timing.extensions.get("/tmp/extensions/welcome-screen.ts")).toEqual({
      path: "/tmp/extensions/welcome-screen.ts",
      importMs: 3,
      factoryMs: 1,
    });
    expect(
      timing.extensions.get("/tmp/node_modules/@ff-labs/pi-fff/src/index.ts")
        ?.importMs,
    ).toBe(44);
  });

  test("calculates medians for odd and even samples", () => {
    expect(median([8, 2, 4])).toBe(4);
    expect(median([8, 2, 4, 6])).toBe(5);
  });

  test("normalizes local and package extension names", () => {
    expect(extensionName("/tmp/extensions/subagent/index.ts")).toBe(
      "subagent/index",
    );
    expect(
      extensionName("/tmp/extensions/pi-welcome-screen/src/index.ts"),
    ).toBe("pi-welcome-screen");
    expect(
      extensionName("/tmp/node_modules/@ff-labs/pi-fff/src/index.ts"),
    ).toBe("@ff-labs/pi-fff");
    expect(extensionName("/tmp/node_modules/pi-web-access/index.ts")).toBe(
      "pi-web-access",
    );
  });

  test("recognizes local, migrated, and packaged welcome-screen paths", () => {
    expect(isWelcomeScreenPath("/tmp/extensions/welcome-screen.ts")).toBe(true);
    expect(
      isWelcomeScreenPath("/tmp/extensions/pi-welcome-screen/src/index.ts"),
    ).toBe(true);
    expect(
      isWelcomeScreenPath(
        "/tmp/node_modules/@pi-kaush/pi-welcome-screen/src/index.ts",
      ),
    ).toBe(true);
    expect(isWelcomeScreenPath("/tmp/extensions/custom-footer.ts")).toBe(false);
  });
});

describe("Pi startup benchmark process control", () => {
  test.skipIf(!HAS_EXPECT)(
    "finishes after Pi prints timings even when background handles remain open",
    () => {
      const directory = mkdtempSync(join(tmpdir(), "pi-startup-benchmark-"));
      const fakePi = join(directory, "pi");
      writeFileSync(
        fakePi,
        `#!/usr/bin/env node
console.log(\`--- Startup Timings: main ---
  TOTAL: 10ms
-----------------------------

--- Startup Timings: extensions ---
  TOTAL: 5ms
-----------------------------------\`);
setInterval(() => {}, 1_000);
`,
      );
      chmodSync(fakePi, 0o755);

      try {
        const result = spawnSync("expect", ["-c", EXPECT_SCRIPT], {
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${directory}${delimiter}${process.env.PATH ?? ""}`,
            PI_BENCH_TIMEOUT_SECONDS: "5",
            PI_BENCH_NO_EXTENSIONS: "0",
            PI_BENCH_EXTENSION: "",
          },
          timeout: 2_000,
        });

        expect(result.error).toBeUndefined();
        expect(result.status).toBe(0);
        expect(result.stdout).toContain("Startup Timings: extensions");
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
});

describe("Pi startup benchmark reporting", () => {
  test("shows startup baselines, welcome import, and extension shares", () => {
    const report = renderBenchmarkReport([
      {
        label: "Current",
        cwd: "/tmp/project",
        runs: 3,
        fullMs: 1000,
        noExtensionsMs: 100,
        welcomeImportMs: 3,
        extensions: [
          {
            name: "@ff-labs/pi-fff",
            path: "/tmp/node_modules/@ff-labs/pi-fff/src/index.ts",
            importMs: 44,
            isolatedTotalMs: 600,
            overheadMs: 500,
          },
        ],
      },
    ]);

    expect(report).toContain("3-run median · offline");
    expect(report).toContain("Full startup");
    expect(report).toContain("100ms /    1.00s ( 10.0%)");
    expect(report).toContain("Welcome import");
    expect(report).toContain("3ms /    1.00s (  0.3%)");
    expect(report).toContain("@ff-labs/pi-fff");
    expect(report).toContain("500ms /    1.00s ( 50.0%)");
    expect(report).toContain("[isolated 600ms]");
  });
});
