// Fake pi for the bench harness tests: emits a pi-compatible JSON-mode
// event stream and exits. Never calls a model. Modes are selected with
// FAKE_PI_MODE (happy | happy-edit | tool-error | provider-retry |
// recovered-retry | final-retry-fail | assistant-error | slow | spam |
// garbage | oversized-output | nonzero | version).
//
// When FAKE_PI_CHILD_PIDFILE is set, a detached grandchild (a node process
// that idles forever) is spawned first and its pid written to that file —
// tests use it to prove the harness kills the WHOLE process group on
// timeout / tool-call cap, not just the direct child.
//
// Event payloads mirror pi's agent session: message_update carries usage
// on the in-progress message, and message_end carries per-turn usage plus
// the actual provider/model identity.

import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const MODE = process.env.FAKE_PI_MODE || "happy";
const stdout = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const usage = {
  input: 10,
  output: 5,
  cacheRead: 2,
  cacheWrite: 0,
  reasoning: 3,
  totalTokens: 15,
  cost: { total: 0.01 },
};
const usage2 = {
  input: 20,
  output: 8,
  cacheRead: 2,
  cacheWrite: 1,
  reasoning: 1,
  totalTokens: 30,
  cost: { total: 0.02 },
};
const IDENTITY = { provider: "fake", model: "model" };
const session = {
  type: "session",
  version: 3,
  id: "fake-session",
  timestamp: new Date().toISOString(),
  cwd: process.cwd(),
};

function toolCall(part) {
  if (typeof part === "string") return { type: "text", text: part };
  return {
    type: "tool_use",
    id: part.id,
    name: part.name,
    input: part.input ?? {},
  };
}

function spawnGrandchild() {
  const pidFile = process.env.FAKE_PI_CHILD_PIDFILE;
  if (!pidFile) return;
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  try {
    writeFileSync(pidFile, `${child.pid}\n`);
  } catch {
    /* pidfile is best-effort for tests */
  }
}

function patchWorkspace() {
  // Deterministic fixture edits so a run ends with a byte-exact tree.
  const apply = (relPath, transform) => {
    if (!existsSync(relPath)) return;
    try {
      const next = transform(readFileSync(relPath, "utf8"));
      writeFileSync(relPath, next);
    } catch {
      /* ignored: reads/writes use the fixture cwd */
    }
  };
  apply("src/greeting.ts", (text) =>
    text.replaceAll("formatGreeting", "composeGreeting"),
  );
  apply("src/a.ts", (text) => text.replace('"0.1.0"', '"0.2.0"'));
  apply("src/b.ts", (text) => text.replace('"0.1.0"', '"0.2.0"'));
  apply("records.js", (text) =>
    text
      .split("\n")
      .filter((line) => !/^  \{ id: 1[0-4][0-9][0-9],/.test(line))
      .join("\n"),
  );
}

function run() {
  spawnGrandchild();
  stdout(session);
  stdout({ type: "agent_start" });
  if (MODE === "version") return;
  if (MODE === "garbage") {
    process.stdout.write("not-json{broken\n{also broken\n");
    return;
  }
  if (MODE === "oversized-output") {
    process.stdout.write("x".repeat(2_048));
    return;
  }
  if (MODE === "nonzero") {
    stdout({
      type: "message_start",
      message: { role: "assistant", content: [] },
    });
    stdout({
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        stopReason: "stop",
        errorMessage: "boom",
        usage,
        ...IDENTITY,
      },
    });
    process.exitCode = 3;
    return;
  }
  if (MODE === "slow") {
    stdout({
      type: "message_start",
      message: { role: "assistant", content: [] },
    });
    setTimeout(() => process.exit(0), 60_000);
    return;
  }
  if (MODE === "spam") {
    for (let index = 0; index < 1000; index++) {
      stdout({
        type: "tool_execution_start",
        toolCallId: `spam-${index}`,
        toolName: "read",
        args: { path: "x.txt" },
      });
    }
    return;
  }
  if (MODE === "provider-retry") {
    stdout({
      type: "auto_retry_start",
      attempt: 1,
      maxAttempts: 1,
      errorMessage: "fake provider overloaded",
    });
    stdout({
      type: "auto_retry_end",
      success: false,
      attempt: 1,
      finalError: "fake provider gone",
    });
    return;
  }
  if (MODE === "recovered-retry") {
    // A retry that fails once on an earlier attempt then recovers must
    // NOT become a provider-error: the final lifecycle completed.
    stdout({
      type: "auto_retry_start",
      attempt: 1,
      maxAttempts: 2,
      errorMessage: "fake transient 429",
    });
    stdout({
      type: "auto_retry_end",
      success: false,
      attempt: 1,
      finalError: "fake transient 429",
    });
    stdout({
      type: "auto_retry_start",
      attempt: 2,
      maxAttempts: 2,
    });
    stdout({ type: "auto_retry_end", success: true, attempt: 2 });
    stdout({
      type: "message_end",
      message: { role: "assistant", content: [], stopReason: "stop", usage },
    });
    stdout({ type: "agent_end", messages: [], willRetry: false });
    return;
  }
  if (MODE === "final-retry-fail") {
    stdout({
      type: "auto_retry_start",
      attempt: 1,
      maxAttempts: 2,
    });
    stdout({ type: "auto_retry_end", success: true, attempt: 1 });
    stdout({
      type: "auto_retry_start",
      attempt: 2,
      maxAttempts: 2,
      errorMessage: "fake provider gone",
    });
    stdout({
      type: "auto_retry_end",
      success: false,
      attempt: 2,
      finalError: "fake provider gone",
    });
    return;
  }
  if (MODE === "assistant-error") {
    stdout({
      type: "message_start",
      message: { role: "assistant", content: [] },
    });
    stdout({
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "fake assistant errored",
        usage,
        ...IDENTITY,
      },
    });
    return;
  }
  if (MODE === "agent-end-retry") {
    // First agent lifecycle ends with willRetry; a second one completes.
    stdout({
      type: "message_end",
      message: { role: "assistant", content: [], stopReason: "error", usage },
    });
    stdout({ type: "agent_end", messages: [], willRetry: true });
    stdout({ type: "agent_start" });
    stdout({
      type: "message_end",
      message: { role: "assistant", content: [], stopReason: "stop", usage },
    });
    stdout({ type: "agent_end", messages: [], willRetry: false });
    return;
  }

  if (MODE === "happy-edit") patchWorkspace();

  const readId = "call-read-1";
  const editId = "call-edit-1";
  stdout({ type: "turn_start" });
  stdout({
    type: "message_start",
    message: { role: "assistant", content: [] },
  });
  stdout({
    type: "tool_execution_start",
    toolCallId: readId,
    toolName: "read",
    args: { path: "data.js", offset: 1 },
  });
  stdout({
    type: "tool_execution_end",
    toolCallId: readId,
    toolName: "read",
    isError: false,
    result: { content: [], details: {} },
  });
  stdout({
    type: "message_update",
    message: { role: "assistant", content: [], usage },
    assistantMessageEvent: { type: "signature_start", id: "sig-1" },
  });
  stdout({
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        toolCall("done reading"),
        toolCall({ id: editId, name: "edit", input: { script: "PUT" } }),
      ],
      stopReason: "toolUse",
      usage,
      ...IDENTITY,
    },
  });
  stdout({
    type: "tool_execution_start",
    toolCallId: editId,
    toolName: "edit",
    args: {
      files: [
        {
          path: "data.js",
          edits: [{ startLine: 7, deleteCount: 1, newLines: ["CHANGED"] }],
        },
      ],
    },
  });
  if (MODE === "tool-error") {
    stdout({
      type: "tool_execution_end",
      toolCallId: editId,
      toolName: "edit",
      isError: true,
      result: undefined,
    });
  } else {
    stdout({
      type: "tool_execution_end",
      toolCallId: editId,
      toolName: "edit",
      isError: false,
      result: { content: [], details: { diff: "ok" } },
    });
  }
  stdout({
    type: "message_update",
    message: { role: "assistant", content: [], usage: usage2 },
    assistantMessageEvent: {
      type: "text_delta",
      contentIndex: 0,
      delta: "done",
    },
  });
  stdout({
    type: "message_end",
    message: {
      role: "assistant",
      content: [toolCall("finished")],
      stopReason: "stop",
      usage: usage2,
      ...IDENTITY,
    },
  });
  stdout({ type: "agent_end", messages: [], willRetry: false });
}

if (process.argv.includes("--version")) {
  process.stdout.write("0.0.0-fake\n");
} else {
  run();
}
