import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

const STATE_TYPE = "pi-response-style/state";

interface HarnessOptions {
  selectChoice?: string | undefined;
  confirmAnswer?: boolean;
  branch?: unknown[];
  trusted?: boolean;
  projectStyles?: Record<string, string>;
}

async function createHarness(opts: HarnessOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), "pi-response-style-"));
  const bundledDir = join(root, "bundled");
  const userDir = join(root, "user");
  mkdirSync(bundledDir);
  mkdirSync(userDir);
  writeFileSync(
    join(bundledDir, "terse.md"),
    "---\ntitle: Terse\ndescription: Few words\n---\n\nBe terse.\n",
  );
  writeFileSync(
    join(userDir, "chatty.md"),
    "---\ntitle: Chatty\ndescription: Many words\n---\n\nBe chatty.\n",
  );

  process.env.PI_RESPONSE_STYLE_BUNDLED_DIR = bundledDir;
  process.env.PI_RESPONSE_STYLE_DIR = userDir;
  process.env.PI_RESPONSE_STYLE_STATE_FILE = join(root, "state.json");

  const cwd = join(root, "proj");
  if (opts.projectStyles) {
    const projectStylesDir = join(cwd, ".pi", "response-styles");
    mkdirSync(projectStylesDir, { recursive: true });
    for (const [file, content] of Object.entries(opts.projectStyles)) {
      writeFileSync(join(projectStylesDir, file), content);
    }
  }

  const appended: Array<{ type: string; data: { name: string | null } }> = [];
  const emitted: Array<{
    name: string;
    payload: {
      name: string | null;
      title: string | null;
      defaultName?: string;
    };
  }> = [];
  const notifications: string[] = [];
  const statuses: Record<string, string | undefined> = {};
  let commandHandler: (args: string, ctx: unknown) => Promise<void>;
  let completionsFn:
    | ((prefix: string) => { value: string; label: string }[] | null)
    | undefined;
  const handlers: Record<string, (event: never, ctx: unknown) => unknown> = {};

  const pi = {
    registerCommand: (_name: string, def: never) => {
      const d = def as {
        handler: typeof commandHandler;
        getArgumentCompletions?: typeof completionsFn;
      };
      commandHandler = d.handler;
      completionsFn = d.getArgumentCompletions;
    },
    on: (event: string, handler: (event: never, ctx: unknown) => unknown) => {
      handlers[event] = handler;
    },
    appendEntry: (type: string, data: { name: string | null }) =>
      appended.push({ type, data }),
    events: {
      emit: (name: string, payload: never) => emitted.push({ name, payload }),
    },
  };
  const ctx = {
    ui: {
      select: async (_title: string, _choices: string[]) => opts.selectChoice,
      confirm: async () => opts.confirmAnswer ?? false,
      notify: (msg: string) => notifications.push(msg),
      setStatus: (key: string, text: string | undefined) => {
        statuses[key] = text;
      },
    },
    sessionManager: { getBranch: () => opts.branch ?? [] },
    cwd,
    isProjectTrusted: () => opts.trusted ?? false,
  };

  const { default: extension } = await import("../src/index.ts");
  extension(pi as never);

  return {
    userDir,
    appended,
    emitted,
    notifications,
    statuses,
    handlers,
    runCommand: (args: string) => commandHandler(args, ctx),
    completions: (prefix: string) => completionsFn?.(prefix),
    sessionStart: () =>
      handlers.session_start?.({ reason: "startup" } as never, ctx),
    inject: (prompt = "BASE") =>
      (
        handlers.before_agent_start?.(
          { systemPrompt: prompt } as never,
          ctx,
        ) as { systemPrompt: string } | undefined
      )?.systemPrompt ?? prompt,
  };
}

beforeEach(() => {
  delete process.env.PI_RESPONSE_STYLE_BUNDLED_DIR;
  delete process.env.PI_RESPONSE_STYLE_DIR;
  delete process.env.PI_RESPONSE_STYLE_STATE_FILE;
});

describe("/response-style picker", () => {
  it("picking a style persists state, last-used, and footer status", async () => {
    const h = await createHarness({
      selectChoice: "Terse — Few words",
      confirmAnswer: false,
    });
    await h.runCommand("");
    expect(h.appended).toEqual([{ type: STATE_TYPE, data: { name: "terse" } }]);
    expect(h.statuses["response-style"]).toBe("Terse");
    expect(h.inject()).toContain("# Communication");
    expect(h.inject()).toContain("Be terse.");
  });

  it("confirming yes writes the default config", async () => {
    const h = await createHarness({
      selectChoice: "Terse — Few words",
      confirmAnswer: true,
    });
    await h.runCommand("");
    const { readDefaultName } = await import("../src/state.ts");
    expect(readDefaultName(h.userDir)).toBe("terse");
    // Once the pick becomes the default, the footer marker hides.
    expect(h.statuses["response-style"]).toBeUndefined();
  });

  it("Esc-cancel changes nothing", async () => {
    const h = await createHarness({ selectChoice: undefined });
    await h.runCommand("");
    expect(h.appended).toEqual([]);
    expect(h.inject()).toBe("BASE");
    expect(h.notifications.some((msg) => msg.includes("unchanged"))).toBe(true);
  });

  it("picking Off records an explicit off marker and clears the footer", async () => {
    const h = await createHarness({ selectChoice: "Off — No response style" });
    await h.runCommand("");
    expect(h.appended).toEqual([{ type: STATE_TYPE, data: { name: null } }]);
    expect(h.statuses["response-style"]).toBeUndefined();
    expect(h.inject()).toBe("BASE");
  });

  it("direct arg sets a style; unknown arg warns and changes nothing", async () => {
    const h = await createHarness();
    await h.runCommand("chatty");
    expect(h.appended).toEqual([
      { type: STATE_TYPE, data: { name: "chatty" } },
    ]);

    const before = h.appended.length;
    await h.runCommand("nope");
    expect(h.appended).toHaveLength(before);
    expect(h.notifications.some((msg) => msg.includes("nope"))).toBe(true);
    expect(h.inject()).toContain("# Communication");
  });

  it("completions offer style names and off", async () => {
    const h = await createHarness();
    const values = h.completions("")?.map((item) => item.value);
    expect(values).toContain("off");
    expect(values).toContain("terse");
    expect(values).toContain("chatty");
    expect(h.completions("te")?.map((item) => item.value)).toEqual(["terse"]);
  });
});

describe("session restore and injection", () => {
  it("restores the newest pick on the branch", async () => {
    const h = await createHarness({
      branch: [
        { type: "custom", customType: STATE_TYPE, data: { name: "terse" } },
        { type: "custom", customType: STATE_TYPE, data: { name: "chatty" } },
      ],
    });
    await h.sessionStart();
    expect(h.inject()).toContain("# Communication");
  });

  it("off marker on the branch stops the cascade even with a default configured", async () => {
    const h = await createHarness({
      branch: [
        { type: "custom", customType: STATE_TYPE, data: { name: null } },
      ],
    });
    const { writeDefaultName } = await import("../src/state.ts");
    writeDefaultName(h.userDir, "terse");
    await h.sessionStart();
    expect(h.inject()).toBe("BASE");
  });

  it("injects exactly once per turn with the guardrail", async () => {
    const h = await createHarness({
      selectChoice: "Terse — Few words",
    });
    await h.runCommand("");
    const prompt = h.inject();
    expect(prompt.indexOf("# Communication")).toBe(
      prompt.lastIndexOf("# Communication"),
    );
    expect(prompt).toContain("Never apply it to internal reasoning");
    expect(prompt.startsWith("BASE")).toBe(true);
  });

  it("re-persists the pick across compaction", async () => {
    const h = await createHarness({
      selectChoice: "Terse — Few words",
    });
    await h.runCommand("");
    h.handlers.session_compact?.({} as never, {});
    expect(h.appended).toHaveLength(2);
    expect(h.appended[1]).toEqual({
      type: STATE_TYPE,
      data: { name: "terse" },
    });
  });
});

describe("project styles", () => {
  const projectFiles = {
    "chatty.md":
      "---\ntitle: ProjectChatty\ndescription: Repo voice\n---\n\nBe project-chatty.\n",
  };

  it("trusted project styles override user styles", async () => {
    const h = await createHarness({
      trusted: true,
      projectStyles: projectFiles,
    });
    await h.runCommand("chatty");
    expect(h.inject()).toContain("# Communication");
    expect(h.inject()).toContain("Be project-chatty.");
  });

  it("untrusted project styles are ignored", async () => {
    const h = await createHarness({
      trusted: false,
      projectStyles: projectFiles,
    });
    await h.runCommand("chatty");
    expect(h.inject()).toContain("# Communication");
    expect(h.inject()).toContain("Be chatty.");
  });
});

describe("footer status", () => {
  it("stays hidden when the active style is the default", async () => {
    const h = await createHarness({
      branch: [
        { type: "custom", customType: STATE_TYPE, data: { name: "terse" } },
      ],
    });
    const { writeDefaultName } = await import("../src/state.ts");
    writeDefaultName(h.userDir, "terse");
    await h.sessionStart();
    expect(h.inject()).toContain("# Communication");
    expect(h.statuses["response-style"]).toBeUndefined();
  });

  it("shows the title only when the pick differs from the default, and emits on the bus", async () => {
    const h = await createHarness({
      branch: [
        { type: "custom", customType: STATE_TYPE, data: { name: "chatty" } },
      ],
    });
    const { writeDefaultName } = await import("../src/state.ts");
    writeDefaultName(h.userDir, "terse");
    await h.sessionStart();
    expect(h.statuses["response-style"]).toBe("Chatty");
    const last = h.emitted[h.emitted.length - 1]!;
    expect(last.name).toBe("pi-response-style:changed");
    expect(last.payload).toEqual({
      name: "chatty",
      title: "Chatty",
      defaultName: "terse",
    });
  });
});
