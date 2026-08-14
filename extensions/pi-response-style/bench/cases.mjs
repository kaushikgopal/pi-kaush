// Bench cases: three sets.
//
// - readability: short explanation/advice questions. Metrics: char count,
//   words before the first bold, answer-in-first-line, longest unbroken
//   block.
// - deliverable: "write me a ..." asks. Metric: pure deliverable vs wrapped.
// - coding: tiny function specs, each with a hidden node test that calls
//   the function by name. The runner extracts the fenced code block from
//   each arm's reply, concatenates the hidden test, and runs node. This set
//   is included here but run conditionally by the runner (only if the first
//   two sets complete cleanly and quickly).

export const READABILITY_CASES = [
  {
    id: "r1",
    prompt:
      "Which database should I pick for a new social app, Postgres or Mongo?",
  },
  {
    id: "r2",
    prompt:
      "What's the difference between async/await and promises in JavaScript?",
  },
  {
    id: "r3",
    prompt: "Should I use SSR or client-side rendering for a marketing site?",
  },
  {
    id: "r4",
    prompt:
      "When would I reach for a message queue instead of a direct API call?",
  },
  {
    id: "r5",
    prompt: "Is TypeScript worth it for a small solo side project?",
  },
  {
    id: "r6",
    prompt: "How do I decide between REST and gRPC for an internal service?",
  },
  {
    id: "r7",
    prompt: "What's the simplest way to cache API responses in a React app?",
  },
  {
    id: "r8",
    prompt: "Monorepo or polyrepo for a 3-person engineering team?",
  },
];

export const DELIVERABLE_CASES = [
  {
    id: "d1",
    prompt:
      "Write me a Slack message asking my team to review PR #482 by Friday.",
  },
  {
    id: "d2",
    prompt:
      "Write me a commit message for a fix that stops the export job from crashing on empty input.",
  },
  {
    id: "d3",
    prompt: "Write me a short out-of-office email for a one-week vacation.",
  },
  {
    id: "d4",
    prompt:
      "Write me a release note for v2.3.0 that adds CSV export and fixes a login bug.",
  },
  {
    id: "d5",
    prompt:
      "Write me a LinkedIn post announcing I'm hiring a senior backend engineer.",
  },
  {
    id: "d6",
    prompt:
      "Write me a polite follow-up email to a candidate who ghosted after the onsite.",
  },
];

// Each coding case names a single function the model must define. The hidden
// test calls that function by name; the runner concatenates the extracted
// snippet with the test and runs it as CommonJS (no import/export needed).
export const CODING_CASES = [
  {
    id: "c1",
    prompt:
      "Write a standalone function `sumNested(arr)` that returns the sum of all numbers in a possibly-nested array of numbers and arrays. No imports, no IIFE, no export statements — just the function definition.",
    test: `
const assert = require("assert");
assert.strictEqual(sumNested([1, [2, [3]], 4]), 10);
assert.strictEqual(sumNested([]), 0);
assert.strictEqual(sumNested([[[]], [[0]]]), 0);
assert.strictEqual(sumNested([1, -1, 2, -2]), 0);
console.log("c1 ok");
`,
  },
  {
    id: "c2",
    prompt:
      'Write a standalone function `fizzBuzz(n)` that returns an array of length n where the i-th entry (1-based) is "Fizz" if i is divisible by 3, "Buzz" if divisible by 5, "FizzBuzz" if divisible by 15, otherwise i as a string. No imports, no IIFE, no export statements — just the function definition.',
    test: `
const assert = require("assert");
assert.deepStrictEqual(fizzBuzz(5), ["1", "2", "Fizz", "4", "Buzz"]);
assert.strictEqual(fizzBuzz(15)[14], "FizzBuzz");
assert.deepStrictEqual(fizzBuzz(3), ["1", "2", "Fizz"]);
assert.strictEqual(fizzBuzz(1).length, 1);
console.log("c2 ok");
`,
  },
  {
    id: "c3",
    prompt:
      "Write a standalone function `isPalindrome(s)` that returns true if s is a palindrome, ignoring non-alphanumeric characters and case. No imports, no IIFE, no export statements — just the function definition.",
    test: `
const assert = require("assert");
assert.strictEqual(isPalindrome("A man, a plan, a canal: Panama"), true);
assert.strictEqual(isPalindrome("race a car"), false);
assert.strictEqual(isPalindrome(""), true);
assert.strictEqual(isPalindrome("a"), true);
assert.strictEqual(isPalindrome("No 'x' in Nixon"), true);
console.log("c3 ok");
`,
  },
  {
    id: "c4",
    prompt:
      "Write a standalone function `chunk(arr, size)` that splits arr into subarrays each of length `size` (the last may be shorter). No imports, no IIFE, no export statements — just the function definition.",
    test: `
const assert = require("assert");
assert.deepStrictEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
assert.deepStrictEqual(chunk([1, 2, 3, 4], 2), [[1, 2], [3, 4]]);
assert.deepStrictEqual(chunk([], 3), []);
assert.deepStrictEqual(chunk([1], 3), [[1]]);
console.log("c4 ok");
`,
  },
  {
    id: "c5",
    prompt:
      "Write a standalone function `countVowels(s)` that returns the number of vowels (a, e, i, o, u) in s, case-insensitive. No imports, no IIFE, no export statements — just the function definition.",
    test: `
const assert = require("assert");
assert.strictEqual(countVowels("hello"), 2);
assert.strictEqual(countVowels("AEIOU"), 5);
assert.strictEqual(countVowels("rhythm"), 0);
assert.strictEqual(countVowels(""), 0);
assert.strictEqual(countVowels("HAPPY bIRTHdAy"), 3);
console.log("c5 ok");
`,
  },
];
