import {
  createReadTool,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  type AgentToolUpdateCallback,
  type ExtensionAPI,
  type ExtensionContext,
  type ReadToolDetails,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  resolveLocalPath,
  tryReadProjection,
  untaggedRangeResult,
} from "./artifacts.ts";
import { tryHashlineRead } from "./local-text.ts";
import type { HashlineSnapshotStore } from "../hashline/snapshot-store.ts";
import { HASHLINE_SNAPSHOT_CAP_LINES } from "../hashline/contract.ts";
import { LOCAL_READ_CAP_BYTES, readBoundedText } from "./bounded.ts";
import { isLineSelector } from "./selectors.ts";

const readSchema = Type.Object(
  {
    path: Type.String({
      description:
        "Path, URL, GitHub PR URL, archive member (archive.zip:path), SQLite selector (db.sqlite:table), or local file to read",
    }),
    offset: Type.Optional(
      Type.Number({
        description: "Line number to start reading from (1-indexed)",
      }),
    ),
    limit: Type.Optional(
      Type.Number({ description: "Maximum number of lines to read" }),
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
      "Resource projections are deliberately untagged and cannot authorize file edits.",
    ],
    parameters: readSchema,
    async execute(
      toolCallId: string,
      params: ReadParams,
      signal: AbortSignal | undefined,
      onUpdate:
        | AgentToolUpdateCallback<ReadToolDetails | undefined>
        | undefined,
      ctx: ExtensionContext,
    ) {
      if (params.ranges !== undefined && !isLineSelector(params.ranges)) {
        throw new Error(
          "ranges must use N, N-M, N+K, N-, or comma-separated ranges.",
        );
      }
      const routed = await tryReadProjection(pi, ctx.cwd, params, signal);
      if (routed?.result) {
        if (params.offset !== undefined || params.limit !== undefined) {
          throw new Error(
            "offset/limit apply to ordinary local text only; use selector/ranges for projections.",
          );
        }
        return routed.result;
      }

      const readPath = routed?.path ?? params.path;
      const selector = routed?.selector ?? params.ranges ?? params.selector;
      if (selector !== undefined && !isLineSelector(selector)) {
        throw new Error(
          `Unsupported selector '${selector}' for local text. Use raw or a line range.`,
        );
      }
      const tagged = await tryHashlineRead(
        ctx.cwd,
        readPath,
        {
          ...(params.offset !== undefined ? { offset: params.offset } : {}),
          ...(params.limit !== undefined ? { limit: params.limit } : {}),
          ...(selector && isLineSelector(selector) ? { selector } : {}),
        },
        snapshots,
        signal,
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
        return untaggedRangeResult(absolutePath, bounded.text, selector);
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
      return builtin.execute(
        toolCallId,
        {
          path: readPath,
          ...(params.offset !== undefined ? { offset: params.offset } : {}),
          ...(params.limit !== undefined ? { limit: params.limit } : {}),
        },
        signal,
        onUpdate,
      );
    },
  });
}
