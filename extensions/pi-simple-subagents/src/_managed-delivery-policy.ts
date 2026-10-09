/**
 * Pure delivery policy for automatic managed-worker reports. It decides what
 * to send and when from plain inputs (results, receipts, the in-flight
 * message, parent activity, and the current time); the notifications shell
 * gathers those inputs and performs the effects.
 */

export const POLL_MS = 1_000;
/** An unacknowledged report is resent only after this long, and only while the parent is idle. */
export const RETRY_MS = 30_000;
/** After the parent settles, a report it did not consume is resent sooner. */
export const SETTLE_RETRY_MS = 2_000;
/** Sends per report, counted from durable intents so restarts do not reset it. */
export const MAX_ATTEMPTS = 3;
export const MAX_REPORTS_PER_MESSAGE = 10;
export const MESSAGE_LIMIT_BYTES = 50 * 1024;

export type NonEmptyArray<T> = readonly [T, ...T[]];

export function mapNonEmpty<T, U>(
  items: NonEmptyArray<T>,
  map: (item: T) => U,
): NonEmptyArray<U> {
  const [first, ...rest] = items;
  return [map(first), ...rest.map(map)];
}

export function toNonEmpty<T>(
  items: readonly T[],
): NonEmptyArray<T> | undefined {
  const [first, ...rest] = items;
  return first === undefined ? undefined : [first, ...rest];
}

/** Identity of one reportable assignment. */
export type ReportKey = string & { readonly __reportKey: unique symbol };

export function reportKey(handle: string, assignmentId: string): ReportKey {
  // SAFETY: the brand only records that the key was built here.
  return `${handle}\0${assignmentId}` as ReportKey;
}

export interface ReportSubject {
  readonly handle: string;
  readonly id: string;
}

/** Receipts and send counts for the active branch. */
export interface DeliveryLedger {
  /** Keys acknowledged in the branch or collected by a manual wait. */
  readonly received: ReadonlySet<ReportKey>;
  /** Sends per key, one per durable intent. */
  readonly attempts: ReadonlyMap<ReportKey, number>;
}

/** At most one unacknowledged report message. */
export interface InFlight {
  readonly keys: ReadonlySet<ReportKey>;
  readonly retryAt: number;
}

export type ParentActivity = "idle" | "busy";
export type LastRun = "aborted" | "normal";
/** `quiet` appends without starting a parent turn. */
export type TurnMode = "trigger" | "quiet";

/** Where the in-flight message stands after one poll. */
export type InFlightStatus =
  /** Keep waiting on it, possibly with fewer unacknowledged keys. */
  | { readonly _tag: "wait"; readonly inFlight: InFlight }
  /** Nothing in flight: it was acknowledged, or its resend is due. */
  | { readonly _tag: "ready" };

export type BatchPlan<T extends ReportSubject> =
  | { readonly _tag: "none" }
  | {
      readonly _tag: "send";
      readonly batch: NonEmptyArray<T>;
      readonly turn: TurnMode;
    };

/**
 * Results eligible for the next message: unacknowledged, under the attempt
 * cap, and, for a resend, only while the parent is idle because an earlier
 * send may still sit in a busy parent's queue.
 */
export function selectBatch<T extends ReportSubject>(
  results: readonly T[],
  ledger: DeliveryLedger,
  activity: ParentActivity,
): readonly T[] {
  return results
    .filter((result) => {
      const key = reportKey(result.handle, result.id);
      if (ledger.received.has(key)) return false;
      const attempts = ledger.attempts.get(key) ?? 0;
      return attempts < MAX_ATTEMPTS && (attempts === 0 || activity === "idle");
    })
    .slice(0, MAX_REPORTS_PER_MESSAGE);
}

/**
 * A busy parent may still deliver its queued report, so only an idle parent
 * acknowledges keys from its branch and lets a due resend through.
 */
export function nextDelivery(
  inFlight: InFlight | undefined,
  ledger: DeliveryLedger,
  activity: ParentActivity,
  now: number,
): InFlightStatus {
  if (!inFlight) return { _tag: "ready" };
  if (activity === "busy") return { _tag: "wait", inFlight };
  const keys = new Set(
    [...inFlight.keys].filter((key) => !ledger.received.has(key)),
  );
  return keys.size > 0 && now < inFlight.retryAt
    ? { _tag: "wait", inFlight: { keys, retryAt: inFlight.retryAt } }
    : { _tag: "ready" };
}

/** The next message once nothing is in flight. */
export function planBatch<T extends ReportSubject>(
  results: readonly T[],
  ledger: DeliveryLedger,
  activity: ParentActivity,
  lastRun: LastRun,
): BatchPlan<T> {
  const batch = toNonEmpty(selectBatch(results, ledger, activity));
  if (!batch) return { _tag: "none" };
  const retry = batch.every(
    (result) =>
      (ledger.attempts.get(reportKey(result.handle, result.id)) ?? 0) > 0,
  );
  // A retry after the user aborted lands quietly instead of starting a new turn.
  const turn = retry && lastRun === "aborted" ? "quiet" : "trigger";
  return { _tag: "send", batch, turn };
}

export function startInFlight(
  keys: Iterable<ReportKey>,
  now: number,
): InFlight {
  return { keys: new Set(keys), retryAt: now + RETRY_MS };
}

/** Removes acknowledged keys; the message is done once none remain. */
export function acknowledgeInFlight(
  inFlight: InFlight | undefined,
  keys: Iterable<ReportKey>,
): InFlight | undefined {
  if (!inFlight) return undefined;
  const acknowledged = new Set(keys);
  const remaining = new Set(
    [...inFlight.keys].filter((key) => !acknowledged.has(key)),
  );
  return remaining.size
    ? { keys: remaining, retryAt: inFlight.retryAt }
    : undefined;
}

/** A settled parent that did not consume the report gets it sooner. */
export function settleInFlight(inFlight: InFlight, now: number): InFlight {
  return {
    keys: inFlight.keys,
    retryAt: Math.min(inFlight.retryAt, now + SETTLE_RETRY_MS),
  };
}
