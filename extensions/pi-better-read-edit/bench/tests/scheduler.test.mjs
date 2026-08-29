// Deterministic counterbalanced scheduling + model matrix resolution.

import { describe, expect, test } from "vitest";
import { planSlots, expandSlotArms } from "../scheduler.mjs";
import {
  parseModelSpec,
  resolveModels,
  globMatch,
  validateModelId,
} from "../models.mjs";

const MODELS = [
  { id: "provider-a/model-1", thinking: "low" },
  { id: "provider-b/model-2", thinking: "off" },
];
const FIXTURES = ["f1", "f2"];

describe("counterbalanced slot planning", () => {
  test("arm order alternates per trial within every cell", () => {
    const slots = planSlots({
      models: MODELS,
      fixtures: FIXTURES,
      trials: 2,
      seed: 7,
    });
    expect(slots).toHaveLength(8); // 2 models × 2 fixtures × 2 trials
    for (const model of MODELS) {
      for (const fixture of FIXTURES) {
        const arms = slots
          .filter(
            (slot) => slot.model.id === model.id && slot.fixture === fixture,
          )
          .sort((a, b) => a.trial - b.trial);
        expect(new Set(arms.map((slot) => slot.armOrder.join(">")))).toEqual(
          new Set(["better>builtin", "builtin>better"]),
        );
      }
    }
    for (const slot of slots) {
      expect(expandSlotArms(slot).map((arm) => arm.arm)).toEqual(slot.armOrder);
    }
  });

  test("single-trial runs counterbalance across adjacent cells", () => {
    // A negative seed disables the shuffle, exposing the raw plan so
    // adjacent-cell alternation is observable.
    const slots = planSlots({
      models: MODELS,
      fixtures: FIXTURES,
      trials: 1,
      seed: -1,
    });
    expect(slots).toHaveLength(4); // 2 models × 2 fixtures × 1 trial
    const orders = slots.map((slot) => slot.armOrder.join(">"));
    // Adjacent cells must counterbalance at one trial.
    for (let index = 1; index < orders.length; index++) {
      expect(orders[index]).not.toBe(orders[index - 1]);
    }
    expect(new Set(orders)).toEqual(
      new Set(["better>builtin", "builtin>better"]),
    );
    // Shuffled plans preserve the counterbalance as a multiset.
    const shuffledOrders = planSlots({
      models: MODELS,
      fixtures: FIXTURES,
      trials: 1,
      seed: 1,
    }).map((slot) => slot.armOrder.join(">"));
    expect(new Set(shuffledOrders)).toEqual(
      new Set(["better>builtin", "builtin>better"]),
    );
  });

  test("same seed is fully deterministic; different seeds shuffle the order", () => {
    const sixModels = Array.from({ length: 6 }, (_, index) => ({
      id: `p${index}/m${index}`,
      thinking: "off",
    }));
    const config = { models: sixModels, fixtures: FIXTURES, trials: 2 };
    const key = (slots) =>
      slots
        .map((slot) => `${slot.model.id}@${slot.fixture}@${slot.trial}`)
        .join("|");
    const a = planSlots({ ...config, seed: 7 });
    const b = planSlots({ ...config, seed: 7 });
    expect(key(a)).toBe(key(b));
    const orders = [15, 16, 17].map((seed) =>
      key(planSlots({ ...config, seed })),
    );
    expect(new Set(orders).size).toBe(3); // seeds produce distinct orders
  });

  test("counterbalance survives shuffling", () => {
    const slots = planSlots({
      models: MODELS,
      fixtures: FIXTURES,
      trials: 3,
      seed: 1234,
    });
    // Within every (model, fixture) cell, trials still alternate.
    for (const model of MODELS) {
      for (const fixture of FIXTURES) {
        const cellSlots = slots
          .filter(
            (slot) => slot.model.id === model.id && slot.fixture === fixture,
          )
          .sort((a, b) => a.trial - b.trial);
        const orders = cellSlots.map((slot) => slot.armOrder.join(">"));
        for (let trial = 1; trial < orders.length; trial++) {
          expect(orders[trial]).not.toBe(orders[trial - 1]);
        }
      }
    }
  });
});

describe("model matrix resolution", () => {
  test("--model entries replace the default matrix", () => {
    const models = resolveModels({
      specs: ["openai/gpt-4o:low", "anthropic/claude:off"],
    });
    expect(models).toEqual([
      { id: "openai/gpt-4o", thinking: "low" },
      { id: "anthropic/claude", thinking: "off" },
    ]);
  });

  test("filters narrow the matrix case-insensitively", () => {
    const models = resolveModels({
      specs: ["openai/gpt-4o", "anthropic/claude"],
      filter: "gpt-4o,CLAUDE",
    });
    expect(models.map((model) => model.id)).toEqual([
      "openai/gpt-4o",
      "anthropic/claude",
    ]);
    const none = resolveModels({ filter: "does-not-exist*" });
    expect(none).toEqual([]);
  });

  test("duplicate --model entries collapse, last thinking wins", () => {
    const models = resolveModels({ specs: ["a/b", "a/b", "a/b:low"] });
    expect(models).toHaveLength(1);
    expect(models[0].thinking).toBe("low");
  });

  test("--thinking overrides every selected model", () => {
    const models = resolveModels({ specs: ["a/b"], thinking: "high" });
    expect(models[0]).toEqual({ id: "a/b", thinking: "high" });
  });

  test("parseModelSpec only splits on KNOWN thinking suffixes", () => {
    expect(parseModelSpec("a/b:medium")).toEqual({
      id: "a/b",
      thinking: "medium",
    });
    expect(parseModelSpec("a/b")).toEqual({ id: "a/b", thinking: undefined });
    // An unknown suffix stays part of the id instead of throwing.
    expect(parseModelSpec("a/b:coyote")).toEqual({
      id: "a/b:coyote",
      thinking: undefined,
    });
    expect(parseModelSpec("hf:org/model")).toEqual({
      id: "hf:org/model",
      thinking: undefined,
    });
  });

  test("model ids are validated for charset/length", () => {
    expect(() => validateModelId("a/b")).not.toThrow();
    expect(() => validateModelId("bad id")).toThrow(/Invalid model id/);
    expect(() => validateModelId("a//b")).toThrow(/Invalid model id/);
    expect(() => validateModelId("a".repeat(200))).toThrow(/Invalid model id/);
    expect(() => resolveModels({ specs: ["x/y", "x y"] })).toThrow(
      /Invalid model id/,
    );
  });

  test("portable glob respects slash segments", () => {
    expect(globMatch("openai/gpt-4o", "openai/*")).toBe(true);
    expect(globMatch("a/b/c", "a/*")).toBe(false);
    expect(globMatch("a/b/c", "a/**")).toBe(true);
    expect(globMatch("x/y", "x?y")).toBe(false); // ? stays within one segment
  });
});
