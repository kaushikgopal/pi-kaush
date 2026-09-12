import type { SubagentLimitsConfig } from "./_limits.ts";

export type SubagentTimeoutReason = "inactivity" | "runtime";

type TimerHandle = ReturnType<typeof setTimeout>;

interface TimerScheduler {
  set(callback: () => void, delayMs: number): TimerHandle;
  clear(handle: TimerHandle): void;
}

const defaultScheduler: TimerScheduler = {
  set(callback, delayMs) {
    const handle = setTimeout(callback, delayMs);
    handle.unref?.();
    return handle;
  },
  clear(handle) {
    clearTimeout(handle);
  },
};

export interface SubagentExecutionWatchdog {
  recordActivity(): void;
  stop(): void;
}

export function createSubagentExecutionWatchdog(
  limits: Pick<SubagentLimitsConfig, "maxRuntimeMs" | "maxInactivityMs">,
  onTimeout: (reason: SubagentTimeoutReason) => void,
  scheduler: TimerScheduler = defaultScheduler,
): SubagentExecutionWatchdog {
  let runtimeTimer: TimerHandle | undefined;
  let inactivityTimer: TimerHandle | undefined;
  let stopped = false;

  const clearTimer = (handle: TimerHandle | undefined): void => {
    if (handle !== undefined) scheduler.clear(handle);
  };
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    clearTimer(runtimeTimer);
    clearTimer(inactivityTimer);
    runtimeTimer = undefined;
    inactivityTimer = undefined;
  };
  const expire = (reason: SubagentTimeoutReason): void => {
    if (stopped) return;
    stop();
    onTimeout(reason);
  };
  const armInactivityTimer = (): void => {
    clearTimer(inactivityTimer);
    inactivityTimer =
      limits.maxInactivityMs > 0
        ? scheduler.set(() => expire("inactivity"), limits.maxInactivityMs)
        : undefined;
  };

  if (limits.maxRuntimeMs > 0) {
    runtimeTimer = scheduler.set(() => expire("runtime"), limits.maxRuntimeMs);
  }
  armInactivityTimer();

  return {
    recordActivity() {
      if (!stopped) armInactivityTimer();
    },
    stop,
  };
}

export function formatSubagentTimeoutMessage(
  reason: SubagentTimeoutReason,
  limits: Pick<SubagentLimitsConfig, "maxRuntimeMs" | "maxInactivityMs">,
): string {
  const durationMs =
    reason === "runtime" ? limits.maxRuntimeMs : limits.maxInactivityMs;
  const duration = formatDuration(durationMs);
  return reason === "runtime"
    ? `Subagent exceeded the total runtime limit of ${duration}.`
    : `Subagent exceeded the inactivity limit after ${duration} without output.`;
}

export function formatDuration(durationMs: number): string {
  if (durationMs === 0) return "disabled";
  if (durationMs % 3_600_000 === 0) {
    const hours = durationMs / 3_600_000;
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  if (durationMs % 60_000 === 0) {
    const minutes = durationMs / 60_000;
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  if (durationMs % 1_000 === 0) {
    const seconds = durationMs / 1_000;
    return `${seconds} second${seconds === 1 ? "" : "s"}`;
  }
  return `${durationMs} ms`;
}
