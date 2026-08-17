/**
 * Shared helpers for tool implementations.
 */

import type { Page } from "puppeteer-core";
import type { CdpSender } from "../core/cdp.ts";
import { takeSnapshot } from "../core/ax-snapshot.ts";
import { diffOutlines } from "../core/diff.ts";

export const textResult = (value: unknown) => ({
  content: [
    {
      type: "text" as const,
      text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
    },
  ],
  details: value,
});

export const delay = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/** Let SPA reactions/lazy loads land before the post-mutation snapshot. */
const MUTATION_SETTLE_MS = 400;

/**
 * Run a mutation with before/after outlines and append a "Page changes" diff —
 * the agent's confirmation the step landed, without a screenshot round-trip.
 */
export const withMutationDiff = async (
  client: CdpSender,
  action: () => Promise<string>,
): Promise<string> => {
  const before = await takeSnapshot(client, { register: false });
  const summary = await action();
  await delay(MUTATION_SETTLE_MS);
  let after: string;
  try {
    after = await takeSnapshot(client, { register: false });
  } catch {
    return `${summary}\n\n(could not snapshot the page after the action)`;
  }
  return `${summary}\n\n${diffOutlines(before, after)}`;
};
