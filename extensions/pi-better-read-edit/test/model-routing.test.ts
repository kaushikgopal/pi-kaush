import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

const runtime = vi.hoisted(() => ({ agentDir: "" }));
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@earendil-works/pi-coding-agent")>()),
  getAgentDir: () => runtime.agentDir,
}));

import registerExtension from "../src/index.ts";
import {
  matchesPortableModelGlob,
  modelMatchesAvoidlist,
  useBuiltinReadEdit,
} from "../src/model-routing.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("portable model glob matching", () => {
  test("uses anchored case-insensitive segment globs", () => {
    expect(
      matchesPortableModelGlob("OpenAI/gpt-4o-mini", "openai/gpt-4o-*"),
    ).toBe(true);
    expect(matchesPortableModelGlob("openai/gpt-4o/mini", "openai/*")).toBe(
      false,
    );
    expect(matchesPortableModelGlob("openai/gpt-4o/mini", "openai/**")).toBe(
      true,
    );
    expect(matchesPortableModelGlob("google/gemini-2", "google/gemini-?")).toBe(
      true,
    );
    expect(matchesPortableModelGlob("xgoogle/gemini-2", "google/*")).toBe(
      false,
    );
    expect(
      matchesPortableModelGlob("provider/model[1]", "provider/model[1]"),
    ).toBe(true);
  });

  test("matches each pattern against both model id and provider/model id", () => {
    const model = {
      provider: "openrouter",
      id: "anthropic/claude-3.5-haiku",
    };
    expect(modelMatchesAvoidlist(model, ["openrouter/**"])).toBe(true);
    expect(modelMatchesAvoidlist(model, ["anthropic/claude-*-haiku"])).toBe(
      true,
    );
    expect(modelMatchesAvoidlist(model, ["openai/**", "claude-*"])).toBe(false);
    expect(useBuiltinReadEdit(model, { avoidModels: [] })).toBe(false);
    expect(useBuiltinReadEdit(undefined, { avoidModels: ["**"] })).toBe(false);
  });
});

describe("model-routed tool registration", () => {
  test("switches both tools on session start and model selection", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-better-read-edit-routing-"));
    roots.push(root);
    runtime.agentDir = join(root, "agent");
    const cwd = join(root, "project");
    await mkdir(runtime.agentDir, { recursive: true });
    await mkdir(cwd, { recursive: true });
    await writeFile(
      join(runtime.agentDir, "settings.json"),
      JSON.stringify({
        betterReadEdit: { avoidModels: ["openai/gpt-4o*"] },
      }),
    );
    await writeFile(join(cwd, "example.txt"), "one\ntwo\n");

    const tools = new Map<string, any>();
    const handlers = new Map<string, (event: any, ctx: any) => unknown>();
    const pi = {
      registerTool(tool: any) {
        tools.set(tool.name, tool);
      },
      on(event: string, handler: (event: any, ctx: any) => unknown) {
        handlers.set(event, handler);
      },
      async exec() {
        return { code: 1, stdout: "", stderr: "", killed: false };
      },
    };
    registerExtension(pi as never);

    const avoidedModel = { provider: "openai", id: "gpt-4o-mini" };
    const context = {
      cwd,
      model: avoidedModel,
      hasUI: false,
      ui: { notify: vi.fn() },
      isProjectTrusted: () => false,
      sessionManager: { getBranch: () => [] },
    };
    await handlers.get("session_start")?.(
      { type: "session_start", reason: "startup" },
      context,
    );

    expect(Object.keys(tools.get("read").parameters.properties)).toEqual([
      "path",
      "offset",
      "limit",
    ]);
    expect(Object.keys(tools.get("edit").parameters.properties)).toEqual([
      "path",
      "edits",
    ]);
    await tools
      .get("edit")
      .execute(
        "builtin-edit",
        { path: "example.txt", edits: [{ oldText: "two", newText: "TWO" }] },
        undefined,
        undefined,
        context,
      );
    expect(await readFile(join(cwd, "example.txt"), "utf8")).toBe("one\nTWO\n");

    const supportedModel = { provider: "anthropic", id: "claude-sonnet-4" };
    await handlers.get("model_select")?.(
      {
        type: "model_select",
        model: supportedModel,
        previousModel: avoidedModel,
        source: "set",
      },
      { ...context, model: supportedModel },
    );
    expect(Object.keys(tools.get("read").parameters.properties)).toEqual([
      "path",
      "offset",
      "limit",
      "selector",
      "ranges",
    ]);
    expect(Object.keys(tools.get("edit").parameters.properties)).toEqual([
      "files",
    ]);
    const read = await tools
      .get("read")
      .execute("better-read", { path: "example.txt" }, undefined, undefined, {
        ...context,
        model: supportedModel,
      });
    expect(read.content[0].text).toMatch(/^\[example\.txt#[0-9A-F]{16}\]\n/m);
  });
});
