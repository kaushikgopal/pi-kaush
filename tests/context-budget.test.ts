import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

/**
 * Context-budget guardrail.
 *
 * Pi injects the global AGENTS.md, the cwd AGENTS.md, and the active response
 * style into every system prompt, so their combined size is pure per-turn
 * overhead. The hard rule is the net budget: all files together stay under
 * 200 lines. Per-file caps are the recommendation, printed when the net
 * budget is exceeded so the fix direction is obvious: each AGENTS.md <= 100
 * lines and the response style <= 50 lines (sum: the classic 150 rule).
 *
 * This guards Kaushik's personal config, not a package behavior, so it only
 * runs where those files exist (his machines). CI and other machines skip it.
 */

const NET_BUDGET = 200;
const AGENTS_RECOMMENDATION = 100;
const STYLE_RECOMMENDATION = 50;

function lineCount(filePath: string): number {
  const content = readFileSync(filePath, "utf8");
  return (content.match(/\n/g) ?? []).length;
}

/** Resolve the active response style file: config default, else last-used. */
function resolveStyleFile(): string | undefined {
  const stylesDir = join(homedir(), ".pi", "agent", "response-styles");
  const source = [
    join(stylesDir, "config.json"),
    join(homedir(), ".pi", "agent", "pi-response-style.state.json"),
  ]
    .filter(existsSync)
    .map((p) => JSON.parse(readFileSync(p, "utf8")))
    .find(
      (value) =>
        typeof value?.default === "string" ||
        typeof value?.lastUsed === "string",
    );
  const name = source?.default ?? source?.lastUsed;
  if (typeof name !== "string") return undefined;
  const candidate = join(stylesDir, `${name}.md`);
  return existsSync(candidate) ? candidate : undefined;
}

const homeAgents = join(homedir(), "AGENTS.md");
const repoAgents = fileURLToPath(new URL("../AGENTS.md", import.meta.url));
const styleFile = resolveStyleFile();

const files: Array<[label: string, path: string]> = [
  ["home AGENTS.md", homeAgents],
  ["repo AGENTS.md", repoAgents],
];
if (styleFile) files.push(["response style", styleFile]);

const present = files.filter(([, path]) => existsSync(path));

describe.skipIf(present.length === 0)("context budget", () => {
  test(`AGENTS.md + response style stay under ${NET_BUDGET} lines net`, () => {
    const breakdown = present.map(
      ([label, path]) => `${label}: ${lineCount(path)} lines`,
    );
    const total = present.reduce((sum, [, path]) => sum + lineCount(path), 0);
    const recommendation = [
      `recommended caps: each AGENTS.md <= ${AGENTS_RECOMMENDATION} lines,`,
      `response style <= ${STYLE_RECOMMENDATION} lines (sum ${AGENTS_RECOMMENDATION + STYLE_RECOMMENDATION})`,
    ].join("\n");
    expect(
      total,
      `${breakdown.join(", ")}\n${recommendation}\n-> net ${total} lines`,
    ).toBeLessThan(NET_BUDGET);
  });
});
