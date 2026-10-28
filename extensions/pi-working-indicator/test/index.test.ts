import {
  Theme,
  type WorkingIndicatorOptions,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import registerIndicator, {
  waveFrames,
  type WaveColors,
} from "../src/index.ts";

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

  test.each(["256color", "truecolor"] as const)(
    "each ANSI wave frame occupies eight terminal columns in %s mode",
    async (mode) => {
      const handlers = new Map<
        string,
        (event: unknown, context: unknown) => Promise<void>
      >();
      registerIndicator({
        on(
          event: string,
          handler: (event: unknown, context: unknown) => Promise<void>,
        ) {
          handlers.set(event, handler);
        },
        registerCommand() {},
      } as never);

      const theme = new Theme(
        {
          text: "#ff8010",
          muted: "#401008",
          dim: "#010203",
          thinkingXhigh: 15,
        } as never,
        { selectedBg: 0 } as never,
        mode,
        { dim: ["dim"] },
      );
      const indicators: WorkingIndicatorOptions[] = [];
      await handlers.get("session_start")!(
        {},
        {
          ui: {
            theme,
            setWorkingIndicator: (indicator: WorkingIndicatorOptions) =>
              indicators.push(indicator),
            setWorkingMessage() {},
          },
        },
      );

      const frames = indicators[0]!.frames!;
      expect(frames).toHaveLength(8);
      expect(frames.every((frame) => frame.includes("\x1b["))).toBe(true);
      expect(frames.map(visibleWidth)).toEqual(Array(8).fill(8));
    },
  );

  test("the head square advances one cell per frame and wraps", () => {
    const frames = waveFrames(colors, 5, 2);
    const headCell = (frame: string) => frame.match(/H|l|d/gu)?.indexOf("H");
    expect(frames.map(headCell)).toEqual([0, 1, 2, 3, 4]);
  });

  test("each frame has one head and window-1 trailing lit squares", () => {
    for (const frame of waveFrames(colors, 8, 4)) {
      expect(frame.match(/H/gu)).toHaveLength(1);
      expect(frame.split("l")).toHaveLength(4); // window - 1 lit cells
    }
  });

  test("squares render adjacent, with no separator", () => {
    for (const frame of waveFrames(colors)) {
      expect(frame).toMatch(/^(?:[Hld]▪){8}$/u);
    }
  });

  test("zero cells yields frames that hide the indicator", () => {
    expect(waveFrames(colors, 0, 0)).toEqual([]);
  });
});
