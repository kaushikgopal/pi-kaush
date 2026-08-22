import { describe, expect, it } from "vitest";
import { splitNdjsonFrames } from "../src/core/ndjson.ts";

describe("splitNdjsonFrames", () => {
  it("returns multiple complete frames and the remainder", () => {
    expect(splitNdjsonFrames("one\ntwo\npartial")).toEqual({
      frames: ["one", "two"],
      remainder: "partial",
    });
  });

  it("reassembles a frame split across inputs", () => {
    const first = splitNdjsonFrames("par");
    const second = splitNdjsonFrames(first.remainder + "tial\n");

    expect(first).toEqual({ frames: [], remainder: "par" });
    expect(second).toEqual({ frames: ["partial"], remainder: "" });
  });

  it("leaves blank frames available to callers", () => {
    expect(splitNdjsonFrames("\nvalue\n\n")).toEqual({
      frames: ["", "value", ""],
      remainder: "",
    });
  });

  it("rejects an oversized unterminated frame", () => {
    expect(() => splitNdjsonFrames("1234", 3)).toThrow(
      "NDJSON frame exceeds 3 characters",
    );
  });

  it("rejects an oversized complete frame", () => {
    expect(() => splitNdjsonFrames("1234\n", 3)).toThrow(
      "NDJSON frame exceeds 3 characters",
    );
  });

  it("accepts a frame exactly at the bound", () => {
    expect(splitNdjsonFrames("1234\n", 4)).toEqual({
      frames: ["1234"],
      remainder: "",
    });
  });
});
