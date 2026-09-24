import { visibleWidth } from "@earendil-works/pi-tui";
import {
  SUBMITTED_PROMPT_PADDING,
  promptBlockContentWidth,
  promptBlockInset,
  renderRailedBlockLines,
  type PromptShellTheme,
} from "./prompt-shell.ts";
import { sanitizeInline } from "./sanitize.ts";

// An asked question is a user-input moment inside the transcript, not an
// execution row, so it takes the submitted-prompt shell instead of the
// tool-call rail: the questions read as quoted prose and the answers as the
// user's own text. The data comes entirely from what Pi already hands the
// tool row — `args.questions` and `result.details.answers` — so no coupling to
// any particular question-tool implementation is needed.

type QuestionTheme = PromptShellTheme & {
  fg(color: string, text: string): string;
  italic?(text: string): string;
};

type QuestionRow = {
  toolName?: string;
  args?: unknown;
  isPartial?: boolean;
  result?: {
    isError?: boolean;
    details?: Record<string, unknown>;
  };
};

type AnswerEntry = {
  question: string;
  questionIndex?: number | undefined;
  kind?: string | undefined;
  answer?: string | null | undefined;
  selected?: string[] | undefined;
};

type QuestionLine =
  | { kind: "question"; text: string }
  | { kind: "answer"; text: string }
  | { kind: "status"; text: string; tone: "muted" | "warning" }
  // A painted blank body row; the shell gives it the prompt surface.
  | { kind: "spacer" };

// rpiv's canonical decline text, reused verbatim so the transcript says what
// the model was told.
const DECLINE_TEXT = "User declined to answer questions";
const AWAITING_TEXT = "awaiting your answer…";
const NO_ANSWER_TEXT = "(no answer)";
const QUESTION_PREFIX = "> ";
const ANSWER_PREFIX = "User: ";

// Question tools keep the ask-tool vocabulary in their name even when they
// invent their own result shape. The result-shape check is the primary signal;
// this pattern is the fallback for calls that never reached an answer.
const QUESTION_TOOL_NAME_RE =
  /(^|_)(ask_?user_?question|ask_?user|user_?question|questionnaire)($|_)/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeToolName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function isQuestionToolName(name: string | undefined): boolean {
  if (!name) return false;
  return QUESTION_TOOL_NAME_RE.test(normalizeToolName(name));
}

// The rpiv result contract: `details.answers` is always an array of entries
// carrying the question text, and each entry's answer arrives as `answer`
// (option label or typed text) or `selected` (multi-select labels). Any
// deviation fails the shape check so an unrelated tool is never reshaped.
function parseAnswerEntries(details: unknown): AnswerEntry[] | undefined {
  if (!isRecord(details)) return undefined;
  const raw = details.answers;
  if (!Array.isArray(raw)) return undefined;
  const entries: AnswerEntry[] = [];
  for (const item of raw) {
    if (!isRecord(item) || typeof item.question !== "string") return undefined;
    const answer = item.answer;
    if (answer !== undefined && answer !== null && typeof answer !== "string") {
      return undefined;
    }
    const selected = item.selected;
    if (
      selected !== undefined &&
      !(
        Array.isArray(selected) &&
        selected.every((label) => typeof label === "string")
      )
    ) {
      return undefined;
    }
    entries.push({
      question: item.question,
      questionIndex:
        typeof item.questionIndex === "number" ? item.questionIndex : undefined,
      kind: typeof item.kind === "string" ? item.kind : undefined,
      answer,
      selected: selected as string[] | undefined,
    });
  }
  return entries;
}

function hasQuestionDetails(details: unknown): boolean {
  const entries = parseAnswerEntries(details);
  if (entries === undefined) return false;
  if (entries.length > 0) return true;
  if (!isRecord(details)) return false;
  // An empty `answers` array only means a questionnaire when the details also
  // carry the outcome that emptied it: a decline, or a validation failure.
  return details.cancelled === true || typeof details.error === "string";
}

function parseAskedQuestions(args: unknown): string[] | undefined {
  if (!isRecord(args) || !Array.isArray(args.questions)) return undefined;
  const questions: string[] = [];
  for (const item of args.questions) {
    if (!isRecord(item) || typeof item.question !== "string") return undefined;
    questions.push(item.question);
  }
  return questions.length > 0 ? questions : undefined;
}

function answerText(entry: AnswerEntry | undefined): string | undefined {
  if (!entry) return undefined;
  if (entry.kind === "multi" || entry.selected !== undefined) {
    return entry.selected && entry.selected.length > 0
      ? entry.selected.join(", ")
      : undefined;
  }
  return entry.answer && entry.answer.length > 0 ? entry.answer : undefined;
}

function entryForIndex(
  entries: AnswerEntry[],
  index: number,
  questionCount: number,
): AnswerEntry | undefined {
  const indexed = entries.find((entry) => entry.questionIndex === index);
  if (indexed) return indexed;
  // Entries without a `questionIndex` still arrive in ask order.
  return entries.some((entry) => entry.questionIndex !== undefined) ||
    entries.length !== questionCount
    ? undefined
    : entries[index];
}

function questionLines(
  row: QuestionRow,
  details: unknown,
): QuestionLine[] | undefined {
  const entries = parseAnswerEntries(details) ?? [];
  const asked = parseAskedQuestions(row.args);
  const pairs: Array<{ question: string; answer: string | undefined }> = [];
  if (asked) {
    asked.forEach((question, index) => {
      const entry = entryForIndex(entries, index, asked.length);
      pairs.push({ question, answer: answerText(entry) });
    });
  } else {
    for (const entry of entries) {
      pairs.push({ question: entry.question, answer: answerText(entry) });
    }
  }
  if (pairs.length === 0) return undefined;

  const pending = row.isPartial === true;
  const declined =
    !pending &&
    isRecord(details) &&
    details.cancelled === true &&
    pairs.every((pair) => pair.answer === undefined);

  // One group per question. Groups are separated by a painted blank row so a
  // multi-question ask stays scannable.
  const groups: QuestionLine[][] = pairs.map((pair) => {
    const group: QuestionLine[] = [{ kind: "question", text: pair.question }];
    if (!pending && !declined) {
      group.push({ kind: "answer", text: pair.answer ?? NO_ANSWER_TEXT });
    }
    return group;
  });
  if (pending || declined) {
    const status: QuestionLine = pending
      ? { kind: "status", text: AWAITING_TEXT, tone: "warning" }
      : { kind: "status", text: DECLINE_TEXT, tone: "muted" };
    // A lone question keeps its outcome on the following line; a
    // multi-question ask separates the global outcome so it cannot read as
    // answering only the last question.
    if (groups.length > 1) groups.push([status]);
    else groups[0]!.push(status);
  }

  const lines: QuestionLine[] = [];
  groups.forEach((group, index) => {
    if (index > 0) lines.push({ kind: "spacer" });
    lines.push(...group);
  });
  return lines;
}

function fg(theme: QuestionTheme, token: string, text: string): string {
  if (text === "") return "";
  try {
    return theme.fg(token, text);
  } catch {
    return text;
  }
}

// The question is the model's text read inside a user-input shell, so it takes
// the quotation's italics; the answer is the user's own words and stays upright.
// A theme without italics simply renders the question plainly.
function italics(theme: QuestionTheme, text: string): string {
  if (text === "" || typeof theme.italic !== "function") return text;
  try {
    return theme.italic(text);
  } catch {
    return text;
  }
}

// Plain-text word wrap with a hanging indent, so a wrapped question stays
// visually attached to its `> ` prefix. Wrapping before styling keeps the
// width math exact and lets the shell's own fit pass stay a no-op.
function wrapPlain(text: string, width: number): string[] {
  const max = Math.max(1, width);
  const words = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (words.length === 0) return [""];

  const lines: string[] = [];
  let current = "";
  const push = (word: string) => {
    const candidate = current === "" ? word : `${current} ${word}`;
    if (visibleWidth(candidate) <= max) {
      current = candidate;
      return;
    }
    if (current !== "") lines.push(current);
    // A single token wider than the line is hard-split rather than truncated.
    let rest = word;
    while (visibleWidth(rest) > max) {
      let cut = rest.length;
      while (cut > 1 && visibleWidth(rest.slice(0, cut)) > max) cut--;
      lines.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    current = rest;
  };
  for (const word of words) push(word);
  if (current !== "") lines.push(current);
  return lines;
}

function styleLine(
  line: QuestionLine,
  width: number,
  theme: QuestionTheme,
): string[] {
  if (line.kind === "spacer") return [""];
  const prefix =
    line.kind === "question"
      ? QUESTION_PREFIX
      : line.kind === "answer"
        ? ANSWER_PREFIX
        : "";
  const prefixToken = line.kind === "question" ? "borderAccent" : "muted";
  const textToken =
    line.kind === "question"
      ? "text"
      : line.kind === "answer"
        ? "userMessageText"
        : line.tone;
  const hang = " ".repeat(visibleWidth(prefix));
  const body = wrapPlain(line.text, Math.max(1, width - visibleWidth(prefix)));
  return body.map(
    (piece, index) =>
      fg(theme, prefixToken, index === 0 ? prefix : hang) +
      (line.kind === "question"
        ? italics(theme, fg(theme, textToken, piece))
        : fg(theme, textToken, piece)),
  );
}

/**
 * True when the row should read as an asked question rather than an execution
 * row. Shape first, so another author's question tool works unedited; the tool
 * name is the fallback for calls that failed before answering.
 */
export function isQuestionToolCall(row: QuestionRow): boolean {
  if (hasQuestionDetails(row.result?.details)) return true;
  return isQuestionToolName(row.toolName);
}

/**
 * Renders the question/answer block in the submitted-prompt shell, or
 * `undefined` when the row should keep the generic collapsed presentation.
 * A failed questionnaire is one such case: its details carry an error code
 * rather than a state worth a block, and the generic failure row already
 * reports it in the error tone.
 */
export function renderQuestionBlock(
  row: QuestionRow,
  width: number,
  theme: QuestionTheme,
): string[] | undefined {
  const details = row.result?.details;
  if (!isQuestionToolCall(row)) return undefined;
  if (isRecord(details) && typeof details.error === "string") return undefined;

  const lines = questionLines(row, details);
  if (!lines) return undefined;

  const inset = promptBlockInset(width);
  const padding = SUBMITTED_PROMPT_PADDING;
  const contentWidth = promptBlockContentWidth(width, inset, padding);
  const styled = lines.flatMap((line) => styleLine(line, contentWidth, theme));
  // The blank rows top and bottom are the shell's background padding, matching
  // a submitted user message; they become fully painted body rows.
  return renderRailedBlockLines(
    ["", ...styled, ""],
    width,
    theme,
    inset,
    "borderAccent",
    padding,
  );
}
