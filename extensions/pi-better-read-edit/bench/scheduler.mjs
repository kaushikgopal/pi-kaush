// Deterministic counterbalanced scheduling of arm runs.
//
// A slot is one (model, fixture, trial) cell. Arm order is counterbalanced
// by combined cell + trial parity: at N trials the order alternates inside
// every cell, and across cells the trial-0 order also alternates — so even
// a single-trial run keeps both orders represented across cells. The slot
// sequence itself is optionally shuffled with a seeded PRNG so different
// seeds cover different orders while every cell keeps its counterbalance.
// Same inputs -> same plan.

import { mulberry32 } from "./util.mjs";

/** Arms participating in the benchmark. */
export const ARMS = ["better", "builtin"];

/** Build the full ordered slot plan. */
export function planSlots({ models, fixtures, trials, seed = 1 }) {
  const slots = [];
  let cellIndex = 0;
  for (const model of models) {
    for (const fixtureName of fixtures) {
      for (let trial = 0; trial < trials; trial++) {
        const flip = (cellIndex + trial) % 2 === 1;
        const armOrder = flip ? [...ARMS].reverse() : [...ARMS];
        slots.push({
          model: { id: model.id, thinking: model.thinking },
          fixture: fixtureName,
          trial,
          trialCount: trials,
          armOrder,
        });
      }
      cellIndex++;
    }
  }
  if (Number.isFinite(seed) && seed >= 0) shuffle(slots, mulberry32(seed));
  return slots;
}

/** Fisher-Yates shuffle driven by a deterministic PRNG. */
function shuffle(entries, random) {
  for (let index = entries.length - 1; index > 0; index--) {
    const pick = Math.floor(random() * (index + 1));
    [entries[index], entries[pick]] = [entries[pick], entries[index]];
  }
}

/** Stable key for one slot; also used for journal/artifact file names. */
export function slotKey(slot) {
  return `${slot.arm}.${slot.fixture}.${slot.model.id.replace(/[^A-Za-z0-9._-]+/g, "-")}.trial${slot.trial}`;
}

/** Human-readable progress label for one slot. */
export function slotLabel(slot) {
  return `[${slot.model.id} ${slot.thinking ?? "-"} / ${slot.fixture} / trial ${slot.trial} / ${slot.arm}]`;
}

/** Independent, deterministic per-slot workstreams (awaited in sequence). */
export function expandSlotArms(slot) {
  return slot.armOrder.map((arm) => ({ ...slot, arm }));
}
