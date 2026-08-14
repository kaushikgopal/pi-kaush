import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  readDefaultName,
  readLastUsed,
  resolveActive,
  writeDefaultName,
  writeLastUsed,
} from "../src/state.ts";

const NAMES = ["terse", "verbose"];

describe("resolveActive", () => {
  it("returns off when nothing is set", () => {
    expect(
      resolveActive({
        pick: undefined,
        defaultName: undefined,
        lastUsed: undefined,
        styleNames: NAMES,
      }),
    ).toEqual({ active: null });
  });

  it("prefers session pick over default over last-used", () => {
    const base = {
      defaultName: "verbose",
      lastUsed: "verbose",
      styleNames: NAMES,
    };
    expect(resolveActive({ ...base, pick: { name: "terse" } }).active).toBe(
      "terse",
    );
    expect(resolveActive({ ...base, pick: undefined }).active).toBe("verbose");
    expect(
      resolveActive({
        pick: undefined,
        defaultName: undefined,
        lastUsed: "terse",
        styleNames: NAMES,
      }).active,
    ).toBe("terse");
  });

  it("treats an explicit off pick as a cascade stop, even with a default configured", () => {
    const result = resolveActive({
      pick: { name: null },
      defaultName: "terse",
      lastUsed: "terse",
      styleNames: NAMES,
    });
    expect(result.active).toBeNull();
    expect(result.warning).toBeUndefined();
  });

  it("falls through with a warning when the picked style was deleted", () => {
    const result = resolveActive({
      pick: { name: "gone" },
      defaultName: "terse",
      lastUsed: undefined,
      styleNames: NAMES,
    });
    expect(result.active).toBe("terse");
    expect(result.warning).toMatch(/gone/);
  });

  it("falls through past a stale default to last-used", () => {
    const result = resolveActive({
      pick: undefined,
      defaultName: "gone",
      lastUsed: "verbose",
      styleNames: NAMES,
    });
    expect(result.active).toBe("verbose");
    expect(result.warning).toMatch(/gone/);
  });

  it("resolves off with a warning when only a stale last-used remains", () => {
    const result = resolveActive({
      pick: undefined,
      defaultName: undefined,
      lastUsed: "gone",
      styleNames: NAMES,
    });
    expect(result.active).toBeNull();
    expect(result.warning).toMatch(/gone/);
  });
});

describe("persistence", () => {
  it("round-trips default and last-used, preserving other keys", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-response-style-"));
    const stateFile = join(dir, "state.json");

    writeDefaultName(dir, "terse");
    expect(readDefaultName(dir)).toBe("terse");

    writeLastUsed(stateFile, "verbose");
    expect(readLastUsed(stateFile)).toBe("verbose");

    writeDefaultName(dir, "verbose");
    expect(readDefaultName(dir)).toBe("verbose");
  });

  it("reads missing or corrupt files as unset", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-response-style-"));
    expect(readDefaultName(dir)).toBeUndefined();
    expect(readLastUsed(join(dir, "missing.json"))).toBeUndefined();

    writeFileSync(join(dir, "config.json"), "not json");
    expect(readDefaultName(dir)).toBeUndefined();
  });
});
