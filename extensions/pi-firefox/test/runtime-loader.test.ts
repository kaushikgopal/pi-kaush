import { spawnSync } from "node:child_process";
import { copyFile, cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  discoverAndLoadExtensions,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { expect, test, vi } from "vitest";
import { FIREFOX_TOOLS } from "@pi-kaush/firefox-agent-core";

test("the Firefox core entry resolves for require-style extension loaders", () => {
  const require = createRequire(import.meta.url);
  expect(require.resolve("@pi-kaush/firefox-agent-core")).toBe(
    fileURLToPath(
      new URL(
        "../../../packages/firefox-agent-core/dist/index.js",
        import.meta.url,
      ),
    ),
  );
});

test.each(["missing dependency", "missing build"])(
  "Pi starts with an actionable warning for a %s",
  async (failure) => {
    const directory = await mkdtemp(join(tmpdir(), "pi-firefox-missing-"));
    try {
      const source = join(directory, "extensions", "pi-firefox", "src");
      await mkdir(source, { recursive: true });
      await Promise.all(
        ["index.ts", "register.ts"].map((file) =>
          copyFile(
            fileURLToPath(new URL("../src/" + file, import.meta.url)),
            join(source, file),
          ),
        ),
      );
      const core = join(
        directory,
        "node_modules",
        "@pi-kaush",
        "firefox-agent-core",
      );
      if (failure === "missing build") {
        await mkdir(core, { recursive: true });
        await writeFile(
          join(core, "package.json"),
          JSON.stringify({
            name: "@pi-kaush/firefox-agent-core",
            exports: { ".": { default: "./dist/index.js" } },
          }),
        );
      }
      const result = await discoverAndLoadExtensions(
        [
          join(source, "index.ts"),
          fileURLToPath(
            new URL("../../pi-browser/src/index.ts", import.meta.url),
          ),
        ],
        directory,
        directory,
      );

      expect(result.errors).toEqual([]);
      expect(result.extensions).toHaveLength(2);
      const firefox = result.extensions[0]!;
      expect(firefox.tools.size).toBe(0);
      expect(result.extensions[1]!.tools.has("browser_snapshot")).toBe(true);
      const notify = vi.fn();
      const handler = firefox.handlers.get("session_start")?.[0];
      expect(handler).toBeDefined();
      await handler!({ type: "session_start", reason: "startup" }, {
        hasUI: true,
        ui: { notify },
      } as unknown as ExtensionContext);
      expect(notify).toHaveBeenCalledOnce();
      expect(notify).toHaveBeenCalledWith(
        expect.stringContaining("npm install"),
        "warning",
      );
      expect(notify).toHaveBeenCalledWith(
        expect.stringContaining(
          "npm run build --workspace @pi-kaush/firefox-agent-core",
        ),
        "warning",
      );
      expect(notify).toHaveBeenCalledWith(
        expect.stringContaining("/reload"),
        "warning",
      );

      if (failure === "missing build") {
        const agent = join(directory, "agent");
        await mkdir(agent);
        const cli = fileURLToPath(
          new URL(
            "../../../node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
            import.meta.url,
          ),
        );
        const provider = fileURLToPath(
          new URL(
            "../../pi-simple-subagents/test/fixtures/managed-smoke-provider.ts",
            import.meta.url,
          ),
        );
        const processResult = spawnSync(
          process.execPath,
          [
            cli,
            "--offline",
            "--no-extensions",
            "--no-skills",
            "--no-context-files",
            "--no-prompt-templates",
            "--no-session",
            "--mode",
            "rpc",
            "--model",
            "managed-smoke/offline",
            "-e",
            provider,
            "-e",
            join(source, "index.ts"),
          ],
          {
            cwd: directory,
            env: {
              ...process.env,
              PI_CODING_AGENT_DIR: agent,
              PI_OFFLINE: "1",
            },
            input: JSON.stringify({ id: "1", type: "get_state" }) + "\n",
            encoding: "utf8",
            timeout: 15_000,
          },
        );
        expect(processResult.status, processResult.stderr).toBe(0);
        const messages = processResult.stdout
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(messages).toContainEqual(
          expect.objectContaining({
            type: "extension_ui_request",
            method: "notify",
            notifyType: "warning",
            message: expect.stringContaining(
              "npm run build --workspace @pi-kaush/firefox-agent-core",
            ),
          }),
        );
        expect(messages).toContainEqual(
          expect.objectContaining({
            type: "response",
            id: "1",
            command: "get_state",
            success: true,
          }),
        );
      }

      const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        await handler!({ type: "session_start", reason: "startup" }, {
          hasUI: false,
        } as ExtensionContext);
        expect(stderr).toHaveBeenCalledWith(
          expect.stringContaining("npm install"),
        );
      } finally {
        stderr.mockRestore();
      }

      await mkdir(core, { recursive: true });
      await writeFile(
        join(core, "package.json"),
        JSON.stringify({
          name: "@pi-kaush/firefox-agent-core",
          type: "module",
          exports: { ".": { default: "./dist/index.js" } },
        }),
      );
      await cp(
        fileURLToPath(
          new URL("../../../packages/firefox-agent-core/dist", import.meta.url),
        ),
        join(core, "dist"),
        { recursive: true },
      );
      const reloaded = await discoverAndLoadExtensions(
        [join(source, "index.ts")],
        directory,
        directory,
      );
      expect(reloaded.errors).toEqual([]);
      expect(reloaded.extensions[0]!.tools.has("ff_status")).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

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
