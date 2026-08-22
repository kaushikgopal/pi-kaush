export const MAX_NDJSON_FRAME_CHARS = 64 * 1024 * 1024;

export interface NdjsonFrames {
  frames: string[];
  remainder: string;
}

/** Split accumulated NDJSON while bounding complete and partial frames. */
export const splitNdjsonFrames = (
  input: string,
  maxFrameChars = MAX_NDJSON_FRAME_CHARS,
): NdjsonFrames => {
  const frames: string[] = [];
  let start = 0;
  let newline = input.indexOf("\n", start);

  while (newline !== -1) {
    const length = newline - start;
    if (length > maxFrameChars) {
      throw new Error(`NDJSON frame exceeds ${maxFrameChars} characters`);
    }
    frames.push(input.slice(start, newline));
    start = newline + 1;
    newline = input.indexOf("\n", start);
  }

  const remainder = input.slice(start);
  if (remainder.length > maxFrameChars) {
    throw new Error(`NDJSON frame exceeds ${maxFrameChars} characters`);
  }

  return { frames, remainder };
};
