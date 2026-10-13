import { describe, expect, test } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { linkSessionParent } from "../src/_session-link.ts";

function sessionDir(): string {
  return mkdtempSync(path.join(tmpdir(), "pi-session-link-"));
}

function writeSession(header: Record<string, unknown>, body: string[] = []) {
  const file = path.join(sessionDir(), "child.jsonl");
  const lines = [
    JSON.stringify(header),
    ...body.map((line) => JSON.stringify(line)),
  ];
  writeFileSync(file, lines.join("\n") + "\n");
  return file;
}

function firstHeader(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, "utf-8").split("\n")[0]!) as Record<
    string,
    unknown
  >;
}

describe("linkSessionParent", () => {
  test("writes the resolved parent path into the session header", () => {
    const file = writeSession({
      type: "session",
      version: 3,
      id: "s-child",
      cwd: "/tmp",
    });
    expect(linkSessionParent(file, "/tmp/parent.jsonl")).toBeUndefined();
    expect(firstHeader(file).parentSession).toBe(
      path.resolve("/tmp/parent.jsonl"),
    );
  });

  test("keeps entries intact and is idempotent for the same parent", () => {
    const file = writeSession({ type: "session", id: "s-child", cwd: "/tmp" }, [
      "first",
      "second",
    ]);
    expect(linkSessionParent(file, "/tmp/parent.jsonl")).toBeUndefined();
    expect(linkSessionParent(file, "/tmp/parent.jsonl")).toBeUndefined();
    const lines = readFileSync(file, "utf-8").trimEnd().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toBe(JSON.stringify("first"));
    expect(lines[2]).toBe(JSON.stringify("second"));
  });

  test("overwrites a different existing parent link", () => {
    const file = writeSession({
      type: "session",
      id: "s-child",
      parentSession: "/tmp/old.jsonl",
    });
    expect(linkSessionParent(file, "/tmp/new.jsonl")).toBeUndefined();
    expect(firstHeader(file).parentSession).toBe(
      path.resolve("/tmp/new.jsonl"),
    );
  });

  test("reports missing files, foreign headers, and broken JSON", () => {
    expect(linkSessionParent("/nonexistent/session.jsonl", "/p.jsonl")).toMatch(
      /missing/,
    );
    const foreign = path.join(sessionDir(), "foreign.jsonl");
    writeFileSync(foreign, "{not json}\n");
    expect(linkSessionParent(foreign, "/p.jsonl")).toMatch(/JSON header/);
    const other = path.join(sessionDir(), "other.jsonl");
    writeFileSync(other, JSON.stringify({ type: "message" }) + "\n");
    expect(linkSessionParent(other, "/p.jsonl")).toMatch(/Not a pi session/);
  });

  test("does nothing without both paths", () => {
    expect(linkSessionParent(undefined, "/p.jsonl")).toBeUndefined();
    expect(linkSessionParent("/child.jsonl", undefined)).toBeUndefined();
  });
});
