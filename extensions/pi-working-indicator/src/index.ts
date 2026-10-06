import type {
  ExtensionAPI,
  ExtensionContext,
  WorkingIndicatorOptions,
} from "@earendil-works/pi-coding-agent";

const CELLS = 8;
const LIT_WINDOW = 4; // lit squares per frame, including the leading head
const INTERVAL_MS = 80;
const SQUARE = "▪";

// The user message rail (▎) color, so the wave matches the chat's accent.
const ACCENT_TOKEN = "borderAccent" as const;

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

const accentWave = (ctx: ExtensionContext): WorkingIndicatorOptions => ({
  frames: waveFrames({
    head: (square) => `\x1b[1m${ctx.ui.theme.fg(ACCENT_TOKEN, square)}\x1b[22m`,
    lit: (square) => ctx.ui.theme.fg(ACCENT_TOKEN, square),
    dim: (square) => ctx.ui.theme.fg("dim", square),
  }),
  intervalMs: INTERVAL_MS,
});

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.setWorkingIndicator(accentWave(ctx));
    ctx.ui.setWorkingMessage("");
  });

  pi.registerCommand("working-indicator", {
    description:
      "Toggle the working indicator: wave, none, or reset to Pi's native spinner.",
    handler: async (args, ctx) => {
      switch (args.trim().toLowerCase()) {
        case "":
        case "wave":
          ctx.ui.setWorkingIndicator(accentWave(ctx));
          ctx.ui.notify("Working indicator: accent wave, no label", "info");
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
