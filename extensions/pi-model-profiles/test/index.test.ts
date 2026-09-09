import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  formatProfileCandidate,
  formatProfileGuidance,
  loadModelProfiles,
  parseModelProfiles,
  resolveProfilesPath,
  selectProfileCandidates,
} from "../src/index.ts";

const VALID_CONFIG = {
  version: 1,
  profiles: {
    quick: {
      description: "Fast work",
      candidates: [{ model: "prov/fast", thinkingLevel: "low" }],
    },
    thinker: {
      description: "Deep work",
      candidates: [
        { model: "prov/big", thinkingLevel: "max" },
        { model: "other/fallback" },
      ],
    },
  },
};

describe("parseModelProfiles", () => {
  it("accepts a valid config and normalizes models", () => {
    const config = parseModelProfiles({
      version: 1,
      profiles: {
        quick: {
          description: "  Fast work  ",
          candidates: [{ model: " prov/fast ", thinkingLevel: "low" }],
        },
      },
    });
    expect(config.version).toBe(1);
    expect(config.profiles.quick).toEqual({
      description: "Fast work",
      candidates: [{ model: "prov/fast", thinkingLevel: "low" }],
    });
  });

  it("rejects invalid version, names, descriptions, and candidates", () => {
    expect(() => parseModelProfiles({ ...VALID_CONFIG, version: 2 })).toThrow(
      '"version" must be 1',
    );
    expect(() => parseModelProfiles({ version: 1, profiles: {} })).toThrow(
      "non-empty",
    );
    expect(() =>
      parseModelProfiles({
        version: 1,
        profiles: {
          "Bad Name": { description: "x", candidates: [{ model: "a/b" }] },
        },
      }),
    ).toThrow("kebab-case");
    expect(() =>
      parseModelProfiles({
        version: 1,
        profiles: {
          quick: { description: " ", candidates: [{ model: "a/b" }] },
        },
      }),
    ).toThrow("non-empty description");
    expect(() =>
      parseModelProfiles({
        version: 1,
        profiles: { quick: { description: "x", candidates: [] } },
      }),
    ).toThrow("at least one candidate");
    expect(() =>
      parseModelProfiles({
        version: 1,
        profiles: {
          quick: { description: "x", candidates: [{ model: "nofamily" }] },
        },
      }),
    ).toThrow("canonical provider/model");
  });

  it("rejects duplicate candidates and unsupported thinking levels", () => {
    expect(() =>
      parseModelProfiles({
        version: 1,
        profiles: {
          quick: {
            description: "x",
            candidates: [{ model: "a/b" }, { model: "a/b" }],
          },
        },
      }),
    ).toThrow('repeats model "a/b"');
    expect(() =>
      parseModelProfiles({
        version: 1,
        profiles: {
          quick: {
            description: "x",
            candidates: [{ model: "a/b", thinkingLevel: "ultra" }],
          },
        },
      }),
    ).toThrow('unsupported thinking level "ultra"');
  });
});

describe("loadModelProfiles and resolveProfilesPath", () => {
  it("loads a YAML file from disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-model-profiles-"));
    const file = join(dir, "profiles.yaml");
    writeFileSync(file, JSON.stringify(VALID_CONFIG));
    const config = loadModelProfiles(file);
    expect(Object.keys(config.profiles)).toEqual(["quick", "thinker"]);
  });

  it("throws a readable error for invalid YAML", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-model-profiles-"));
    const file = join(dir, "profiles.yaml");
    writeFileSync(file, "version: [unclosed");
    expect(() => loadModelProfiles(file)).toThrow(/Invalid YAML/);
  });

  it("throws when the file is missing and when the agent dir has no profiles.yaml", () => {
    expect(() =>
      loadModelProfiles(join(tmpdir(), "missing-profiles.yaml")),
    ).toThrow(/Failed to read/);
    expect(() =>
      resolveProfilesPath(mkdtempSync(join(tmpdir(), "pi-model-profiles-"))),
    ).toThrow(/Model profiles not found/);
  });

  it("resolves profiles.yaml under the given agent dir", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-model-profiles-"));
    writeFileSync(join(dir, "profiles.yaml"), JSON.stringify(VALID_CONFIG));
    expect(resolveProfilesPath(dir)).toBe(join(dir, "profiles.yaml"));
  });
});

describe("formatting and selection", () => {
  const config = parseModelProfiles(VALID_CONFIG);

  it("formats candidates with and without thinking levels", () => {
    expect(
      formatProfileCandidate({ model: "a/b", thinkingLevel: "high" }),
    ).toBe("a/b:high");
    expect(formatProfileCandidate({ model: "a/b" })).toBe("a/b");
  });

  it("formats name-and-description guidance", () => {
    expect(formatProfileGuidance(config)).toBe(
      "quick: Fast work; thinker: Deep work",
    );
  });

  it("splits candidates by availability, preserving order", () => {
    const { available, unavailable } = selectProfileCandidates(
      config.profiles.thinker!,
      (model) => model === "other/fallback",
    );
    expect(available).toEqual([{ model: "other/fallback" }]);
    expect(unavailable).toEqual([{ model: "prov/big", thinkingLevel: "max" }]);
  });
});
