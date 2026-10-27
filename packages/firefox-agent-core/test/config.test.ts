import { afterEach, expect, test } from "vitest";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
  lstat,
  symlink,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadFirefoxConfig } from "../src/config.js";
import { createFirefoxLogger } from "../src/diagnostics.js";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "firefox-config-"));
  roots.push(root);
  const user = join(root, ".config", "firefox-agent");
  await mkdir(user, { recursive: true });
  return { root, user, options: { cwd: root, home: root, env: {} } };
}
test("config defaults are harness-neutral and loading creates no state", async () => {
  const { root, options } = await setup();
  const result = await loadFirefoxConfig(options);
  expect(result).toMatchObject({
    ok: true,
    config: {
      binaryPath: "firefox-cli",
      logLevel: "off",
      agentId: null,
      summaryMaxBytes: 4000,
    },
  });
  if (result.ok)
    expect(result.config.statePath).toBe(
      join(root, ".cache/firefox-agent/sessions.json"),
    );
  await expect(lstat(join(root, ".cache"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});
test("trusted config, safe project limits and environment have explicit precedence", async () => {
  const { root, user, options } = await setup();
  await writeFile(
    join(user, "config.json"),
    JSON.stringify({
      binaryPath: "/trusted/firefox-cli",
      summaryMaxBytes: 3000,
      agentId: "personal",
    }),
  );
  await writeFile(
    join(root, ".pi-firefox.json"),
    JSON.stringify({ summaryMaxBytes: 2000 }),
  );
  expect(
    await loadFirefoxConfig({ ...options, env: { FFX_MAX_BYTES: "1000" } }),
  ).toMatchObject({
    ok: true,
    config: {
      summaryMaxBytes: 1000,
      binaryPath: "/trusted/firefox-cli",
      agentId: "personal",
    },
  });
});
test("project config cannot redirect executables, identities, state or container labels", async () => {
  const { root, options } = await setup();
  for (const config of [
    { binaryPath: "/untrusted/run" },
    { statePath: "/untrusted/state" },
    { agentId: "someone-else" },
    { containerNames: { "firefox-default": "Work" } },
  ]) {
    await writeFile(join(root, ".pi-firefox.json"), JSON.stringify(config));
    expect(await loadFirefoxConfig(options)).toMatchObject({
      ok: false,
      code: "project_config_unsafe",
    });
  }
});
test("malformed config and invalid limits fail without reflecting raw settings", async () => {
  const { user, options } = await setup();
  await writeFile(join(user, "config.json"), '{"token":"synthetic-secret",');
  const invalid = await loadFirefoxConfig(options);
  expect(invalid).toMatchObject({ ok: false, code: "config_invalid" });
  expect(JSON.stringify(invalid)).not.toContain("synthetic-secret");
  await writeFile(join(user, "config.json"), "{}");
  expect(
    await loadFirefoxConfig({ ...options, env: { FFX_MAX_BYTES: "2" } }),
  ).toMatchObject({ ok: false, code: "config_invalid" });
});
test("config rejects symlinks and explicit missing config", async () => {
  const { root, user, options } = await setup();
  await writeFile(join(root, "target"), "{}");
  await symlink(join(root, "target"), join(user, "config.json"));
  expect(await loadFirefoxConfig(options)).toMatchObject({
    ok: false,
    code: "config_invalid",
  });
  expect(
    await loadFirefoxConfig({
      ...options,
      env: { FFX_CONFIG: "missing.json" },
    }),
  ).toMatchObject({ ok: false, code: "config_read_failed" });
});
test("diagnostics are off by default and project content cannot enter logs", async () => {
  const { root } = await setup();
  const path = join(root, "events.jsonl");
  await createFirefoxLogger({ path, level: "off" })({
    event: "tool",
    operation: "read",
  });
  await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
  const event = {
    event: "tool" as const,
    operation: "read",
    domain: "https://user:password@example.test/path?token=secret#fragment",
    body: "synthetic-private-body",
  };
  expect(await createFirefoxLogger({ path, level: "debug" })(event)).toBe(true);
  const data = await readFile(path, "utf8");
  expect(JSON.parse(data)).toMatchObject({
    domain: "example.test",
    operation: "read",
  });
  expect(data).not.toMatch(/password|token|fragment|private-body|\/path/);
  expect((await lstat(path)).mode & 0o077).toBe(0);
});
test("diagnostics reject symlinks and cannot break a browser result", async () => {
  const { root } = await setup();
  const target = join(root, "target");
  await writeFile(target, "untouched");
  const path = join(root, "log-link");
  await symlink(target, path);
  expect(
    await createFirefoxLogger({ path, level: "debug" })({
      event: "error",
      code: "timeout",
    }),
  ).toBe(false);
  expect(await readFile(target, "utf8")).toBe("untouched");
});
