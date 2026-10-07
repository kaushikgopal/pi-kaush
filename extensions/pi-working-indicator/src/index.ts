import type {
  ExtensionAPI,
  ExtensionContext,
  WorkingIndicatorOptions,
} from "@earendil-works/pi-coding-agent";

const CELLS = 8;
const LIT_WINDOW = 3; // lit squares per frame: the head plus two neighbors
const INTERVAL_MS = 80;
const SQUARE = "▪";

export interface WaveColors {
  /** Leading edge of the wave. */
  head: (square: string) => string;
  /** Squares trailing the head inside the lit window. */
  lit: (square: string) => string;
  /** Squares outside the lit window. */
  dim: (square: string) => string;
}

/**
 * Frames for a bright window of squares traveling left-to-right with wraparound.
 * Frame `offset` places the head at square `offset`; squares behind it stay lit
 * for `window` cells, the rest dim. All frames render at identical width.
 */
export function waveFrames(
  colors: WaveColors,
  cells = CELLS,
  window = LIT_WINDOW,
): string[] {
  return Array.from({ length: cells }, (_, offset) =>
    Array.from({ length: cells }, (_, i) => {
      const trail = (i - offset + cells) % cells;
      const color =
        trail === 0 ? colors.head : trail < window ? colors.lit : colors.dim;
      return color(SQUARE);
    }).join(""),
  );
}

const wave = (ctx: ExtensionContext): WorkingIndicatorOptions => ({
  frames: waveFrames({
    head: (square) => `\x1b[1m${ctx.ui.theme.fg("text", square)}\x1b[22m`,
    lit: (square) => ctx.ui.theme.fg("muted", square),
    dim: (square) => ctx.ui.theme.fg("dim", square),
  }),
  intervalMs: INTERVAL_MS,
});

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.setWorkingIndicator(wave(ctx));
    ctx.ui.setWorkingMessage("");
  });

  // Re-resolve theme tokens each turn so theme switches between turns
  // are picked up (Pi exposes no theme-change event to extensions).
  pi.on("agent_start", async (_event, ctx) => {
    ctx.ui.setWorkingIndicator(wave(ctx));
  });

  pi.registerCommand("working-indicator", {
    description:
      "Toggle the working indicator: wave, none, or reset to Pi's native spinner.",
    handler: async (args, ctx) => {
      switch (args.trim().toLowerCase()) {
        case "":
        case "wave":
          ctx.ui.setWorkingIndicator(wave(ctx));
          ctx.ui.notify("Working indicator: muted wave, no label", "info");
          break;
        case "none":
          ctx.ui.setWorkingIndicator({ frames: [] });
          ctx.ui.notify("Working indicator: hidden", "info");
          break;
        case "reset":
          ctx.ui.setWorkingIndicator();
          ctx.ui.setWorkingMessage();
          ctx.ui.notify("Working indicator: Pi native", "info");
          break;
        default:
          ctx.ui.notify("Usage: /working-indicator [wave|none|reset]", "error");
      }
    },
  });
}
