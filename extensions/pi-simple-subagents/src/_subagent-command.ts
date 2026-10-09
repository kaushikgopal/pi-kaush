/**
 * Parses raw `subagent` tool arguments into exactly one command. Mixed control
 * and launch fields are rejected here, and per-item tools/isolation/cwd
 * inheritance is resolved once so handlers never re-read raw parameters.
 */
import type { AgentScope } from "./_definition.ts";
import type { SubagentIsolationOptions } from "./_execution.ts";
import type { ManagedDelivery } from "./_managed.ts";
import type {
  ManagedIsolationOptions,
  ManagedLaunchRequest,
} from "./_managed-tool.ts";
import {
  booleanValue,
  finiteNumber,
  isPlainRecord,
  nonEmptyString,
  oneOf,
  stringArray,
  stringValue,
} from "./_parse.ts";

/** One bounded child: agent, task, and resolved launch overrides. */
export interface BoundedItem {
  readonly agent: string;
  readonly task: string;
  readonly profile?: string;
  readonly model?: string;
  readonly cwd?: string;
  readonly tools?: readonly string[];
  readonly isolation?: SubagentIsolationOptions;
}

export type BoundedPlan =
  | { readonly kind: "single"; readonly item: BoundedItem }
  | {
      readonly kind: "parallel";
      readonly items: readonly BoundedItem[];
      readonly context?: string;
    }
  | { readonly kind: "chain"; readonly steps: readonly BoundedItem[] };

export type BoundedMode = BoundedPlan["kind"];

/**
 * A run whose mode shape is invalid. It is reported after the depth gate and
 * agent discovery, because its message lists the available agents.
 */
export interface InvalidBoundedPlan {
  readonly kind: "invalid";
  readonly problem: "modeCount" | "contextOutsideParallel";
  /** Mode recorded in the error result's details. */
  readonly mode: "single" | "chain";
}

export interface AgentSelection {
  readonly scope: AgentScope;
  readonly confirmProjectAgents?: boolean;
}

export type SpawnLaunch =
  | { readonly kind: "single"; readonly request: ManagedLaunchRequest }
  | {
      readonly kind: "batch";
      readonly requests: readonly ManagedLaunchRequest[];
      readonly context?: string;
    };

export type SubagentCommand =
  | { readonly kind: "list" }
  | { readonly kind: "status"; readonly handle: string }
  | {
      readonly kind: "send";
      readonly handle: string;
      readonly message: string;
      readonly delivery: ManagedDelivery;
    }
  | {
      readonly kind: "wait";
      readonly handle: string;
      readonly assignmentId?: string;
      readonly timeoutMs?: number;
    }
  | { readonly kind: "stop"; readonly handle: string }
  | { readonly kind: "resume"; readonly handle: string }
  | {
      readonly kind: "spawn";
      readonly selection: AgentSelection;
      readonly launch: SpawnLaunch;
    }
  | {
      readonly kind: "run";
      readonly selection: AgentSelection;
      readonly plan: BoundedPlan | InvalidBoundedPlan;
    };

export type ParsedSubagentCall =
  | { readonly ok: true; readonly command: SubagentCommand }
  | {
      readonly ok: false;
      /** The requested action, so callers can gate nested sessions before reporting. */
      readonly action: string;
      readonly error: string;
    };

const CONTROL_FIELDS = [
  "handle",
  "assignmentId",
  "message",
  "delivery",
  "waitTimeoutMs",
] as const;
const INVOCATION_FIELDS = [
  "agent",
  "task",
  "profile",
  "model",
  "context",
  "tasks",
  "chain",
  "cwd",
  "agentScope",
  "confirmProjectAgents",
  "isolation",
  "tools",
] as const;
const CONTROL_ACTIONS = [
  "status",
  "list",
  "send",
  "wait",
  "stop",
  "resume",
] as const;
const AGENT_SCOPES = ["user", "project", "both"] as const;
const DELIVERIES = ["auto", "followUp"] as const;
const MAX_WAIT_TIMEOUT_MS = 86_400_000;

type RawParams = Readonly<Record<string, unknown>>;
type Fail = (error: string) => ParsedSubagentCall;

function supplied(value: unknown): boolean {
  return value !== undefined && value !== null;
}

/** Drops undefined entries so optional fields stay absent under exactOptionalPropertyTypes. */
function definedFields<T extends Record<string, unknown>>(
  fields: T,
): { [K in keyof T]?: Exclude<T[K], undefined> } {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields))
    if (value !== undefined) result[key] = value;
  // SAFETY: result holds exactly the keys of `fields` whose values are defined.
  return result as { [K in keyof T]?: Exclude<T[K], undefined> };
}

function parseIsolation(value: unknown): ManagedIsolationOptions | undefined {
  if (!isPlainRecord(value)) return undefined;
  return definedFields({
    noExtensions: booleanValue(value.noExtensions),
    noSkills: booleanValue(value.noSkills),
    noContextFiles: booleanValue(value.noContextFiles),
    noPromptTemplates: booleanValue(value.noPromptTemplates),
    noMcp: booleanValue(value.noMcp),
  });
}

function hasEmptyToolOverride(raw: RawParams): boolean {
  const empty = (value: unknown): boolean =>
    Array.isArray(value) && value.length === 0;
  const itemOverrides = [raw.tasks, raw.chain].flatMap((value) =>
    Array.isArray(value) ? value.filter(isPlainRecord) : [],
  );
  return empty(raw.tools) || itemOverrides.some((item) => empty(item.tools));
}

function parseSelection(raw: RawParams): AgentSelection {
  return {
    scope: oneOf(raw.agentScope, AGENT_SCOPES) ?? "user",
    ...definedFields({
      confirmProjectAgents: booleanValue(raw.confirmProjectAgents),
    }),
  };
}

/** Items of a tasks[]/chain[] array, or undefined when any item lacks string agent and task. */
function parseItemRecords(
  value: unknown,
): ReadonlyArray<RawParams & { agent: string; task: string }> | undefined {
  if (!Array.isArray(value)) return [];
  const items: Array<RawParams & { agent: string; task: string }> = [];
  for (const item of value) {
    if (!isPlainRecord(item)) return undefined;
    const agent = stringValue(item.agent);
    const task = stringValue(item.task);
    if (agent === undefined || task === undefined) return undefined;
    items.push({ ...item, agent, task });
  }
  return items;
}

/** Parallel tasks and chain steps inherit tools and isolation, never cwd. */
function boundedListItem(
  item: RawParams & { agent: string; task: string },
  raw: RawParams,
): BoundedItem {
  return {
    agent: item.agent,
    task: item.task,
    ...definedFields({
      profile: stringValue(item.profile),
      model: stringValue(item.model),
      cwd: stringValue(item.cwd),
      tools: stringArray(item.tools ?? raw.tools),
      isolation: parseIsolation(item.isolation ?? raw.isolation),
    }),
  };
}

function parseRun(raw: RawParams, fail: Fail): ParsedSubagentCall {
  const selection = parseSelection(raw);
  const steps = parseItemRecords(raw.chain);
  if (!steps)
    return fail(
      "Invalid parameters. Every chain step needs an agent and task.",
    );
  const tasks = parseItemRecords(raw.tasks);
  if (!tasks)
    return fail(
      "Invalid parameters. Every parallel task needs an agent and task.",
    );
  const singleAgent = nonEmptyString(raw.agent);
  const singleTask = nonEmptyString(raw.task);

  const hasChain = steps.length > 0;
  const hasTasks = tasks.length > 0;
  const hasSingle = singleAgent !== undefined && singleTask !== undefined;
  const run = (plan: BoundedPlan | InvalidBoundedPlan): ParsedSubagentCall => ({
    ok: true,
    command: { kind: "run", selection, plan },
  });

  if (Number(hasChain) + Number(hasTasks) + Number(hasSingle) !== 1)
    return run({ kind: "invalid", problem: "modeCount", mode: "single" });
  const context = stringValue(raw.context)?.trim() || undefined;
  if (context !== undefined && !hasTasks)
    return run({
      kind: "invalid",
      problem: "contextOutsideParallel",
      mode: hasChain ? "chain" : "single",
    });

  if (hasChain)
    return run({
      kind: "chain",
      steps: steps.map((step) => boundedListItem(step, raw)),
    });
  if (hasTasks)
    return run({
      kind: "parallel",
      items: tasks.map((task) => boundedListItem(task, raw)),
      ...definedFields({ context }),
    });
  // SAFETY: hasSingle established both values are defined.
  const item: BoundedItem = {
    agent: singleAgent!,
    task: singleTask!,
    ...definedFields({
      profile: stringValue(raw.profile),
      model: stringValue(raw.model),
      cwd: stringValue(raw.cwd),
      tools: stringArray(raw.tools),
      isolation: parseIsolation(raw.isolation),
    }),
  };
  return run({ kind: "single", item });
}

/** Managed requests omit empty strings; batch items inherit cwd, tools, and isolation. */
function managedRequest(
  agent: string,
  task: string,
  own: RawParams,
  inherited: RawParams,
): ManagedLaunchRequest {
  return {
    agent,
    task,
    ...definedFields({
      profile: nonEmptyString(own.profile),
      model: nonEmptyString(own.model),
      cwd: nonEmptyString(own.cwd ?? inherited.cwd),
      tools: stringArray(own.tools ?? inherited.tools),
      isolation: parseIsolation(own.isolation ?? inherited.isolation),
    }),
  };
}

function parseSpawn(
  raw: RawParams,
  controls: readonly string[],
  fail: Fail,
): ParsedSubagentCall {
  if (controls.length > 0)
    return fail(
      `Action "spawn" does not accept managed control fields: ${controls.join(", ")}.`,
    );
  if (supplied(raw.chain))
    return fail(
      'Managed spawn does not support chains; use action "run" for bounded chains.',
    );
  const single = supplied(raw.agent) || supplied(raw.task);
  const batch = supplied(raw.tasks);
  if (batch && (!Array.isArray(raw.tasks) || raw.tasks.length === 0))
    return fail('Action "spawn" requires a non-empty tasks[] batch.');
  if (Number(single) + Number(batch) !== 1)
    return fail(
      'Action "spawn" requires exactly one agent/task or a tasks[] batch.',
    );

  const selection = parseSelection(raw);
  if (!batch) {
    const agent = stringValue(raw.agent);
    const task = stringValue(raw.task);
    if (agent === undefined || task === undefined)
      return fail('Action "spawn" single mode requires both agent and task.');
    if (supplied(raw.context))
      return fail('Action "spawn" context is supported only with tasks[].');
    return {
      ok: true,
      command: {
        kind: "spawn",
        selection,
        launch: {
          kind: "single",
          request: managedRequest(agent, task, raw, {}),
        },
      },
    };
  }
  if (supplied(raw.profile) || supplied(raw.model))
    return fail(
      'Action "spawn" tasks[] takes profile/model on each task, not at the top level.',
    );
  const items = parseItemRecords(raw.tasks);
  if (!items)
    return fail('Action "spawn" tasks[] items require an agent and task.');
  return {
    ok: true,
    command: {
      kind: "spawn",
      selection,
      launch: {
        kind: "batch",
        requests: items.map((item) =>
          managedRequest(item.agent, item.task, item, raw),
        ),
        ...definedFields({ context: stringValue(raw.context) }),
      },
    },
  };
}

function parseControl(
  action: (typeof CONTROL_ACTIONS)[number],
  raw: RawParams,
  controls: readonly string[],
  fail: Fail,
): ParsedSubagentCall {
  const ok = (command: SubagentCommand): ParsedSubagentCall => ({
    ok: true,
    command,
  });
  const invocation = INVOCATION_FIELDS.filter((field) => supplied(raw[field]));
  if (invocation.length > 0)
    return fail(
      `Action "${action}" does not accept launch fields: ${invocation.join(", ")}.`,
    );
  if (action === "list") {
    if (controls.length > 0)
      return fail(
        `Action "list" does not accept control fields: ${controls.join(", ")}.`,
      );
    return ok({ kind: "list" });
  }
  const handle = stringValue(raw.handle);
  if (handle === undefined || !handle.trim())
    return fail(`Action "${action}" requires a non-empty handle.`);

  if (action === "send") {
    const message = stringValue(raw.message);
    if (message === undefined || !message.trim())
      return fail('Action "send" requires a non-empty message.');
    if (supplied(raw.assignmentId) || supplied(raw.waitTimeoutMs))
      return fail(
        'Action "send" does not accept assignmentId or waitTimeoutMs.',
      );
    const delivery = oneOf(raw.delivery, DELIVERIES);
    if (supplied(raw.delivery) && !delivery)
      return fail('Action "send" delivery must be "auto" or "followUp".');
    return ok({ kind: "send", handle, message, delivery: delivery ?? "auto" });
  }
  if (action === "wait") {
    if (supplied(raw.message) || supplied(raw.delivery))
      return fail('Action "wait" does not accept message or delivery.');
    const timeoutMs = finiteNumber(raw.waitTimeoutMs);
    if (
      supplied(raw.waitTimeoutMs) &&
      (timeoutMs === undefined ||
        timeoutMs < 0 ||
        timeoutMs > MAX_WAIT_TIMEOUT_MS)
    )
      return fail(
        `waitTimeoutMs must be between 0 and ${MAX_WAIT_TIMEOUT_MS}.`,
      );
    const assignmentId = stringValue(raw.assignmentId);
    if (
      supplied(raw.assignmentId) &&
      (assignmentId === undefined || !assignmentId.trim())
    )
      return fail("assignmentId must be a non-empty string.");
    return ok({
      kind: "wait",
      handle,
      ...definedFields({ assignmentId, timeoutMs }),
    });
  }
  if (controls.some((field) => field !== "handle"))
    return fail(`Action "${action}" accepts only handle.`);
  return ok({ kind: action, handle });
}

/** Parses raw tool parameters; error text is shown to the model verbatim. */
export function parseSubagentCall(params: unknown): ParsedSubagentCall {
  const raw: RawParams = isPlainRecord(params) ? params : {};
  const action = stringValue(raw.action) ?? "run";
  const fail: Fail = (error) => ({ ok: false, action, error });

  if (hasEmptyToolOverride(raw))
    return fail(
      "An empty tools override is not supported; omit tools to use the agent's configured tools.",
    );
  const controls = CONTROL_FIELDS.filter((field) => supplied(raw[field]));
  if (action === "run") {
    if (controls.length > 0)
      return fail(
        `Action "run" does not accept managed control fields: ${controls.join(", ")}.`,
      );
    return parseRun(raw, fail);
  }
  if (action === "spawn") return parseSpawn(raw, controls, fail);
  const control = oneOf(action, CONTROL_ACTIONS);
  if (!control) return fail(`Unknown subagent action "${action}".`);
  return parseControl(control, raw, controls, fail);
}
