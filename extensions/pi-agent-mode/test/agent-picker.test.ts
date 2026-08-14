import { describe, expect, it } from "vitest";
import { buildAgentPickerItems, NONE_VALUE } from "../src/agent-picker.ts";
import type { AgentConfig } from "../src/agent-discovery.ts";

function agent(name: string, extra: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name,
    description: `${name} description`,
    systemPrompt: "prompt",
    filePath: `/tmp/${name}.md`,
    source: "user",
    ...extra,
  } as AgentConfig;
}

describe("buildAgentPickerItems", () => {
  it("keeps the emoji in the label and marks the active agent", () => {
    const items = buildAgentPickerItems(
      [agent("hemingway", { emoji: "👨‍🎨" }), agent("plain")],
      "plain",
    );
    expect(items[0]!.label).toBe("👨‍🎨 hemingway");
    expect(items[1]!.label).toBe("● plain");
  });

  it("prefixes project agent descriptions", () => {
    const items = buildAgentPickerItems(
      [agent("repo", { source: "project" })],
      undefined,
    );
    expect(items[0]!.description).toBe("Project agent. repo description");
  });

  it("adds None only when an agent is active, always last", () => {
    const withActive = buildAgentPickerItems([agent("a")], "a");
    expect(withActive.at(-1)!.value).toBe(NONE_VALUE);
    const withoutActive = buildAgentPickerItems([agent("a")], undefined);
    expect(withoutActive.some((item) => item.value === NONE_VALUE)).toBe(false);
  });
});
