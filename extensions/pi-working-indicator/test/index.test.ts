import { describe, expect, test } from "vitest";
import { waveFrames, type WaveColors } from "../src/index.ts";

const colors: WaveColors = {
  head: (square) => `H${square}`,
  lit: (square) => `l${square}`,
  dim: (square) => `d${square}`,
};

describe("waveFrames", () => {
  test("emits one frame per cell", () => {
    expect(waveFrames(colors)).toHaveLength(8);
    expect(waveFrames(colors, 5, 2)).toHaveLength(5);
  });

  test("every frame renders at the same visible width", () => {
    const widths = new Set(waveFrames(colors).map((frame) => frame.length));
    expect([...widths]).toHaveLength(1);
  });

  test("the head square advances one cell per frame and wraps", () => {
    const frames = waveFrames(colors, 5, 2);
    const headCell = (frame: string) => frame.match(/H|l|d/gu)?.indexOf("H");
    expect(frames.map(headCell)).toEqual([0, 1, 2, 3, 4]);
  });

  test("each frame has one head and window-1 trailing lit squares", () => {
    for (const frame of waveFrames(colors, 8, 4)) {
      expect(frame.indexOf("H")).toBeGreaterThanOrEqual(0);
      expect(frame.split("l")).toHaveLength(4); // window - 1 lit cells
    }
  });

  test("squares render adjacent, with no separator", () => {
    for (const frame of waveFrames(colors)) {
      expect(frame).not.toContain(" ");
    }
  });

  test("zero cells yields frames that hide the indicator", () => {
    expect(waveFrames(colors, 0, 0)).toEqual([]);
  });
});
