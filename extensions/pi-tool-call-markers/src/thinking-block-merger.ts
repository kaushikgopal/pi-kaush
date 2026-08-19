import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AssistantMessageComponent } from "@earendil-works/pi-coding-agent";

const THINKING_GROUPING_PATCHED = Symbol.for("kg.pi.thinkingGrouping.v1");
const PI_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;

type AssistantMessageLike = {
  content?: unknown[];
};

type AssistantMessageRow = {
  hiddenThinkingLabel?: unknown;
  hideThinkingBlock?: unknown;
  updateContent(message: AssistantMessageLike, ...args: unknown[]): void;
};

type ThinkingTiming = {
  finishedAt?: number;
  startedAt: number;
};

type ThinkingGroupingPatchState = {
  originalUpdateContent: (
    message: AssistantMessageLike,
    ...args: unknown[]
  ) => void;
  patchedUpdateContent?: (
    message: AssistantMessageLike,
    ...args: unknown[]
  ) => void;
  timings: WeakMap<AssistantMessageRow, ThinkingTiming>;
};

type ThinkingContentLike = {
  type: "thinking";
  thinking: string;
  [key: string]: unknown;
};

function isThinkingContent(content: unknown): content is ThinkingContentLike {
  return (
    !!content &&
    typeof content === "object" &&
    (content as { type?: unknown }).type === "thinking" &&
    typeof (content as { thinking?: unknown }).thinking === "string"
  );
}

function hasThinkingContent(message: AssistantMessageLike): boolean {
  return (
    Array.isArray(message.content) &&
    message.content.some(
      (content) =>
        isThinkingContent(content) && content.thinking.trim().length > 0,
    )
  );
}

function combineAdjacentThinking(
  message: AssistantMessageLike,
): AssistantMessageLike {
  if (!Array.isArray(message.content)) return message;

  // Merge a display-only copy; provider blocks and signatures stay untouched.
  let changed = false;
  const content: unknown[] = [];
  for (const block of message.content) {
    const previous = content.at(-1);
    if (isThinkingContent(previous) && isThinkingContent(block)) {
      content[content.length - 1] = {
        ...previous,
        thinking: `${previous.thinking.trim()}\n\n${block.thinking.trim()}`,
      };
      changed = true;
      continue;
    }
    content.push(block);
  }

  return changed ? { ...message, content } : message;
}

function formatThoughtDuration(startedAt: number, finishedAt: number): string {
  return `${(Math.max(0, finishedAt - startedAt) / 1000).toFixed(1)}s`;
}

function thinkingSpinner(startedAt: number, now: number): string {
  const frame = Math.floor(Math.max(0, now - startedAt) / SPINNER_INTERVAL_MS);
  return PI_SPINNER_FRAMES[frame % PI_SPINNER_FRAMES.length]!;
}

function lifecycleLabel(
  row: AssistantMessageRow,
  streaming: boolean | undefined,
  timings: WeakMap<AssistantMessageRow, ThinkingTiming>,
): string {
  const now = Date.now();
  let current = timings.get(row);
  if (streaming === true) {
    if (!current || current.finishedAt !== undefined) {
      current = { startedAt: now };
      timings.set(row, current);
    }
    return `${thinkingSpinner(current.startedAt, now)} Thinking…`;
  }

  if (streaming === undefined && current?.finishedAt === undefined && current) {
    // Pi can rebuild a live row on resize/theme changes without forwarding
    // the optional streaming flag. Keep its active label until an explicit
    // final update arrives.
    return `${thinkingSpinner(current.startedAt, now)} Thinking…`;
  }

  if (streaming === false && current?.finishedAt === undefined) {
    if (current) current.finishedAt = now;
  }

  const settled = timings.get(row);
  if (settled?.finishedAt !== undefined) {
    return `+ Thought · ${formatThoughtDuration(settled.startedAt, settled.finishedAt)}`;
  }
  return "+ Thought";
}

function applyHiddenThinkingLabel(
  row: AssistantMessageRow,
  message: AssistantMessageLike,
  streaming: boolean | undefined,
  timings: WeakMap<AssistantMessageRow, ThinkingTiming>,
): void {
  // Record the component's first streaming update even when the provider has
  // not emitted a non-empty thinking block yet.
  const label = lifecycleLabel(row, streaming, timings);
  if (!hasThinkingContent(message)) return;
  if (
    row.hideThinkingBlock !== true ||
    typeof row.hiddenThinkingLabel !== "string"
  ) {
    return;
  }
  // Assign the row-local field directly. The public UI setter relabels every
  // historical assistant row and would make earlier durations change.
  row.hiddenThinkingLabel = label;
}

// TODO: Replace prototype patching with a public assistant-message rendering API.
function installThinkingGroupingPatch():
  | ThinkingGroupingPatchState
  | undefined {
  try {
    const proto =
      AssistantMessageComponent?.prototype as unknown as AssistantMessageRow & {
        [THINKING_GROUPING_PATCHED]?: ThinkingGroupingPatchState;
        updateContent?: (
          message: AssistantMessageLike,
          ...args: unknown[]
        ) => void;
      };
    if (!proto || typeof proto.updateContent !== "function") return undefined;

    const existing = proto[THINKING_GROUPING_PATCHED];
    if (existing) return existing;

    const state: ThinkingGroupingPatchState = {
      originalUpdateContent: proto.updateContent,
      timings: new WeakMap(),
    };
    const patchedUpdateContent = function updateContentWithCombinedThinking(
      this: AssistantMessageRow,
      message: AssistantMessageLike,
      ...args: unknown[]
    ): void {
      // Grouping and labels are cosmetic. Each fails open independently, and
      // the original renderer is still called exactly once with every arg.
      let combined = message;
      try {
        combined = combineAdjacentThinking(message);
      } catch {
        // Preserve the original message intact.
      }
      try {
        const streaming = typeof args[0] === "boolean" ? args[0] : undefined;
        applyHiddenThinkingLabel(this, combined, streaming, state.timings);
      } catch {
        // Preserve Pi's native label if its private row shape changes.
      }
      Reflect.apply(state.originalUpdateContent, this, [combined, ...args]);
    };

    state.patchedUpdateContent = patchedUpdateContent;
    proto.updateContent = patchedUpdateContent;
    Object.defineProperty(proto, THINKING_GROUPING_PATCHED, {
      configurable: true,
      value: state,
    });
    return state;
  } catch {
    return undefined;
  }
}

function uninstallThinkingGroupingPatch(
  state: ThinkingGroupingPatchState | undefined,
): void {
  if (!state) return;
  const proto =
    AssistantMessageComponent?.prototype as unknown as AssistantMessageRow & {
      [THINKING_GROUPING_PATCHED]?: ThinkingGroupingPatchState;
      updateContent?: (
        message: AssistantMessageLike,
        ...args: unknown[]
      ) => void;
    };
  if (
    proto[THINKING_GROUPING_PATCHED] !== state ||
    proto.updateContent !== state.patchedUpdateContent
  ) {
    return;
  }
  proto.updateContent = state.originalUpdateContent;
  delete proto[THINKING_GROUPING_PATCHED];
}

export default function (pi: ExtensionAPI) {
  const patch = installThinkingGroupingPatch();
  pi.on("session_shutdown", () => uninstallThinkingGroupingPatch(patch));
}
