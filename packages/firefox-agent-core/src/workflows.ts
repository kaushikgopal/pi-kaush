// Workflow plans use the same explicit, deterministic browser-operation style as surf-cli:
// https://github.com/nicobailon/surf-cli
export type WorkflowJson =
  | null
  | boolean
  | number
  | string
  | WorkflowJson[]
  | { [key: string]: WorkflowJson };

export type WorkflowJsonObject = { [key: string]: WorkflowJson };

export type WorkflowOperationType =
  | "navigate"
  | "read"
  | "locate"
  | "click"
  | "fill"
  | "key"
  | "scroll"
  | "select"
  | "wait"
  | "extract";

export type WorkflowOperationStep = WorkflowJsonObject & {
  type: WorkflowOperationType;
};

export type WorkflowStep =
  | (WorkflowOperationStep & { as?: string })
  | {
      type: "assert";
      actual: WorkflowJson;
      op: "equals" | "notEquals" | "contains" | "exists";
      expected?: WorkflowJson;
      as?: string;
    }
  | {
      type: "repeat";
      count: number;
      steps: WorkflowStep[];
    }
  | {
      type: "each";
      items: string | WorkflowJson[];
      as: string;
      steps: WorkflowStep[];
    };

export type FirefoxWorkflowInput = {
  steps: WorkflowStep[];
  args?: WorkflowJsonObject;
  dryRun?: boolean;
  allowWrite?: boolean;
  onError?: "stop" | "continue";
};

export type WorkflowResolvedArgs = {
  args: WorkflowJsonObject;
  captures: WorkflowJsonObject;
};

export type WorkflowPortResult = {
  ok: boolean;
  result?: WorkflowJson;
  code?: string;
  message?: string;
};

export type FirefoxWorkflowPort = {
  execute(
    step: WorkflowOperationStep,
    resolvedArgs: WorkflowResolvedArgs,
  ): Promise<WorkflowPortResult>;
};

export type WorkflowStepOutcome = {
  path: string;
  type: string;
  ok: boolean;
  result?: WorkflowJson;
  code?: string;
  message?: string;
};

export type FirefoxWorkflowResult = {
  ok: boolean;
  dryRun: boolean;
  stopped: boolean;
  plannedOperations: number;
  outcomes: WorkflowStepOutcome[];
  captures: WorkflowJsonObject;
  code?: string;
  message?: string;
};

export type FirefoxWorkflowOptions = { signal?: AbortSignal };

const MAX_INPUT_STEPS = 128;
const MAX_EXPANDED_STEPS = 128;
const MAX_LOOP_COUNT = 32;
const MAX_NESTING = 5;
const MAX_CAPTURES = 32;
const MAX_CAPTURE_BYTES = 4_096;
const MAX_RESULT_BYTES = 16_384;
const MAX_WAIT_MS = 30_000;
const MAX_JSON_DEPTH = 12;
const MAX_ARRAY_ITEMS = 256;
const MAX_OBJECT_KEYS = 128;
const SAFE_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u;
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9_-]{1,64}$/u;
const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const WRITE_TYPES = new Set([
  "navigate",
  "click",
  "fill",
  "key",
  "scroll",
  "select",
]);
const OPERATION_TYPES = new Set<WorkflowOperationType>([
  "navigate",
  "read",
  "locate",
  "click",
  "fill",
  "key",
  "scroll",
  "select",
  "wait",
  "extract",
]);
const SAFETY_CODES = new Set([
  "aborted",
  "confirmation_required",
  "container_conflict",
  "private_window",
  "stale_ref",
  "unknown_outcome",
  "unsafe_url",
  "write_gate",
  "assertion_failed",
  "port_error",
  "invalid_port_result",
  "result_limit",
  "owned_tab_missing",
  "browser_epoch_changed",
  "browser_epoch_unknown",
  "replacement_ambiguous",
  "malformed_state",
  "unsafe_path",
]);

type Validation =
  | { ok: true; writes: boolean; operations: number; declared?: Set<string> }
  | { ok: false; code: string; message: string };

export async function runFirefoxWorkflow(
  input: FirefoxWorkflowInput,
  port: FirefoxWorkflowPort,
  options: FirefoxWorkflowOptions = {},
): Promise<FirefoxWorkflowResult> {
  const invalid = validateWorkflow(input);
  if (!invalid.ok)
    return failure(invalid.code, invalid.message, input?.dryRun === true);
  if (invalid.writes && input.allowWrite !== true) {
    return failure(
      "write_gate",
      "Workflow contains write operations; set allowWrite to true.",
      input.dryRun === true,
    );
  }
  if (!port || typeof port.execute !== "function") {
    return failure(
      "invalid_port",
      "Workflow port is invalid.",
      input.dryRun === true,
    );
  }

  const args = cloneJsonObject(input.args ?? {});
  if (!args.ok)
    return failure(
      "invalid_args",
      "Workflow arguments are not bounded JSON data.",
      input.dryRun === true,
    );
  const state: RunState = {
    args: args.value,
    captures: {},
    outcomes: [],
    executed: 0,
    stopped: false,
    failed: false,
    onError: input.onError ?? "stop",
  };
  if (input.dryRun === true) {
    return {
      ok: true,
      dryRun: true,
      stopped: false,
      plannedOperations: invalid.operations,
      outcomes: [],
      captures: {},
    };
  }

  let terminalError: { code: string; message: string } | undefined;
  try {
    await runSteps(input.steps, port, state, options.signal, "", 0);
  } catch (error) {
    const code = error instanceof WorkflowStop ? error.code : "workflow_error";
    const message =
      error instanceof WorkflowStop
        ? error.message
        : "Workflow stopped safely.";
    terminalError = { code, message };
    state.failed = true;
    state.stopped = true;
    const path = error instanceof WorkflowStop ? error.path : "";
    const type = error instanceof WorkflowStop ? error.type : "workflow";
    const alreadyRecorded = state.outcomes.some(
      (outcome) =>
        outcome.path === path && outcome.code === code && !outcome.ok,
    );
    if (!alreadyRecorded)
      state.outcomes.push({ path, type, ok: false, code, message });
  }
  return {
    ok: !state.failed,
    dryRun: false,
    stopped: state.stopped,
    plannedOperations: invalid.operations,
    outcomes: state.outcomes,
    captures: state.captures,
    ...(terminalError ?? {}),
  };
}

type RunState = {
  args: WorkflowJsonObject;
  captures: WorkflowJsonObject;
  outcomes: WorkflowStepOutcome[];
  executed: number;
  stopped: boolean;
  failed: boolean;
  onError: "stop" | "continue";
};

class WorkflowStop extends Error {
  constructor(
    readonly code: string,
    override readonly message: string,
    readonly path: string,
    readonly type: string,
  ) {
    super(message);
  }
}

function validateWorkflow(input: FirefoxWorkflowInput): Validation {
  if (
    !isPlainObject(input) ||
    !hasOnlyKeys(input, ["steps", "args", "dryRun", "allowWrite", "onError"]) ||
    !Array.isArray(input.steps) ||
    input.steps.length > MAX_INPUT_STEPS
  ) {
    return {
      ok: false,
      code: "invalid_workflow",
      message: "Workflow must contain a bounded steps array.",
    };
  }
  if (input.dryRun !== undefined && typeof input.dryRun !== "boolean")
    return invalidInput();
  if (input.allowWrite !== undefined && typeof input.allowWrite !== "boolean")
    return invalidInput();
  if (
    input.onError !== undefined &&
    input.onError !== "stop" &&
    input.onError !== "continue"
  )
    return invalidInput();
  const args = cloneJsonObject(input.args ?? {});
  if (!args.ok)
    return {
      ok: false,
      code: "invalid_args",
      message: "Workflow arguments are not bounded JSON data.",
    };
  const safeInput = { ...input, args: args.value };
  if (
    !isSafeData(safeInput) ||
    new TextEncoder().encode(JSON.stringify(safeInput)).byteLength > 131_072
  ) {
    return {
      ok: false,
      code: "workflow_limit",
      message: "Workflow input exceeds its data limit.",
    };
  }

  type Analysis = Validation;
  let visitedSteps = 0;
  const analyze = (
    steps: unknown[],
    available: Set<string>,
    depth: number,
  ): Analysis => {
    if (depth > MAX_NESTING || steps.length > MAX_INPUT_STEPS) {
      return {
        ok: false,
        code: "workflow_limit",
        message: "Workflow nesting or step count exceeds its limit.",
      };
    }
    let operations = 0;
    let writes = false;
    const declared = new Set<string>();
    for (const raw of steps) {
      visitedSteps++;
      if (visitedSteps > MAX_INPUT_STEPS)
        return {
          ok: false,
          code: "workflow_limit",
          message: "Workflow input exceeds its step limit.",
        };
      if (
        !isPlainObject(raw) ||
        !isSafeData(raw) ||
        typeof raw.type !== "string"
      )
        return {
          ok: false,
          code: "invalid_step",
          message: "Workflow step is invalid.",
        };
      const step = raw;
      const type = step.type as string;
      if (type === "repeat" || type === "each") {
        const keys =
          type === "repeat"
            ? ["type", "count", "steps"]
            : ["type", "items", "as", "steps"];
        if (!hasOnlyKeys(step, keys) || !Array.isArray(step.steps))
          return invalidStep();
        let multiplier = 0;
        let local = new Set(available);
        if (type === "repeat") {
          if (!isInt(step.count, 0, Number.MAX_SAFE_INTEGER))
            return invalidStep();
          if (step.count > MAX_LOOP_COUNT)
            return {
              ok: false,
              code: "workflow_limit",
              message: "Repeat count exceeds its limit.",
            };
          multiplier = step.count;
        } else {
          if (!isCaptureName(step.as) || !isSafeData(step.items))
            return invalidStep();
          local.add(step.as);
          if (Array.isArray(step.items)) {
            if (step.items.length > MAX_LOOP_COUNT)
              return {
                ok: false,
                code: "workflow_limit",
                message: "Each loop exceeds its item limit.",
              };
            multiplier = step.items.length;
          } else if (
            typeof step.items === "string" &&
            /^%\{arg\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*\}$/u.test(step.items)
          ) {
            const resolved = resolveArgsOnly(step.items, args.value);
            if (
              !resolved.ok ||
              !Array.isArray(resolved.value) ||
              resolved.value.length > MAX_LOOP_COUNT
            ) {
              return {
                ok: false,
                code: "workflow_limit",
                message: "Each loop needs a bounded array.",
              };
            }
            multiplier = resolved.value.length;
          } else if (
            typeof step.items === "string" &&
            /^%\{capture\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*\}$/u.test(
              step.items,
            )
          ) {
            const refs = validateReferences(step.items, args.value, available);
            if (refs) return refs;
            multiplier = MAX_LOOP_COUNT;
          } else {
            return {
              ok: false,
              code: "invalid_step",
              message: "Each loop items must be an array or a data reference.",
            };
          }
        }
        const refs =
          type === "each" && typeof step.items === "string"
            ? validateReferences(step.items, args.value, available)
            : undefined;
        if (refs) return refs;
        const nested = analyze(step.steps, local, depth + 1);
        if (!nested.ok) return nested;
        operations += nested.operations * multiplier;
        writes ||= nested.writes;
        if (multiplier > 0) {
          for (const name of nested.declared ?? []) declared.add(name);
        }
      } else if (type === "assert") {
        if (
          !hasOnlyKeys(step, ["type", "actual", "op", "expected", "as"]) ||
          !["equals", "notEquals", "contains", "exists"].includes(
            String(step.op),
          ) ||
          !("actual" in step) ||
          !isSafeData(step.actual) ||
          (step.op !== "exists" && !("expected" in step)) ||
          (step.op === "exists" &&
            step.expected !== undefined &&
            typeof step.expected !== "boolean") ||
          (step.as !== undefined && !isCaptureName(step.as))
        )
          return invalidStep();
        operations++;
        if (operations > MAX_EXPANDED_STEPS)
          return {
            ok: false,
            code: "workflow_limit",
            message: "Expanded workflow exceeds its step limit.",
          };
        const refs = validateReferences(step.actual, args.value, available);
        if (refs) return refs;
        if (step.expected !== undefined) {
          const expectedRefs = validateReferences(
            step.expected,
            args.value,
            available,
          );
          if (expectedRefs) return expectedRefs;
        }
        if (step.as) {
          available.add(step.as);
          declared.add(step.as);
        }
      } else {
        if (!OPERATION_TYPES.has(type as WorkflowOperationType))
          return {
            ok: false,
            code: "unknown_effect",
            message: "Workflow contains an unsupported operation.",
          };
        const checked = validateOperation(step, type);
        if (!checked.ok) return checked;
        const refs = validateReferences(step, args.value, available);
        if (refs) return refs;
        const resolvedStep = resolveArgsOnly(step as WorkflowJson, args.value);
        if (resolvedStep.ok) {
          if (!isPlainObject(resolvedStep.value)) return invalidStep();
          const resolvedCheck = validateOperation(resolvedStep.value, type);
          if (!resolvedCheck.ok) return resolvedCheck;
          if (
            type === "navigate" &&
            !isSafeNavigationUrl(resolvedStep.value.url)
          ) {
            return {
              ok: false,
              code: "unsafe_url",
              message: "Workflow navigation URL is not allowed.",
            };
          }
        }
        operations++;
        writes ||= WRITE_TYPES.has(type);
        if (step.as !== undefined) {
          if (!isCaptureName(step.as)) return invalidStep();
          available.add(step.as);
          declared.add(step.as);
        }
      }
      if (operations > MAX_EXPANDED_STEPS)
        return {
          ok: false,
          code: "workflow_limit",
          message: "Expanded workflow exceeds its step limit.",
        };
      for (const name of declared) available.add(name);
    }
    return { ok: true, operations, writes, declared };
  };
  const result = analyze(input.steps, new Set(), 0);
  if (!result.ok) return result;
  if (result.operations > MAX_EXPANDED_STEPS)
    return {
      ok: false,
      code: "workflow_limit",
      message: "Expanded workflow exceeds its step limit.",
    };
  return { ok: true, writes: result.writes, operations: result.operations };
}

function validateOperation(
  step: Record<string, unknown>,
  type: string,
): Validation {
  const keys = Object.keys(step);
  if (keys.some((key) => DANGEROUS_KEYS.has(key)))
    return {
      ok: false,
      code: "invalid_step",
      message: "Workflow step contains an unsafe key.",
    };
  if (step.as !== undefined && !isCaptureName(step.as))
    return {
      ok: false,
      code: "invalid_step",
      message: "Capture name is invalid.",
    };
  const str = (key: string, required = false) =>
    step[key] === undefined
      ? !required
      : typeof step[key] === "string" && (step[key] as string).length <= 2_000;
  const suppliedString = (key: string) =>
    typeof step[key] === "string" && (step[key] as string).length <= 2_000;
  const nonemptyString = (key: string) =>
    suppliedString(key) && (step[key] as string).length > 0;
  switch (type) {
    case "navigate":
      if (!hasOnlyKeys(step, ["type", "url", "as"]) || !str("url", true))
        return invalidStep();
      break;
    case "read":
      if (
        !hasOnlyKeys(step, [
          "type",
          "mode",
          "ref",
          "depth",
          "maxBytes",
          "noText",
          "as",
        ]) ||
        (step.mode !== undefined &&
          !["summary", "full", "scoped", "text"].includes(String(step.mode))) ||
        (step.ref !== undefined && !nonemptyString("ref")) ||
        !isOptionalInt(step.depth, 0, 12) ||
        !isOptionalInt(step.maxBytes, 256, 16_000) ||
        (step.noText !== undefined && typeof step.noText !== "boolean")
      )
        return invalidStep();
      break;
    case "locate":
      if (
        !hasOnlyKeys(step, [
          "type",
          "role",
          "name",
          "text",
          "label",
          "exact",
          "as",
        ]) ||
        !["role", "name", "text", "label"].some((key) => nonemptyString(key)) ||
        ["role", "name", "text", "label"].some((key) => !str(key)) ||
        (step.exact !== undefined && typeof step.exact !== "boolean")
      )
        return invalidStep();
      break;
    case "click":
      if (
        !hasOnlyKeys(step, ["type", "ref", "locate", "as"]) ||
        (step.ref !== undefined && !nonemptyString("ref")) ||
        (step.locate !== undefined && !isLocator(step.locate)) ||
        (!nonemptyString("ref") && !isLocator(step.locate))
      )
        return invalidStep();
      break;
    case "fill":
      if (
        !hasOnlyKeys(step, ["type", "ref", "locate", "value", "as"]) ||
        (step.ref !== undefined && !nonemptyString("ref")) ||
        (!nonemptyString("ref") && !isLocator(step.locate)) ||
        !str("value", true)
      )
        return invalidStep();
      break;
    case "key":
      if (!hasOnlyKeys(step, ["type", "key", "as"]) || !nonemptyString("key"))
        return invalidStep();
      break;
    case "scroll":
      if (
        !hasOnlyKeys(step, ["type", "ref", "direction", "amount", "as"]) ||
        (step.ref !== undefined && !nonemptyString("ref")) ||
        !["up", "down", "left", "right"].includes(String(step.direction)) ||
        !isOptionalInt(step.amount, 1, 2_000)
      )
        return invalidStep();
      break;
    case "select":
      if (
        !hasOnlyKeys(step, ["type", "ref", "locate", "value", "as"]) ||
        (step.ref !== undefined && !nonemptyString("ref")) ||
        (!nonemptyString("ref") && !isLocator(step.locate)) ||
        !str("value", true)
      )
        return invalidStep();
      break;
    case "wait":
      if (
        !hasOnlyKeys(step, ["type", "ref", "text", "url", "timeoutMs", "as"]) ||
        !["ref", "text", "url"].some((key) => nonemptyString(key)) ||
        ["ref", "text", "url"].some((key) => !str(key)) ||
        !isOptionalInt(step.timeoutMs, 1, MAX_WAIT_MS)
      )
        return invalidStep();
      break;
    case "extract":
      if (
        !hasOnlyKeys(step, ["type", "fields", "as"]) ||
        !isPlainObject(step.fields) ||
        Object.keys(step.fields).length > 64
      )
        return invalidStep();
      break;
    default:
      return {
        ok: false,
        code: "unknown_effect",
        message: "Workflow contains an unsupported operation.",
      };
  }
  return { ok: true, writes: WRITE_TYPES.has(type), operations: 1 };
}

function isLocator(value: unknown): boolean {
  return (
    isPlainObject(value) &&
    hasOnlyKeys(value, ["role", "name", "text", "label", "exact"]) &&
    ["role", "name", "text", "label"].some(
      (key) => typeof value[key] === "string" && value[key].length > 0,
    ) &&
    ["role", "name", "text", "label"].every(
      (key) =>
        value[key] === undefined ||
        (typeof value[key] === "string" && value[key].length <= 500),
    ) &&
    (value.exact === undefined || typeof value.exact === "boolean")
  );
}

async function runSteps(
  steps: WorkflowStep[],
  port: FirefoxWorkflowPort,
  state: RunState,
  signal: AbortSignal | undefined,
  prefix: string,
  depth: number,
): Promise<void> {
  if (depth > MAX_NESTING)
    throw new WorkflowStop(
      "workflow_limit",
      "Workflow nesting exceeds its limit.",
      prefix,
      "workflow",
    );
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (!step) continue;
    const path = prefix ? prefix + "." + String(i) : String(i);
    if (signal?.aborted)
      throw new WorkflowStop(
        "aborted",
        "Workflow was cancelled.",
        path,
        String(step.type),
      );
    if (step.type === "repeat") {
      for (let n = 0; n < step.count; n++)
        await runSteps(
          step.steps,
          port,
          state,
          signal,
          path + "[" + String(n) + "]",
          depth + 1,
        );
      continue;
    }
    if (step.type === "each") {
      const items = resolveValue(step.items as WorkflowJson, state);
      if (!Array.isArray(items) || items.length > MAX_LOOP_COUNT)
        throw new WorkflowStop(
          "workflow_limit",
          "Each loop source is not a bounded array.",
          path,
          "each",
        );
      for (let n = 0; n < items.length; n++) {
        setCapture(state, step.as, items[n] as WorkflowJson, path, "each");
        await runSteps(
          step.steps,
          port,
          state,
          signal,
          path + "[" + String(n) + "]",
          depth + 1,
        );
      }
      continue;
    }
    state.executed++;
    if (state.executed > MAX_EXPANDED_STEPS)
      throw new WorkflowStop(
        "workflow_limit",
        "Expanded workflow exceeds its step limit.",
        path,
        step.type,
      );
    if (step.type === "assert") {
      let actual: WorkflowJson;
      let present = true;
      let expected: WorkflowJson | undefined;
      try {
        if (step.op === "exists" && typeof step.actual === "string") {
          const reference = /^%\{([^{}]+)\}$/u.exec(step.actual);
          const parsed = reference
            ? parseReference(reference[1] ?? "")
            : undefined;
          if (parsed) {
            const root = parsed.source === "arg" ? state.args : state.captures;
            const resolved = readPath(root, parsed.parts);
            present = resolved.ok;
            actual = resolved.ok ? resolved.value : null;
          } else {
            actual = resolveValue(step.actual, state);
          }
        } else {
          actual = resolveValue(step.actual, state);
        }
        expected =
          step.expected === undefined
            ? undefined
            : resolveValue(step.expected, state);
      } catch {
        throw new WorkflowStop(
          "invalid_reference",
          "Workflow assertion reference could not be resolved.",
          path,
          "assert",
        );
      }
      const pass =
        step.op === "exists"
          ? present === (expected === undefined ? true : expected)
          : testAssertion(actual, step.op, expected);
      const result = boundedJson(
        { passed: pass, actual: cloneJson(actual) },
        MAX_RESULT_BYTES,
      );
      if (result === undefined)
        throw new WorkflowStop(
          "result_limit",
          "Workflow assertion result exceeded its limit.",
          path,
          "assert",
        );
      if (step.as) setCapture(state, step.as, result, path, "assert");
      state.outcomes.push({
        path,
        type: "assert",
        ok: pass,
        result,
        ...(!pass
          ? { code: "assertion_failed", message: "Workflow assertion failed." }
          : {}),
      });
      if (!pass) {
        state.failed = true;
        throw new WorkflowStop(
          "assertion_failed",
          "Workflow assertion failed.",
          path,
          "assert",
        );
      }
      continue;
    }
    let resolved: WorkflowJson;
    try {
      resolved = resolveValue(step, state);
    } catch {
      throw new WorkflowStop(
        "invalid_reference",
        "Workflow substitution could not be resolved.",
        path,
        step.type,
      );
    }
    if (!isPlainObject(resolved))
      throw new WorkflowStop(
        "invalid_step",
        "Resolved workflow step is invalid.",
        path,
        step.type,
      );
    const resolvedValidation = validateOperation(resolved, step.type);
    if (!resolvedValidation.ok)
      throw new WorkflowStop(
        resolvedValidation.code,
        resolvedValidation.message,
        path,
        step.type,
      );
    if (step.type === "navigate" && !isSafeNavigationUrl(resolved.url)) {
      throw new WorkflowStop(
        "unsafe_url",
        "Workflow navigation URL is not allowed.",
        path,
        step.type,
      );
    }
    const operation = { ...resolved } as WorkflowOperationStep;
    delete operation.as;
    let result: WorkflowPortResult;
    try {
      result = await port.execute(operation, {
        args: state.args,
        captures: state.captures,
      });
    } catch {
      result = {
        ok: false,
        code: "port_error",
        message: "Workflow operation failed.",
      };
    }
    if (signal?.aborted)
      throw new WorkflowStop(
        "aborted",
        "Workflow was cancelled.",
        path,
        step.type,
      );
    if (!isPortResult(result)) {
      result = {
        ok: false,
        code: "invalid_port_result",
        message: "Workflow port returned an invalid result.",
      };
    }
    if (result.ok) {
      const output =
        result.result === undefined
          ? undefined
          : boundedJson(result.result, MAX_RESULT_BYTES);
      if (result.result !== undefined && output === undefined) {
        state.outcomes.push({
          path,
          type: step.type,
          ok: false,
          code: "result_limit",
          message: "Workflow result exceeded its limit.",
        });
        state.failed = true;
        throw new WorkflowStop(
          "result_limit",
          "Workflow result exceeded its limit.",
          path,
          step.type,
        );
      }
      const outcome: WorkflowStepOutcome = { path, type: step.type, ok: true };
      if (output !== undefined) outcome.result = output;
      state.outcomes.push(outcome);
      if (step.as) setCapture(state, step.as, output ?? null, path, step.type);
    } else {
      const code = safeCode(result.code);
      const message = safeMessage(result.message);
      state.outcomes.push({ path, type: step.type, ok: false, code, message });
      const safety = isSafetyFailure(code) || WRITE_TYPES.has(step.type);
      state.failed = true;
      if (safety || stepsOnErrorStop(state)) {
        throw new WorkflowStop(code, message, path, step.type);
      }
    }
    if (state.outcomes.length > MAX_EXPANDED_STEPS)
      throw new WorkflowStop(
        "workflow_limit",
        "Workflow outcome count exceeds its limit.",
        path,
        step.type,
      );
  }
}

function stepsOnErrorStop(state: RunState): boolean {
  return state.onError !== "continue";
}

function setCapture(
  state: RunState,
  name: string,
  value: WorkflowJson,
  path: string,
  type: string,
): void {
  if (
    !(name in state.captures) &&
    Object.keys(state.captures).length >= MAX_CAPTURES
  ) {
    throw new WorkflowStop(
      "capture_limit",
      "Workflow capture count exceeds its limit.",
      path,
      type,
    );
  }
  const bounded = boundedJson(value, MAX_CAPTURE_BYTES);
  if (bounded === undefined)
    throw new WorkflowStop(
      "capture_limit",
      "Workflow capture exceeds its limit.",
      path,
      type,
    );
  const captures = { ...state.captures, [name]: bounded };
  if (new TextEncoder().encode(JSON.stringify(captures)).byteLength > 16_384) {
    throw new WorkflowStop(
      "capture_limit",
      "Workflow captures exceed their total limit.",
      path,
      type,
    );
  }
  state.captures[name] = bounded;
}

function testAssertion(
  actual: WorkflowJson,
  op: string,
  expected: WorkflowJson | undefined,
): boolean {
  if (op === "exists")
    return expected === false ? actual === null : actual !== null;
  if (op === "equals") return jsonEqual(actual, expected);
  if (op === "notEquals") return !jsonEqual(actual, expected);
  if (op === "contains") {
    if (typeof actual === "string" && typeof expected === "string")
      return actual.includes(expected);
    if (Array.isArray(actual))
      return actual.some((item) => jsonEqual(item, expected));
  }
  return false;
}

function validateReferences(
  value: unknown,
  args: WorkflowJsonObject,
  captures: Set<string>,
): Validation | undefined {
  if (typeof value === "string") {
    const refs = [...value.matchAll(/%\{([^{}]+)\}/gu)];
    if (value.includes("%{") && refs.length === 0)
      return {
        ok: false,
        code: "invalid_reference",
        message: "Workflow substitution syntax is invalid.",
      };
    for (const match of refs) {
      const expression = match[1] ?? "";
      const parsed = parseReference(expression);
      if (!parsed)
        return {
          ok: false,
          code: "invalid_reference",
          message: "Workflow substitution path is invalid.",
        };
      if (parsed.source === "arg") {
        const arg = readPath(args, parsed.parts);
        if (!arg.ok) {
          return {
            ok: false,
            code: "invalid_reference",
            message: "Workflow argument path does not exist.",
          };
        }
        if (value !== match[0] && typeof arg.value === "object") {
          return {
            ok: false,
            code: "invalid_reference",
            message: "Embedded substitutions must be scalar values.",
          };
        }
      }
      if (parsed.source === "capture" && !captures.has(parsed.parts[0] ?? ""))
        return {
          ok: false,
          code: "invalid_reference",
          message: "Workflow capture must be created before use.",
        };
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const error = validateReferences(item, args, captures);
      if (error) return error;
    }
  } else if (isPlainObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (DANGEROUS_KEYS.has(key))
        return {
          ok: false,
          code: "invalid_reference",
          message: "Workflow data contains an unsafe key.",
        };
      const error = validateReferences(item, args, captures);
      if (error) return error;
    }
  }
  return;
}

function resolveArgsOnly(
  value: WorkflowJson,
  args: WorkflowJsonObject,
): { ok: true; value: WorkflowJson } | { ok: false } {
  try {
    const result = resolveValue(value, { args, captures: {} });
    return { ok: true, value: result };
  } catch {
    return { ok: false };
  }
}

function resolveValue(
  value: WorkflowJson,
  state: Pick<RunState, "args" | "captures">,
): WorkflowJson {
  if (typeof value === "string") {
    const exact = /^%\{([^{}]+)\}$/u.exec(value);
    if (exact) {
      const ref = parseReference(exact[1] ?? "");
      if (!ref) throw new Error("invalid reference");
      const root = ref.source === "arg" ? state.args : state.captures;
      const result = readPath(root, ref.parts);
      if (!result.ok) throw new Error("missing reference");
      return cloneJson(result.value);
    }
    const expressions = [...value.matchAll(/%\{([^{}]+)\}/gu)];
    if (value.includes("%{") && expressions.length === 0)
      throw new Error("invalid reference");
    const replaced = value.replace(
      /%\{([^{}]+)\}/gu,
      (_whole, expression: string) => {
        const ref = parseReference(expression);
        if (!ref) throw new Error("invalid reference");
        const root = ref.source === "arg" ? state.args : state.captures;
        const result = readPath(root, ref.parts);
        if (
          !result.ok ||
          (typeof result.value !== "string" &&
            typeof result.value !== "number" &&
            typeof result.value !== "boolean")
        ) {
          throw new Error("reference must be scalar in text");
        }
        return String(result.value);
      },
    );
    return replaced;
  }
  if (Array.isArray(value))
    return value.map((item) => resolveValue(item, state));
  if (isPlainObject(value)) {
    const copy: WorkflowJsonObject = {};
    for (const [key, item] of Object.entries(value)) {
      if (DANGEROUS_KEYS.has(key)) throw new Error("unsafe key");
      copy[key] = resolveValue(item, state);
    }
    return copy;
  }
  return value;
}

function parseReference(
  value: string,
): { source: "arg" | "capture"; parts: string[] } | undefined {
  const match = /^(arg|capture)\.([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)$/u.exec(
    value,
  );
  if (!match) return;
  const parts = (match[2] ?? "").split(".");
  if (
    parts.some(
      (part) => !SAFE_PATH_SEGMENT.test(part) || DANGEROUS_KEYS.has(part),
    )
  )
    return;
  return { source: match[1] as "arg" | "capture", parts };
}

function readPath(
  root: WorkflowJsonObject,
  parts: string[],
): { ok: true; value: WorkflowJson } | { ok: false } {
  let value: WorkflowJson = root;
  for (const part of parts) {
    if (Array.isArray(value)) {
      if (!/^(0|[1-9][0-9]*)$/u.test(part)) return { ok: false };
      const index = Number(part);
      if (!Number.isSafeInteger(index) || index >= value.length)
        return { ok: false };
      value = value[index] as WorkflowJson;
    } else {
      if (!isPlainObject(value) || !Object.hasOwn(value, part))
        return { ok: false };
      value = value[part] as WorkflowJson;
    }
  }
  return { ok: true, value };
}

function isSafeNavigationUrl(value: unknown): boolean {
  if (typeof value !== "string" || value.length > 2_000) return false;
  if (value === "about:blank") return true;
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

function cloneJsonObject(
  value: unknown,
): { ok: true; value: WorkflowJsonObject } | { ok: false } {
  if (!isPlainObject(value)) return { ok: false };
  try {
    const cloned = cloneJson(value);
    if (
      !isPlainObject(cloned) ||
      new TextEncoder().encode(JSON.stringify(cloned)).byteLength > 16_384
    )
      return { ok: false };
    return { ok: true, value: cloned };
  } catch {
    return { ok: false };
  }
}

function cloneJson(value: unknown): WorkflowJson {
  if (!isSafeData(value)) throw new TypeError("not JSON data");
  if (value === null || typeof value !== "object")
    return value as null | boolean | number | string;
  if (Array.isArray(value)) return value.map(cloneJson);
  const copy: WorkflowJsonObject = {};
  for (const [key, item] of Object.entries(value)) copy[key] = cloneJson(item);
  return copy;
}

function boundedJson(
  value: unknown,
  maxBytes: number,
): WorkflowJson | undefined {
  if (!isSafeData(value)) return;
  try {
    const result = cloneJson(value);
    if (new TextEncoder().encode(JSON.stringify(result)).byteLength <= maxBytes)
      return result;
  } catch {
    return;
  }
}

function isSafeData(value: unknown, depth = 0): value is WorkflowJson {
  if (depth > MAX_JSON_DEPTH) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return typeof value !== "string" || value.length <= 8_192;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value))
    return (
      value.length <= MAX_ARRAY_ITEMS &&
      value.every((item) => isSafeData(item, depth + 1))
    );
  if (isPlainObject(value)) {
    const entries = Object.entries(value);
    return (
      entries.length <= MAX_OBJECT_KEYS &&
      entries.every(
        ([key, item]) =>
          !DANGEROUS_KEYS.has(key) &&
          key.length <= 128 &&
          isSafeData(item, depth + 1),
      )
    );
  }
  return false;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function isCaptureName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    SAFE_NAME.test(value) &&
    !DANGEROUS_KEYS.has(value)
  );
}

function isInt(value: unknown, min: number, max: number): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= min &&
    (value as number) <= max
  );
}

function isOptionalInt(value: unknown, min: number, max: number): boolean {
  return value === undefined || isInt(value, min, max);
}

function isPortResult(value: unknown): value is WorkflowPortResult {
  return (
    isPlainObject(value) &&
    typeof value.ok === "boolean" &&
    (value.result === undefined || isSafeData(value.result)) &&
    (value.code === undefined || typeof value.code === "string") &&
    (value.message === undefined || typeof value.message === "string")
  );
}

function safeCode(value: unknown): string {
  return typeof value === "string" && /^[a-z][a-z0-9_-]{0,63}$/u.test(value)
    ? value
    : "operation_failed";
}

function safeMessage(value: unknown): string {
  if (typeof value !== "string") return "Workflow operation failed.";
  return value.replace(/[\u0000-\u001f\u007f]/gu, " ").slice(0, 300);
}

function isSafetyFailure(code: string): boolean {
  return (
    SAFETY_CODES.has(code) ||
    code.startsWith("safety_") ||
    code.startsWith("state_") ||
    code.endsWith("_changed") ||
    code.startsWith("invalid_") ||
    code.startsWith("ambiguous_") ||
    code.startsWith("stale_") ||
    code.endsWith("_uncertain") ||
    code.endsWith("_conflict") ||
    code.endsWith("_mismatch")
  );
}

function jsonEqual(
  left: WorkflowJson,
  right: WorkflowJson | undefined,
): boolean {
  if (right === undefined) return false;
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => jsonEqual(value, right[index]))
    );
  }
  if (isPlainObject(left) || isPlainObject(right)) {
    if (!isPlainObject(left) || !isPlainObject(right)) return false;
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every(
        (key, index) =>
          key === rightKeys[index] &&
          jsonEqual(left[key] as WorkflowJson, right[key] as WorkflowJson),
      )
    );
  }
  return false;
}

function invalidInput(): Validation {
  return {
    ok: false,
    code: "invalid_workflow",
    message: "Workflow input is invalid.",
  };
}

function invalidStep(): Validation {
  return {
    ok: false,
    code: "invalid_step",
    message: "Workflow step is invalid.",
  };
}

function failure(
  code: string,
  message: string,
  dryRun: boolean,
): FirefoxWorkflowResult {
  return {
    ok: false,
    dryRun,
    stopped: true,
    plannedOperations: 0,
    outcomes: [],
    captures: {},
    code,
    message,
  };
}
