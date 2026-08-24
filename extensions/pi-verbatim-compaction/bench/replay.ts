import { readFile } from "node:fs/promises";
import { applyCompaction, selectRangesForRetention } from "../src/ranges.ts";
import { buildTranscript } from "../src/transcript.ts";
import type { CompactionSource, InclusiveRange } from "../src/types.ts";

interface ReplayCase {
  name: string;
  source: CompactionSource;
  ranges: InclusiveRange[];
  retentionRatio?: number;
  minimumTokens?: number;
  probes?: string[];
}

const cases = process.argv[2]
  ? (JSON.parse(await readFile(process.argv[2], "utf8")) as ReplayCase[])
  : [syntheticCase()];

const results = cases.map(runCase);
console.log(JSON.stringify(results, null, 2));

function runCase(testCase: ReplayCase) {
  const transcript = buildTranscript(testCase.source, {
    protectedContext: true,
  });
  const target = Math.floor(
    transcript.estimatedTokens * (testCase.retentionRatio ?? 0.5),
  );
  const selected = selectRangesForRetention(transcript, testCase.ranges, {
    targetRetainedTokens: target,
    minimumRetainedTokens: testCase.minimumTokens ?? 0,
  });
  const applied = applyCompaction(transcript, selected);
  const probes = (testCase.probes ?? []).map((probe) => ({
    probe,
    before: transcript.text.includes(probe),
    after: applied.text.includes(probe),
  }));
  return {
    name: testCase.name,
    sourceLines: transcript.lines.length,
    sourceTokens: transcript.estimatedTokens,
    outputTokens: applied.retainedTokens,
    retainedRatio:
      transcript.estimatedTokens === 0
        ? 1
        : applied.retainedTokens / transcript.estimatedTokens,
    deletedLines: applied.deletedLines,
    rangesApplied: applied.ranges.length,
    probes,
  };
}

function syntheticCase(): ReplayCase {
  const noise = Array.from(
    { length: 500 },
    (_, index) => `duplicate successful output ${index}`,
  ).join("\n");
  return {
    name: "synthetic coding session",
    source: {
      messagesToSummarize: [
        {
          role: "user",
          content:
            "Fix src/parser.ts.\n<keepContext>\nDo not change the public API.\n</keepContext>",
          timestamp: 1,
        },
        {
          role: "toolResult",
          toolCallId: "test-1",
          toolName: "bash",
          content: [
            {
              type: "text",
              text: `${noise}\nFAIL src/parser.ts:147 expected 14, received 13`,
            },
          ],
          isError: true,
          timestamp: 2,
        },
      ],
      turnPrefixMessages: [],
    },
    ranges: [{ start: 1, end: 10_000 }],
    probes: [
      "Do not change the public API.",
      "src/parser.ts:147",
      "duplicate successful output 1",
    ],
  };
}
