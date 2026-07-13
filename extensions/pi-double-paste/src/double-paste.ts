import {
  extractBracketedPaste,
  fingerprint,
  isLongPaste,
  normalizePaste,
} from "./paste.ts";

export const DEFAULT_DOUBLE_PASTE_WINDOW_MS = 3_000;

type TerminalInputResult = { consume?: boolean; data?: string } | undefined;

type Candidate = {
  pasteFingerprint: string;
  editorFingerprint: string;
  armedAt: number;
};

export interface EditorTextApi {
  getEditorText(): string;
  setEditorText(text: string): void;
}

export interface DoublePasteOptions {
  now?: () => number;
  scheduleAfterInput?: (callback: () => void) => void;
  windowMs?: number;
  warn?: (message: string) => void;
}

export function createDoublePasteHandler(
  editor: EditorTextApi,
  options: DoublePasteOptions = {},
): (data: string) => TerminalInputResult {
  const now = options.now ?? Date.now;
  const scheduleAfterInput = options.scheduleAfterInput ?? queueMicrotask;
  const windowMs = options.windowMs ?? DEFAULT_DOUBLE_PASTE_WINDOW_MS;

  let candidate: Candidate | undefined;
  let armGeneration = 0;
  let warned = false;

  const warnOnce = () => {
    if (warned) return;
    warned = true;
    try {
      options.warn?.(
        "Could not expand pasted text; Pi's normal paste behavior was preserved.",
      );
    } catch {
      // Warning delivery must never interfere with input.
    }
  };

  return (data: string): TerminalInputResult => {
    const rawPaste = extractBracketedPaste(data);
    if (rawPaste === undefined) return undefined;

    const normalizedPaste = normalizePaste(rawPaste);
    if (!isLongPaste(normalizedPaste)) return undefined;

    const pasteFingerprint = fingerprint(normalizedPaste);
    const observedAt = now();

    if (candidate && observedAt - candidate.armedAt > windowMs) {
      candidate = undefined;
    }

    if (candidate?.pasteFingerprint === pasteFingerprint) {
      let expandedEditorText: string;
      try {
        expandedEditorText = editor.getEditorText();
      } catch {
        candidate = undefined;
        warnOnce();
        return undefined;
      }

      if (fingerprint(expandedEditorText) === candidate.editorFingerprint) {
        try {
          editor.setEditorText(expandedEditorText);
          candidate = undefined;
          armGeneration += 1;
          return { consume: true };
        } catch {
          candidate = undefined;
          warnOnce();
          return undefined;
        }
      }
    }

    let editorTextBeforePaste: string;
    try {
      editorTextBeforePaste = editor.getEditorText();
    } catch {
      candidate = undefined;
      warnOnce();
      return undefined;
    }

    const generation = ++armGeneration;
    scheduleAfterInput(() => {
      if (generation !== armGeneration) return;

      try {
        const editorTextAfterPaste = editor.getEditorText();
        if (editorTextAfterPaste === editorTextBeforePaste) return;

        candidate = {
          pasteFingerprint,
          editorFingerprint: fingerprint(editorTextAfterPaste),
          armedAt: now(),
        };
      } catch {
        candidate = undefined;
      }
    });

    return undefined;
  };
}
