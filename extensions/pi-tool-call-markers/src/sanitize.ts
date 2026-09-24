// Command output and model-supplied text can carry cursor-moving control
// bytes, raw terminal sequences, line feeds, and tabs. Collapsed rows and
// prompt blocks are width-fitted single lines, so scraped text is stripped of
// display sequences and all C0 controls before it can reach them; otherwise
// control bytes could split or overwrite a row.

const INLINE_CONTROL_RE = /[\x00-\x1f\x7f]/g;

// OSC first: the two-byte alternative would otherwise consume `\x1b]` and
// leave the hyperlink payload behind as visible text. OSC sequences (OSC 8
// hyperlinks, titles) end at their first BEL/ST terminator; a payload match
// must stop there too, because the visible text sits BETWEEN two OSC
// sequences — Pi wraps read paths as `ESC]8;;url ESC\ <path> ESC]8;; ESC\`,
// and a greedy `[^\x07]*` would swallow that path along with the sequences.
const DISPLAY_ANSI_RE =
  /\x1b(?:\][^\x07\x1b]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~]|[@-Z\\-_])/g;

export function sanitizeInline(text: string): string {
  return text.replace(DISPLAY_ANSI_RE, "").replace(INLINE_CONTROL_RE, " ");
}
