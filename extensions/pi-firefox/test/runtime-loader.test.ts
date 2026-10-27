import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";
import { FIREFOX_TOOLS } from "@pi-kaush/firefox-agent-core";

test("Pi loads Firefox and pi-browser together without connecting to a browser", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-firefox-loader-"));
  try {
    const result = await discoverAndLoadExtensions(
      [
        fileURLToPath(new URL("../src/index.ts", import.meta.url)),
        fileURLToPath(
          new URL("../../pi-browser/src/index.ts", import.meta.url),
        ),
      ],
      directory,
      directory,
    );

    expect(result.errors).toEqual([]);
    expect(result.extensions).toHaveLength(2);
    const tools = result.extensions.flatMap((extension) => [
      ...extension.tools.keys(),
    ]);
    const commands = result.extensions.flatMap((extension) => [
      ...extension.commands.keys(),
    ]);

    for (const descriptor of FIREFOX_TOOLS) {
      expect(tools.filter((name) => name === descriptor.name)).toHaveLength(1);
    }
    expect(commands).toContain("firefox-status");
    expect(commands).toContain("firefox-session");
    expect(commands).toContain("firefox-container");
    expect(tools).toContain("browser_snapshot");
    expect(commands).toContain("browser-status");
    expect(new Set(tools).size).toBe(tools.length);
    expect(new Set(commands).size).toBe(commands.length);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
