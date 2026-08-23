import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

/**
 * Keep Kaushik's complete always-injected personal context under one limit.
 * This local guard only runs when both AGENTS.md files and the configured
 * response style exist; CI and other machines skip it.
 */
const NET_BUDGET = 200;

function lineCount(filePath: string): number {
  const content = readFileSync(filePath, "utf8");
  return (content.match(/\n/g) ?? []).length;
}

/** Resolve the configured response style: default, else last-used. */
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
const hasCompleteContext = styleFile !== undefined && present.length === 3;

describe.skipIf(!hasCompleteContext)("context budget", () => {
  test(`complete personal context stays under ${NET_BUDGET} lines net`, () => {
    const breakdown = present.map(
      ([label, path]) => `${label}: ${lineCount(path)} lines`,
    );
    const total = present.reduce((sum, [, path]) => sum + lineCount(path), 0);
    expect(
      total,
      `${breakdown.join(", ")}\n-> net ${total} lines`,
    ).toBeLessThan(NET_BUDGET);
  });
});
