/**
 * Pure lifecycle policy for managed workers. The runtime shell gathers facts
 * (config, child status, clock readings) and applies these decisions; nothing
 * here touches files, processes, or the clock.
 */
import type {
  ChildStatus,
  ManagedAttempt,
  ManagedConfig,
  ManagedPlacement,
} from "./_managed-store.ts";

/** Generic diagnostic for a worker that vanished without saying why. */
export const UNEXPECTED_EXIT_MESSAGE = "Worker process exited unexpectedly.";

/**
 * Why a launch runs: the first boot of a new worker, an idle resume that
 * never redelivers earlier messages or falls back, or a fallback boot that
 * starts the next model candidate fresh.
 */
export type LaunchKind = "initial" | "resume" | "fallback";

export function attemptSessionId(
  handle: string,
  candidateIndex: number,
): string {
  return candidateIndex === 0 ? handle : `${handle}-m${candidateIndex}`;
}

// ---------------------------------------------------------------- transition

export type LifecycleEvent =
  /** The host placed the worker and its bridge reported ready. */
  | { readonly kind: "started"; readonly placement: ManagedPlacement }
  /** A failed attempt moves on to the next model candidate in a new session. */
  | { readonly kind: "candidateAdvanced"; readonly attempt: ManagedAttempt }
  /** A failed attempt with no candidate left (or none worth trying). */
  | {
      readonly kind: "launchFailed";
      readonly attempt: ManagedAttempt;
      readonly error: string;
    }
  /** The parent is stopping a live worker; the target lifecycle is recorded first. */
  | {
      readonly kind: "shutdownRequested";
      readonly lifecycle: "stopped" | "suspended" | "starting";
    }
  /** Same request for a worker with no live process. */
  | {
      readonly kind: "shutdownIdle";
      readonly lifecycle: "stopped" | "suspended" | "starting";
    }
  /** The live process exited without a parent request. */
  | { readonly kind: "exitedUnplanned"; readonly lastError?: string };

/**
 * The single writer of `lifecycle`, `lastError`, `placement`,
 * `candidateIndex`, and `sessionId`. Returns `config` itself when the event
 * changes nothing, so the caller can skip the write; never touches `nextSeq`
 * or `updatedAt`.
 */
export function transition(
  config: ManagedConfig,
  event: LifecycleEvent,
): ManagedConfig {
  switch (event.kind) {
    case "started": {
      const { lastError: _cleared, ...rest } = config;
      return { ...rest, lifecycle: "running", placement: event.placement };
    }
    case "candidateAdvanced": {
      const candidateIndex = config.candidateIndex + 1;
      return {
        ...config,
        attempts: [...config.attempts, event.attempt],
        candidateIndex,
        sessionId: attemptSessionId(config.handle, candidateIndex),
        lifecycle: "starting",
      };
    }
    case "launchFailed":
      return {
        ...config,
        attempts: [...config.attempts, event.attempt],
        lifecycle: "failed",
        lastError: event.error,
      };
    case "shutdownRequested":
      return { ...config, lifecycle: event.lifecycle };
    case "shutdownIdle":
      return config.lifecycle === "stopped"
        ? config
        : { ...config, lifecycle: event.lifecycle };
    case "exitedUnplanned": {
      if (config.lifecycle !== "running") return config;
      const { lastError: _previous, ...rest } = config;
      return event.lastError === undefined
        ? { ...rest, lifecycle: "exited" }
        : { ...rest, lifecycle: "exited", lastError: event.lastError };
    }
  }
}

// ---------------------------------------------------------------- candidates

/** Whether the child should hold a model error so the parent can relaunch on the next candidate. */
export function holdsForFallback(
  kind: LaunchKind,
  candidateIndex: number,
  candidateCount: number,
): boolean {
  return kind !== "resume" && candidateIndex < candidateCount - 1;
}

export type CandidateStep =
  | { readonly kind: "advance" }
  | { readonly kind: "stop" };

/** After a failed attempt: walk to the next candidate only while nothing could have run. */
export function nextCandidateStep(input: {
  readonly launchKind: LaunchKind;
  readonly aborted: boolean;
  /** Only failures a different model could fix are worth another candidate. */
  readonly retryable: boolean;
  /** The failed boot acknowledged a message or used a tool. */
  readonly ran: boolean;
  readonly candidateIndex: number;
  readonly candidateCount: number;
}): CandidateStep {
  return input.launchKind !== "resume" &&
    !input.aborted &&
    input.retryable &&
    !input.ran &&
    input.candidateIndex + 1 < input.candidateCount
    ? { kind: "advance" }
    : { kind: "stop" };
}

// ---------------------------------------------------------------- watchdog

export type WatchdogVerdict =
  /** No assignment is running; poll rarely. */
  | { readonly kind: "idle" }
  /** An assignment is running within its limits. */
  | { readonly kind: "running" }
  /** The child's own watchdog failed; the parent must terminate it. */
  | { readonly kind: "terminate"; readonly reason: string };

/** Parent-side backstop for runtime and inactivity limits; a zero limit is disabled. */
export function watchdogVerdict(
  status: ChildStatus,
  limits: { readonly maxRuntimeMs: number; readonly maxInactivityMs: number },
  now: number,
  graceMs: number,
): WatchdogVerdict {
  const active = status.activeAssignmentId
    ? status.assignments.find((entry) => entry.id === status.activeAssignmentId)
    : undefined;
  if (active?.state !== "running" || active.startedAt === undefined)
    return { kind: "idle" };
  const limit = limits.maxRuntimeMs;
  if (limit > 0 && now > active.startedAt + limit + graceMs)
    return {
      kind: "terminate",
      reason: `Worker exceeded the ${limit} ms runtime limit and did not stop itself; the parent terminated it.`,
    };
  const inactivity = limits.maxInactivityMs;
  if (inactivity > 0 && now > status.updatedAt + inactivity + graceMs)
    return {
      kind: "terminate",
      reason: `Worker exceeded the ${inactivity} ms inactivity limit and did not stop itself; the parent terminated it.`,
    };
  return { kind: "running" };
}

// ---------------------------------------------------------------- exits

export type UnplannedExit =
  /** The child recorded its own orderly shutdown (for example /quit in its tab). */
  | { readonly kind: "clean" }
  /** A known reason: the parent's kill or the child's own last error. */
  | { readonly kind: "failed"; readonly reason: string }
  /** No explanation; the caller reports a generic exit with stderr context. */
  | { readonly kind: "crashed" };

export function classifyUnplannedExit(input: {
  /** Why the parent forced the worker down, if it did. */
  readonly killReason: string | undefined;
  readonly status: ChildStatus | undefined;
  readonly bootId: string;
  readonly sessionId: string;
}): UnplannedExit {
  if (input.killReason !== undefined)
    return { kind: "failed", reason: input.killReason };
  const own = input.status?.bootId === input.bootId ? input.status : undefined;
  if (own?.lastError !== undefined)
    return { kind: "failed", reason: own.lastError };
  return own?.state === "exited" && own.sessionId === input.sessionId
    ? { kind: "clean" }
    : { kind: "crashed" };
}
