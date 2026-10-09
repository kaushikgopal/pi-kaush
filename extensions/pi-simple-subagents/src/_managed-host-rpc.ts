/**
 * Portable RPC host: each worker is a `pi --mode rpc` subprocess whose open
 * stdin keeps it alive. The host cancels dialogs a headless worker cannot
 * answer and logs bounded diagnostics next to the worker's stderr.
 */
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { stripParentControlEnvironment } from "./_delegation.ts";
import { ManagedError, type ManagedHostPort } from "./_managed-host.ts";
import { isPlainRecord } from "./_parse.ts";
import type { SubagentProcessRegistry } from "./_process-tree.ts";
import { truncateUtf8Head } from "./_text.ts";

const RPC_DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);
const RPC_RECORD_PREFIXES = [
  '{"type":"extension_ui_request"',
  '{"type":"extension_error"',
];
const RPC_PREFIX_PROBE = Math.max(
  ...RPC_RECORD_PREFIXES.map((prefix) => prefix.length),
);
// Dialog requests can carry an editor prefill; anything larger is not a record we act on.
const RPC_MAX_RECORD_CHARS = 1024 * 1024;
const RPC_DIAGNOSTIC_ENTRY_BYTES = 512;
const RPC_DIAGNOSTIC_TOTAL_BYTES = 64 * 1024;

/**
 * Strict LF-delimited JSONL reader for Pi RPC stdout. Readline is unsuitable
 * because JSON strings may contain U+2028/U+2029. Only records the host acts
 * on are buffered and parsed; transcript events stream past unkept.
 */
export function createRpcRecordReader(
  onRecord: (record: Record<string, unknown>) => void,
): { push(chunk: Buffer | string): void; end(): void } {
  const decoder = new StringDecoder("utf8");
  let line = "";
  let skipping = false;
  const wanted = (text: string) =>
    RPC_RECORD_PREFIXES.some((prefix) => text.startsWith(prefix));
  const finish = () => {
    const text = line.endsWith("\r") ? line.slice(0, -1) : line;
    const keep = !skipping && wanted(text);
    line = "";
    skipping = false;
    if (!keep) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    if (isPlainRecord(parsed)) onRecord(parsed);
  };
  const consume = (text: string) => {
    let start = 0;
    for (;;) {
      const newline = text.indexOf("\n", start);
      if (!skipping) {
        line += newline === -1 ? text.slice(start) : text.slice(start, newline);
        if (
          line.length > RPC_MAX_RECORD_CHARS ||
          (line.length >= RPC_PREFIX_PROBE && !wanted(line))
        ) {
          line = "";
          skipping = true;
        }
      }
      if (newline === -1) return;
      finish();
      start = newline + 1;
    }
  };
  return {
    push: (chunk) =>
      consume(typeof chunk === "string" ? chunk : decoder.write(chunk)),
    end: () => {
      consume(decoder.end());
      if (line) finish();
      line = "";
      skipping = false;
    },
  };
}

/** Bounded diagnostics appended to the worker's stderr log, which startup and exit errors quote. */
function createDiagnosticLog(file: string): (entry: string) => void {
  let written = 0;
  return (entry) => {
    if (written >= RPC_DIAGNOSTIC_TOTAL_BYTES) return;
    const text = truncateUtf8Head(
      entry.replace(/\s+/g, " "),
      RPC_DIAGNOSTIC_ENTRY_BYTES,
    ).value;
    const line = `[managed rpc] ${text}\n`;
    written += Buffer.byteLength(line);
    try {
      fs.appendFileSync(file, line, { mode: 0o600 });
    } catch {
      // Diagnostics are best effort.
    }
  };
}

/**
 * Acts on RPC records a headless worker would otherwise hang on or hide:
 * dialogs are cancelled (never approved) and extension errors are logged.
 * Notification and dialog contents are not copied anywhere.
 */
export function handleRpcRecord(
  record: Record<string, unknown>,
  respond: (response: Record<string, unknown>) => void,
  log: (entry: string) => void,
): void {
  if (record.type === "extension_error") {
    const where = [
      typeof record.event === "string" ? `in ${record.event}` : "",
      typeof record.extensionPath === "string"
        ? `(${path.basename(record.extensionPath)})`
        : "",
    ]
      .filter(Boolean)
      .join(" ");
    const error =
      typeof record.error === "string" ? record.error : "unknown error";
    log(`extension error${where ? ` ${where}` : ""}: ${error}`);
    return;
  }
  if (record.type !== "extension_ui_request" || typeof record.id !== "string")
    return;
  const method = typeof record.method === "string" ? record.method : "";
  if (RPC_DIALOG_METHODS.has(method)) {
    respond({ type: "extension_ui_response", id: record.id, cancelled: true });
    log(`cancelled a ${method} dialog; managed workers cannot answer prompts`);
    return;
  }
  if (method === "notify" && record.notifyType === "error")
    log("an extension reported an error notification");
}

/** JSONL writer that honors stdin backpressure and drops output once the pipe fails. */
function createStdinWriter(stdin: NodeJS.WritableStream | null | undefined): {
  send(value: unknown): void;
  end(): void;
} {
  const queue: string[] = [];
  let waiting = false;
  let ending = false;
  let closed = !stdin;
  const pump = () => {
    if (!stdin || closed) {
      queue.length = 0;
      return;
    }
    while (!waiting && queue.length > 0) {
      if (!stdin.write(queue.shift()!)) {
        waiting = true;
        stdin.once("drain", () => {
          waiting = false;
          pump();
        });
      }
    }
    if (!waiting && ending) {
      closed = true;
      stdin.end();
    }
  };
  stdin?.on("error", () => {
    closed = true;
    queue.length = 0;
  });
  stdin?.on("close", () => {
    closed = true;
  });
  return {
    send(value) {
      if (closed || ending) return;
      queue.push(`${JSON.stringify(value)}\n`);
      pump();
    },
    end() {
      if (closed || ending) return;
      ending = true;
      pump();
    },
  };
}

export function createRpcHost(
  registry: SubagentProcessRegistry,
): ManagedHostPort {
  return {
    kind: "rpc",
    async launch(request) {
      if (request.signal?.aborted)
        throw new ManagedError("aborted", "Managed worker launch was aborted.");
      const stderrFd = fs.openSync(request.paths.stderr, "a", 0o600);
      const isolated = process.platform !== "win32";
      let proc: ChildProcess;
      try {
        proc = spawn(request.command, [...request.args], {
          cwd: request.cwd,
          env: {
            ...stripParentControlEnvironment(process.env),
            ...request.env,
          },
          detached: isolated,
          shell: false,
          // Open stdin keeps RPC mode alive; EOF (including parent death) is its shutdown request.
          stdio: ["pipe", "pipe", stderrFd],
        });
      } finally {
        fs.closeSync(stderrFd);
      }
      const writer = createStdinWriter(proc.stdin);
      const log = createDiagnosticLog(request.paths.stderr);
      const reader = createRpcRecordReader((record) =>
        handleRpcRecord(record, (response) => writer.send(response), log),
      );
      // Consuming stdout keeps Pi from blocking on a full pipe.
      proc.stdout?.on("data", (chunk: Buffer) => reader.push(chunk));
      proc.stdout?.on("end", () => reader.end());
      proc.stdout?.on("error", () => {});
      const registered = registry.register(proc, isolated);
      const exited = new Promise<void>((resolve) => {
        proc.once("close", () => resolve());
        proc.once("error", () => resolve());
      }).then(() => registered.complete());
      return {
        placement: {
          kind: "rpc",
          ...(proc.pid !== undefined ? { pid: proc.pid } : {}),
        },
        exited,
        requestStop: () => writer.end(),
        async terminate() {
          writer.end();
          registered.terminate();
          await Promise.race([exited, registered.done]);
          await registered.done;
        },
      };
    },
    async focus() {
      throw new ManagedError(
        "unsupported",
        "Native TUI attachment is only available when Pi runs inside Herdr.",
      );
    },
  };
}
