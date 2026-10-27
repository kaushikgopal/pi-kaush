import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { join, resolve } from "node:path";
import { loadFirefoxConfig, type FirefoxRuntimeConfig } from "./config.js";
import { createFirefoxLogger } from "./diagnostics.js";
import { createFirefoxActivityGate } from "./activity.js";
import { createPersistentFirefoxBrowser } from "./persistent.js";
import { createFirefoxClient } from "./index.js";
import { FIREFOX_TOOLS } from "./tool-catalog.js";
import {
  extractFirefoxFields,
  type FirefoxExtractionField,
  type FirefoxExtractionType,
  type FirefoxExtractionCandidate,
} from "./extraction.js";
import {
  runFirefoxWorkflow,
  type FirefoxWorkflowInput,
  type WorkflowJson,
  type WorkflowOperationStep,
} from "./workflows.js";
import {
  fail,
  record,
  type FirefoxReplacementConfirmation,
} from "./browser-types.js";
import type {
  FirefoxActInput,
  FirefoxLocateInput,
  FirefoxSnapshotInput,
} from "./browser-feature-types.js";
import type { FirefoxClientTransport } from "./types.js";

export type FirefoxAutomationJson =
  | null
  | boolean
  | number
  | string
  | FirefoxAutomationJson[]
  | { [key: string]: FirefoxAutomationJson };
export type FirefoxAutomationResult = { [key: string]: FirefoxAutomationJson };
export type FirefoxAutomationContext = {
  signal?: AbortSignal;
  approveReplacement?: (
    candidate: FirefoxReplacementConfirmation,
  ) => Promise<boolean>;
};
export type FirefoxAutomationOptions = {
  cwd?: string;
  agentId?: string;
  env?: Record<string, string | undefined>;
  config?: FirefoxRuntimeConfig;
  transport?: FirefoxClientTransport;
  getEpoch?: () => Promise<string | null>;
  /**
   * Advanced cooperation override for synthetic transports only. Cooperating clients must share
   * this path. Never set this for real-browser use; config, environment, and tools cannot set it.
   */
  coordinationPath?: string;
};
type Browser = ReturnType<typeof createPersistentFirefoxBrowser>;
type Runtime = {
  cwd: string;
  config: FirefoxRuntimeConfig;
  browser: Browser;
  status: ReturnType<typeof createFirefoxClient>;
  gate: ReturnType<typeof createFirefoxActivityGate>;
  log: ReturnType<typeof createFirefoxLogger>;
  scope: string;
};
const WRITERS = new Set([
  "ff_session_ensure",
  "ff_session_close",
  "ff_session_cleanup",
  "ff_screenshot",
]);
const GLOBAL = new Set([
  "ff_status",
  "ff_container_list",
  "ff_session_list",
  "ff_tab_list",
  "ff_session_cleanup",
]);
const FIELD_TYPES = [
  "text",
  "number",
  "integer",
  "date",
  "time",
  "datetime",
  "duration",
  "list",
  "list.number",
  "list.date",
] as const;

export function createFirefoxAutomation(
  options: FirefoxAutomationOptions = {},
) {
  let runtimePromise:
    | Promise<{ runtime: Runtime } | { error: FirefoxAutomationResult }>
    | undefined;
  async function initialize(): Promise<
    { runtime: Runtime } | { error: FirefoxAutomationResult }
  > {
    const loaded = options.config
      ? { ok: true as const, config: options.config }
      : await loadFirefoxConfig({
          ...(options.cwd ? { cwd: options.cwd } : {}),
          ...(options.env ? { env: options.env } : {}),
        });
    if (!loaded.ok) return { error: json({ ...loaded, recovery: null }) };
    const config = loaded.config;
    const namespace =
      config.namespace ??
      createHash("sha256")
        .update(resolve(options.cwd ?? process.cwd()))
        .digest("hex");
    const agentId = config.agentId ?? options.agentId ?? "default";
    const common = {
      binaryPath: config.binaryPath,
      timeoutMs: config.timeoutMs,
      maxOutputBytes: config.maxOutputBytes,
      ...(options.transport ? { transport: options.transport } : {}),
    };
    return {
      runtime: {
        cwd: resolve(options.cwd ?? process.cwd()),
        config,
        browser: createPersistentFirefoxBrowser({
          ...common,
          settleTimeoutMs: config.settleTimeoutMs,
          containerNames: config.containerNames,
          statePath: config.statePath,
          namespace,
          agentId,
          ...(options.getEpoch ? { getEpoch: options.getEpoch } : {}),
        }),
        status: createFirefoxClient(common),
        gate: createFirefoxActivityGate({
          path:
            options.coordinationPath ??
            join(
              userInfo().homedir,
              ".cache",
              "firefox-agent",
              "browser-activity.json",
            ),
        }),
        log: createFirefoxLogger({
          path: config.logPath,
          level: config.logLevel,
        }),
        scope: JSON.stringify([namespace, agentId]),
      },
    };
  }
  async function execute(
    name: string,
    input: Record<string, unknown> = {},
    context: FirefoxAutomationContext = {},
  ): Promise<FirefoxAutomationResult> {
    const descriptor = FIREFOX_TOOLS.find((tool) => tool.name === name);
    if (
      !descriptor ||
      !record(input) ||
      !matchesSchema(input, descriptor.parameters) ||
      Object.keys(input).some(
        (key) => !Object.hasOwn(descriptor.parameters.properties, key),
      ) ||
      !isJson(input) ||
      Buffer.byteLength(JSON.stringify(input)) > 128_000
    )
      return json(
        fail("invalid_input", "Firefox tool input is invalid or unsupported."),
      );
    if (context.signal?.aborted)
      return json(fail("aborted", "Firefox operation was cancelled."));
    const initialized = await (runtimePromise ??= initialize());
    if ("error" in initialized) return initialized.error;
    const runtime = initialized.runtime;
    const session =
      typeof input.session === "string"
        ? input.session
        : runtime.config.defaultSession;
    const args = {
      ...input,
      session,
      ...(name === "ff_session_list" && input.session === undefined
        ? { allSessions: true }
        : {}),
    };
    if (name === "ff_do" && input.dryRun === true)
      return workflow(runtime, args, context);
    const started = Date.now();
    try {
      const run = () =>
        runtime.gate.run(
          WRITERS.has(name) ? "write" : "read",
          () => dispatch(runtime, name, args, context),
          context.signal,
        );
      let result: FirefoxAutomationResult;
      if (name === "ff_status")
        result = json(
          await runtime.status.status(signalOptions(context.signal)),
        );
      else if (GLOBAL.has(name)) result = await run();
      else
        result = await runtime.gate.withSessionLane(
          `${runtime.scope}:${session}`,
          async () => {
            const first = await run();
            if (
              first.ok === false &&
              first.code === "confirmation_required" &&
              record(first.confirmation) &&
              context.approveReplacement &&
              !context.signal?.aborted
            ) {
              // Approval is a harness callback, never a model-supplied boolean.
              const confirmation =
                first.confirmation as FirefoxReplacementConfirmation;
              if (
                (await context.approveReplacement(confirmation)) &&
                !context.signal?.aborted
              )
                return runtime.gate.run(
                  "read",
                  async () =>
                    json(
                      await runtime.browser.confirmReplacement(
                        {
                          session: confirmation.session,
                          confirmationId: confirmation.id,
                        },
                        signalOptions(context.signal),
                      ),
                    ),
                  context.signal,
                );
            }
            return first;
          },
          context.signal,
        );
      await runtime.log({
        event: result.ok === false ? "error" : "tool",
        operation: name,
        ...(GLOBAL.has(name) ? {} : { session }),
        ...(typeof result.code === "string" ? { code: result.code } : {}),
        ...(record(result.tab) && typeof result.tab.url === "string"
          ? { domain: result.tab.url }
          : {}),
        durationMs: Date.now() - started,
      });
      return result;
    } catch (error) {
      const code =
        record(error) &&
        typeof error.code === "string" &&
        /^[a-z_]{1,64}$/.test(error.code)
          ? error.code
          : context.signal?.aborted
            ? "aborted"
            : "operation_failed";
      await runtime.log({
        event: "error",
        operation: name,
        code,
        durationMs: Date.now() - started,
      });
      return json(
        fail(
          code,
          "Firefox operation could not complete safely. Inspect session state before repeating a write.",
        ),
      );
    }
  }
  return { execute };
}

async function dispatch(
  runtime: Runtime,
  name: string,
  args: Record<string, unknown>,
  context: FirefoxAutomationContext,
): Promise<FirefoxAutomationResult> {
  const browser = runtime.browser;
  const session = args.session;
  if (typeof session !== "string" || !session.trim() || session.length > 80)
    return json(
      fail("invalid_session", "A valid Firefox session is required."),
    );
  const call = signalOptions(context.signal);
  // Public core operations own complete runtime validation of their selected JSON inputs.
  switch (name) {
    case "ff_session_ensure":
      if (args.recover === true)
        return json(await browser.recoverSession({ session }, call));
      return json(
        await browser.sessionEnsure(
          {
            ...args,
            ...(args.containerId === undefined &&
            runtime.config.defaultContainerId
              ? { containerId: runtime.config.defaultContainerId }
              : {}),
          } as Parameters<Browser["sessionEnsure"]>[0],
          call,
        ),
      );
    case "ff_go":
      await browser.network({ session }, call);
      return json(await browser.go(args as Parameters<Browser["go"]>[0], call));
    case "ff_read":
      if (args.mode === undefined || args.mode === "summary")
        return json(
          await browser.read(
            {
              session,
              maxBytes:
                typeof args.maxBytes === "number"
                  ? args.maxBytes
                  : runtime.config.summaryMaxBytes,
            },
            call,
          ),
        );
      {
        const view = await browser.snapshot(
          {
            ...args,
            maxBytes:
              typeof args.maxBytes === "number"
                ? args.maxBytes
                : runtime.config.scopedMaxBytes,
          } as FirefoxSnapshotInput,
          call,
        );
        return json(
          view.ok
            ? {
                ...view,
                result: {
                  ...view.result,
                  shownBytes: Buffer.byteLength(view.result.text),
                  totalBytes: null,
                  hint: view.result.truncated
                    ? "Use ff_locate or ff_read with mode:scoped and a returned ref to narrow this read."
                    : null,
                },
              }
            : view,
        );
      }
    case "ff_locate":
      return json(await browser.locate(args as FirefoxLocateInput, call));
    case "ff_act":
      await browser.network({ session }, call);
      return json(await browser.act(args as FirefoxActInput, call));
    case "ff_wait":
      return json(
        await browser.wait(args as Parameters<Browser["wait"]>[0], call),
      );
    case "ff_network":
      return json(
        await browser.network(args as Parameters<Browser["network"]>[0], call),
      );
    case "ff_screenshot": {
      const path =
        typeof args.outputPath === "string"
          ? resolve(runtime.cwd, args.outputPath)
          : join(
              runtime.config.screenshotDir,
              `${Date.now()}-${createHash("sha256").update(session).digest("hex").slice(0, 12)}.png`,
            );
      return json(
        await browser.screenshot(
          { ...args, outputPath: path } as Parameters<Browser["screenshot"]>[0],
          call,
        ),
      );
    }
    case "ff_session_close":
      return json(await browser.sessionClose({ session }, call));
    case "ff_session_list":
    case "ff_tab_list":
      return json(
        await browser.sessionList(
          name === "ff_session_list" && args.allSessions !== true
            ? { session }
            : {},
          call,
        ),
      );
    case "ff_session_cleanup":
      return json(
        await browser.sessionCleanup(
          args as Parameters<Browser["sessionCleanup"]>[0],
          call,
        ),
      );
    case "ff_container_list": {
      const listed = await browser.sessionList({}, call);
      if (!listed.ok) return json(listed);
      const known = new Map<
        string,
        { cookieStoreId: string; name: string | null; source: string }
      >();
      for (const [id, label] of Object.entries(runtime.config.containerNames))
        known.set(id, { cookieStoreId: id, name: label, source: "configured" });
      for (const item of listed.result)
        if (item.containerId)
          known.set(item.containerId, {
            cookieStoreId: item.containerId,
            name:
              runtime.config.containerNames[item.containerId] ??
              (item.containerId === "firefox-default" ? "default" : null),
            source: "observed_owned_session",
          });
      return json({
        ok: true,
        result: {
          containers: [...known.values()],
          complete: false,
          limitation: "The tested firefox-cli cannot enumerate all containers.",
        },
      });
    }
    case "ff_extract":
      return extract(runtime, args, context);
    case "ff_do":
      return workflow(runtime, args, context);
    default:
      return json(fail("unsupported_tool", "Firefox tool is not supported."));
  }
}

async function extract(
  runtime: Runtime,
  args: Record<string, unknown>,
  context: FirefoxAutomationContext,
): Promise<FirefoxAutomationResult> {
  const session = String(args.session);
  if (
    !record(args.fields) ||
    Object.keys(args.fields).length < 1 ||
    Object.keys(args.fields).length > 64
  )
    return json(fail("invalid_input", "Extraction fields are invalid."));
  const page = await runtime.browser.read(
    { session },
    signalOptions(context.signal),
  );
  if (!page.ok) return json(page);
  const fields: Record<string, FirefoxExtractionField> = {};
  const sources: Record<string, FirefoxExtractionCandidate[]> = {};
  const ambiguous = new Set<string>();
  let reads = 0;
  for (const [name, raw] of Object.entries(args.fields)) {
    if (
      !record(raw) ||
      !isFieldType(raw.type) ||
      !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name)
    )
      return json(
        fail("invalid_input", "Extraction field definitions are invalid."),
      );
    fields[name] = {
      type: raw.type,
      ...(typeof raw.instructions === "string"
        ? { instructions: raw.instructions }
        : {}),
      ...(typeof raw.unit === "string" ? { unit: raw.unit } : {}),
      ...(typeof raw.decimals === "number" ? { decimals: raw.decimals } : {}),
    };
    sources[name] = [];
    if (
      name === "title" &&
      raw.ref === undefined &&
      raw.selector === undefined
    ) {
      sources[name] = [{ text: page.result.title }];
      continue;
    }
    let ref = typeof raw.ref === "string" ? raw.ref : undefined;
    if (!ref) {
      const selector = record(raw.selector)
        ? raw.selector
        : { name, exact: true };
      const found = await runtime.browser.locate(
        { ...selector, session } as FirefoxLocateInput,
        signalOptions(context.signal),
      );
      if (!found.ok) {
        if (found.code === "no_match") continue;
        if (found.code === "ambiguous_match") {
          ambiguous.add(name);
          continue;
        }
        return json(found);
      }
      ref = found.result.ref;
    }
    if (typeof ref !== "string")
      return json(
        fail("invalid_input", "An extraction source reference is required."),
      );
    if (++reads > 64)
      return json(
        fail("extraction_limit", "Extraction exceeded its source-read budget."),
      );
    const value = await runtime.browser.readText(
      { session, ref, maxBytes: 4096 },
      signalOptions(context.signal),
    );
    if (!value.ok) return json(value);
    sources[name] = [{ text: value.result.text, ref }];
  }
  const result = extractFirefoxFields(fields, sources);
  for (const name of ambiguous)
    result[name] = {
      status: "uncertain",
      reason: "ambiguous_source",
      evidence: [],
    };
  return json({ ...page, result });
}

async function workflow(
  runtime: Runtime,
  args: Record<string, unknown>,
  context: FirefoxAutomationContext,
): Promise<FirefoxAutomationResult> {
  let steps: unknown = args.steps;
  if (args.workflowFile !== undefined) {
    if (steps !== undefined || typeof args.workflowFile !== "string")
      return json(
        fail("invalid_input", "Supply steps or one JSON workflow file."),
      );
    try {
      const path = resolve(runtime.cwd, args.workflowFile);
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64_000)
        return json(
          fail(
            "invalid_input",
            "Workflow file is not a bounded regular JSON file.",
          ),
        );
      const data: unknown = JSON.parse(await readFile(path, "utf8"));
      steps = Array.isArray(data)
        ? data
        : record(data)
          ? data.steps
          : undefined;
    } catch {
      return json(
        fail("invalid_input", "Workflow file could not be read safely."),
      );
    }
  }
  const input = {
    steps,
    ...(args.args !== undefined ? { args: args.args } : {}),
    ...(args.dryRun !== undefined ? { dryRun: args.dryRun } : {}),
    ...(args.allowWrite !== undefined ? { allowWrite: args.allowWrite } : {}),
    ...(args.onError !== undefined ? { onError: args.onError } : {}),
  };
  // The workflow engine validates the complete grammar before any port call.
  const result = await runFirefoxWorkflow(
    input as FirefoxWorkflowInput,
    {
      execute: async (step: WorkflowOperationStep) => {
        const map: Record<string, string> = {
          navigate: "ff_go",
          read: "ff_read",
          locate: "ff_locate",
          click: "ff_act",
          fill: "ff_act",
          key: "ff_act",
          scroll: "ff_act",
          select: "ff_act",
          wait: "ff_wait",
          extract: "ff_extract",
        };
        const name = map[step.type];
        if (!name)
          return {
            ok: false,
            code: "unsupported_step",
            message: "Unsupported workflow operation.",
          };
        const values: Record<string, unknown> = {
          ...step,
          session: args.session,
        };
        delete values.type;
        if (["click", "fill", "key", "scroll", "select"].includes(step.type))
          values.action = step.type;
        const output = await dispatch(runtime, name, values, context);
        return {
          ok: output.ok === true,
          ...(output.ok === true
            ? { result: output.result as WorkflowJson }
            : {
                code:
                  typeof output.code === "string"
                    ? output.code
                    : "operation_failed",
                message:
                  typeof output.message === "string"
                    ? output.message
                    : "Workflow step failed.",
              }),
        };
      },
    },
    signalOptions(context.signal),
  );
  const last = [...result.outcomes]
    .reverse()
    .find((outcome) => outcome.ok && outcome.result !== undefined)?.result;
  const compact = {
    dryRun: result.dryRun,
    stopped: result.stopped,
    plannedOperations: result.plannedOperations,
    outcomes: result.outcomes.map(({ path, type, ok, code }) => ({
      path,
      type,
      ok,
      ...(code ? { code } : {}),
    })),
    ...(last !== undefined && Buffer.byteLength(JSON.stringify(last)) <= 4096
      ? { result: last }
      : {}),
    code: result.code ?? null,
  };
  return json({
    ok: result.ok,
    ...(result.ok
      ? {}
      : {
          code: result.code ?? "workflow_failed",
          message:
            result.message ??
            "Workflow stopped; do not replay completed writes.",
          recovery: null,
        }),
    result: compact,
  });
}
function signalOptions(signal?: AbortSignal) {
  return signal ? { signal } : {};
}
function isFieldType(value: unknown): value is FirefoxExtractionType {
  return FIELD_TYPES.some((type) => type === value);
}
function isJson(value: unknown, depth = 0): value is FirefoxAutomationJson {
  if (depth > 16) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value))
    return (
      value.length <= 1024 && value.every((item) => isJson(item, depth + 1))
    );
  return (
    record(value) &&
    Object.keys(value).length <= 256 &&
    Object.entries(value).every(
      ([key, item]) =>
        !["__proto__", "constructor", "prototype"].includes(key) &&
        isJson(item, depth + 1),
    )
  );
}
function json(value: unknown): FirefoxAutomationResult {
  try {
    const text = JSON.stringify(value);
    if (Buffer.byteLength(text) > 64_000)
      return {
        ok: false,
        code: "output_limit",
        message:
          "Firefox output exceeded its cap. Narrow the request before trying again.",
        recovery: null,
      };
    const parsed: unknown = JSON.parse(text);
    if (record(parsed) && isJson(parsed) && typeof parsed.ok === "boolean")
      return parsed;
  } catch {}
  return {
    ok: false,
    code: "invalid_result",
    message: "Firefox returned an invalid structured result.",
    recovery: null,
  };
}

// This checks only the small schema vocabulary in our own operation catalog.
function matchesSchema(value: unknown, schema: unknown, depth = 0): boolean {
  if (depth > 16 || !record(schema)) return false;
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return false;
  if (schema.type === "string")
    return (
      typeof value === "string" &&
      (typeof schema.minLength !== "number" ||
        value.length >= schema.minLength) &&
      (typeof schema.maxLength !== "number" || value.length <= schema.maxLength)
    );
  if (schema.type === "boolean") return typeof value === "boolean";
  if (schema.type === "integer")
    return typeof value === "number" && Number.isSafeInteger(value);
  if (schema.type === "array")
    return (
      Array.isArray(value) &&
      (typeof schema.maxItems !== "number" ||
        value.length <= schema.maxItems) &&
      (schema.items === undefined ||
        value.every((item) => matchesSchema(item, schema.items, depth + 1)))
    );
  if (schema.type === "object") {
    if (!record(value)) return false;
    const entries = Object.entries(value);
    if (
      (typeof schema.minProperties === "number" &&
        entries.length < schema.minProperties) ||
      (typeof schema.maxProperties === "number" &&
        entries.length > schema.maxProperties)
    )
      return false;
    const properties = record(schema.properties) ? schema.properties : {};
    if (
      Array.isArray(schema.required) &&
      schema.required.some(
        (key) => typeof key !== "string" || !Object.hasOwn(value, key),
      )
    )
      return false;
    return entries.every(([key, item]) =>
      Object.hasOwn(properties, key)
        ? matchesSchema(item, properties[key], depth + 1)
        : schema.additionalProperties === false
          ? false
          : record(schema.additionalProperties)
            ? matchesSchema(item, schema.additionalProperties, depth + 1)
            : true,
    );
  }
  return schema.type === undefined;
}
