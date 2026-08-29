import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { loadBetterReadEditSettings } from "../src/settings.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function createRoots(): Promise<{ agentDir: string; cwd: string }> {
  const root = await mkdtemp(join(tmpdir(), "pi-better-read-edit-settings-"));
  roots.push(root);
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await mkdir(agentDir, { recursive: true });
  return { agentDir, cwd };
}

function context(cwd: string, trusted: boolean) {
  return { cwd, isProjectTrusted: () => trusted };
}

describe("betterReadEdit settings", () => {
  test("defaults to an empty avoidlist", async () => {
    const { agentDir, cwd } = await createRoots();
    expect(loadBetterReadEditSettings(context(cwd, false), agentDir)).toEqual({
      settings: { avoidModels: [] },
      sources: [],
      warnings: [],
    });
  });

  test("loads the global block and lets a trusted project replace it", async () => {
    const { agentDir, cwd } = await createRoots();
    const globalPath = join(agentDir, "settings.json");
    const projectPath = join(cwd, ".pi", "settings.json");
    await writeFile(
      globalPath,
      JSON.stringify({
        theme: "dark",
        betterReadEdit: {
          avoidModels: [" openai/gpt-4o* ", "google/gemini-*"],
        },
      }),
    );
    await writeFile(
      projectPath,
      JSON.stringify({ betterReadEdit: { avoidModels: ["anthropic/*"] } }),
    );

    expect(
      loadBetterReadEditSettings(context(cwd, false), agentDir),
    ).toMatchObject({
      settings: { avoidModels: ["openai/gpt-4o*", "google/gemini-*"] },
      sources: [globalPath],
      warnings: [],
    });
    expect(
      loadBetterReadEditSettings(context(cwd, true), agentDir),
    ).toMatchObject({
      settings: { avoidModels: ["anthropic/*"] },
      sources: [globalPath, projectPath],
      warnings: [],
    });
  });

  test("ignores malformed overrides without discarding a valid lower scope", async () => {
    const { agentDir, cwd } = await createRoots();
    await writeFile(
      join(agentDir, "settings.json"),
      JSON.stringify({ betterReadEdit: { avoidModels: ["openai/*"] } }),
    );
    await writeFile(
      join(cwd, ".pi", "settings.json"),
      JSON.stringify({ betterReadEdit: { avoidModels: ["", 42] } }),
    );

    const loaded = loadBetterReadEditSettings(context(cwd, true), agentDir);
    expect(loaded.settings.avoidModels).toEqual(["openai/*"]);
    expect(loaded.sources).toEqual([join(agentDir, "settings.json")]);
    expect(loaded.warnings).toEqual([
      expect.stringContaining(
        "betterReadEdit.avoidModels: expected an array of non-empty strings",
      ),
    ]);
  });
});
