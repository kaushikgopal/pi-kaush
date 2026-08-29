import {
  createReadTool,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  type AgentToolUpdateCallback,
  type ExtensionAPI,
  type ExtensionContext,
  type ReadToolDetails,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  isSqlitePath,
  resolveLocalPath,
  tryReadProjection,
  untaggedRangeResult,
} from "./artifacts.ts";
import { tryHashlineRead } from "./local-text.ts";
import type { HashlineSnapshotStore } from "../hashline/snapshot-store.ts";
import { HASHLINE_SNAPSHOT_CAP_LINES } from "../hashline/contract.ts";
import { LOCAL_READ_CAP_BYTES, readBoundedText } from "./bounded.ts";
import { isLineSelector } from "./selectors.ts";

export const readSchema = Type.Object(
  {
    path: Type.String({
      description:
        "Path, URL, GitHub PR URL, archive member (archive.zip:path), SQLite selector (db.sqlite:table), or local file to read",
    }),
    offset: Type.Optional(
      Type.Integer({
        minimum: 1,
        description: "Line number to start reading from (1-indexed)",
      }),
    ),
    limit: Type.Optional(
      Type.Integer({
        minimum: 1,
        description: "Maximum number of lines to read",
      }),
    ),
    selector: Type.Optional(
      Type.String({
        description:
          "Selector without leading colon: ranges like 5-20,40-60; raw; a safe SQLite table selector or archive member range",
      }),
    ),
    ranges: Type.Optional(
      Type.String({
        description: "Comma-separated line ranges, for example 5-20,40-60",
      }),
    ),
  },
  { additionalProperties: false },
);

type ReadParams = {
  path: string;
  offset?: number;
  limit?: number;
  selector?: string;
  ranges?: string;
};

/**
 * Clean raw read arguments before schema validation. Optional fields that are
 * null or blank (empty or whitespace-only strings) are treated as absent, and
 * numeric-string offset/limit values are coerced to numbers. The framework
 * calls this via prepareArguments before schema validation; execute() also
 * applies it as defense in depth for direct callers.
 */
export function normalizeReadInput(input: unknown): ReadParams {
  if (!input || typeof input !== "object") {
    return input as unknown as ReadParams;
  }
  const args = input as Record<string, unknown>;
  const normalized: Record<string, unknown> = { ...args };
  for (const key of ["offset", "limit"] as const) {
    const value = args[key];
    if (value === null || value === undefined) {
      delete normalized[key];
    } else if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed === "") {
        delete normalized[key];
      } else if (/^\d+$/.test(trimmed)) {
        normalized[key] = Number(trimmed);
      }
    }
  }
  for (const key of ["selector", "ranges"] as const) {
    const value = args[key];
    if (value === null || value === undefined) {
      delete normalized[key];
    } else if (typeof value === "string" && value.trim() === "") {
      delete normalized[key];
    }
  }
  return normalized as ReadParams;
}

function validateReadSelection(params: ReadParams): void {
  const hasSelector = params.selector !== undefined;
  const hasRanges = params.ranges !== undefined;
  const hasOffsetLimit =
    params.offset !== undefined || params.limit !== undefined;
  if (hasRanges && hasSelector && !isSqlitePath(params.path)) {
    throw new Error("Provide either ranges or selector, not both.");
  }
  if ((hasSelector || hasRanges) && hasOffsetLimit) {
    throw new Error(
      "Provide either offset/limit or selector/ranges, not both.",
    );
  }
  if (
    params.offset !== undefined &&
    (!Number.isSafeInteger(params.offset) || params.offset < 1)
  ) {
    throw new Error("Read offset must be a positive integer (1-indexed).");
  }
  if (
    params.limit !== undefined &&
    (!Number.isSafeInteger(params.limit) || params.limit < 1)
  ) {
    throw new Error("Read limit must be a positive integer.");
  }
  if (params.ranges !== undefined && !isLineSelector(params.ranges)) {
    throw new Error(
      "ranges must use N, N-M, N+K, N-, or comma-separated ranges.",
    );
  }
}
function adjustContinuationMarker(
  marker: string | undefined,
  removedLines: number,
): string | undefined {
  if (!marker || removedLines <= 0) return marker;
  const offsetMatch = /Use offset=(\d+) to continue\./u.exec(marker);
  if (!offsetMatch) return marker;
  const oldOffset = Number(offsetMatch[1]);
  const nextOffset = Math.max(1, oldOffset - removedLines);
  return marker
    .replace(
      /(\[Showing lines \d+-)\d+( of \d+)/u,
      `$1${Math.max(1, nextOffset - 1)}$2`,
    )
    .replace(
      /\[(\d+) more lines/u,
      (_match, count: string) => `[${Number(count) + removedLines} more lines`,
    )
    .replace(
      /Use offset=\d+ to continue\./u,
      `Use offset=${nextOffset} to continue.`,
    );
}

function withUntaggedFallbackNotice<
  T extends { content: Array<{ type: string; text?: string }> },
>(result: T, reason: string): T {
  const block = result.content.find(
    (item): item is typeof item & { type: "text"; text: string } =>
      item.type === "text" && typeof item.text === "string",
  );
  if (!block) return result;
  const updateDisplayedMetrics = () => {
    const details = (result as { details?: Record<string, unknown> }).details;
    if (!details) return;
    if ("displayedLines" in details) {
      details.displayedLines =
        block.text === "" ? 0 : block.text.split("\n").length;
    }
    if ("displayedBytes" in details) {
      details.displayedBytes = Buffer.byteLength(block.text, "utf8");
    }
  };

  const explanation = reason.trim().replace(/[.\s]+$/, "");
  const notice = `[Untagged fallback: ${explanation}. A usable edit requires a [path#TAG] header.]`;
  const separator = block.text ? "\n\n" : "";
  const combined = `${block.text}${separator}${notice}`;
  if (
    Buffer.byteLength(combined, "utf8") <= DEFAULT_MAX_BYTES &&
    combined.split("\n").length <= DEFAULT_MAX_LINES
  ) {
    block.text = combined;
    updateDisplayedMetrics();
    return result;
  }

  const continuationMatch =
    /\n\n(\[[^\n]*Use offset=\d+ to continue\.\])$/u.exec(block.text);
  const originalContinuation = continuationMatch?.[1];
  const rawBody = continuationMatch
    ? block.text.slice(0, continuationMatch.index)
    : block.text;
  const body = rawBody.endsWith("\n") ? rawBody.slice(0, -1) : rawBody;
  const reservedLines = originalContinuation ? 4 : 2;
  const provisionalSuffix = `${originalContinuation ? `\n\n${originalContinuation}` : ""}\n\n${notice}`;
  const truncated = truncateHead(body, {
    // The margin covers offset/range digit growth when the marker is adjusted.
    maxBytes: Math.max(
      1,
      DEFAULT_MAX_BYTES - Buffer.byteLength(provisionalSuffix, "utf8") - 64,
    ),
    maxLines: Math.max(1, DEFAULT_MAX_LINES - reservedLines),
  });
  if (truncated.firstLineExceedsLimit) return result;
  const continuation = adjustContinuationMarker(
    originalContinuation,
    truncated.totalLines - truncated.outputLines,
  );
  const suffix = `${continuation ? `\n\n${continuation}` : ""}\n\n${notice}`;
  block.text = truncated.content
    ? `${truncated.content}${suffix}`
    : [continuation, notice].filter(Boolean).join("\n\n");
  updateDisplayedMetrics();
  return result;
}
export default function registerReadTool(
  pi: ExtensionAPI,
  snapshots: HashlineSnapshotStore,
): void {
  pi.registerTool({
    name: "read",
    label: "read",
    description: `Read files and bounded projections. Exact eligible local UTF-8 text returns a [path#TAG] header and numbered lines for safe hashline editing. Directories, safe public URLs, saved HTML, PDFs, SQLite, archives, notebooks, and GitHub PRs remain untagged projections. Output is capped at ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}.`,
    promptSnippet:
      "Read tagged local text plus bounded directories, URLs, HTML, PDFs, SQLite, archives, notebooks, and GitHub PRs",
    promptGuidelines: [
      "Use read for known local files and supported artifacts; use fffind for path discovery and ffgrep for broad text search.",
      "Keep the [path#TAG] header from local text output: edit requires that exact session tag and only authorizes displayed lines.",
      "Use selector/ranges such as 5-20,80-120 for precise disjoint ranges. Use selector=raw to bypass HTML extraction and tagging.",
      "For read, use only one local selection mode: offset/limit, selector, or ranges. SQLite alone may combine selector with ranges.",
      "Resource projections are deliberately untagged and cannot authorize file edits.",
    ],
    parameters: readSchema,
    prepareArguments: normalizeReadInput,
    async execute(
      toolCallId: string,
      params: ReadParams,
      signal: AbortSignal | undefined,
      onUpdate:
        | AgentToolUpdateCallback<ReadToolDetails | undefined>
        | undefined,
      ctx: ExtensionContext,
    ) {
      const input = normalizeReadInput(params);
      validateReadSelection(input);
      const routed = await tryReadProjection(pi, ctx.cwd, input, signal);
      if (routed?.result) {
        if (input.offset !== undefined || input.limit !== undefined) {
          throw new Error(
            "offset/limit apply to ordinary local text only; use selector/ranges for projections.",
          );
        }
        return routed.result;
      }

      const readPath = routed?.path ?? input.path;
      const selector = routed?.selector ?? input.ranges ?? input.selector;
      if (selector !== undefined && !isLineSelector(selector)) {
        throw new Error(
          `Unsupported selector '${selector}' for local text. Use raw or a line range.`,
        );
      }
      let unavailableReason =
        "the source is not eligible for a tagged exact-text snapshot";
      const tagged = await tryHashlineRead(
        ctx.cwd,
        readPath,
        {
          ...(input.offset !== undefined ? { offset: input.offset } : {}),
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
          ...(selector && isLineSelector(selector) ? { selector } : {}),
        },
        snapshots,
        signal,
        (reason) => {
          unavailableReason = reason;
        },
      );
      if (tagged) return tagged;

      if (selector && isLineSelector(selector)) {
        const absolutePath = resolveLocalPath(ctx.cwd, readPath);
        const bounded = await readBoundedText(
          absolutePath,
          LOCAL_READ_CAP_BYTES,
          signal,
        );
        if (bounded.truncated) {
          throw new Error(
            `Local range source exceeds the ${LOCAL_READ_CAP_BYTES}-byte safety cap.`,
          );
        }
        return withUntaggedFallbackNotice(
          untaggedRangeResult(absolutePath, bounded.text, selector),
          unavailableReason,
        );
      }
      const fallbackPath = resolveLocalPath(ctx.cwd, readPath);
      const boundedFallback = await readBoundedText(
        fallbackPath,
        LOCAL_READ_CAP_BYTES,
        signal,
      );
      if (boundedFallback.truncated) {
        throw new Error(
          `Local file exceeds the ${LOCAL_READ_CAP_BYTES}-byte safety cap.`,
        );
      }
      let fallbackLines =
        boundedFallback.bytes.length === 0
          ? 0
          : boundedFallback.bytes.at(-1) === 10
            ? 0
            : 1;
      for (const byte of boundedFallback.bytes) {
        if (byte === 10) fallbackLines++;
      }
      if (fallbackLines > HASHLINE_SNAPSHOT_CAP_LINES) {
        throw new Error(
          `Local file exceeds the ${HASHLINE_SNAPSHOT_CAP_LINES}-line processing cap.`,
        );
      }

      const builtin = createReadTool(ctx.cwd);
      const fallback = await builtin.execute(
        toolCallId,
        {
          path: readPath,
          ...(input.offset !== undefined ? { offset: input.offset } : {}),
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
        },
        signal,
        onUpdate,
      );
      return withUntaggedFallbackNotice(fallback, unavailableReason);
    },
  });
}
