import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SessionManager,
  type CustomEntry,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { NESTED_HASHLINE_ENTRY_TYPE } from "../src/hashline/registry.ts";
import registerExtension from "../src/index.ts";

const roots: string[] = [];
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pi-nested-results-"));
  roots.push(root);
});

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

type ToolResult = {
  content: unknown[];
  details?: unknown;
  structuredContent?: unknown;
};

type Harness = {
  session: SessionManager;
  read(path: string, extra?: Record<string, unknown>): Promise<any>;
  edit(script: string): Promise<any>;
  /**
   * Deliver a nested tool result to every registered tool_result observer, the
   * way Pi does for calls another tool made. Returns each handler's outcome.
   */
  nested(
    toolName: string,
    result: ToolResult,
    overrides?: Record<string, unknown>,
  ): Promise<unknown[]>;
  nestedEntries(): CustomEntry[];
};

function hashlineHeader(result: any): string {
  const match = /^\[.+#[0-9A-F]{16}\]$/m.exec(result.content[0].text);
  if (!match) throw new Error("Result did not contain a hashline header");
  return match[0];
}

function createHarness(session: SessionManager): Harness {
  const tools = new Map<string, any>();
  const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
  registerExtension({
    registerTool(tool: any) {
      tools.set(tool.name, tool);
    },
    on(event: string, handler: (event: any, ctx: any) => unknown) {
      const registered = handlers.get(event) ?? [];
      registered.push(handler);
      handlers.set(event, registered);
      return () => {};
    },
    appendEntry(customType: string, data?: unknown) {
      session.appendCustomEntry(customType, data);
    },
    async exec() {
      return { code: 1, stdout: "", stderr: "not installed", killed: false };
    },
  } as never);

  const context = { cwd: root, sessionManager: session, hasUI: false };
  const execute = (name: string, args: Record<string, unknown>) => {
    const tool = tools.get(name);
    if (!tool) throw new Error(`Tool ${name} was not registered`);
    return tool.execute(`${name}-call`, args, undefined, undefined, context);
  };

  return {
    session,
    read: (path, extra = {}) => execute("read", { path, ...extra }),
    edit: (script) => execute("edit", { script }),
    async nested(toolName, result, overrides = {}) {
      const event = {
        type: "tool_result",
        toolCallId: `${toolName}-nested/1`,
        parentToolCallId: "codemode-call",
        toolName,
        input: {},
        content: result.content,
        structuredContent: result.structuredContent,
        details: result.details,
        isError: false,
        ...overrides,
      };
      const outcomes: unknown[] = [];
      for (const handler of handlers.get("tool_result") ?? []) {
        outcomes.push(await handler(event, context));
      }
      return outcomes;
    },
    nestedEntries: () =>
      session
        .getBranch()
        .filter(
          (entry): entry is CustomEntry =>
            entry.type === "custom" &&
            entry.customType === NESTED_HASHLINE_ENTRY_TYPE,
        ),
  };
}

describe("nested tool results", () => {
  test("keeps the nested anchor entry type as a stable session key", () => {
    expect(NESTED_HASHLINE_ENTRY_TYPE).toBe(
      "pi-better-read-edit:nested-anchors",
    );
  });

  test("authorizes a nested edit in the same script and hands off the fresh tag", async () => {
    const path = join(root, "notes.txt");
    await writeFile(path, "one\ntwo\nthree\n");
    const harness = createHarness(SessionManager.inMemory(root));

    const readResult = await harness.read("notes.txt");
    const outcomes = await harness.nested("read", readResult);
    // Observing a result must not replace it for the script that awaits it.
    expect(outcomes.every((outcome) => outcome === undefined)).toBe(true);

    const firstEdit = await harness.edit(
      `${hashlineHeader(readResult)}\nPUT 2.=2:\n+TWO`,
    );
    expect(await readFile(path, "utf8")).toBe("one\nTWO\nthree\n");

    await harness.nested("edit", firstEdit);
    await harness.edit(`${hashlineHeader(firstEdit)}\nPUT >$:\n+four`);
    expect(await readFile(path, "utf8")).toBe("one\nTWO\nthree\nfour\n");
  });

  test("keeps displayed-range and EOF authorization from a nested read", async () => {
    const path = join(root, "partial.txt");
    await writeFile(path, "one\ntwo\nthree\n");
    const harness = createHarness(SessionManager.inMemory(root));

    const partial = await harness.read("partial.txt", { ranges: "2-2" });
    await harness.nested("read", partial);

    await expect(
      harness.edit(`${hashlineHeader(partial)}\nPUT 1.=1:\n+ONE`),
    ).rejects.toThrow(/not displayed/);
    await expect(
      harness.edit(`${hashlineHeader(partial)}\nPUT >$:\n+four`),
    ).rejects.toThrow(/displayed EOF/);
    expect(await readFile(path, "utf8")).toBe("one\ntwo\nthree\n");
  });

  test("does not authorize edits from a failed nested read", async () => {
    const path = join(root, "failed.txt");
    await writeFile(path, "one\ntwo\n");
    const harness = createHarness(SessionManager.inMemory(root));

    const failed = await harness.read("failed.txt");
    await harness.nested("read", failed, { isError: true });

    expect(harness.nestedEntries()).toEqual([]);
    await expect(
      harness.edit(`${hashlineHeader(failed)}\nPUT 1.=1:\n+ONE`),
    ).rejects.toThrow(/Unknown tag/);
    expect(await readFile(path, "utf8")).toBe("one\ntwo\n");
  });

  test("records nothing for an untagged projection", async () => {
    await mkdir(join(root, "folder"));
    await writeFile(join(root, "folder", "entry.txt"), "x\n");
    const harness = createHarness(SessionManager.inMemory(root));

    const listing = await harness.read("folder");
    expect(listing.structuredContent?.source).toBe("projection");
    const outcomes = await harness.nested("read", listing);
    expect(outcomes.every((outcome) => outcome === undefined)).toBe(true);
    expect(harness.nestedEntries()).toEqual([]);
  });

  test("ignores anchors smuggled through a non-read/edit tool result", async () => {
    const path = join(root, "smuggle.txt");
    await writeFile(path, "one\ntwo\n");
    const harness = createHarness(SessionManager.inMemory(root));

    const tagged = await harness.read("smuggle.txt");
    await harness.nested("bash", tagged);

    expect(harness.nestedEntries()).toEqual([]);
    await expect(
      harness.edit(`${hashlineHeader(tagged)}\nPUT 1.=1:\n+ONE`),
    ).rejects.toThrow(/Unknown tag/);
    expect(await readFile(path, "utf8")).toBe("one\ntwo\n");
  });

  test("does not trust anchors stored under a foreign custom entry type", async () => {
    const path = join(root, "foreign.txt");
    await writeFile(path, "one\ntwo\n");
    const harness = createHarness(SessionManager.inMemory(root));

    const tagged = await harness.read("foreign.txt");
    harness.session.appendCustomEntry("someone-else:anchors", {
      hashlineAnchors: [tagged.details.hashlineAnchor],
    });

    await expect(
      harness.edit(`${hashlineHeader(tagged)}\nPUT 1.=1:\n+ONE`),
    ).rejects.toThrow(/Unknown tag/);
    expect(await readFile(path, "utf8")).toBe("one\ntwo\n");
  });

  test("does not authorize edits from an abandoned branch", async () => {
    const path = join(root, "branch.txt");
    await writeFile(path, "one\ntwo\n");
    const harness = createHarness(SessionManager.inMemory(root));
    const markerId = harness.session.appendMessage({
      role: "user",
      content: "start",
      timestamp: Date.now(),
    });

    const tagged = await harness.read("branch.txt");
    await harness.nested("read", tagged);
    harness.session.branch(markerId);

    await expect(
      harness.edit(`${hashlineHeader(tagged)}\nPUT 1.=1:\n+ONE`),
    ).rejects.toThrow(/Unknown tag/);

    // Re-recording on the current branch restores authorization.
    await harness.nested("read", tagged);
    await harness.edit(`${hashlineHeader(tagged)}\nPUT 1.=1:\n+ONE`);
    expect(await readFile(path, "utf8")).toBe("ONE\ntwo\n");
  });

  test("merges displayed ranges across nested reads", async () => {
    const path = join(root, "parallel.txt");
    await writeFile(path, "one\ntwo\nthree\nfour\n");
    const harness = createHarness(SessionManager.inMemory(root));

    const first = await harness.read("parallel.txt", { ranges: "1-2" });
    await harness.nested("read", first);
    await expect(
      harness.edit(`${hashlineHeader(first)}\nPUT 1.=3:\n+X`),
    ).rejects.toThrow(/not displayed/);

    const second = await harness.read("parallel.txt", { ranges: "3-3" });
    expect(hashlineHeader(second)).toBe(hashlineHeader(first));
    await harness.nested("read", second);
    await harness.edit(`${hashlineHeader(second)}\nPUT 1.=3:\n+X`);
    expect(await readFile(path, "utf8")).toBe("X\nfour\n");
  });

  test("authorizes independent files from concurrent nested reads", async () => {
    const paths = ["first.txt", "second.txt"];
    await Promise.all(
      paths.map((path) => writeFile(join(root, path), "before\n")),
    );
    const harness = createHarness(SessionManager.inMemory(root));
    const tagged = await Promise.all(
      paths.map(async (path, index) => {
        const result = await harness.read(path);
        await harness.nested("read", result, {
          parentToolCallId: `codemode-${index}`,
        });
        return result;
      }),
    );

    await harness.edit(
      tagged
        .map((result) => `${hashlineHeader(result)}\nPUT 1.=1:\n+after`)
        .join("\n"),
    );
    for (const path of paths) {
      expect(await readFile(join(root, path), "utf8")).toBe("after\n");
    }
  });

  test("keeps a nested anchor after the enclosing script fails", async () => {
    const path = join(root, "script.txt");
    await writeFile(path, "one\ntwo\n");
    const harness = createHarness(SessionManager.inMemory(root));

    const tagged = await harness.read("script.txt");
    await harness.nested("read", tagged);
    harness.session.appendMessage({
      role: "toolResult",
      toolCallId: "codemode-call",
      toolName: "codemode",
      content: [{ type: "text", text: "script failed after the read" }],
      isError: true,
      timestamp: Date.now(),
    });

    await harness.edit(`${hashlineHeader(tagged)}\nPUT 1.=1:\n+ONE`);
    expect(await readFile(path, "utf8")).toBe("ONE\ntwo\n");
  });

  test("resumes nested anchors from serialized entries in a fresh runtime", async () => {
    const path = join(root, "resume.txt");
    await writeFile(path, "one\ntwo\n");
    const first = createHarness(SessionManager.inMemory(root));

    const tagged = await first.read("resume.txt");
    await first.nested("read", tagged);

    const sessionHeader = first.session.getHeader();
    if (!sessionHeader) throw new Error("Expected a session header");
    const serialized = JSON.parse(
      JSON.stringify([sessionHeader, ...first.session.getEntries()]),
    );
    const resumed = createHarness(
      SessionManager.inMemory(root, undefined, serialized),
    );

    await resumed.edit(`${hashlineHeader(tagged)}\nPUT 2.=2:\n+TWO`);
    expect(await readFile(path, "utf8")).toBe("one\nTWO\n");
  });
});
