import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createFirefoxStateStore,
  FirefoxStateError,
} from "../src/state-store.js";

const temporaryDirectories: string[] = [];

async function newStatePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "firefox-state-test-"));
  temporaryDirectories.push(directory);
  return join(directory, "state.json");
}

function childProgram(): string {
  return `
    const { createFirefoxStateStore } = await import(process.argv[1]);
    const [statePath, key, label, eventPath, delayMs] = process.argv.slice(2);
    const store = createFirefoxStateStore({ path: statePath, lockTimeoutMs: 10000 });
    await store.withEntry(key, async (entry) => {
      if (eventPath) await (await import("node:fs/promises")).appendFile(eventPath, label + ":start\\n");
      if (label === "hold") {
        console.log("LOCKED");
        await new Promise(() => {});
      }
      await new Promise((resolve) => setTimeout(resolve, Number(delayMs)));
      if (eventPath) await (await import("node:fs/promises")).appendFile(eventPath, label + ":end\\n");
      return { entry: (typeof entry === "number" ? entry : 0) + 1, result: true };
    });
  `;
}

function launch(
  statePath: string,
  key: string,
  label: string,
  eventPath: string,
  delayMs: number,
): ChildProcess {
  const moduleUrl = new URL("../dist/state-store.js", import.meta.url).href;
  return spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      childProgram(),
      moduleUrl,
      statePath,
      key,
      label,
      eventPath,
      String(delayMs),
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
}

function waitForLine(child: ChildProcess, expected: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = "";
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes(expected)) {
        cleanup();
        resolve();
      }
    };
    const onExit = (code: number | null) => {
      cleanup();
      reject(new Error(`Child exited before readiness: ${code}`));
    };
    const cleanup = () => {
      child.stdout?.off("data", onData);
      child.off("exit", onExit);
    };
    child.stdout?.on("data", onData);
    child.on("exit", onExit);
  });
}

function waitForExit(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null) {
      resolve();
      return;
    }
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0 || code === null) resolve();
      else reject(new Error(`Child exited with code ${code}`));
    });
  });
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("private Firefox state store", () => {
  it("serializes operations on one key across child processes", async () => {
    const path = await newStatePath();
    const events = join(path, "..", "events.txt");
    const first = launch(path, "same-session", "first", events, 120);
    const second = launch(path, "same-session", "second", events, 120);
    await Promise.all([waitForExit(first), waitForExit(second)]);

    const lines = (await readFile(events, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatch(/:start$/u);
    expect(lines[1]).toMatch(/:end$/u);
    expect(lines[2]).toMatch(/:start$/u);
    expect(lines[3]).toMatch(/:end$/u);
    expect(await createFirefoxStateStore({ path }).list()).toEqual({
      "same-session": 2,
    });
  });

  it("merges independent keys while their operations overlap", async () => {
    const path = await newStatePath();
    const events = join(path, "..", "events.txt");
    const first = launch(path, "session-a", "a", events, 220);
    const second = launch(path, "session-b", "b", events, 220);
    await Promise.all([waitForExit(first), waitForExit(second)]);

    const lines = (await readFile(events, "utf8")).trim().split("\n");
    const firstEnd = lines.findIndex((line) => line.endsWith(":end"));
    const secondStart = lines.findIndex((line) => line === "b:start");
    const firstStart = lines.findIndex((line) => line === "a:start");
    const otherStart = lines.findIndex(
      (line) => line.endsWith(":start") && line !== "a:start",
    );
    expect(Math.max(firstStart, otherStart)).toBeLessThan(firstEnd);
    expect(secondStart).toBeGreaterThanOrEqual(0);
    expect(await createFirefoxStateStore({ path }).list()).toEqual({
      "session-a": 1,
      "session-b": 1,
    });
  });

  it("aborts a wait for an entry lock without saving an update", async () => {
    const path = await newStatePath();
    const store = createFirefoxStateStore({ path, lockTimeoutMs: 3_000 });
    let releaseOperation!: () => void;
    let markStarted!: () => void;
    const operationStarted = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const blockedOperation = new Promise<void>((resolve) => {
      releaseOperation = resolve;
    });
    const first = store.withEntry("session", async () => {
      markStarted();
      await blockedOperation;
      return { entry: { saved: true }, result: undefined };
    });
    await operationStarted;

    const controller = new AbortController();
    const waiting = store.withEntry(
      "session",
      async () => ({ entry: { shouldNotSave: true }, result: undefined }),
      { signal: controller.signal },
    );
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ code: "aborted" });
    releaseOperation();
    await first;
    expect(await store.list()).toEqual({ session: { saved: true } });
  });

  it("reclaims a lock only after the child owner is dead", async () => {
    const path = await newStatePath();
    const child = launch(path, "interrupted", "hold", "", 0);
    await waitForLine(child, "LOCKED");
    child.kill("SIGKILL");
    await waitForExit(child);

    const store = createFirefoxStateStore({ path, lockTimeoutMs: 3_000 });
    await expect(
      store.withEntry("interrupted", async () => ({
        entry: { recovered: true },
        result: "recovered",
      })),
    ).resolves.toBe("recovered");
    expect(await store.list()).toEqual({ interrupted: { recovered: true } });
  });

  it("does not overwrite malformed state", async () => {
    const path = await newStatePath();
    const malformed = "{not-json";
    await writeFile(path, malformed, { mode: 0o600 });
    const store = createFirefoxStateStore({ path });

    await expect(
      store.withEntry("session", async () => ({ entry: 1, result: true })),
    ).rejects.toMatchObject({ code: "malformed_state" });
    expect(await readFile(path, "utf8")).toBe(malformed);
  });

  it("does not overwrite valid JSON with an unsupported index shape", async () => {
    const path = await newStatePath();
    const malformed = JSON.stringify({ version: 1, entries: {}, legacy: true });
    await writeFile(path, malformed, { mode: 0o600 });
    const store = createFirefoxStateStore({ path });

    await expect(store.list()).rejects.toMatchObject({
      code: "malformed_state",
    });
    expect(await readFile(path, "utf8")).toBe(malformed);
  });

  it("rejects a symlink state file", async () => {
    const path = await newStatePath();
    const target = join(path, "..", "outside.json");
    await writeFile(target, JSON.stringify({ version: 1, entries: {} }), {
      mode: 0o600,
    });
    await symlink(target, path);
    const store = createFirefoxStateStore({ path });

    await expect(store.list()).rejects.toBeInstanceOf(FirefoxStateError);
    await expect(store.list()).rejects.toMatchObject({ code: "unsafe_path" });
    expect(await readFile(target, "utf8")).toContain('"version":1');
  });
});
