/**
 * TUI picker for `/agent`: SelectList with per-item descriptions, theme
 * colors, agent emoji kept in the label, and a ● marker on the active agent.
 * Non-TUI modes fall back to plain ctx.ui.select in the command handler.
 */

import {
  DynamicBorder,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  SelectList,
  Text,
  type SelectItem,
} from "@earendil-works/pi-tui";
import { formatAgentDisplayName, type AgentConfig } from "./agent-discovery.ts";

export const NONE_VALUE = "none";

export function buildAgentPickerItems(
  agents: AgentConfig[],
  activeName: string | undefined,
): SelectItem[] {
  const items: SelectItem[] = agents.map((agent) => {
    const marker = agent.name === activeName ? "● " : "";
    const origin = agent.source === "project" ? "Project agent. " : "";
    return {
      value: agent.name,
      label: `${marker}${formatAgentDisplayName(agent)}`,
      description: `${origin}${agent.description}`,
    };
  });
  if (activeName) {
    items.push({
      value: NONE_VALUE,
      label: "None",
      description: "Restore the default model, thinking level, and tools",
    });
  }
  return items;
}

/** Resolves with the picked agent name, NONE_VALUE, or null when cancelled. */
export async function showAgentPicker(
  ctx: ExtensionCommandContext,
  items: SelectItem[],
): Promise<string | null> {
  return ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
    const container = new Container();
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    container.addChild(
      new Text(theme.fg("accent", theme.bold("Activate agent")), 1, 0),
    );

    const list = new SelectList(items, Math.min(items.length, 10), {
      selectedPrefix: (t: string) => theme.fg("accent", t),
      selectedText: (t: string) => theme.fg("accent", t),
      description: (t: string) => theme.fg("muted", t),
      scrollInfo: (t: string) => theme.fg("dim", t),
      noMatch: (t: string) => theme.fg("warning", t),
    });
    list.onSelect = (item: SelectItem) => done(item.value);
    list.onCancel = () => done(null);
    container.addChild(list);

    container.addChild(
      new Text(
        theme.fg("dim", "↑↓ navigate • enter select • esc cancel   ● active"),
        1,
        0,
      ),
    );
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

    return {
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        list.handleInput(data);
        tui.requestRender();
      },
    };
  });
}
