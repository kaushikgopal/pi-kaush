import { describe, expect, it, vi } from "vitest";
import {
  runFirefoxWorkflow,
  type FirefoxWorkflowPort,
  type WorkflowOperationStep,
  type WorkflowResolvedArgs,
  type WorkflowPortResult,
} from "../src/workflows.js";

function portFor(
  execute: (
    step: WorkflowOperationStep,
    args: WorkflowResolvedArgs,
  ) => Promise<WorkflowPortResult> | WorkflowPortResult,
): FirefoxWorkflowPort {
  return { execute: execute as FirefoxWorkflowPort["execute"] };
}

describe("runFirefoxWorkflow", () => {
  it("validates the full plan and dry-runs without calling the port", async () => {
    const execute = vi.fn(async () => ({ ok: true, result: "read" }));
    const result = await runFirefoxWorkflow(
      {
        dryRun: true,
        allowWrite: true,
        steps: [
          { type: "read", as: "page" },
          { type: "navigate", url: "javascript:alert(1)" },
        ],
      },
      { execute },
    );

    expect(result).toMatchObject({
      ok: false,
      code: "unsafe_url",
      outcomes: [],
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not perform earlier reads when any write lacks approval", async () => {
    const execute = vi.fn(async () => ({ ok: true }));
    const result = await runFirefoxWorkflow(
      {
        steps: [
          { type: "read" },
          { type: "navigate", url: "https://example.test/" },
        ],
      },
      { execute },
    );

    expect(result.code).toBe("write_gate");
    expect(execute).not.toHaveBeenCalled();
  });

  it("substitutes only data, captures results, and bounds repeat and each loops", async () => {
    const seen: string[] = [];
    const execute = vi.fn(async (step: WorkflowOperationStep) => {
      if (step.type === "read")
        return { ok: true, result: { items: ["first", "second"] } };
      seen.push(String(step.value));
      return { ok: true, result: { filled: step.value as string } };
    });
    const result = await runFirefoxWorkflow(
      {
        allowWrite: true,
        args: { label: "Order" },
        steps: [
          { type: "read", as: "page" },
          {
            type: "each",
            items: "%{capture.page.items}",
            as: "row",
            steps: [
              {
                type: "fill",
                ref: "e1",
                value: "%{arg.label}: %{capture.row}",
              },
            ],
          },
          { type: "repeat", count: 2, steps: [{ type: "read" }] },
        ],
      },
      { execute },
    );

    expect(result.ok).toBe(true);
    expect(seen).toEqual(["Order: first", "Order: second"]);
    expect(execute).toHaveBeenCalledTimes(5);
    expect(result.captures.row).toBe("second");
  });

  it("rejects an untargeted click before any earlier read runs", async () => {
    const execute = vi.fn(async () => ({ ok: true }));
    const result = await runFirefoxWorkflow(
      {
        allowWrite: true,
        steps: [{ type: "read" }, { type: "click" }],
      },
      { execute },
    );

    expect(result.code).toBe("invalid_step");
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not continue after a failed write even when continue is selected", async () => {
    const execute = vi.fn(async () => ({ ok: false, code: "click_failed" }));
    const result = await runFirefoxWorkflow(
      {
        allowWrite: true,
        onError: "continue",
        steps: [{ type: "click", ref: "e1" }, { type: "read" }],
      },
      { execute },
    );

    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.stopped).toBe(true);
  });

  it("treats substituted strings as data and does not resolve them again", async () => {
    const values: unknown[] = [];
    const execute = vi.fn(async (step: WorkflowOperationStep) => {
      values.push(step.value);
      return { ok: true };
    });
    const result = await runFirefoxWorkflow(
      {
        allowWrite: true,
        args: { literal: "%{capture.notDefined}" },
        steps: [{ type: "fill", ref: "e1", value: "%{arg.literal}" }],
      },
      { execute },
    );

    expect(result.ok).toBe(true);
    expect(values).toEqual(["%{capture.notDefined}"]);
  });

  it("requires simple locator input and rejects prototype paths before effects", async () => {
    const execute = vi.fn(async () => ({ ok: true }));
    const unsafeArgs = JSON.parse('{"__proto__":{"polluted":true}}') as Record<
      string,
      never
    >;
    const invalidArgs = await runFirefoxWorkflow(
      { args: unsafeArgs, steps: [{ type: "read" }] },
      { execute },
    );
    const invalidRef = await runFirefoxWorkflow(
      {
        args: { row: "x" },
        steps: [
          { type: "click", locate: { role: "button" } },
          { type: "read", as: "next" },
          { type: "fill", ref: "e1", value: "%{capture.missing}" },
        ],
        allowWrite: true,
      },
      { execute },
    );

    expect(invalidArgs.code).toBe("invalid_args");
    expect(invalidRef.code).toBe("invalid_reference");
    expect(execute).not.toHaveBeenCalled();
  });

  it("continues after ordinary errors but stops after safety errors", async () => {
    const execute = vi.fn(async (step: WorkflowOperationStep) => {
      if (step.type === "read")
        return { ok: false, code: "read_failed", message: "temporary" };
      if (step.type === "locate")
        return { ok: false, code: "stale_ref", message: "stale target" };
      return { ok: true };
    });
    const result = await runFirefoxWorkflow(
      {
        onError: "continue",
        steps: [
          { type: "read" },
          { type: "locate", text: "Go" },
          { type: "read" },
        ],
      },
      { execute },
    );

    expect(execute).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(false);
    expect(result.stopped).toBe(true);
    expect(result.outcomes.map((outcome) => outcome.code)).toEqual([
      "read_failed",
      "stale_ref",
    ]);
  });

  it("stops between steps when the caller aborts", async () => {
    const controller = new AbortController();
    let calls = 0;
    const execute = vi.fn(async () => {
      calls++;
      controller.abort();
      return { ok: true, result: "done" };
    });
    const result = await runFirefoxWorkflow(
      { steps: [{ type: "read" }, { type: "read" }] },
      { execute },
      { signal: controller.signal },
    );

    expect(calls).toBe(1);
    expect(result.code).toBe("aborted");
    expect(result.outcomes).toHaveLength(1);
  });

  it("rejects loop expansion beyond the cap before any port call", async () => {
    const execute = vi.fn(async () => ({ ok: true }));
    const result = await runFirefoxWorkflow(
      { steps: [{ type: "repeat", count: 33, steps: [{ type: "read" }] }] },
      { execute },
    );

    expect(result.code).toBe("workflow_limit");
    expect(execute).not.toHaveBeenCalled();
  });

  it("compares JSON objects by value and distinguishes missing paths from null", async () => {
    const result = await runFirefoxWorkflow(
      {
        steps: [
          { type: "read", as: "page" },
          {
            type: "assert",
            actual: "%{capture.page.profile}",
            op: "equals",
            expected: { name: "Ada", age: 37 },
          },
          {
            type: "assert",
            actual: "%{capture.page.missing}",
            op: "exists",
            expected: false,
          },
          {
            type: "assert",
            actual: "%{capture.page.empty}",
            op: "exists",
            expected: true,
          },
        ],
      },
      portFor(async () => ({
        ok: true,
        result: { profile: { age: 37, name: "Ada" }, empty: null },
      })),
    );

    expect(result.ok).toBe(true);
    expect(result.outcomes.slice(1).every((outcome) => outcome.ok)).toBe(true);
  });

  it("runs deterministic assertions over captured values", async () => {
    const result = await runFirefoxWorkflow(
      {
        steps: [
          { type: "read", as: "page" },
          {
            type: "assert",
            actual: "%{capture.page.title}",
            op: "equals",
            expected: "Inbox",
          },
        ],
      },
      portFor(async () => ({ ok: true, result: { title: "Inbox" } })),
    );

    expect(result.ok).toBe(true);
    expect(result.outcomes[1]).toMatchObject({ type: "assert", ok: true });
  });
});

it("stops on changed ownership evidence before another operation", async () => {
  const execute = vi.fn(async () => ({ ok: false, code: "page_changed" }));
  const result = await runFirefoxWorkflow(
    {
      allowWrite: true,
      onError: "continue",
      steps: [{ type: "read" }, { type: "click", ref: "e1" }],
    },
    { execute },
  );
  expect(result.stopped).toBe(true);
  expect(execute).toHaveBeenCalledTimes(1);
});
