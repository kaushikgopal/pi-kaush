import { afterEach, beforeEach, expect, test, vi } from "vitest";

const execFileSync = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFileSync }));

const files = [
  "CHANGELOG.md",
  "LICENSE",
  "README.md",
  "package.json",
  "src/container-hooks.ts",
  "src/index.ts",
  "src/intercom-message.ts",
  "src/render.ts",
];

beforeEach(() => {
  vi.resetModules();
  execFileSync.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function mockPack(paths) {
  execFileSync.mockReturnValue(
    JSON.stringify([
      {
        filename: "package.tgz",
        size: 100,
        files: paths.map((path) => ({ path })),
      },
    ]),
  );
}

test("accepts a package containing the intercom renderer", async () => {
  mockPack(files);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});

  await import("../scripts/check-package.mjs");

  expect(log).toHaveBeenCalledWith(
    "Verified package.tgz: 8 reviewed files, 100 bytes packed.",
  );
});

test("rejects a package missing the intercom renderer", async () => {
  mockPack(files.filter((path) => path !== "src/intercom-message.ts"));
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const exit = vi.spyOn(process, "exit").mockImplementation(() => {
    throw new Error("package check failed");
  });

  await expect(import("../scripts/check-package.mjs")).rejects.toThrow(
    "package check failed",
  );
  expect(error).toHaveBeenCalledWith("Missing: src/intercom-message.ts");
  expect(exit).toHaveBeenCalledWith(1);
});
