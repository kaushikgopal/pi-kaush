// Deterministic text metrics for the pi-response-style bench.
//
// No LLM judge: every metric is a plain function over the reply string.
// The harness measures two things — (a) the model's work is unchanged when
// a style is active, and (b) the visible output is shorter and more
// skimmable. These functions handle (b); the coding-test runner in
// runner.mjs handles (a).

/** Count whitespace-separated words. */
export function countWords(text) {
  const matched = text.trim().match(/\S+/g);
  return matched ? matched.length : 0;
}

/** First line of the reply, trimmed. */
export function firstLine(reply) {
  const lines = reply.trim().split(/\r?\n/);
  return (lines[0] ?? "").trim();
}

/**
 * Words before the first bold marker (**): the lower, the faster the reply
 * reaches its point. If the reply never bolds anything, the point is never
 * reached, so we count the whole reply — the case is penalized in the
 * median rather than silently dropped.
 */
export function wordsBeforeBold(reply) {
  const idx = reply.indexOf("**");
  if (idx < 0) return countWords(reply);
  return countWords(reply.slice(0, idx));
}

export function hasBold(reply) {
  return reply.includes("**");
}

// "Ends with a verb-led recommendation": checked against the tail of the
// first line, not the whole reply. Imperfect by design (the spec calls this
// a heuristic); the bold check is the stronger signal.
const RECOMMENDATION_VERBS =
  /\b(use|pick|choose|go with|reach for|prefer|avoid|skip|start with|grab|take|stick with|switch to)\b/i;

/** Answer/conclusion in the first line: bolded phrase OR verb-led recommendation at the end. */
export function answerInFirstLine(reply) {
  const line = firstLine(reply);
  if (line.includes("**")) return true;
  const tail = line.split(/\s+/).slice(-8).join(" ");
  return RECOMMENDATION_VERBS.test(tail);
}

/**
 * Longest unbroken text block, in words. A block is a run of text with no
 * blank line inside it; walls of prose score high, tight paragraphs low.
 */
export function longestBlockWords(reply) {
  const blocks = reply.split(/\n\s*\n/);
  let max = 0;
  for (const block of blocks) {
    const n = countWords(block);
    if (n > max) max = n;
  }
  return max;
}

// Wrapper openers and trailing offers that mark a non-bare deliverable.
const WRAPPER_START =
  /^(here(?:'s| is|'re)?|sure|of course|certainly|absolutely|below(?: is)?|i've|i have|this is|let me|great|happy to|yep|yeah|okay|ofc)\b[,!.]?/i;

const WRAPPER_END =
  /\b(let me know|hope this helps|feel free|happy to help|reach out|if you need|if you'd like|if you want)\b[.!?]?\s*$/i;

/**
 * Deliverable purity: pure if the reply neither opens with a wrapper phrase
 * ("Here's...", "Sure,...") nor closes with an offer ("Let me know.").
 */
export function deliverablePurity(reply) {
  const body = reply.trim();
  const wrappedStart = WRAPPER_START.test(body);
  const wrappedEnd = WRAPPER_END.test(body.slice(-80));
  return { pure: !wrappedStart && !wrappedEnd, wrappedStart, wrappedEnd };
}

/** Readability metrics for one reply. */
export function readabilityMetrics(reply) {
  return {
    chars: reply.length,
    words: countWords(reply),
    wordsBeforeBold: wordsBeforeBold(reply),
    hasBold: hasBold(reply),
    answerInFirstLine: answerInFirstLine(reply),
    longestBlockWords: longestBlockWords(reply),
  };
}
