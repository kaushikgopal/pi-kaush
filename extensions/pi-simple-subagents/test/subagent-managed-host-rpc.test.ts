import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  createRpcHost,
  createRpcRecordReader,
  handleRpcRecord,
} from "../src/_managed-host-rpc.ts";
import { managedPaths } from "../src/_managed-store.ts";
import { SubagentProcessRegistry } from "../src/_process-tree.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

const tick = (ms = 1) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await tick(5);
  }
}

describe("rpc host", () => {
  test("parses LF-delimited records across chunk boundaries and skips transcript lines", () => {
    const records: Record<string, unknown>[] = [];
    const reader = createRpcRecordReader((record) => records.push(record));
    const dialog = JSON.stringify({
      type: "extension_ui_request",
      id: "d1",
      method: "confirm",
      title: "Proceed\u2028now? é",
    });
    const bytes = Buffer.from(
      `${JSON.stringify({ type: "message_update", text: "x".repeat(5_000) })}\n${dialog}\r\n{"type":"extension_error","error":"boom"}`,
    );
    const split = bytes.indexOf(Buffer.from("é")) + 1; // inside the two-byte é
    reader.push(bytes.subarray(0, split));
    reader.push(bytes.subarray(split));
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      id: "d1",
      title: "Proceed\u2028now? é",
    });
    reader.end();
    expect(records[1]).toMatchObject({
      type: "extension_error",
      error: "boom",
    });

    const oversized: unknown[] = [];
    const strict = createRpcRecordReader((record) => oversized.push(record));
    strict.push(
      `{"type":"extension_ui_request","id":"big","method":"editor","prefill":"${"y".repeat(1_100_000)}"}\n`,
    );
    expect(oversized).toEqual([]);
  });

  test("cancels dialogs by id, logs extension errors, and never copies notification text", () => {
    const responses: unknown[] = [];
    const log: string[] = [];
    const respond = (response: Record<string, unknown>) =>
      responses.push(response);
    handleRpcRecord(
      { type: "extension_ui_request", id: "q", method: "select" },
      respond,
      (entry) => log.push(entry),
    );
    handleRpcRecord(
      {
        type: "extension_ui_request",
        id: "n",
        method: "notify",
        notifyType: "error",
        message: "secret-ish text",
      },
      respond,
      (entry) => log.push(entry),
    );
    handleRpcRecord(
      {
        type: "extension_error",
        extensionPath: "/x/ext.ts",
        event: "input",
        error: "bad",
      },
      respond,
      (entry) => log.push(entry),
    );
    expect(responses).toEqual([
      { type: "extension_ui_response", id: "q", cancelled: true },
    ]);
    expect(log.join("\n")).not.toContain("secret-ish");
    expect(log.at(-1)).toBe("extension error in input (ext.ts): bad");
  });

  test("answers a real child's dialog with a cancel and stops it by closing stdin", async () => {
    const dir = fs.mkdtempSync(path.join(tmpdir(), "managed-rpc-"));
    roots.push(dir);
    const paths = managedPaths(dir);
    fs.mkdirSync(dir, { recursive: true });
    const script = path.join(dir, "child.mjs");
    const reply = path.join(dir, "reply.json");
    fs.writeFileSync(
      script,
      `
import * as fs from "node:fs";
process.stdout.write(JSON.stringify({ type: "extension_ui_request", id: "d1", method: "confirm", title: "ok?" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "extension_error", extensionPath: "/e/x.ts", event: "input", error: "kaboom" }) + "\\n");
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  if (buffer.includes("\\n")) fs.writeFileSync(${JSON.stringify(reply)}, buffer.split("\\n")[0]);
});
process.stdin.on("end", () => process.exit(0));
`,
    );
    const host = createRpcHost(new SubagentProcessRegistry());
    const proc = await host.launch({
      handle: "mw-rpc",
      bootId: "b",
      label: "x",
      cwd: dir,
      command: process.execPath,
      args: [script],
      piArgs: [],
      env: {},
      paths,
    });
    await waitFor(() => fs.existsSync(reply), 5_000);
    expect(JSON.parse(fs.readFileSync(reply, "utf8"))).toEqual({
      type: "extension_ui_response",
      id: "d1",
      cancelled: true,
    });
    proc.requestStop?.();
    await proc.exited;
    const stderr = fs.readFileSync(paths.stderr, "utf8");
    expect(stderr).toContain("cancelled a confirm dialog");
    expect(stderr).toContain("extension error in input (x.ts): kaboom");
  });
});
