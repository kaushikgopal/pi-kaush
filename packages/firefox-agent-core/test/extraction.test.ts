import { describe, expect, it } from "vitest";
import { extractFirefoxFields } from "../src/extraction.js";

describe("extractFirefoxFields", () => {
  it("returns exact typed values with bounded source evidence", () => {
    const result = extractFirefoxFields(
      {
        title: { type: "text" },
        amount: { type: "number", unit: "USD", decimals: 2 },
        count: { type: "integer" },
        due: { type: "date" },
        time: { type: "time" },
        startsAt: { type: "datetime" },
        elapsed: { type: "duration" },
        pause: { type: "duration", unit: "min" },
        tags: { type: "list" },
        scores: { type: "list.number" },
        dates: { type: "list.date" },
      },
      {
        title: [
          {
            text: "  Release notes  ",
            ref: "e2",
            pageText: "not returned",
          } as never,
        ],
        amount: [{ text: "12.50" }],
        count: [{ text: "4" }],
        due: [{ text: "2026-02-28" }],
        time: [{ text: "09:30" }],
        startsAt: [{ text: "2026-02-28T09:30:00+02:00" }],
        elapsed: [{ text: "PT1H30M" }],
        pause: [{ text: "1.5" }],
        tags: [{ text: "alpha, beta; gamma" }],
        scores: [{ text: "1.5,2" }],
        dates: [{ text: "2026-01-01;2026-02-28" }],
      },
    );

    expect(result.title).toMatchObject({
      status: "extracted",
      type: "text",
      value: "Release notes",
    });
    expect(result.amount).toMatchObject({
      status: "extracted",
      type: "number",
      value: 12.5,
      unit: "USD",
    });
    expect(result.count).toMatchObject({
      status: "extracted",
      type: "integer",
      value: 4,
    });
    expect(result.due).toMatchObject({
      status: "extracted",
      type: "date",
      value: "2026-02-28",
    });
    expect(result.time).toMatchObject({
      status: "extracted",
      type: "time",
      value: "09:30",
    });
    expect(result.startsAt).toMatchObject({
      status: "extracted",
      type: "datetime",
      value: "2026-02-28T07:30:00.000Z",
    });
    expect(result.elapsed).toMatchObject({
      status: "extracted",
      type: "duration",
      value: 5_400,
      unit: "s",
    });
    expect(result.pause).toMatchObject({
      status: "extracted",
      type: "duration",
      value: 90,
      unit: "s",
    });
    expect(result.tags).toMatchObject({
      status: "extracted",
      type: "list",
      value: ["alpha", "beta", "gamma"],
    });
    expect(result.scores).toMatchObject({
      status: "extracted",
      type: "list.number",
      value: [1.5, 2],
    });
    expect(result.dates).toMatchObject({
      status: "extracted",
      type: "list.date",
      value: ["2026-01-01", "2026-02-28"],
    });
    expect(JSON.stringify(result)).not.toContain("pageText");
  });

  it("distinguishes absent, ambiguous, unsupported, and conflicting sources", () => {
    const result = extractFirefoxFields(
      {
        absent: { type: "text" },
        localeNumber: { type: "number" },
        localeDate: { type: "date" },
        vagueTime: { type: "time" },
        instruction: {
          type: "text",
          instructions: "guess the nearest matching label",
        },
        conflict: { type: "integer" },
      },
      {
        localeNumber: [{ text: "1,234" }],
        localeDate: [{ text: "03/04/2026" }],
        vagueTime: [{ text: "3:30 PM" }],
        instruction: [{ text: "Alpha" }],
        conflict: [{ text: "3" }, { text: "4" }],
      },
    );

    expect(result.absent).toEqual({
      status: "absent",
      type: "text",
      evidence: [],
    });
    expect(result.localeNumber).toMatchObject({
      status: "uncertain",
      reason: "ambiguous_number",
    });
    expect(result.localeDate).toMatchObject({
      status: "uncertain",
      reason: "ambiguous_date",
    });
    expect(result.vagueTime).toMatchObject({
      status: "uncertain",
      reason: "ambiguous_time",
    });
    expect(result.instruction).toMatchObject({
      status: "uncertain",
      reason: "unsupported_instructions",
    });
    expect(result.conflict).toMatchObject({
      status: "uncertain",
      reason: "conflicting_candidates",
    });
  });

  it("does not guess timezone, locale, precision, or list boundaries", () => {
    const result = extractFirefoxFields(
      {
        datetime: { type: "datetime" },
        precise: { type: "number", decimals: 1 },
        highPrecision: { type: "number" },
        emptyList: { type: "list.number" },
        invalidDuration: { type: "duration" },
      },
      {
        datetime: [{ text: "2026-02-28T09:30:00" }],
        precise: [{ text: "1.23" }],
        highPrecision: [{ text: "1234567890123456.7" }],
        emptyList: [{ text: "1,,2" }],
        invalidDuration: [{ text: "about 5 minutes" }],
      },
    );

    expect(result.datetime).toMatchObject({
      status: "uncertain",
      reason: "ambiguous_datetime",
    });
    expect(result.precise).toMatchObject({
      status: "uncertain",
      reason: "precision_exceeded",
    });
    expect(result.highPrecision).toMatchObject({
      status: "uncertain",
      reason: "precision_exceeded",
    });
    expect(result.emptyList).toMatchObject({
      status: "uncertain",
      reason: "invalid_list",
    });
    expect(result.invalidDuration).toMatchObject({
      status: "uncertain",
      reason: "ambiguous_duration",
    });
  });

  it("caps evidence text, source count, candidates, and fields", () => {
    const longText = "x".repeat(1_000);
    const candidates = Array.from({ length: 21 }, () => ({
      text: longText,
      ref: "e1",
    }));
    const result = extractFirefoxFields(
      { field: { type: "text" } },
      { field: candidates },
    );

    expect(result.field).toMatchObject({
      status: "uncertain",
      reason: "candidate_limit",
    });
    expect(result.field?.evidence).toHaveLength(3);
    expect(result.field?.evidence[0]?.text).toHaveLength(240);
    expect(result.field?.evidence[0]?.truncated).toBe(true);
  });
});
