import { describe, expect, test, vi } from "vitest";
import type { SessionConcurrencyGate } from "../src/_concurrency.ts";
import { parseSubagentLimits } from "../src/_limits.ts";
import type { ManagedRuntime } from "../src/_managed.ts";
import type { SubagentProcessRegistry } from "../src/_process-tree.ts";
import { SessionResources } from "../src/_session-resources.ts";

const limits = parseSubagentLimits({
  version: 1,
  maxDepth: 2,
  maxChildrenPerCall: 5,
  maxConcurrency: 2,
  maxRuntimeMs: 60_000,
  maxInactivityMs: 30_000,
});

function fakeRuntime(
  restore: ManagedRuntime["restore"] = async () => [],
): ManagedRuntime {
  // SAFETY: SessionResources only calls bind, suspendAll, and restore.
  return {
    bind: vi.fn(),
    suspendAll: vi.fn(async () => {}),
    restore: vi.fn(restore),
  } as unknown as ManagedRuntime;
}

function setup(runtimes: ManagedRuntime[] = []) {
  const registries: Array<{ terminateAll: ReturnType<typeof vi.fn> }> = [];
  const created: string[] = [];
  const resources = new SessionResources({
    limits,
    runtimeFactory: (options) => {
      created.push(options.parentSessionId);
      return runtimes.shift() ?? fakeRuntime();
    },
    processRegistryFactory: () => {
      const registry = { terminateAll: vi.fn(async () => {}) };
      registries.push(registry);
      // SAFETY: SessionResources only calls terminateAll.
      return registry as unknown as SubagentProcessRegistry;
    },
    runtimeOptions: (parentSessionId, gate: SessionConcurrencyGate) => ({
      parentSessionId,
      agentDir: "/agent",
      limits,
      gate,
    }),
  });
  return { resources, registries, created };
}

describe("SessionResources", () => {
  test("re-entering the open session is a no-op; switching sessions tears down the old one", async () => {
    const runtime = fakeRuntime();
    const { resources, registries } = setup([runtime]);
    await resources.enterManaged("s1", () => {});
    const firstGate = resources.concurrency;
    await resources.enter("s1");
    expect(resources.concurrency).toBe(firstGate);
    expect(registries[1]!.terminateAll).not.toHaveBeenCalled();

    await resources.enter("s2");
    expect(resources.concurrency).not.toBe(firstGate);
    await expect(firstGate.acquire()).rejects.toThrow("shutting down");
    expect(registries[1]!.terminateAll).toHaveBeenCalledOnce();
    expect(runtime.suspendAll).toHaveBeenCalledOnce();
  });

  test("creates one runtime per session and restores it once, reporting failures", async () => {
    const runtime = fakeRuntime(async () => [
      { handle: "mw-1", restored: false, error: "gone" },
      { handle: "mw-2", restored: true },
    ]);
    const { resources, created } = setup([runtime]);
    const warn = vi.fn();
    expect(await resources.enterManaged("s1", warn)).toBe(runtime);
    expect(await resources.enterManaged("s1", warn)).toBe(runtime);
    expect(created).toEqual(["s1"]);
    expect(runtime.restore).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith("Could not restore mw-1: gone");
    expect(resources.existingRuntime("s1")).toBe(runtime);
    expect(resources.existingRuntime("s2")).toBeUndefined();
  });

  test("UI and reports need an open session", async () => {
    const { resources } = setup();
    expect(() => resources.runtimeForUi("s1")).toThrow(
      "Managed subagents are not ready until the session starts.",
    );
    const runtime = await resources.enterManaged("s1", () => {});
    expect(resources.runtimeForUi("s1")).toBe(runtime);
    expect(resources.reportingRuntime("s1")).toBe(runtime);
    expect(resources.reportingRuntime("s2")).toBeUndefined();

    await resources.shutdown("quit", () => {});
    expect(resources.reportingRuntime("s1")).toBeUndefined();
    expect(() => resources.runtimeForUi("s1")).toThrow("not ready");
  });

  test("shutdown suspends managed workers unless Pi is reloading", async () => {
    const runtime = fakeRuntime();
    const { resources, registries } = setup([runtime]);
    await resources.enterManaged("s1", () => {});
    await resources.shutdown("reload", () => {});
    expect(registries[1]!.terminateAll).toHaveBeenCalledOnce();
    expect(runtime.suspendAll).not.toHaveBeenCalled();

    await resources.enter("s1");
    vi.mocked(runtime.suspendAll).mockRejectedValueOnce(new Error("disk"));
    const onSuspendFailure = vi.fn();
    await resources.shutdown("quit", onSuspendFailure);
    expect(onSuspendFailure).toHaveBeenCalledWith(new Error("disk"));
  });
});
