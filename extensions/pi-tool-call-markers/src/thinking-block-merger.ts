import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AssistantMessageComponent } from "@earendil-works/pi-coding-agent";

const THINKING_GROUPING_PATCHED = Symbol.for("kg.pi.thinkingGrouping.v1");

type AssistantMessageLike = {
  content?: unknown[];
};

type AssistantMessageRow = {
  updateContent(message: AssistantMessageLike): void;
};

type ThinkingGroupingPatchState = {
  originalUpdateContent: (message: AssistantMessageLike) => void;
  patchedUpdateContent?: (message: AssistantMessageLike) => void;
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

// TODO: Replace prototype patching with a public assistant-message rendering API.
function installThinkingGroupingPatch():
  | ThinkingGroupingPatchState
  | undefined {
  try {
    const proto =
      AssistantMessageComponent?.prototype as unknown as AssistantMessageRow & {
        [THINKING_GROUPING_PATCHED]?: ThinkingGroupingPatchState;
        updateContent?: (message: AssistantMessageLike) => void;
      };
    if (!proto || typeof proto.updateContent !== "function") return undefined;

    const existing = proto[THINKING_GROUPING_PATCHED];
    if (existing) return existing;

    const state: ThinkingGroupingPatchState = {
      originalUpdateContent: proto.updateContent,
    };
    const patchedUpdateContent = function updateContentWithCombinedThinking(
      this: AssistantMessageRow,
      message: AssistantMessageLike,
    ): void {
      // Thinking grouping is cosmetic. If it fails, render the original once.
      let combined = message;
      try {
        combined = combineAdjacentThinking(message);
      } catch {
        // Preserve the original message intact.
      }
      state.originalUpdateContent.call(this, combined);
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
      updateContent?: (message: AssistantMessageLike) => void;
    };
  if (
    proto[THINKING_GROUPING_PATCHED] !== state ||
    proto.updateContent !== state.patchedUpdateContent
  )
    return;
  proto.updateContent = state.originalUpdateContent;
  delete proto[THINKING_GROUPING_PATCHED];
}

export default function (pi: ExtensionAPI) {
  const patch = installThinkingGroupingPatch();
  pi.on("session_shutdown", () => uninstallThinkingGroupingPatch(patch));
}
