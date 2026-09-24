import { relative } from "node:path";
import { describe, expect, test } from "vitest";
import {
  createSubagentExecutionWatchdog,
  formatDuration,
  formatSubagentTimeoutMessage,
  getPiInvocation,
  type SubagentTimeoutReason,
} from "../src/_execution.ts";

class FakeScheduler {
  private nextId = 1;
  readonly tasks = new Map<number, { callback: () => void; delayMs: number }>();

  set(callback: () => void, delayMs: number) {
    const id = this.nextId++;
    this.tasks.set(id, { callback, delayMs });
    return id as unknown as ReturnType<typeof setTimeout>;
  }

  clear(handle: ReturnType<typeof setTimeout>) {
    this.tasks.delete(handle as unknown as number);
  }

  fire(delayMs: number) {
    const match = Array.from(this.tasks.entries()).find(
      ([, task]) => task.delayMs === delayMs,
    );
    if (!match) throw new Error(`No active ${delayMs} ms timer`);
    this.tasks.delete(match[0]);
    match[1].callback();
  }
}

const limits = { maxRuntimeMs: 7_200_000, maxInactivityMs: 900_000 };

describe("subagent execution watchdog", () => {
  test("resets only the inactivity deadline when output arrives", () => {
    const scheduler = new FakeScheduler();
    const reasons: SubagentTimeoutReason[] = [];
    const watchdog = createSubagentExecutionWatchdog(
      limits,
      (reason) => reasons.push(reason),
      scheduler,
    );

    expect(scheduler.tasks.size).toBe(2);
    watchdog.recordActivity();
    expect(scheduler.tasks.size).toBe(2);
    scheduler.fire(900_000);

    expect(reasons).toEqual(["inactivity"]);
    expect(scheduler.tasks.size).toBe(0);
  });

  test("does not extend the total runtime deadline when output arrives", () => {
    const scheduler = new FakeScheduler();
    const reasons: SubagentTimeoutReason[] = [];
    const watchdog = createSubagentExecutionWatchdog(
      limits,
      (reason) => reasons.push(reason),
      scheduler,
    );

    watchdog.recordActivity();
    scheduler.fire(7_200_000);

    expect(reasons).toEqual(["runtime"]);
    expect(scheduler.tasks.size).toBe(0);
  });

  test("allows either deadline to be disabled with zero", () => {
    const scheduler = new FakeScheduler();
    const watchdog = createSubagentExecutionWatchdog(
      { maxRuntimeMs: 0, maxInactivityMs: 0 },
      () => {
        throw new Error("disabled watchdog fired");
      },
      scheduler,
    );

    expect(scheduler.tasks.size).toBe(0);
    watchdog.recordActivity();
    expect(scheduler.tasks.size).toBe(0);
  });

  test("formats explicit timeout diagnostics", () => {
    expect(formatDuration(7_200_000)).toBe("2 hours");
    expect(formatDuration(900_000)).toBe("15 minutes");
    expect(formatDuration(0)).toBe("disabled");
    expect(formatSubagentTimeoutMessage("runtime", limits)).toBe(
      "Subagent exceeded the total runtime limit of 2 hours.",
    );
    expect(formatSubagentTimeoutMessage("inactivity", limits)).toBe(
      "Subagent exceeded the inactivity limit after 15 minutes without output.",
    );
  });
});

describe("subagent process invocation", () => {
  test("uses the current Pi command when the parent runtime was removed", () => {
    expect(
      getPiInvocation(
        ["--model", "provider/model"],
        "/__removed_pi_runtime__/node",
        import.meta.filename,
      ),
    ).toEqual({ command: "pi", args: ["--model", "provider/model"] });
  });

  test("keeps the parent's runtime while it still exists", () => {
    expect(
      getPiInvocation(["--version"], process.execPath, import.meta.filename),
    ).toEqual({
      command: process.execPath,
      args: [import.meta.filename, "--version"],
    });
  });

  test("resolves a relative entrypoint before changing the child's cwd", () => {
    const relativeScript = relative(process.cwd(), import.meta.filename);
    expect(
      getPiInvocation(["--version"], process.execPath, relativeScript),
    ).toEqual({
      command: process.execPath,
      args: [import.meta.filename, "--version"],
    });
  });

  test("does not pass a Bun virtual script to a filesystem runtime", () => {
    expect(
      getPiInvocation(["--version"], process.execPath, "/$bunfs/root/cli.js"),
    ).toEqual({
      command: "pi",
      args: ["--version"],
    });
  });
});
