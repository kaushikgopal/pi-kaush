/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Supports three modes with optional execution profiles or model overrides:
 *   - Single: { agent: "name", task: "...", profile?: "name", model?: "provider/model" }
 *   - Parallel: { tasks: [{ agent: "name", task: "...", profile?: "name", model?: "provider/model" }, ...] }
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ...", profile?: "name", model?: "provider/model" }, ...] }
 *
 * Uses JSON mode to capture structured output from subagents.
 *
 * This module wires the pieces together: `_subagent-command.ts` parses the
 * call, `_bounded-runner.ts` runs bounded children, `_managed.ts` owns
 * persistent workers, `_session-resources.ts` scopes both to a session, and
 * `_render.ts` draws the call and result.
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  CONFIG_DIR_NAME,
  type AgentToolResult,
  type AgentToolUpdateCallback,
  type ExtensionAPI,
  type ExtensionContext,
  getAgentDir,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  formatProfileGuidance,
  loadModelProfiles,
  type ModelProfilesConfig,
  resolveProfilesPath,
} from "@pi-kaush/pi-model-profiles";
import {
  runBoundedPlan,
  type SingleResult,
  toPersistedResult,
} from "./_bounded-runner.ts";
import {
  type AgentConfig,
  type AgentDiscoveryResult,
  type AgentScope,
  discoverAgents,
  formatAgentList,
  shouldConfirmProjectAgent,
} from "./_definition.ts";
import {
  createDelegationTrace,
  createModelResolver,
  currentDelegationDepth,
  type DelegationTrace,
} from "./_delegation.ts";
import { formatAgentDisplayName } from "./_display.ts";
import { formatDuration } from "./_execution.ts";
import { loadSubagentLimits, type SubagentLimitsConfig } from "./_limits.ts";
import {
  getManagedRuntime,
  isManagedChildProcess,
  ManagedError,
  type ManagedRuntime,
  type ManagedRuntimeOptions,
} from "./_managed.ts";
import {
  type ManagedNotifications,
  registerManagedNotifications,
} from "./_managed-notifications.ts";
import {
  boundManagedToolOutput,
  formatManagedWorkerSummary,
  type ManagedLaunchPreparation,
  prepareManagedLaunch,
  truncateManagedText,
} from "./_managed-tool.ts";
import {
  formatManualManagedOpenHint,
  registerManagedUi,
} from "./_managed-ui.ts";
import { errorText } from "./_parse.ts";
import { SubagentProcessRegistry } from "./_process-tree.ts";
import {
  loadSubagentProfilesCurrent,
  type SubagentProfilesCache,
} from "./_profiles.ts";
import {
  renderSubagentCall,
  renderSubagentResult,
  type SubagentDetails,
  type SubagentRenderState,
} from "./_render.ts";
import { SessionResources } from "./_session-resources.ts";
import {
  type AgentSelection,
  type BoundedItem,
  type BoundedMode,
  type BoundedPlan,
  type InvalidBoundedPlan,
  parseSubagentCall,
  type SubagentCommand,
} from "./_subagent-command.ts";
import { formatUsageCompact } from "./_usage.ts";
import { registerSubagentYield } from "./_yield.ts";

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
  description:
    'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
  default: "user",
});

function createSubagentParams(
  profiles: ModelProfilesConfig,
  limits: SubagentLimitsConfig,
) {
  const profileNames = Object.keys(profiles.profiles) as [string, ...string[]];
  const profileDescription = `Execution profile configured in profiles.yaml. ${formatProfileGuidance(profiles)}`;
  const profileSchema = () =>
    Type.Optional(
      StringEnum(profileNames, { description: profileDescription }),
    );
  const modelSchema = (scope: string) =>
    Type.Optional(
      Type.String({
        description: `Model pattern for ${scope}; overrides profile and agent configuration`,
      }),
    );

  const agentSchema = () =>
    Type.String({
      description:
        "Agent name; selects behavior and tools. Profile separately selects compute.",
    });
  const toolsSchema = () =>
    Type.Optional(
      Type.Array(Type.String(), {
        description: "Override the agent's tool allowlist for this invocation.",
      }),
    );
  const isolationSchema = () =>
    Type.Optional(
      Type.Object({
        noExtensions: Type.Optional(Type.Boolean()),
        noSkills: Type.Optional(Type.Boolean()),
        noContextFiles: Type.Optional(Type.Boolean()),
        noPromptTemplates: Type.Optional(Type.Boolean()),
        noMcp: Type.Optional(
          Type.Boolean({
            description: "Disable MCP servers and tools for bounded children.",
          }),
        ),
      }),
    );
  const TaskItem = Type.Object({
    agent: agentSchema(),
    task: Type.String({ description: "Task to delegate to the agent" }),
    profile: profileSchema(),
    model: modelSchema("this task"),
    cwd: Type.Optional(
      Type.String({ description: "Working directory for the agent process" }),
    ),
    tools: toolsSchema(),
    isolation: isolationSchema(),
  });

  const ChainItem = Type.Object({
    agent: agentSchema(),
    task: Type.String({
      description: "Task with optional {previous} placeholder for prior output",
    }),
    profile: profileSchema(),
    model: modelSchema("this step"),
    cwd: Type.Optional(
      Type.String({ description: "Working directory for the agent process" }),
    ),
    tools: toolsSchema(),
    isolation: isolationSchema(),
  });

  return Type.Object({
    action: Type.Optional(
      StringEnum(
        [
          "run",
          "spawn",
          "status",
          "list",
          "send",
          "wait",
          "stop",
          "resume",
        ] as const,
        {
          description:
            "run (default), spawn, status, list, send, wait, stop, or resume.",
          default: "run",
        },
      ),
    ),
    handle: Type.Optional(
      Type.String({
        description: "Managed worker handle for control actions.",
      }),
    ),
    assignmentId: Type.Optional(
      Type.String({
        description:
          "Assignment ID to wait for; defaults to the latest assignment.",
      }),
    ),
    message: Type.Optional(
      Type.String({
        description: "Message to send or steer to a managed worker.",
      }),
    ),
    delivery: Type.Optional(
      StringEnum(["auto", "followUp"] as const, {
        description:
          'Delivery for send: "auto" steers active work; "followUp" queues a separate assignment.',
      }),
    ),
    waitTimeoutMs: Type.Optional(
      Type.Number({
        minimum: 0,
        maximum: 86_400_000,
        description: "Optional wait deadline in milliseconds (max 24 hours).",
      }),
    ),
    agent: Type.Optional(agentSchema()),
    task: Type.Optional(
      Type.String({ description: "Task to delegate (for single mode)" }),
    ),
    profile: profileSchema(),
    model: modelSchema("single mode"),
    context: Type.Optional(
      Type.String({
        description:
          "Shared immutable context prepended to every task in parallel mode",
      }),
    ),
    tasks: Type.Optional(
      Type.Array(TaskItem, {
        description:
          "Parallel tasks with optional per-task profiles or model overrides",
        maxItems: limits.maxChildrenPerCall,
      }),
    ),
    chain: Type.Optional(
      Type.Array(ChainItem, {
        description:
          "Sequential steps with optional per-step profiles or model overrides",
        maxItems: limits.maxChildrenPerCall,
      }),
    ),
    agentScope: Type.Optional(AgentScopeSchema),
    confirmProjectAgents: Type.Optional(
      Type.Boolean({
        description:
          "Prompt before running project-local agents. Overrides agent frontmatter; defaults to its value, then true.",
      }),
    ),
    cwd: Type.Optional(
      Type.String({
        description: "Working directory for the agent process (single mode)",
      }),
    ),
    tools: toolsSchema(),
    isolation: isolationSchema(),
  });
}

type SubagentParams = ReturnType<typeof createSubagentParams>;
type SubagentToolResult = AgentToolResult<SubagentDetails>;

export interface SubagentRegistrationOptions {
  readonly managedRuntimeFactory?: (
    options: ManagedRuntimeOptions,
  ) => ManagedRuntime;
  readonly processRegistryFactory?: () => SubagentProcessRegistry;
}

/** State shared by every call of one registered tool. */
interface ToolEnv {
  readonly limits: SubagentLimitsConfig;
  readonly resources: SessionResources;
  readonly loadProfiles: () => ModelProfilesConfig;
  readonly notifications: ManagedNotifications;
}

/** One tool invocation. */
interface ToolCall {
  readonly env: ToolEnv;
  readonly ctx: ExtensionContext;
  readonly trace: DelegationTrace;
  readonly signal: AbortSignal | undefined;
}

type ControlCommand = Exclude<SubagentCommand, { kind: "run" | "spawn" }>;
type RunCommand = Extract<SubagentCommand, { kind: "run" }>;
type SpawnCommand = Extract<SubagentCommand, { kind: "spawn" }>;

const NESTED_MANAGED_MESSAGE =
  "Managed spawn and control actions are available only in a top-level Pi session; nested workers may use bounded action run.";
const PROJECT_AGENTS_DECLINED = "Canceled: project-local agents not approved.";
const FAILED_ASSIGNMENT_STATES: readonly string[] = [
  "failed",
  "timedOut",
  "aborted",
  "interrupted",
  "cancelled",
];

function notifyLifecycle(ctx: ExtensionContext, message: string): void {
  if (!ctx.hasUI) return;
  try {
    ctx.ui.notify(message, "warning");
  } catch {
    // The UI may be tearing down during shutdown or session replacement.
  }
}

function buildDetails(
  call: ToolCall,
  mode: BoundedMode,
  discovery: AgentDiscoveryResult | undefined,
  scope: AgentScope,
  results: readonly SingleResult[] = [],
): SubagentDetails {
  return {
    mode,
    agentScope: scope,
    projectAgentsDir: discovery?.projectAgentsDir ?? null,
    trace: call.trace,
    concurrency: call.env.resources.concurrency.status,
    results: results.map(toPersistedResult),
  };
}

function textResult(
  text: string,
  details: SubagentDetails,
): SubagentToolResult {
  return { content: [{ type: "text", text }], details };
}

function errorResult(
  text: string,
  details: SubagentDetails,
): SubagentToolResult {
  return { ...textResult(text, details), isError: true };
}

function managedText(call: ToolCall, text: string): SubagentToolResult {
  return textResult(
    boundManagedToolOutput(text),
    buildDetails(call, "single", undefined, "user"),
  );
}

function managedError(call: ToolCall, text: string): SubagentToolResult {
  return { ...managedText(call, text), isError: true };
}

/**
 * Delegated children launch a fresh Pi process. The parent's scopedModels only
 * controls its startup/cycling choices and can remain stale when models.json
 * changes during a long-lived session, so refresh before every launch.
 */
async function loadDelegationModels(ctx: ExtensionContext) {
  // SAFETY: Pi 0.80's refresh() was synchronous and took no options; newer Pi
  // accepts allowNetwork to avoid remote catalog requests per delegation.
  await (
    ctx.modelRegistry.refresh as (options: {
      allowNetwork: boolean;
    }) => void | Promise<unknown>
  )({ allowNetwork: false });
  const models = ctx.modelRegistry.getAvailable();
  return {
    availableModels: new Set(
      models.map((model) => `${model.provider}/${model.id}`.toLowerCase()),
    ) as ReadonlySet<string>,
    resolveModel: createModelResolver(models),
  };
}

/** Asks before running repo-controlled agents; resolves true when allowed. */
async function approveProjectAgents(
  ctx: ExtensionContext,
  selection: AgentSelection,
  discovery: AgentDiscoveryResult,
  agentNames: readonly string[],
): Promise<boolean> {
  if (selection.scope === "user" || !ctx.hasUI) return true;
  const requiringConfirmation = [...new Set(agentNames)]
    .map((name) => discovery.agents.find((agent) => agent.name === name))
    .filter(
      (agent): agent is AgentConfig =>
        agent?.source === "project" &&
        shouldConfirmProjectAgent(agent, selection.confirmProjectAgents),
    );
  if (requiringConfirmation.length === 0) return true;
  const names = requiringConfirmation
    .map((agent) => formatAgentDisplayName(agent))
    .join(", ");
  return ctx.ui.confirm(
    "Run project-local agents?",
    `Agents: ${names}\nSource: ${discovery.projectAgentsDir ?? "(unknown)"}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
  );
}

function planItems(plan: BoundedPlan): readonly BoundedItem[] {
  switch (plan.kind) {
    case "single":
      return [plan.item];
    case "parallel":
      return plan.items;
    case "chain":
      return plan.steps;
  }
}

function invalidPlanResult(
  plan: InvalidBoundedPlan,
  agents: readonly AgentConfig[],
  details: SubagentDetails,
): SubagentToolResult {
  switch (plan.problem) {
    case "modeCount": {
      const available =
        agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
      return textResult(
        `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
        details,
      );
    }
    case "contextOutsideParallel":
      return errorResult(
        "Invalid parameters. context is supported only with parallel tasks[].",
        details,
      );
  }
}

async function runCommand(
  call: ToolCall,
  command: RunCommand,
  onUpdate: AgentToolUpdateCallback<SubagentDetails> | undefined,
): Promise<SubagentToolResult> {
  const { ctx, env, trace } = call;
  const { limits, resources } = env;
  const sessionId = ctx.sessionManager.getSessionId();
  try {
    await resources.enter(sessionId);
  } catch (error) {
    return managedError(
      call,
      `Could not initialize subagent runtime: ${errorText(error)}`,
    );
  }
  if (currentDelegationDepth() === 0) {
    const liveWorkers =
      resources
        .existingRuntime(sessionId)
        ?.list()
        .filter((worker) => worker.live) ?? [];
    if (liveWorkers.length >= limits.maxConcurrency)
      return managedError(
        call,
        `All ${limits.maxConcurrency} subagent slots are held by managed workers: ${liveWorkers.map((worker) => worker.handle).join(", ")}. Stop a worker before running bounded work; yielding does not release a managed worker's slot.`,
      );
  }

  const profiles = env.loadProfiles();
  const { selection, plan } = command;
  const discovery = discoverAgents(ctx.cwd, selection.scope);
  const details = (
    mode: BoundedMode,
    results: readonly SingleResult[] = [],
  ): SubagentDetails =>
    buildDetails(call, mode, discovery, selection.scope, results);
  if (trace.depth > limits.maxDepth)
    return errorResult(
      `Subagent delegation blocked at depth ${trace.depth}; hard maximum is ${limits.maxDepth}.`,
      details("single"),
    );
  if (plan.kind === "invalid")
    return invalidPlanResult(plan, discovery.agents, details(plan.mode));
  const agentNames = planItems(plan).map((item) => item.agent);
  if (!(await approveProjectAgents(ctx, selection, discovery, agentNames)))
    return textResult(PROJECT_AGENTS_DECLINED, details(plan.kind));

  const models = await loadDelegationModels(ctx);
  const outcome = await runBoundedPlan(
    {
      defaultCwd: ctx.cwd,
      agents: discovery.agents,
      profiles,
      availableModels: models.availableModels,
      resolveModel: models.resolveModel,
      trace,
      limits,
      concurrency: resources.concurrency,
      processes: resources.processes,
      ...(call.signal ? { signal: call.signal } : {}),
    },
    plan,
    onUpdate
      ? (progress) =>
          onUpdate({
            content: [{ type: "text", text: progress.text }],
            details: details(progress.mode, progress.results),
          })
      : undefined,
  );
  if (outcome.kind === "aborted") throw new Error(outcome.message);
  const result = textResult(
    outcome.text,
    details(outcome.mode, outcome.results),
  );
  return outcome.isError ? { ...result, isError: true } : result;
}

type SpawnLine =
  | {
      readonly kind: "started";
      readonly text: string;
      readonly warning?: string;
    }
  | { readonly kind: "failed"; readonly text: string };

async function startWorker(
  runtime: ManagedRuntime,
  label: string,
  preparation: ManagedLaunchPreparation,
  signal: AbortSignal | undefined,
): Promise<SpawnLine> {
  if (!preparation.ok)
    return { kind: "failed", text: `- ${label}: ${preparation.error}` };
  try {
    const worker = await runtime.spawn(preparation.launch, signal);
    const view = runtime.status(worker.handle);
    const text = `- ${label}: worker-handle [${worker.handle}] assignment-id [${worker.assignmentId}]`;
    return view.hostKind === "rpc"
      ? { kind: "started", text, warning: formatManualManagedOpenHint(view) }
      : { kind: "started", text };
  } catch (error) {
    return {
      kind: "failed",
      text: `- ${label}: ${truncateManagedText(errorText(error), 2 * 1024)}`,
    };
  }
}

async function spawnCommand(
  call: ToolCall,
  command: SpawnCommand,
  runtime: ManagedRuntime,
): Promise<SubagentToolResult> {
  const { ctx, env, trace } = call;
  const { limits } = env;
  const profiles = env.loadProfiles();
  const { selection, launch } = command;
  const discovery = discoverAgents(ctx.cwd, selection.scope);
  if (trace.depth > limits.maxDepth)
    return managedError(
      call,
      `Managed spawn blocked at depth ${trace.depth}; hard maximum is ${limits.maxDepth}.`,
    );
  const requests = launch.kind === "batch" ? launch.requests : [launch.request];
  if (launch.kind === "batch" && requests.length > limits.maxChildrenPerCall)
    return managedError(
      call,
      `Too many managed tasks (${requests.length}). Max is ${limits.maxChildrenPerCall}.`,
    );
  const agentNames = requests.map((request) => request.agent);
  if (!(await approveProjectAgents(ctx, selection, discovery, agentNames)))
    return managedError(call, PROJECT_AGENTS_DECLINED);

  try {
    const models = await loadDelegationModels(ctx);
    const context =
      launch.kind === "batch" && launch.context !== undefined
        ? { context: launch.context }
        : {};
    const lines = await Promise.all(
      requests.map((request, index) =>
        startWorker(
          runtime,
          launch.kind === "batch" ? `Task ${index + 1}` : request.agent,
          prepareManagedLaunch({
            discovery,
            profiles,
            availableModelReferences: models.availableModels,
            resolveModel: models.resolveModel,
            defaultCwd: ctx.cwd,
            trace,
            ...context,
            request,
          }),
          call.signal,
        ),
      ),
    );
    const failures = lines.filter((line) => line.kind === "failed").length;
    const warnings = lines.flatMap((line) =>
      line.kind === "started" && line.warning ? [line.warning] : [],
    );
    if (ctx.hasUI && warnings.length)
      ctx.ui.notify(warnings.join("\n\n"), "warning");
    const text = [
      `Managed spawn ${failures === 0 ? "accepted" : `finished with ${failures} failure(s)`}:`,
      ...lines.map((line) => line.text),
      ...(failures < lines.length
        ? [
            "",
            "Results report automatically. To inspect sooner, ask me for status or to wait for a specific assignment; use /subagent to open or control the worker.",
          ]
        : []),
      ...(warnings.length ? ["", ...warnings] : []),
    ].join("\n");
    const response =
      failures === lines.length
        ? managedError(call, text)
        : managedText(call, text);
    return {
      ...response,
      details: {
        ...response.details,
        managedSpawn: {
          started: lines.length - failures,
          failed: failures,
          ...(warnings.length ? { manualOpen: true } : {}),
        },
      },
    };
  } catch (error) {
    return managedError(call, truncateManagedText(errorText(error), 2 * 1024));
  }
}

function formatWorkerStatus(runtime: ManagedRuntime, handle: string): string {
  const worker = runtime.status(handle);
  const assignments = worker.recentAssignments.slice(-5).map((entry) => {
    const outcome = entry.outcome?.result
      ? `\n  Result: ${truncateManagedText(entry.outcome.result, 4 * 1024)}`
      : "";
    return `\n- ${entry.id} · ${entry.state}${entry.disposition ? ` · ${entry.disposition}` : ""}\n  Task: ${truncateManagedText(entry.preview, 2 * 1024)}${outcome}`;
  });
  return [
    formatManagedWorkerSummary(worker),
    `Session: ${worker.sessionId}`,
    ...(worker.sessionFile ? [`Transcript: ${worker.sessionFile}`] : []),
    `Usage: ${formatUsageCompact(worker.usage, worker.model) || "not yet recorded"}`,
    `Latest assignments (${worker.recentAssignments.length} recorded):`,
    ...assignments,
  ].join("\n");
}

function formatWorkerList(runtime: ManagedRuntime): string {
  const workers = runtime.list();
  if (workers.length === 0) return "No managed subagents in this session.";
  const shown = workers.slice(0, 25).map(formatManagedWorkerSummary);
  return [
    `Managed subagents (${workers.length}):`,
    ...shown,
    ...(workers.length > shown.length
      ? [`… ${workers.length - shown.length} more`]
      : []),
  ].join("\n");
}

async function controlCommand(
  call: ToolCall,
  command: ControlCommand,
  runtime: ManagedRuntime,
): Promise<SubagentToolResult> {
  try {
    switch (command.kind) {
      case "list":
        return managedText(call, formatWorkerList(runtime));
      case "status":
        return managedText(call, formatWorkerStatus(runtime, command.handle));
      case "send": {
        const sent = runtime.send(
          command.handle,
          command.message,
          command.delivery,
        );
        return managedText(
          call,
          `Sent to ${command.handle} as ${sent.assignmentId} (${sent.state}).`,
        );
      }
      case "wait": {
        const assignment = await runtime.wait(command.handle, {
          ...(command.assignmentId !== undefined
            ? { assignmentId: command.assignmentId }
            : {}),
          ...(command.timeoutMs !== undefined
            ? { timeoutMs: command.timeoutMs }
            : {}),
          ...(call.signal ? { signal: call.signal } : {}),
        });
        call.env.notifications.markCollected(call.ctx, assignment);
        const state = assignment.waitTimedOut
          ? `${assignment.state} (wait timed out)`
          : assignment.state;
        const outcome = assignment.outcome?.result
          ? `\n${truncateManagedText(assignment.outcome.result)}`
          : "\n(no result recorded)";
        const artifacts = assignment.outcome?.artifacts ?? [];
        const usage = formatUsageCompact(assignment.usage, assignment.model);
        const text = `${assignment.handle} · ${assignment.id} · ${state}${outcome}${usage ? `\nUsage: ${usage}` : ""}${artifacts.length ? `\nArtifacts: ${artifacts.join(", ")}` : ""}`;
        return FAILED_ASSIGNMENT_STATES.includes(assignment.state)
          ? managedError(call, text)
          : managedText(call, text);
      }
      case "stop": {
        const worker = await runtime.stop(command.handle);
        return managedText(
          call,
          `Stopped; session and transcripts retained.\n${formatManagedWorkerSummary(worker)}`,
        );
      }
      case "resume": {
        const worker = await runtime.resume(command.handle);
        return managedText(
          call,
          `Resumed.\n${formatManagedWorkerSummary(worker)}`,
        );
      }
    }
  } catch (error) {
    return managedError(call, truncateManagedText(errorText(error), 2 * 1024));
  }
}

async function managedCommand(
  call: ToolCall,
  command: SpawnCommand | ControlCommand,
): Promise<SubagentToolResult> {
  const { ctx } = call;
  let runtime: ManagedRuntime;
  try {
    runtime = await call.env.resources.enterManaged(
      ctx.sessionManager.getSessionId(),
      (message) => notifyLifecycle(ctx, message),
    );
  } catch (error) {
    return managedError(
      call,
      `Could not initialize subagent runtime: ${errorText(error)}`,
    );
  }
  return command.kind === "spawn"
    ? spawnCommand(call, command, runtime)
    : controlCommand(call, command, runtime);
}

function describeTool(
  profiles: ModelProfilesConfig,
  limits: SubagentLimitsConfig,
): { description: string; promptGuidelines: string[] } {
  const initialUserAgents = discoverAgents(process.cwd(), "user").agents;
  const listedAgents = formatAgentList(initialUserAgents, 20);
  const agentGuidance = `${listedAgents.text}${listedAgents.remaining > 0 ? `; and ${listedAgents.remaining} more` : ""}`;
  const exampleAgent =
    initialUserAgents.find((agent) => agent.name === "redteam") ??
    initialUserAgents[0];
  const exampleProfile = profiles.profiles.thinker
    ? "thinker"
    : Object.keys(profiles.profiles)[0];
  const compositionExample =
    exampleAgent && exampleProfile
      ? ` Phrases "${exampleProfile} ${exampleAgent.name}" and "${exampleAgent.name} ${exampleProfile}" both mean agent "${exampleAgent.name}" with profile "${exampleProfile}".`
      : "";
  const profileGuidance = formatProfileGuidance(profiles);
  const maxTreeChildren =
    limits.maxDepth === 1
      ? limits.maxConcurrency
      : limits.maxConcurrency + limits.maxConcurrency ** 2;
  return {
    description: [
      'Delegate bounded tasks to specialized subagents with isolated context; use agent "bee" (🐝) for general execution.',
      `Agents select behavior and tools; profiles select compute. They compose independently, and their order in the user's wording does not matter.${compositionExample}`,
      `Available user agents: ${agentGuidance}.`,
      "Default action run preserves bounded single, parallel, and chain execution. Opt in with spawn for persistent managed workers; use status, list, send, wait, stop, and resume to control them by handle.",
      "Managed spawn accepts one agent/task or tasks[] with optional shared context; it does not support chains. Idle managed workers keep a shared concurrency slot until stopped or suspended.",
      "Parallel tasks may share one immutable context string that is prepended to every task.",
      `Execution profiles: ${profileGuidance}`,
      `Hard delegation limits: depth ${limits.maxDepth}; ${limits.maxConcurrency} active child processes per Pi session; ${limits.maxChildrenPerCall} children per call; ${maxTreeChildren} maximum active descendants across a fully expanded root tree. Completed children release their concurrency slots.`,
      `Child execution limits: ${formatDuration(limits.maxRuntimeMs)} total runtime; ${formatDuration(limits.maxInactivityMs)} without output. These limits do not apply to the orchestrator.`,
      "Full child stdout/stderr transcripts are stored as private JSONL artifacts; session details retain bounded previews and artifact paths.",
      "Each invocation may choose a profile or an explicit model; an explicit model overrides the profile and agent definition. Managed worker results report automatically to the parent; wait is optional for collecting a specific assignment. Interrupted tasks are never replayed automatically.",
      "Successful spawn confirmations, worker handles, assignment IDs, and control hints belong in the expanded tool output, not a separate assistant chat acknowledgement. Do not ask the user to wait or poll for automatic results.",
      "Isolation flags are opt-in; noExtensions still explicitly loads this package's child bridge and yield tool. noMcp is currently available for bounded runs only.",
      `Default agent scope is "user" (from ${path.join(getAgentDir(), "agents")}).`,
      `To enable project-local agents in ${CONFIG_DIR_NAME}/agents, set agentScope: "both" (or "project").`,
      "Agent frontmatter may set confirmProjectAgents; the invocation parameter overrides it.",
    ].join(" "),
    promptGuidelines: [
      `For subagent, agent and profile are independent: agent selects behavior and tools; profile selects compute. When the user names both in either order, preserve both.${compositionExample}`,
      `When invoking subagent, select the least expensive profile that safely fits the task: ${profileGuidance}`,
      `Bounded delegation is capped at depth ${limits.maxDepth}, ${limits.maxConcurrency} active child processes per Pi session, and ${limits.maxChildrenPerCall} children per call. Managed spawn is top-level only and uses the same process gate; idle workers retain slots.`,
      "Use action run (or omit action) for the existing bounded single/parallel/chain behavior. Use spawn only when the user needs a reusable worker with a stable handle.",
      "After a successful spawn, do not repeat the launch confirmation, worker handle, assignment ID, or control hints in chat. If spawning is the only request, finish without a prose acknowledgement; the tool output confirms startup and the result will report automatically. Still report launch errors and answer any other questions in the user's request.",
      "Use subagent model only for an exact model override; model takes precedence over profile.",
      "Use top-level context only for background or constraints shared by every parallel task or managed spawn batch.",
    ],
  };
}

function createSubagentTool(
  env: ToolEnv,
  profiles: ModelProfilesConfig,
): ToolDefinition<SubagentParams, SubagentDetails, SubagentRenderState> {
  const { description, promptGuidelines } = describeTool(profiles, env.limits);
  return {
    name: "subagent",
    label: "Subagent",
    description,
    promptSnippet:
      "Delegate bounded work or manage persistent subagents with optional execution profiles",
    promptGuidelines,
    parameters: createSubagentParams(profiles, env.limits),

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const call: ToolCall = {
        env,
        ctx,
        signal,
        trace: createDelegationTrace(
          ctx.sessionManager.getSessionId(),
          toolCallId,
        ),
      };
      const parsed = parseSubagentCall(params);
      const action = parsed.ok ? parsed.command.kind : parsed.action;
      if (action !== "run" && currentDelegationDepth() > 0)
        return managedError(call, NESTED_MANAGED_MESSAGE);
      if (!parsed.ok) return managedError(call, parsed.error);
      const { command } = parsed;
      return command.kind === "run"
        ? runCommand(call, command, onUpdate)
        : managedCommand(call, command);
    },

    renderCall(args, theme, context) {
      return renderSubagentCall(args, theme, context);
    },

    renderResult(result, options, theme) {
      return renderSubagentResult(result, options, theme);
    },
  };
}

export function registerSubagent(
  pi: ExtensionAPI,
  extensionDir = path.dirname(fileURLToPath(import.meta.url)),
  options: SubagentRegistrationOptions = {},
) {
  if (currentDelegationDepth() > 0 && !isManagedChildProcess())
    registerSubagentYield(pi);
  const profilesPath = resolveProfilesPath(getAgentDir());
  // Registration-time snapshot drives the tool schema (profile-name enum) and
  // description; call-time resolution reloads on file change so ladder edits
  // apply to long-running sessions without a restart.
  const profiles = loadModelProfiles(profilesPath);
  let profilesCache: SubagentProfilesCache | undefined;
  const loadProfiles = (): ModelProfilesConfig => {
    profilesCache = loadSubagentProfilesCurrent(profilesPath, profilesCache);
    return profilesCache.config;
  };
  const limits = loadSubagentLimits(path.join(extensionDir, "limits.json"));
  const resources = new SessionResources({
    limits,
    runtimeFactory: options.managedRuntimeFactory ?? getManagedRuntime,
    processRegistryFactory:
      options.processRegistryFactory ?? (() => new SubagentProcessRegistry()),
    runtimeOptions: (parentSessionId, gate) => ({
      parentSessionId,
      agentDir: getAgentDir(),
      limits,
      gate,
      env: process.env,
    }),
  });

  pi.on("session_start", async (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    try {
      if (currentDelegationDepth() > 0) await resources.enter(sessionId);
      else
        await resources.enterManaged(sessionId, (message) =>
          notifyLifecycle(ctx, message),
        );
    } catch (error) {
      notifyLifecycle(
        ctx,
        `Could not initialize managed subagents: ${errorText(error)}`,
      );
    }
  });
  pi.on("session_shutdown", (event, ctx) =>
    resources.shutdown(event.reason, (reason) =>
      notifyLifecycle(
        ctx,
        `Could not suspend managed subagents: ${errorText(reason)}`,
      ),
    ),
  );
  // Registered after the session handlers above so the runtime exists before reports start.
  const notifications = registerManagedNotifications(pi, async (ctx) =>
    currentDelegationDepth() > 0
      ? undefined
      : resources.reportingRuntime(ctx.sessionManager.getSessionId()),
  );

  pi.registerTool(
    createSubagentTool(
      { limits, resources, loadProfiles, notifications },
      profiles,
    ),
  );
  registerManagedUi(
    pi,
    (ctx) => {
      if (currentDelegationDepth() > 0)
        throw new ManagedError(
          "depth",
          "Managed subagents are only available in a top-level Pi session.",
        );
      return resources.runtimeForUi(ctx.sessionManager.getSessionId());
    },
    notifications.isReported,
  );
}
