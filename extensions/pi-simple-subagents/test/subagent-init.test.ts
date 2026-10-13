import { describe, expect, test } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { initScaffoldFiles } from "../src/_init.ts";
import { parseSubagentCall } from "../src/_subagent-command.ts";

function agentDir(): string {
  return mkdtempSync(path.join(tmpdir(), "pi-subagent-init-"));
}

describe("init scaffold", () => {
  test("creates the starter agent and profiles when missing", () => {
    const dir = agentDir();
    const outcomes = initScaffoldFiles(dir);

    expect(outcomes).toHaveLength(2);
    expect(outcomes[0]!.created).toBe(true);
    expect(outcomes[1]!.created).toBe(true);
    const agent = readFileSync(path.join(dir, "agents", "bee.md"), "utf-8");
    expect(agent).toContain("profile: quick");
    expect(agent).toContain("yield");
    const profiles = readFileSync(path.join(dir, "profiles.yaml"), "utf-8");
    expect(profiles).toContain("version: 1");
    expect(profiles).toContain("quick:");
  });

  test("keeps existing files untouched and reports them", () => {
    const dir = agentDir();
    mkdirSync(path.join(dir, "agents"), { recursive: true });
    const existing = path.join(dir, "agents", "bee.md");
    writeExisting(existing, "---\nemoji: 🐜\n---\n\nCustom.");
    const profiles = path.join(dir, "profiles.yaml");
    writeExisting(profiles, "version: 1\nprofiles: {}\n");

    const outcomes = initScaffoldFiles(dir);

    expect(outcomes.every((outcome) => !outcome.created)).toBe(true);
    expect(readFileSync(existing, "utf-8")).toContain("🐜");
    expect(readFileSync(profiles, "utf-8")).toContain("profiles: {}");
  });

  test("parses the init action with no arguments", () => {
    const parsed = parseSubagentCall({ action: "init" });
    expect(parsed).toEqual({ ok: true, command: { kind: "init" } });
    expect(parseSubagentCall({ action: "init", handle: "mw-x" }).ok).toBe(
      false,
    );
  });
});

function writeExisting(file: string, content: string): void {
  const { writeFileSync } = require("node:fs") as typeof import("node:fs");
  writeFileSync(file, content);
  expect(existsSync(file)).toBe(true);
}
