import { describe, expect, it } from "vitest";
import { buildPickerItems, OFF_VALUE } from "../src/picker.ts";
import type { Style } from "../src/styles.ts";

const styles: Style[] = [
  {
    name: "terse",
    title: "Terse",
    description: "Few words",
    body: "Be terse.",
    origin: "bundled",
  },
  {
    name: "repo",
    title: "Repo Voice",
    description: "Project tone",
    body: "Speak repo.",
    origin: "project",
  },
];

describe("buildPickerItems", () => {
  it("marks the active style with ● and the default with ★", () => {
    const items = buildPickerItems(styles, "terse", "repo");
    expect(items[0]!.label).toBe("● Terse");
    expect(items[1]!.label).toBe("Repo Voice ★");
  });

  it("prefixes project style descriptions and leaves others alone", () => {
    const items = buildPickerItems(styles, null, undefined);
    expect(items[0]!.description).toBe("Few words");
    expect(items[1]!.description).toBe("Project style. Project tone");
  });

  it("always puts Off last", () => {
    const items = buildPickerItems(styles, null, undefined);
    const off = items[items.length - 1]!;
    expect(off.value).toBe(OFF_VALUE);
    expect(off.label).toBe("Off");
  });

  it("combines markers when the active style is also the default", () => {
    const items = buildPickerItems(styles, "terse", "terse");
    expect(items[0]!.label).toBe("● Terse ★");
  });
});
