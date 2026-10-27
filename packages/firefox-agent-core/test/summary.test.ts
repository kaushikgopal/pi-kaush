import { describe, expect, it } from "vitest";
import { summarizeSnapshot } from "../src/summary.js";

describe("summarizeSnapshot", () => {
  it("parses recognized compact snapshot roles without returning refs or values", () => {
    const result = summarizeSnapshot({
      title: "Checkout",
      text: [
        'title "Checkout"',
        "url https://example.test/checkout?token=hidden",
        "generation g1-abc",
        '@e1 heading "Checkout" level=1',
        '@e2 textbox "customer@example.test" type=email',
        '@e3 button "Submit"',
        '@e4 button "Submit"',
        '@e5 dialog "Confirm order"',
      ].join("\n"),
      truncated: false,
    });

    expect(result).toEqual({
      title: "Checkout",
      headings: ["Checkout"],
      controls: { textbox: 1, button: 2 },
      dialogs: ["Confirm order"],
      truncated: false,
    });
    expect(JSON.stringify(result)).not.toMatch(
      /@e\d|customer@example|token=hidden|https:/u,
    );
  });

  it("keeps repeated headings and counts only recognized control roles", () => {
    const result = summarizeSnapshot({
      title: "Page",
      text: [
        '@e1 heading "Overview" level=1',
        '@e2 heading "Overview" level=2',
        '@e3 menuitem "Options"',
        '@e4 link "Help" href="/help"',
      ].join("\n"),
      truncated: false,
    });

    expect(result.headings).toEqual(["Overview", "Overview"]);
    expect(result.controls).toEqual({ menuitem: 1, link: 1 });
  });

  it("does not derive headings or controls from prose, HTML, or malformed lines", () => {
    const result = summarizeSnapshot({
      title: "Known title",
      text: '<h1>Invented</h1>\nheading "Not a snapshot entry"\n@e1 heading "Broken',
      truncated: false,
    });

    expect(result).toEqual({
      title: "Known title",
      headings: [],
      controls: {},
      dialogs: [],
      truncated: false,
    });
  });

  it("preserves Unicode and caps the complete serialized object by UTF-8 bytes", () => {
    const text = [
      '@e1 heading "' + "🧭".repeat(80) + '" level=1',
      '@e2 dialog "' + "🚀".repeat(80) + '"',
    ].join("\n");
    const result = summarizeSnapshot({
      title: "世界🌍".repeat(80),
      text,
      truncated: false,
      maxBytes: 512,
    });
    const encoded = new TextEncoder().encode(JSON.stringify(result));

    expect(encoded.byteLength).toBeLessThanOrEqual(512);
    expect(JSON.parse(new TextDecoder().decode(encoded))).toEqual(result);
    expect(result.truncated).toBe(true);
    expect(result.title).not.toMatch(/[\uD800-\uDBFF]$/u);
    for (const value of [...result.headings, ...result.dialogs]) {
      expect(value).not.toMatch(/[\uD800-\uDBFF]$/u);
    }
  });

  it("fits exactly at the serialized byte limit and stays valid below it", () => {
    const input = {
      title: "Exact 🌟",
      text: Array.from(
        { length: 24 },
        (_, index) => "@e" + String(index + 1) + ' heading "A heading"',
      ).join("\n"),
      truncated: false,
    };
    const full = summarizeSnapshot(input);
    const exactBytes = new TextEncoder().encode(
      JSON.stringify(full),
    ).byteLength;
    const exact = summarizeSnapshot({ ...input, maxBytes: exactBytes });
    const oneByteLess = summarizeSnapshot({
      ...input,
      maxBytes: exactBytes - 1,
    });

    expect(exactBytes).toBeGreaterThanOrEqual(256);
    expect(JSON.stringify(exact)).toBe(JSON.stringify(full));
    expect(new TextEncoder().encode(JSON.stringify(exact)).byteLength).toBe(
      exactBytes,
    );
    expect(
      new TextEncoder().encode(JSON.stringify(oneByteLess)).byteLength,
    ).toBeLessThanOrEqual(exactBytes - 1);
    expect(oneByteLess.truncated).toBe(true);
  });

  it("marks backend truncation and preserves an empty backend without invented content", () => {
    expect(summarizeSnapshot({ title: "", text: "", truncated: true })).toEqual(
      {
        title: "",
        headings: [],
        controls: {},
        dialogs: [],
        truncated: true,
      },
    );
    expect(
      summarizeSnapshot({ title: "", text: "", truncated: false }),
    ).toEqual({
      title: "",
      headings: [],
      controls: {},
      dialogs: [],
      truncated: false,
    });
  });

  it("bounds scanning for very large backend text", () => {
    const manyEntries = Array.from(
      { length: 6_000 },
      (_, index) => "@e" + String(index + 1) + ' button "Action"',
    ).join("\n");
    const result = summarizeSnapshot({
      title: "Page",
      text: manyEntries,
      truncated: false,
    });

    expect(result.controls.button).toBeLessThan(6_000);
    expect(result.controls.button).toBeGreaterThan(0);
    expect(result.truncated).toBe(true);
    expect(
      summarizeSnapshot({
        title: "Page",
        text: "x".repeat(1_000_000),
        truncated: false,
      }).truncated,
    ).toBe(true);
    const hugeTitle = summarizeSnapshot({
      title: "x".repeat(1_000_000),
      text: "",
      truncated: false,
    });
    expect(hugeTitle.title).toHaveLength(256);
    expect(hugeTitle.truncated).toBe(true);
  });

  it("rejects budgets below the documented minimum", () => {
    expect(() =>
      summarizeSnapshot({
        title: "",
        text: "",
        truncated: false,
        maxBytes: 255,
      }),
    ).toThrow(RangeError);
  });
});
