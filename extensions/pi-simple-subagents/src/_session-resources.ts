/**
 * Per-session subagent resources: the concurrency gate, the child process
 * registry, and each session's managed runtime. Entering a different session
 * (or reopening a closed one) tears down the previous session's resources.
 */
import type { SessionShutdownEvent } from "@earendil-works/pi-coding-agent";
import { SessionConcurrencyGate } from "./_concurrency.ts";
import type { SubagentLimitsConfig } from "./_limits.ts";
import type { ManagedRuntime, ManagedRuntimeOptions } from "./_managed.ts";
import { errorText } from "./_parse.ts";
import type { SubagentProcessRegistry } from "./_process-tree.ts";

type SessionState =
  | { readonly kind: "unstarted" }
  | { readonly kind: "open"; readonly sessionId: string }
  | { readonly kind: "closed" };

export interface SessionResourcesOptions {
  readonly limits: SubagentLimitsConfig;
  readonly runtimeFactory: (options: ManagedRuntimeOptions) => ManagedRuntime;
  readonly processRegistryFactory: () => SubagentProcessRegistry;
  /** Built per runtime so settings read from the environment stay current. */
  readonly runtimeOptions: (
    parentSessionId: string,
    gate: SessionConcurrencyGate,
  ) => ManagedRuntimeOptions;
}

export class SessionResources {
  private readonly options: SessionResourcesOptions;
  private state: SessionState = { kind: "unstarted" };
  private gate: SessionConcurrencyGate;
  private processRegistry: SubagentProcessRegistry;
  private rotation: { sessionId: string; promise: Promise<void> } | undefined;
  private shutdownPromise: Promise<void> | undefined;
  private readonly runtimes = new Map<string, ManagedRuntime>();
  private readonly restoreAttempted = new Set<string>();

  constructor(options: SessionResourcesOptions) {
    this.options = options;
    this.gate = new SessionConcurrencyGate(options.limits.maxConcurrency);
    this.processRegistry = options.processRegistryFactory();
  }

  get concurrency(): SessionConcurrencyGate {
    return this.gate;
  }

  get processes(): SubagentProcessRegistry {
    return this.processRegistry;
  }

  private isOpen(sessionId: string): boolean {
    return this.state.kind === "open" && this.state.sessionId === sessionId;
  }

  private async rotate(sessionId: string): Promise<void> {
    if (this.state.kind !== "unstarted") {
      this.gate.close();
      await this.processRegistry.terminateAll();
      const suspended = await Promise.allSettled(
        [...this.runtimes.values()].map((runtime) => runtime.suspendAll()),
      );
      for (const result of suspended)
        if (result.status === "rejected")
          console.warn("Could not suspend managed subagents:", result.reason);
    }
    this.gate = new SessionConcurrencyGate(this.options.limits.maxConcurrency);
    this.processRegistry = this.options.processRegistryFactory();
    this.state = { kind: "open", sessionId };
    this.restoreAttempted.delete(sessionId);
  }

  /** Opens `sessionId`'s resources, rotating out any other session's first. */
  async enter(sessionId: string): Promise<void> {
    if (this.shutdownPromise) await this.shutdownPromise;
    if (this.rotation && this.rotation.sessionId !== sessionId)
      await this.rotation.promise;
    if (this.isOpen(sessionId)) return;
    if (this.rotation?.sessionId !== sessionId)
      this.rotation = { sessionId, promise: this.rotate(sessionId) };
    try {
      await this.rotation.promise;
    } finally {
      if (this.rotation?.sessionId === sessionId) this.rotation = undefined;
    }
  }

  /**
   * Opens `sessionId` and returns its managed runtime, restoring persisted
   * workers the first time. Restore problems go to `warn`; they never fail entry.
   */
  async enterManaged(
    sessionId: string,
    warn: (message: string) => void,
  ): Promise<ManagedRuntime> {
    await this.enter(sessionId);
    let runtime = this.runtimes.get(sessionId);
    if (!runtime) {
      runtime = this.options.runtimeFactory(
        this.options.runtimeOptions(sessionId, this.gate),
      );
      runtime.bind(this.gate, this.options.limits);
      this.runtimes.set(sessionId, runtime);
    }
    if (!this.restoreAttempted.has(sessionId)) {
      this.restoreAttempted.add(sessionId);
      try {
        const restored = await runtime.restore();
        for (const result of restored)
          if (!result.restored && result.error)
            warn(`Could not restore ${result.handle}: ${result.error}`);
      } catch (error) {
        warn(`Could not restore managed subagents: ${errorText(error)}`);
      }
    }
    return runtime;
  }

  /** The runtime already created for `sessionId`, if any; never creates one. */
  existingRuntime(sessionId: string): ManagedRuntime | undefined {
    return this.runtimes.get(sessionId);
  }

  /** The runtime for UI commands; throws until `sessionId` is open. */
  runtimeForUi(sessionId: string): ManagedRuntime {
    if (!this.isOpen(sessionId))
      throw new Error(
        "Managed subagents are not ready until the session starts.",
      );
    const runtime =
      this.runtimes.get(sessionId) ??
      this.options.runtimeFactory(
        this.options.runtimeOptions(sessionId, this.gate),
      );
    runtime.bind(this.gate, this.options.limits);
    this.runtimes.set(sessionId, runtime);
    return runtime;
  }

  /** The runtime that may deliver reports now: open and not mid-transition. */
  reportingRuntime(sessionId: string): ManagedRuntime | undefined {
    if (!this.isOpen(sessionId) || this.shutdownPromise || this.rotation)
      return undefined;
    return this.runtimes.get(sessionId);
  }

  /**
   * Closes the session: stops admitting work, terminates bounded children,
   * and suspends managed workers unless Pi is reloading the extension.
   */
  async shutdown(
    reason: SessionShutdownEvent["reason"],
    onSuspendFailure: (reason: unknown) => void,
  ): Promise<void> {
    this.state = { kind: "closed" };
    this.gate.close();
    this.shutdownPromise = (async () => {
      await this.processRegistry.terminateAll();
      const suspended =
        reason === "reload"
          ? []
          : await Promise.allSettled(
              [...this.runtimes.values()].map((runtime) =>
                runtime.suspendAll(),
              ),
            );
      for (const result of suspended)
        if (result.status === "rejected") onSuspendFailure(result.reason);
    })();
    try {
      await this.shutdownPromise;
    } finally {
      this.shutdownPromise = undefined;
    }
  }
}
