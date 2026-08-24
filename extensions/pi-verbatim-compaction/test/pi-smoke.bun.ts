import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import verbatimCompaction from "../src/extension.ts";
import { splitRangesAroundProtected } from "../src/ranges.ts";
import { buildTranscript } from "../src/transcript.ts";

const temporaryDirectories: string[] = [];

for (const [name, value] of Object.entries({
  PI_VERBATIM_COMPACTION_ENABLED: "true",
  PI_VERBATIM_COMPACTION_RETENTION_RATIO: "0.5",
  PI_VERBATIM_COMPACTION_MINIMUM_TOKENS: "0",
  PI_VERBATIM_COMPACTION_MINIMUM_REDUCTION_TOKENS: "1",
  PI_VERBATIM_COMPACTION_SPECULATION_ENABLED: "false",
})) {
  process.env[name] = value;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test("Pi SDK persists and resumes an extension-provided verbatim compaction", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-verbatim-smoke-"));
  temporaryDirectories.push(cwd);
  const agentDir = join(cwd, "agent");
  const sessionManager = SessionManager.inMemory(cwd);
  sessionManager.appendMessage(
    user(
      "first objective\n<keepContext>\nnever change the public API\n</keepContext>\n" +
        "old-noise\n".repeat(600),
    ),
  );
  sessionManager.appendMessage(
    assistant("first result\n" + "old-output\n".repeat(600)),
  );
  sessionManager.appendMessage(user("current objective"));
  sessionManager.appendMessage(assistant("current result"));

  const settingsManager = SettingsManager.inMemory({
    compaction: {
      enabled: true,
      reserveTokens: 256,
      keepRecentTokens: 100,
    },
  });
  const faux = fauxProvider({
    provider: "verbatim-faux",
    api: "verbatim-faux-api",
    models: [
      {
        id: "planner",
        name: "Planner",
        contextWindow: 100_000,
        maxTokens: 4_096,
      },
    ],
  });
  const modelRuntime = await ModelRuntime.create({
    modelsPath: null,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);

  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    extensionFactories: [
      {
        name: "planner-fixture",
        factory: (pi) => {
          pi.on("session_before_compact", (event) => {
            const transcript = buildTranscript({
              previousSummary: event.preparation.previousSummary,
              messagesToSummarize: event.preparation.messagesToSummarize,
              turnPrefixMessages: event.preparation.turnPrefixMessages,
            });
            const ranges = splitRangesAroundProtected(
              [{ start: 1, end: transcript.lines.length }],
              transcript.protectedLines,
              transcript.lines.length,
            );
            faux.setResponses([
              fauxAssistantMessage(
                ranges.map((range) => `${range.start},${range.end}`).join("\n"),
              ),
            ]);
          });
        },
      },
      { name: "pi-verbatim-compaction", factory: verbatimCompaction },
    ],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();

  const { session, extensionsResult } = await createAgentSession({
    cwd,
    agentDir,
    model: faux.getModel(),
    modelRuntime,
    sessionManager,
    settingsManager,
    resourceLoader,
    tools: [],
  });
  expect(extensionsResult.errors).toEqual([]);
  let sessionDisposed = false;
  let resumedSession: typeof session | undefined;

  try {
    const result = await session.compact();
    expect(result.summary).toContain("[verbatim-compaction:");
    expect(result.details).toEqual(
      expect.objectContaining({
        strategy: "verbatim-lines-v1",
        planSource: "foreground",
      }),
    );

    const compactionEntry = [...sessionManager.getBranch()]
      .reverse()
      .find((entry) => entry.type === "compaction");
    expect(compactionEntry).toEqual(
      expect.objectContaining({
        fromHook: true,
        firstKeptEntryId: result.firstKeptEntryId,
        details: expect.objectContaining({ strategy: "verbatim-lines-v1" }),
      }),
    );
    expect(sessionManager.buildSessionContext().messages[0]).toEqual(
      expect.objectContaining({
        role: "compactionSummary",
        summary: result.summary,
      }),
    );
    expect(faux.state.callCount).toBe(1);

    session.dispose();
    sessionDisposed = true;
    sessionManager.appendMessage(
      user("follow-up objective\n" + "new-noise\n".repeat(600)),
    );
    sessionManager.appendMessage(
      assistant("follow-up result\n" + "new-output\n".repeat(600)),
    );
    const resumed = await createAgentSession({
      cwd,
      agentDir,
      model: faux.getModel(),
      modelRuntime,
      sessionManager,
      settingsManager,
      resourceLoader,
      tools: [],
    });
    resumedSession = resumed.session;
    expect(resumed.extensionsResult.errors).toEqual([]);
    const second = await resumedSession.compact();
    expect(second.details).toEqual(
      expect.objectContaining({ strategy: "verbatim-lines-v1" }),
    );
    expect(second.summary).toContain("never change the public API");
    expect(
      sessionManager.getBranch().filter((entry) => entry.type === "compaction"),
    ).toHaveLength(2);
    expect(faux.state.callCount).toBe(2);
  } finally {
    if (!sessionDisposed) session.dispose();
    resumedSession?.dispose();
  }
});

function user(content: string) {
  return { role: "user" as const, content, timestamp: Date.now() };
}

function assistant(text: string) {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    api: "verbatim-faux-api",
    provider: "verbatim-faux",
    model: "planner",
    usage: {
      input: 10,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 20,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop" as const,
    timestamp: Date.now(),
  };
}
