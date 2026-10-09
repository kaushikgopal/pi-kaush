/**
 * Contract between the managed runtime and the hosts that place worker
 * processes (`_managed-host-rpc.ts`, `_managed-host-herdr.ts`). Hosts start,
 * focus, and tear down processes; lifecycle policy stays in the runtime.
 */
import type { ManagedPaths, ManagedPlacement } from "./_managed-store.ts";
import type { ProcessStartIdentity } from "./_process-tree.ts";

export type ManagedErrorCode =
  | "capacity"
  | "depth"
  | "ownership"
  | "not_found"
  | "not_running"
  | "invalid"
  | "launch"
  | "unsupported"
  | "aborted";

export class ManagedError extends Error {
  constructor(
    readonly code: ManagedErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ManagedError";
  }
}

export interface ManagedHostLaunch {
  readonly handle: string;
  readonly bootId: string;
  readonly label: string;
  readonly cwd: string;
  readonly command: string;
  readonly args: readonly string[];
  /** Pi CLI arguments alone; hosts that launch the installed `pi` themselves use these. */
  readonly piArgs: readonly string[];
  /** Managed and delegation variables only; hosts add their own base environment. */
  readonly env: Record<string, string>;
  readonly paths: ManagedPaths;
  /** Other live worker placements, used only to stack Herdr panes below owned siblings. */
  readonly ownedPlacements?: readonly ManagedPlacement[];
  /** Aborts a launch that is still waiting on the host. */
  readonly signal?: AbortSignal;
  /**
   * PID the bridge of this boot reported, once known. Hosts that did not spawn
   * the process themselves (Herdr panes) watch this PID for liveness.
   */
  readonly readBootPid?: () => number | undefined;
}

export interface ManagedHostProcess {
  readonly placement: ManagedPlacement;
  /** Resolves once the worker process is gone. */
  readonly exited: Promise<void>;
  /** Forced, idempotent process-tree and placement cleanup. */
  terminate(): Promise<void>;
  /**
   * Graceful stop the host can deliver itself (RPC: close stdin, which Pi
   * treats as shutdown even when the bridge's own shutdown request is deferred).
   */
  requestStop?(): void;
  /** The host already confirmed Pi reached its interactive prompt. */
  readonly readyConfirmed?: boolean;
}

/** Startup failures that a different model cannot fix are not retried on the next candidate. */
export class ManagedStartupError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "ManagedStartupError";
  }
}

/**
 * Whether `pid` is still the process that reported it at `aliveAt`: `match`
 * when it is alive and started no later than that report (a PID names one
 * process at a time), `other` when it started afterwards (PID reuse), `gone`
 * when nothing runs under it, `unknown` when that cannot be checked.
 */
export type ManagedProcessIdentity = ProcessStartIdentity;

export interface ManagedHostPort {
  readonly kind: "herdr" | "rpc";
  launch(request: ManagedHostLaunch): Promise<ManagedHostProcess>;
  focus(placement: ManagedPlacement): Promise<void>;
}

export function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ManagedError("aborted", "Managed wait was aborted."));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    const onAbort = () => {
      clearTimeout(timer);
      reject(new ManagedError("aborted", "Managed wait was aborted."));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
