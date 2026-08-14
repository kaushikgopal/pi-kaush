/**
 * Response-style discovery and parsing.
 *
 * A style is a markdown file with YAML frontmatter (`title`, `description`)
 * and a body used as the system-prompt injection. Bundled styles ship in the
 * package; user styles layer on top by filename.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

export type StyleOrigin = "bundled" | "user" | "project";

export interface Style {
  /** Filename without .md; the stable identifier for args, state, and config. */
  name: string;
  title: string;
  description: string;
  body: string;
  origin: StyleOrigin;
}

export interface LoadResult {
  styles: Style[];
  warnings: string[];
}

export const GUARDRAIL =
  "Apply this style only when responding to the user in chat. Never apply it to internal reasoning, thinking traces, tool calls, or code.";

export function buildInjection(style: Style): string {
  return `\n\n# Communication\n\n${GUARDRAIL}\n\n${style.body}\n`;
}

/** Collapse newlines so frontmatter values can never mangle picker rows or the injection header. */
function oneLine(value: unknown): string {
  return typeof value === "string"
    ? value.replace(/\s*\n\s*/g, " ").trim()
    : "";
}

export function parseStyleFile(
  name: string,
  content: string,
  origin: StyleOrigin = "bundled",
): { style?: Style; warning?: string } {
  let frontmatter: Record<string, unknown>;
  let body: string;
  try {
    const parsed = parseFrontmatter(content.replace(/^\uFEFF/, ""));
    frontmatter = parsed.frontmatter;
    body = parsed.body;
  } catch {
    return {
      warning: `response style "${name}": unparseable frontmatter, skipped`,
    };
  }
  const trimmedBody = body.trim();
  if (!trimmedBody) {
    return { warning: `response style "${name}": no prompt body, skipped` };
  }
  return {
    style: {
      name,
      title: oneLine(frontmatter.title) || name,
      description: oneLine(frontmatter.description),
      body: trimmedBody,
      origin,
    },
  };
}

function readDirStyles(
  dir: string,
  origin: StyleOrigin,
  into: Map<string, Style>,
  warnings: string[],
): void {
  let files: string[];
  try {
    files = readdirSync(dir).filter((file) => file.endsWith(".md"));
  } catch {
    return; // missing dir is fine (user layer is optional)
  }
  for (const file of files) {
    const name = file.replace(/\.md$/, "");
    let content: string;
    try {
      content = readFileSync(join(dir, file), "utf8");
    } catch {
      warnings.push(`response style "${name}": unreadable, skipped`);
      continue;
    }
    const { style, warning } = parseStyleFile(name, content, origin);
    if (warning) warnings.push(warning);
    if (style) into.set(name, style);
  }
}

/**
 * Later layers override earlier ones by filename: bundled < user < project.
 * projectDir is only passed when the project is trusted (an untrusted repo
 * must not be able to shadow a named style via lastUsed/default).
 */
export function loadStyles(
  bundledDir: string,
  userDir: string,
  projectDir?: string,
): LoadResult {
  const warnings: string[] = [];
  const byName = new Map<string, Style>();
  readDirStyles(bundledDir, "bundled", byName, warnings);
  readDirStyles(userDir, "user", byName, warnings);
  if (projectDir) readDirStyles(projectDir, "project", byName, warnings);
  return { styles: [...byName.values()], warnings };
}
