import { afterEach, describe, expect, test } from "bun:test";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionBeforeCompactEvent,
  SessionEntry,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  COMPACTION_LOG_TYPE,
  renderCompactionLogEntry,
  type CompactionLogData,
} from "../src/chat-log.ts";
import verbatimCompaction from "../src/extension.ts";
import { findSummaryProvenance } from "../src/compactor.ts";
import { runPlanner, PlannerFailure } from "../src/planner.ts";
import { searchSessionHistory } from "../src/recall.ts";
import { buildTranscript, digestText } from "../src/transcript.ts";

const ENV_NAMES = [
  "PI_VERBATIM_COMPACTION_ENABLED",
  "PI_VERBATIM_COMPACTION_RETENTION_RATIO",
  "PI_VERBATIM_COMPACTION_MINIMUM_TOKENS",
  "PI_VERBATIM_COMPACTION_MINIMUM_REDUCTION_TOKENS",
  "PI_VERBATIM_COMPACTION_SPECULATION_ENABLED",
  "PI_VERBATIM_COMPACTION_SPECULATION_TRIGGER_RATIO",
] as const;

afterEach(() => {
  for (const name of ENV_NAMES) delete process.env[name];
});

const model = {
  provider: "faux",
  api: "faux-api",
  id: "planner",
  name: "Planner",
  baseUrl: "https://example.invalid",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 4_096,
} as never;

const usage = {
  input: 100,
  output: 10,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 110,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

describe("planner integration", () => {
  test("uses the configured model runtime and strict range output", async () => {
    let requestContext: unknown;
    const transcript = buildTranscript({
      messagesToSummarize: [userMessage("goal\n" + "noise".repeat(100))],
      turnPrefixMessages: [],
    });
    const result = await runPlanner(
      {
        transcript,
        objective: "finish the parser",
        targetRetainedTokens: 10,
      },
      { model: "current", maxOutputTokens: 512, timeoutMs: 10_000 },
      {
        model,
        modelRegistry: {
          hasConfiguredAuth: () => true,
          complete: async (_model: unknown, context: unknown) => {
            requestContext = context;
            return assistantResponse("3,4");
          },
        },
      } as never,
      new AbortController().signal,
    );

    expect(result.ranges).toEqual([{ start: 3, end: 4 }]);
    expect(result.usage).toEqual(usage);
    expect(JSON.stringify(requestContext)).toContain(
      "BEGIN UNTRUSTED TRANSCRIPT DATA",
    );
    expect(JSON.stringify(requestContext)).toContain("finish the parser");
  });

  test("recovers only complete records from a length stop", async () => {
    const result = await runPlanner(
      {
        transcript: buildTranscript({
          messagesToSummarize: [userMessage("x".repeat(100))],
          turnPrefixMessages: [],
        }),
        objective: "goal",
        targetRetainedTokens: 1,
      },
      { model: "current", maxOutputTokens: 128, timeoutMs: 10_000 },
      plannerContext("2,4\n7,", "length"),
      new AbortController().signal,
    );
    expect(result.ranges).toEqual([{ start: 2, end: 4 }]);
  });

  test("rejects malformed planner prose", async () => {
    await expect(
      runPlanner(
        {
          transcript: buildTranscript({
            messagesToSummarize: [userMessage("x".repeat(100))],
            turnPrefixMessages: [],
          }),
          objective: "goal",
          targetRetainedTokens: 1,
        },
        { model: "current", maxOutputTokens: 128, timeoutMs: 10_000 },
        plannerContext("Here are the ranges:\n2,4"),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      reason: "malformed-output",
    } satisfies Partial<PlannerFailure>);
  });

  test("rejects out-of-bounds ranges before host normalization", async () => {
    await expect(
      runPlanner(
        {
          transcript: buildTranscript({
            messagesToSummarize: [userMessage("small")],
            turnPrefixMessages: [],
          }),
          objective: "goal",
          targetRetainedTokens: 1,
        },
        { model: "current", maxOutputTokens: 128, timeoutMs: 10_000 },
        plannerContext("99,100"),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ reason: "malformed-output" });
  });

  test("preflights planner context and enforces a deadline", async () => {
    const transcript = buildTranscript({
      messagesToSummarize: [userMessage("x".repeat(1_000))],
      turnPrefixMessages: [],
    });
    await expect(
      runPlanner(
        { transcript, objective: "goal", targetRetainedTokens: 1 },
        { model: "current", maxOutputTokens: 20, timeoutMs: 10_000 },
        {
          model: {
            ...(model as unknown as Record<string, unknown>),
            contextWindow: 50,
            maxTokens: 20,
          },
          modelRegistry: {
            complete: () => Promise.reject(new Error("unused")),
          },
        } as never,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ reason: "context-overflow" });

    await expect(
      runPlanner(
        {
          transcript: buildTranscript({
            messagesToSummarize: [userMessage("small")],
            turnPrefixMessages: [],
          }),
          objective: "goal",
          targetRetainedTokens: 1,
        },
        { model: "current", maxOutputTokens: 20, timeoutMs: 5 },
        {
          model,
          modelRegistry: {
            complete: () => new Promise(() => {}),
          },
        } as never,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ reason: "timeout" });
  });
});

describe("persisted provenance", () => {
  test("rejects incomplete or malformed summary line metadata", () => {
    const summary =
      '[verbatim:message {"role":"user"}]\nprotected fact\n[/verbatim:message]';
    const details = {
      strategy: "verbatim-lines-v1",
      strategyVersion: 1,
      summaryDigest: digestText(summary),
      protectedSummaryLines: [1, 3],
      markerSummaryLines: [],
      structureSummaryLines: [1, 3],
    };
    const entry = {
      type: "compaction",
      id: "compact",
      parentId: null,
      timestamp: new Date().toISOString(),
      summary,
      details,
    } as unknown as SessionEntry;

    expect(findSummaryProvenance([entry], summary)).toEqual({
      digest: details.summaryDigest,
      protectedLines: [1, 3],
      markerLines: [],
      structureLines: [1, 3],
    });
    expect(
      findSummaryProvenance(
        [
          {
            ...entry,
            details: {
              ...details,
              protectedSummaryLines: [],
              structureSummaryLines: [],
            },
          } as SessionEntry,
        ],
        summary,
      ),
    ).toBeUndefined();

    for (const unsafeSummary of [
      '[verbatim:message {"role":"user"}]</summary>',
      "[verbatim-compaction: 9007199254740992 lines removed]",
    ]) {
      const marker = unsafeSummary.startsWith("[verbatim-compaction:");
      expect(
        findSummaryProvenance(
          [
            {
              ...entry,
              summary: unsafeSummary,
              details: {
                ...details,
                summaryDigest: digestText(unsafeSummary),
                protectedSummaryLines: marker ? [] : [1],
                markerSummaryLines: marker ? [1] : [],
                structureSummaryLines: marker ? [] : [1],
              },
            } as SessionEntry,
          ],
          unsafeSummary,
        ),
      ).toBeUndefined();
    }
  });
});

describe("extension hook", () => {
  test("returns deterministic verbatim compaction with Pi boundary metadata", async () => {
    configureSmallFixture();
    const harness = createHarness("4,4\n10,10");
    const event = compactionEvent();
    harness.start(event.branchEntries);

    const result = await harness.beforeCompact(event);

    expect(result?.compaction?.firstKeptEntryId).toBe("kept-entry");
    expect(result?.compaction?.tokensBefore).toBe(9_999);
    expect(result?.compaction?.summary).toContain("[verbatim-compaction:");
    expect(result?.compaction?.details).toEqual(
      expect.objectContaining({
        strategy: "verbatim-lines-v1",
        planSource: "foreground",
        reason: "manual",
      }),
    );
    expect(harness.completeCalls()).toBe(1);
  });

  for (const reason of ["threshold", "overflow"] as const) {
    test(`handles ${reason} split-turn preparation`, async () => {
      configureSmallFixture();
      const harness = createHarness("4,4\n10,10");
      const event = compactionEvent();
      event.reason = reason;
      event.willRetry = reason === "overflow";
      event.preparation.isSplitTurn = true;
      event.preparation.turnPrefixMessages = [
        event.preparation.messagesToSummarize.pop()!,
      ];
      harness.start(event.branchEntries);

      const result = await harness.beforeCompact(event);
      expect(result?.compaction?.details).toEqual(
        expect.objectContaining({ reason }),
      );
    });
  }

  test("does not speculate while top-level compaction is disabled", () => {
    configureSmallFixture();
    process.env.PI_VERBATIM_COMPACTION_ENABLED = "false";
    process.env.PI_VERBATIM_COMPACTION_SPECULATION_ENABLED = "true";
    const harness = createHarness("4,4");
    const event = compactionEvent();
    harness.start(event.branchEntries);
    harness.turnEnd();
    expect(harness.completeCalls()).toBe(0);
  });

  test("fails open to Pi on malformed output", async () => {
    configureSmallFixture();
    const harness = createHarness("not a range");
    const event = compactionEvent();
    harness.start(event.branchEntries);
    expect(await harness.beforeCompact(event)).toBeUndefined();
  });

  test("falls back when the provider aborts the planner", async () => {
    configureSmallFixture();
    const harness = createHarness("4,4", "aborted");
    const event = compactionEvent();
    harness.start(event.branchEntries);
    expect(await harness.beforeCompact(event)).toBeUndefined();
  });

  test("cancels only when Pi aborts the compaction event", async () => {
    configureSmallFixture();
    const harness = createHarness("4,4");
    const event = compactionEvent();
    const controller = new AbortController();
    controller.abort();
    event.signal = controller.signal;
    harness.start(event.branchEntries);
    expect(await harness.beforeCompact(event)).toEqual({ cancel: true });
  });

  test("reuses an exact-prefix speculative plan without a second model call", async () => {
    configureSmallFixture();
    process.env.PI_VERBATIM_COMPACTION_SPECULATION_ENABLED = "true";
    process.env.PI_VERBATIM_COMPACTION_SPECULATION_TRIGGER_RATIO = "0.7";
    const harness = createHarness("4,4\n10,10");
    const event = compactionEvent();
    harness.start(event.branchEntries);
    harness.beforeAgentStart(`goal\n${"x".repeat(4_000)}`);
    harness.turnEnd();
    await waitFor(() => harness.completeCalls() === 1);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const result = await harness.beforeCompact(event);

    expect(result?.compaction?.details).toEqual(
      expect.objectContaining({ planSource: "speculative" }),
    );
    expect(harness.completeCalls()).toBe(1);
  });
});

describe("historical recall", () => {
  test("searches original branch entries, excludes thinking and bounds output", () => {
    const entries = [
      sessionEntry("u", null, userMessage("Do not edit generated/cache.ts")),
      sessionEntry("a", "u", {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "private needle" },
          { type: "text", text: "Public needle at src/cache.ts:47" },
          {
            type: "toolCall",
            id: "c",
            name: "bash",
            arguments: { command: "npm test" },
          },
        ],
        api: "faux-api",
        provider: "faux",
        model: "planner",
        usage,
        stopReason: "stop",
        timestamp: 2,
      }),
      sessionEntry("t", "a", {
        role: "toolResult",
        toolCallId: "c",
        toolName: "bash",
        content: [{ type: "text", text: "FAIL expected 14 received 13" }],
        isError: true,
        timestamp: 3,
      }),
    ] as SessionEntry[];

    expect(
      searchSessionHistory(entries, "needle", {
        limit: 5,
        maxCharacters: 2_000,
      }),
    ).toEqual([
      expect.objectContaining({
        entryId: "a",
        excerpt: expect.stringContaining("Public needle"),
      }),
    ]);
    expect(
      searchSessionHistory(entries, "private needle", {
        limit: 5,
        maxCharacters: 2_000,
      }),
    ).toEqual([]);
    expect(
      searchSessionHistory(entries, "expected 14", {
        limit: 1,
        maxCharacters: 30,
      })[0]?.excerpt.length,
    ).toBeLessThanOrEqual(32);
    const excludedBash = sessionEntry("b", "t", {
      role: "bashExecution",
      command: "!! secret-token",
      output: "secret output",
      excludeFromContext: true,
      timestamp: 4,
    }) as SessionEntry;
    expect(
      searchSessionHistory([excludedBash], "secret", {
        limit: 5,
        maxCharacters: 2_000,
      }),
    ).toEqual([]);

    const longPrefix = sessionEntry(
      "long",
      null,
      userMessage(`${"x".repeat(5_000)}\nMATCH-HERE`),
    );
    expect(
      searchSessionHistory([longPrefix], "MATCH-HERE", {
        limit: 1,
        maxCharacters: 100,
      })[0]?.excerpt,
    ).toContain("MATCH-HERE");

    const hostileMetadata = sessionEntry("meta", null, {
      ...assistantMessage(""),
      content: [
        {
          type: "toolCall",
          id: "call",
          name: `hostile\n${"n".repeat(10_000)}`,
          arguments: { payload: `TARGET ${"z".repeat(1_000_000)}` },
        },
      ],
    });
    const metadataMatches = searchSessionHistory([hostileMetadata], "TARGET", {
      limit: 1,
      maxCharacters: 500,
    });
    expect(metadataMatches[0]?.excerpt).toContain("TARGET");
    expect(metadataMatches[0]?.excerpt.length).toBeLessThanOrEqual(500);

    const unicodePrefix = sessionEntry(
      "unicode",
      null,
      userMessage(`${"İ".repeat(500)}TARGET`),
    );
    expect(
      searchSessionHistory([unicodePrefix], "target", {
        limit: 1,
        maxCharacters: 100,
      })[0]?.excerpt,
    ).toContain("TARGET");

    const protoArguments = JSON.parse('{"__proto__":"PROTO-TARGET"}');
    const controlMetadata = sessionEntry("control", null, {
      ...assistantMessage(""),
      content: [
        {
          type: "toolCall",
          id: "control-call",
          name: "bad\u001b[31m\nname",
          arguments: protoArguments,
        },
      ],
    });
    const controlMatches = searchSessionHistory(
      [controlMetadata],
      "PROTO-TARGET",
      { limit: 1, maxCharacters: 500 },
    );
    expect(controlMatches[0]?.excerpt).toContain("PROTO-TARGET");
    expect(controlMatches[0]?.label).not.toContain("\u001b");
    expect(controlMatches[0]?.label).not.toContain("\n");

    const throwingArguments = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("hostile metadata");
        },
      },
    );
    const throwingMetadata = sessionEntry("throwing", null, {
      ...assistantMessage(""),
      content: [
        {
          type: "toolCall",
          id: "throwing-call",
          name: "throwing",
          arguments: throwingArguments,
        },
      ],
    });
    expect(
      searchSessionHistory([throwingMetadata], "unserializable arguments", {
        limit: 1,
        maxCharacters: 500,
      })[0]?.excerpt,
    ).toContain('"[unserializable arguments]"');
  });
});

describe("compaction chat log", () => {
  test("renders a verbatim card with unmuted header and muted body", async () => {
    configureSmallFixture();
    const harness = createHarness("4,4\n10,10");
    const event = compactionEvent();
    harness.start(event.branchEntries);
    const result = await harness.beforeCompact(event);
    harness.compacted({
      summary: result?.compaction?.summary ?? "",
      tokensBefore: event.preparation.tokensBefore,
      details: result?.compaction?.details,
      fromExtension: true,
    });

    const entry = harness.appended.find(
      (item) => item.type === COMPACTION_LOG_TYPE,
    );
    expect(entry).toBeDefined();
    const data = entry?.data as CompactionLogData;
    expect(data.kind).toBe("verbatim");
    expect(data.tokensBefore).toBeGreaterThan(0);

    const component = renderCompactionLogEntry(
      { data },
      { expanded: false },
      fakeTheme,
    );
    const lines = component?.render(80) ?? [];
    expect(lines.length).toBe(3);
    expect(lines[0]).toStartWith("  ");
    expect(lines[0]).toContain("≡");
    expect(lines[0]).toContain("verbatim compaction");
    expect(lines[0]).toContain("\x1b[35m"); // toolTitle
    expect(lines[0]).toContain("─");
    expect(lines[1]).toContain("\x1b[90m"); // muted
    expect(lines[1]).toContain("lines removed");
    expect(lines[1]).toContain("% kept)");
    expect(lines[2]).toContain("pinned lines");
    expect(lines[1]).not.toContain("\x1b[35m");
    for (const line of lines)
      expect(visibleWidth(line)).toBeLessThanOrEqual(80);
  });

  test("renders expanded detail and survives narrow widths", () => {
    const data: CompactionLogData = {
      version: 1,
      kind: "verbatim",
      tokensBefore: 41_203,
      outputTokens: 20_611,
      deletedLines: 258,
      rangesApplied: 1,
      rangesProposed: 12,
      protectedLines: 3,
      targetRetainedTokens: 20_480,
      plannerModel: "gpt-5.4",
      plannerLatencyMs: 2_100,
      planSource: "speculative",
      summaryDigest: "ab12cd34ef56",
    };
    const expanded = renderCompactionLogEntry(
      { data },
      { expanded: true },
      fakeTheme,
    )?.render(80);
    expect(expanded?.some((line) => line.includes("digest ab12cd34ef56"))).toBe(
      true,
    );
    const narrow =
      renderCompactionLogEntry(
        { data },
        { expanded: false },
        fakeTheme,
      )?.render(24) ?? [];
    for (const line of narrow)
      expect(visibleWidth(line)).toBeLessThanOrEqual(24);
  });

  test("rejects malformed entry data", () => {
    expect(
      renderCompactionLogEntry(
        { data: { version: 2 } },
        { expanded: false },
        fakeTheme,
      ),
    ).toBeUndefined();
    expect(
      renderCompactionLogEntry(
        { data: "nope" },
        { expanded: false },
        fakeTheme,
      ),
    ).toBeUndefined();
  });

  test("a verbatim fail-open renders its own failed card, then a normal native card", async () => {
    configureSmallFixture();
    const harness = createHarness("garbage");
    const event = compactionEvent();
    harness.start(event.branchEntries);
    expect(await harness.beforeCompact(event)).toBeUndefined();

    const failedData = harness.appended.find(
      (item) => item.type === COMPACTION_LOG_TYPE,
    )?.data as CompactionLogData;
    expect(failedData.kind).toBe("verbatim");
    expect(failedData.status).toBe("failed");
    const failedLines =
      renderCompactionLogEntry(
        { data: failedData },
        { expanded: false },
        fakeTheme,
      )?.render(80) ?? [];
    expect(failedLines[0]).toContain("verbatim compaction");
    expect(failedLines[0]).toContain("\x1b[31m"); // error header
    expect(failedLines[1]).toContain("malformed");

    // Native then succeeds on its own terms; its card carries no verbatim
    // status and stays the normal tool-title color.
    harness.compacted({
      summary: "native summary",
      tokensBefore: 61_200,
      details: undefined,
      fromExtension: false,
    });
    const nativeData = harness.appended.at(-1)?.data as CompactionLogData;
    expect(nativeData.kind).toBe("native");
    expect(nativeData.status).toBeUndefined();
    const nativeLines =
      renderCompactionLogEntry(
        { data: nativeData },
        { expanded: false },
        fakeTheme,
      )?.render(80) ?? [];
    expect(nativeLines[0]).toContain("native compaction");
    expect(nativeLines[0]).toContain("\x1b[35m"); // toolTitle header
    expect(nativeLines[1]).toContain("61,200 → ~");
    expect(nativeLines.some((line) => line.includes("malformed"))).toBe(false);
  });

  test("failed and cancelled compactions color the card of the strategy that ran", () => {
    configureSmallFixture();
    const harness = createHarness("4,4");
    harness.start([]);
    harness.compactFailed({
      aborted: false,
      fromExtension: true,
      errorMessage: "provider boom",
    });
    harness.compactFailed({ aborted: true, fromExtension: false });

    const [failed, cancelled] = harness.appended.map(
      (item) => item.data as CompactionLogData,
    );
    expect(failed?.kind).toBe("verbatim");
    expect(failed?.status).toBe("failed");
    expect(cancelled?.kind).toBe("native");
    expect(cancelled?.status).toBe("cancelled");

    const failedLines =
      renderCompactionLogEntry(
        { data: failed },
        { expanded: false },
        fakeTheme,
      )?.render(80) ?? [];
    expect(failedLines[0]).toContain("verbatim compaction");
    expect(failedLines[0]).toContain("\x1b[31m"); // error
    expect(failedLines[1]).toContain("provider boom");
    const cancelledLines =
      renderCompactionLogEntry(
        { data: cancelled },
        { expanded: false },
        fakeTheme,
      )?.render(80) ?? [];
    expect(cancelledLines[0]).toContain("native compaction");
    expect(cancelledLines[0]).toContain("\x1b[33m"); // warning
    expect(cancelledLines[1]).toContain("cancelled");
  });
});

const ANSI_BY_TOKEN: Record<string, [string, string]> = {
  toolTitle: ["\x1b[35m", "\x1b[39m"],
  muted: ["\x1b[90m", "\x1b[39m"],
  dim: ["\x1b[2m", "\x1b[22m"],
  error: ["\x1b[31m", "\x1b[39m"],
  warning: ["\x1b[33m", "\x1b[39m"],
};

const fakeTheme = {
  fg: (color: string, text: string) => {
    const [open, close] = ANSI_BY_TOKEN[color] ?? ["", ""];
    return `${open}${text}${close}`;
  },
  bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
} as unknown as Theme;

function configureSmallFixture(): void {
  process.env.PI_VERBATIM_COMPACTION_ENABLED = "true";
  process.env.PI_VERBATIM_COMPACTION_RETENTION_RATIO = "0.5";
  process.env.PI_VERBATIM_COMPACTION_MINIMUM_TOKENS = "0";
  process.env.PI_VERBATIM_COMPACTION_MINIMUM_REDUCTION_TOKENS = "1";
  process.env.PI_VERBATIM_COMPACTION_SPECULATION_ENABLED = "false";
}

function createHarness(
  output: string,
  stopReason: "stop" | "aborted" = "stop",
) {
  const handlers = new Map<string, (...args: any[]) => any>();
  let calls = 0;
  let branch: SessionEntry[] = [];
  const entries = () => branch;
  const ctx = {
    model,
    modelRegistry: {
      hasConfiguredAuth: () => true,
      find: () => model,
      complete: async () => {
        calls += 1;
        return assistantResponse(output, stopReason);
      },
    },
    sessionManager: {
      getBranch: entries,
      getEntries: entries,
      getLeafId: () => branch.at(-1)?.id ?? null,
    },
    getContextUsage: () => ({
      tokens: 80_000,
      contextWindow: 100_000,
      percent: 80,
    }),
    hasUI: false,
    ui: {
      notify() {},
      setStatus() {},
    },
  } as unknown as ExtensionContext;
  const appended: { type: string; data: unknown }[] = [];
  const pi = {
    on(name: string, handler: (...args: any[]) => any) {
      handlers.set(name, handler);
    },
    registerTool() {},
    registerCommand() {},
    registerEntryRenderer() {},
    appendEntry(customType: string, data: unknown) {
      appended.push({ type: customType, data });
    },
  } as unknown as ExtensionAPI;
  verbatimCompaction(pi);

  return {
    start(nextBranch: SessionEntry[]) {
      branch = nextBranch;
      handlers.get("session_start")?.(
        { type: "session_start", reason: "startup" },
        ctx,
      );
    },
    beforeAgentStart(prompt: string) {
      handlers.get("before_agent_start")?.(
        { type: "before_agent_start", prompt },
        ctx,
      );
    },
    turnEnd() {
      handlers.get("turn_end")?.({ type: "turn_end", turnIndex: 1 }, ctx);
    },
    beforeCompact(event: SessionBeforeCompactEvent) {
      return handlers.get("session_before_compact")?.(event, ctx);
    },
    compacted(entry: {
      summary: string;
      tokensBefore: number;
      details?: unknown;
      fromExtension: boolean;
    }) {
      handlers.get("session_compact")?.(
        {
          type: "session_compact",
          compactionEntry: {
            type: "compaction",
            id: `compact-${appended.length}`,
            parentId: null,
            timestamp: new Date().toISOString(),
            summary: entry.summary,
            firstKeptEntryId: "kept-entry",
            tokensBefore: entry.tokensBefore,
            details: entry.details,
          },
          fromExtension: entry.fromExtension,
          reason: "manual",
          willRetry: false,
        },
        ctx,
      );
    },
    compactFailed(event: {
      aborted: boolean;
      fromExtension: boolean;
      errorMessage?: string;
    }) {
      handlers.get("session_compact_failed")?.(
        {
          type: "session_compact_failed",
          reason: "manual",
          willRetry: false,
          ...event,
        },
        ctx,
      );
    },
    appended,
    completeCalls: () => calls,
  };
}

function compactionEvent(): SessionBeforeCompactEvent {
  const user = userMessage("goal\n" + "x".repeat(4_000));
  const assistant = assistantMessage("result\n" + "y".repeat(4_000));
  const branch = [
    sessionEntry("user-entry", null, user),
    sessionEntry("assistant-entry", "user-entry", assistant),
  ];
  return {
    type: "session_before_compact",
    preparation: {
      firstKeptEntryId: "kept-entry",
      messagesToSummarize: [user, assistant],
      turnPrefixMessages: [],
      isSplitTurn: false,
      tokensBefore: 9_999,
      fileOps: { read: new Set(), written: new Set(), edited: new Set() },
      settings: {
        enabled: true,
        reserveTokens: 16_384,
        keepRecentTokens: 20_000,
      },
    },
    branchEntries: branch,
    reason: "manual",
    willRetry: false,
    signal: new AbortController().signal,
  };
}

function plannerContext(
  output: string,
  stopReason: "stop" | "length" = "stop",
) {
  return {
    model,
    modelRegistry: {
      hasConfiguredAuth: () => true,
      complete: async () => assistantResponse(output, stopReason),
    },
  } as never;
}

function assistantResponse(
  text: string,
  stopReason: "stop" | "length" | "aborted" = "stop",
) {
  return {
    role: "assistant",
    content: stopReason === "aborted" ? [] : [{ type: "text", text }],
    api: "faux-api",
    provider: "faux",
    model: "planner",
    usage,
    stopReason,
    ...(stopReason === "aborted" ? { errorMessage: "aborted" } : {}),
    timestamp: Date.now(),
  };
}

function userMessage(text: string) {
  return { role: "user" as const, content: text, timestamp: 1 };
}

function assistantMessage(text: string) {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    api: "faux-api",
    provider: "faux",
    model: "planner",
    usage,
    stopReason: "stop" as const,
    timestamp: 2,
  };
}

function sessionEntry(id: string, parentId: string | null, message: unknown) {
  return {
    type: "message" as const,
    id,
    parentId,
    timestamp: new Date().toISOString(),
    message,
  } as SessionEntry;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
