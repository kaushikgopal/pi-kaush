// Arm runner: spawns one pi invocation in JSON mode under private
// workspace + PI_CODING_AGENT_DIR isolation.
//
// Responsibilities:
//   - build the deterministic pi argv (pure, unit-tested);
//   - materialize the fixture start tree into a fresh workspace;
//   - stream stdout as JSONL, parse it strictly, enforce the per-arm
//     timeout and the max-calls safety cap by killing the WHOLE process
//     group (SIGTERM, then SIGKILL after a grace period);
//   - snapshot the resulting workspace tree and score it byte-exactly
//     against the pre-computed expected tree snapshot;
//   - journal every parsed event and finalize with the outcome.

import { spawn } from "node:child_process";
import { createIsolation } from "./isolation.mjs";
import { createJournal } from "./journal.mjs";
import { materializeFiles } from "./fixtures.mjs";
import { analyzeProtocol, parseStream, reportedIdentity } from "./protocol.mjs";
import { compareTrees, snapshotTree } from "./workspace.mjs";
import { slotKey } from "./scheduler.mjs";
import { scoreTree } from "./scoring.mjs";
import { isoNow } from "./util.mjs";

/**
 * Deterministic argv for one arm; pure so tests can assert it. The
 * prompt is always the final positional argument (fixture prompts never
 * start with "-", and pi rejects a bare "--" terminator in json mode).
 */
export function buildPiArgs({ arm, model, extensionPath, prompt }) {
  const args = [
    "--mode",
    "json",
    "--model",
    model.id,
    "--thinking",
    model.thinking ?? "off",
    "--no-session",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--no-approve",
    "--tools",
    "read,edit",
  ];
  if (arm === "better") args.push("-e", extensionPath);
  args.push(prompt);
  return args;
}

/**
 * Run one arm with isolation and journals; returns the private arm record.
 * expectedTree is the fixture's expected tree snapshot (treeRecord form).
 * Only harness bugs throw here; pi/process failures are classified.
 */
export async function runArm({
  config,
  slot,
  fixture,
  expectedTree,
  tmpBaseDir,
  realAgentDir,
  onEvent,
}) {
  const isolation = await createIsolation({
    tmpBaseDir,
    key: slotKey(slot),
    realAgentDir,
  });
  const journal = createJournal(config.runDir, slotKey(slot));
  const startedAt = isoNow();
  const startMs = Date.now();
  try {
    await materializeFiles(isolation.workspaceDir, fixture.startFiles);
    const argv = buildPiArgs({
      arm: slot.arm,
      model: slot.model,
      extensionPath: config.extensionPath,
      prompt: fixture.prompt,
    });
    const result = await executePi({
      piBin: config.piBin,
      argv,
      cwd: isolation.workspaceDir,
      agentDir: isolation.agentDir,
      timeoutMs: config.timeoutMs,
      maxCalls: config.maxCalls,
      maxProtocolLineChars: config.maxProtocolLineChars,
      onEvent,
      journal,
    });
    const wallMs = Date.now() - startMs;
    const tree = await snapshotTree(isolation.workspaceDir);
    const treeDiff = compareTrees(tree, expectedTree);
    const analysis = analyzeProtocol({
      ...result.parsed,
      exitCode: result.exitCode,
      killReason: result.killReason,
    });
    const identity = reportedIdentity(result.parsed.events);
    const armResult = {
      arm: slot.arm,
      model: { id: slot.model.id, thinking: slot.model.thinking },
      fixture: fixture.name,
      trial: slot.trial,
      startedAt,
      endedAt: isoNow(),
      wallMs,
      exitCode: result.exitCode,
      killReason: result.killReason,
      spawnError: result.spawnError ?? undefined,
      outcome: analysis.outcome,
      outcomeDetail: analysis.outcomeDetail,
      reported: identity,
      events: result.parsed.events,
      metrics: analysis.metrics,
      errors: { ...analysis.errors, stderrTail: result.stderrTail },
      tree: {
        match: treeDiff.match,
        score: scoreTree(treeDiff),
        missing: treeDiff.missing,
        extra: treeDiff.extra,
        changed: treeDiff.changed.map(
          ({
            path,
            actualSha256,
            expectedSha256,
            actualBytes,
            expectedBytes,
          }) => ({
            path,
            actualSha256,
            expectedSha256,
            actualBytes,
            expectedBytes,
          }),
        ),
        actualTotalBytes: tree.totalBytes,
        expectedTotalBytes: expectedTree.totalBytes,
      },
    };
    journal.finalize({
      outcome: armResult.outcome,
      exitCode: armResult.exitCode,
      killReason: armResult.killReason,
      wallMs: armResult.wallMs,
      treeMatch: armResult.tree.match,
    });
    onEvent?.({ type: "arm_done", armResult });
    return armResult;
  } finally {
    if (!config.keepWorkspaces) {
      await isolation.cleanup();
    }
  }
}

/**
 * Spawn pi, stream-parse JSONL, enforce time and call caps. pi is spawned
 * detached so pid == its process-group id; on timeout/cap the whole group
 * (including any shells, helpers, or grandchild processes the model
 * spawned) is SIGTERMed, then SIGKILLed after the grace period.
 */
function executePi({
  piBin,
  argv,
  cwd,
  agentDir,
  timeoutMs,
  maxCalls,
  maxProtocolLineChars,
  onEvent,
  journal,
}) {
  return new Promise((resolve) => {
    const child = spawn(piBin, argv, {
      cwd,
      detached: true,
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: agentDir,
        PI_SKIP_VERSION_CHECK: "1",
        NO_COLOR: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const parsed = { events: [], parseErrors: [], unknownTypeCount: 0 };
    let stderrTail = "";
    let killReason = null;
    let killed = false;
    let toolCallCount = 0;
    let lineIndex = 0;
    let discardStdout = false;
    const timer = setTimeout(() => kill("timeout"), timeoutMs);

    const kill = (reason) => {
      if (killed) return;
      killed = true;
      killReason = reason;
      terminate(child, 5_000);
    };

    const handleLine = (line) => {
      const batch = parseStream([line]);
      parsed.events.push(...batch.events);
      parsed.parseErrors.push(
        ...batch.parseErrors.map((error) => ({ ...error, index: lineIndex })),
      );
      parsed.unknownTypeCount += batch.unknownTypeCount;
      lineIndex++;
      for (const event of batch.events) {
        toolCallCount =
          event.type === "tool_execution_start"
            ? toolCallCount + 1
            : toolCallCount;
        journal.append({ type: "event", event });
        onEvent?.({ type: "event", event });
        if (toolCallCount >= maxCalls) kill("max-calls");
      }
    };

    const maxLineChars = maxProtocolLineChars ?? 16 * 1024 * 1024;
    const rejectOversizedLine = () => {
      if (discardStdout) return;
      parsed.parseErrors.push({
        index: lineIndex,
        truncated: `[protocol line exceeded ${maxLineChars} characters]`,
        reason: "line-too-large",
      });
      discardStdout = true;
      buffer = "";
      kill("output-limit");
    };
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (discardStdout) return;
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.length > maxLineChars) {
          rejectOversizedLine();
          return;
        }
        handleLine(line);
      }
      if (buffer.length > maxLineChars) rejectOversizedLine();
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderrTail = `${stderrTail}${chunk}`.slice(-8_000);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({
        parsed: { events: [], parseErrors: [], unknownTypeCount: 0 },
        exitCode: -1,
        killReason: killReason ?? "spawn-error",
        stderrTail: String(error),
        spawnError: String(error),
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (!discardStdout && buffer.trim() !== "") handleLine(buffer);
      resolve({
        parsed,
        exitCode: code ?? -1,
        killReason,
        stderrTail,
        spawnError: undefined,
      });
    });
  });
}

/**
 * Send SIGTERM to the whole process group (negative pid works because the
 * child was spawned detached and leads its own group), then SIGKILL the
 * group after the grace period, only once. Falls back to signaling the
 * direct child when group signaling fails.
 */
function terminate(child, graceMs) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  signalGroup(child);
  setTimeout(() => {
    if (child.exitCode === null) signalGroup(child, "SIGKILL");
  }, graceMs).unref();
}

function signalGroup(child, signal = "SIGTERM") {
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already exited */
    }
  }
}
