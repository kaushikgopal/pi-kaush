/**
 * TUI picker for response styles: SelectList with per-item descriptions,
 * theme colors, and markers for the active (●) and default (★) styles.
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
import type { Style } from "./styles.ts";

export const OFF_VALUE = "off";

export function buildPickerItems(
  styles: Style[],
  active: string | null,
  defaultName: string | undefined,
): SelectItem[] {
  const items: SelectItem[] = styles.map((style) => {
    const marker = style.name === active ? "● " : "";
    const isDefault = style.name === defaultName ? " ★" : "";
    const origin = style.origin === "project" ? "Project style. " : "";
    return {
      value: style.name,
      label: `${marker}${style.title}${isDefault}`,
      description: `${origin}${style.description}`,
    };
  });
  items.push({
    value: OFF_VALUE,
    label: "Off",
    description: "No response style",
  });
  return items;
}

/** Resolves with the picked style name, OFF_VALUE, or null when cancelled. */
export async function showStylePicker(
  ctx: ExtensionCommandContext,
  items: SelectItem[],
): Promise<string | null> {
  return ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
    const container = new Container();
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    container.addChild(
      new Text(theme.fg("accent", theme.bold("Response style")), 1, 0),
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
        theme.fg(
          "dim",
          "↑↓ navigate • enter select • esc cancel   ● active ★ default",
        ),
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
