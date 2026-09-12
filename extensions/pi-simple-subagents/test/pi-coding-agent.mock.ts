import { tmpdir } from "node:os";
import { join } from "node:path";

export const MAX_BYTES = 120;
export const MAX_LINES = 5;

// Process-wide built-in read call log; every factory invocation shares it
// because bun runs all test files in one process and mocks are global.
const builtInCalls: Array<{ path: string }> = [];

export function installedBuiltInCalls(): Array<{ path: string }> {
  return builtInCalls;
}

export function clearBuiltInCalls(): void {
  builtInCalls.length = 0;
}

export function createPiCodingAgentMock() {
  return {
    VERSION: "0.80.6",
    CONFIG_DIR_NAME: ".pi",
    DEFAULT_MAX_BYTES: MAX_BYTES,
    DEFAULT_MAX_LINES: MAX_LINES,
    formatSize: (bytes: number) => `${bytes}B`,
    truncateHead(
      text: string,
      options: { maxBytes: number; maxLines: number },
    ) {
      const allLines = text.split("\n");
      let content = allLines.slice(0, options.maxLines).join("\n");
      if (Buffer.byteLength(content) > options.maxBytes) {
        content = Buffer.from(content).subarray(0, options.maxBytes).toString();
      }
      return {
        content,
        truncated: content !== text,
        outputLines: content.split("\n").length,
        totalLines: allLines.length,
        outputBytes: Buffer.byteLength(content),
        totalBytes: Buffer.byteLength(text),
      };
    },
    createReadTool() {
      return {
        async execute(_id: string, params: { path: string }) {
          builtInCalls.push({ path: params.path });
          return {
            content: [{ type: "text", text: `built-in:${params.path}` }],
            details: {},
          };
        },
      };
    },
    getAgentDir: () => join(tmpdir(), "pi-agent"),
    getMarkdownTheme: () => ({}),
    generateDiffString: (oldText: string, newText: string) => {
      const oldLines = oldText.split("\n");
      const newLines = newText.split("\n");
      let firstChangedLine: number | undefined;
      const max = Math.max(oldLines.length, newLines.length);
      for (let i = 0; i < max; i++) {
        if (oldLines[i] !== newLines[i]) {
          firstChangedLine = i + 1;
          break;
        }
      }
      return { diff: `@@ line ${firstChangedLine ?? 1} @@`, firstChangedLine };
    },
    generateUnifiedPatch: (path: string) => `--- ${path}\n+++ ${path}\n`,
    renderDiff: (text: string) => text,
    withFileMutationQueue: async <T>(
      _path: string,
      operation: () => Promise<T>,
    ) => operation(),
    parseFrontmatter<T extends Record<string, unknown>>(content: string) {
      const normalized = content.replace(/\r\n/g, "\n");
      const match = normalized.match(/^---\n([\s\S]*?)\n---\s*\n?/);
      if (!match) return { frontmatter: {} as T, body: normalized };

      const frontmatter: Record<string, unknown> = {};
      for (const line of match[1]!.split("\n")) {
        const separator = line.indexOf(":");
        if (separator === -1) continue;
        const key = line.slice(0, separator).trim();
        const raw = line.slice(separator + 1).trim();
        frontmatter[key] =
          raw === "true"
            ? true
            : raw === "false"
              ? false
              : raw.replace(/^["']|["']$/g, "");
      }
      return {
        frontmatter: frontmatter as T,
        body: normalized.slice(match[0].length),
      };
    },
  };
}
