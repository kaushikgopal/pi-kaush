// Strict parser for pi's JSON event-stream protocol (pi --mode json).
//
// The harness records every event it can parse, counts and samples the
// lines it cannot, and classifies the arm outcome from the event stream
// plus the process exit code and kill reason. Nothing is silently dropped:
// unparseable lines, unknown event types, provider retries, assistant
// stop-reason errors, and tool errors all surface in the arm record.
//
// Event coverage mirrors the types emitted by pi's agent session plus the
// session header: session, session_start, agent_start, agent_settled,
// agent_end, turn_start, turn_end, message_start, message_update,
// message_end, tool_execution_start/update/end, tool_call, tool_result,
// auto_retry_start/end, compaction_start/end, entry_appended,
// session_info_changed, thinking_level_changed, thinking_level_select,
// queue_update, model_select, bash_execution_update, session_* lifecycle
// and tree events, and the bare "text" event. Anything else is counted as
// an unknown event type.

import { byteLength, truncate } from "./util.mjs";

/** Parse raw JSONL lines into normalized events plus parse-error samples. */
export function parseStream(lines) {
  const events = [];
  const parseErrors = [];
  let unknownTypeCount = 0;
  lines.forEach((line, index) => {
    if (typeof line !== "string" || line.trim() === "") return;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      parseErrors.push({ index, truncated: truncate(line, 160) });
      return;
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof parsed.type !== "string"
    ) {
      parseErrors.push({
        index,
        truncated: truncate(line, 160),
        reason: "not-an-event",
      });
      return;
    }
    const event = normalizeEvent(parsed);
    if (event === null) unknownTypeCount++;
    else events.push(event);
  });
  return { events, parseErrors, unknownTypeCount };
}

/** Keep only the fields the harness needs; drop all message prose/args. */
function normalizeEvent(raw) {
  switch (raw.type) {
    case "session":
      return {
        type: "session",
        version: raw.version,
        cwdBytes: raw.cwd ? byteLength(raw.cwd) : 0,
      };
    case "agent_start":
    case "agent_settled":
    case "turn_start":
    case "session_start":
      return { type: raw.type };
    case "agent_end":
      return { type: "agent_end", willRetry: Boolean(raw.willRetry) };
    case "message_start":
      return {
        type: "message_start",
        role: raw.message?.role ?? null,
        toolCalls: toolCallCount(raw.message),
      };
    case "message_end":
      return {
        type: "message_end",
        stopReason: raw.message?.stopReason ?? null,
        errorMessage: raw.message?.errorMessage ?? undefined,
        usage: pickUsage(raw.message?.usage),
        provider: raw.message?.provider ?? null,
        model: raw.message?.model ?? null,
        toolCalls: toolCallCount(raw.message),
      };
    case "message_update":
      // Real pi carries usage on the in-progress message; older/other
      // sources may put it on the event itself.
      return {
        type: "message_update",
        usage: pickUsage(raw.message?.usage ?? raw.usage),
      };
    case "tool_execution_start":
      return {
        type: "tool_execution_start",
        id: raw.toolCallId,
        name: raw.toolName,
        argsBytes: byteLength(JSON.stringify(raw.args ?? null)),
      };
    case "tool_execution_update":
      return {
        type: "tool_execution_update",
        id: raw.toolCallId,
        name: raw.toolName,
        partialBytes: byteLength(
          JSON.stringify(raw.partialResult ?? raw.args ?? null),
        ),
      };
    case "tool_execution_end":
      return {
        type: "tool_execution_end",
        id: raw.toolCallId,
        name: raw.toolName,
        isError: Boolean(raw.isError),
        errorText: raw.isError ? extractToolError(raw.result) : undefined,
      };
    case "auto_retry_start":
      return {
        type: "auto_retry_start",
        attempt: raw.attempt,
        maxAttempts: raw.maxAttempts,
        errorMessage: raw.errorMessage ?? undefined,
      };
    case "auto_retry_end":
      return {
        type: "auto_retry_end",
        success: Boolean(raw.success),
        attempt: raw.attempt,
        finalError: raw.finalError ?? undefined,
      };
    case "compaction_start":
      return { type: "compaction_start", reason: raw.reason ?? null };
    case "compaction_end":
      return {
        type: "compaction_end",
        reason: raw.reason ?? null,
        aborted: Boolean(raw.aborted),
        willRetry: Boolean(raw.willRetry),
        errorMessage: raw.errorMessage ?? undefined,
      };
    case "model_select":
      // Carries the actual provider/model pi resolved to, if reported.
      return {
        type: "model_select",
        provider: raw.model?.provider ?? null,
        model: raw.model?.id ?? raw.model?.model ?? null,
        source: raw.source ?? null,
      };
    case "session_info_changed":
    case "thinking_level_changed":
    case "thinking_level_select":
    case "queue_update":
    case "entry_appended":
    case "bash_execution_update":
    case "turn_end":
    case "session_shutdown":
    case "session_before_compact":
    case "session_before_tree":
    case "session_compact":
    case "session_tree":
    case "tool_call":
    case "tool_result":
    case "text":
      return { type: raw.type };
    default:
      return null;
  }
}

function toolCallCount(message) {
  return Array.isArray(message?.content)
    ? message.content.filter((part) => part?.type === "tool_use").length
    : 0;
}

/** Compact usage record; undefined when the provider reported nothing. */
function pickUsage(usage) {
  if (typeof usage !== "object" || usage === null) return undefined;
  return {
    input: usage.input ?? 0,
    output: usage.output ?? 0,
    cacheRead: usage.cacheRead ?? 0,
    cacheWrite: usage.cacheWrite ?? 0,
    reasoning: usage.reasoning ?? 0,
    total: usage.totalTokens ?? usage.total ?? 0,
    costTotal: usage.cost?.total ?? 0,
  };
}

/** Pull a short error text out of a failed tool result, if any. */
function extractToolError(result) {
  if (typeof result === "string") return truncate(result, 300);
  if (typeof result === "object" && result !== null) {
    const details = result.details;
    if (typeof details === "string") return truncate(details, 300);
    if (typeof details === "object" && details !== null) {
      for (const key of ["error", "message"]) {
        if (typeof details[key] === "string")
          return truncate(details[key], 300);
      }
    }
    if (typeof result.error === "string") return truncate(result.error, 300);
    if (typeof result.message === "string")
      return truncate(result.message, 300);
  }
  return undefined;
}

/**
 * Classify the arm outcome and derive metrics from normalized events.
 * killReason values: "timeout" | "max-calls" | "spawn-error" | null.
 */
export function analyzeProtocol({
  events,
  parseErrors,
  unknownTypeCount = 0,
  exitCode = 0,
  killReason = null,
}) {
  const outcomes = classifyOutcome({
    events,
    parseErrors,
    unknownTypeCount,
    exitCode,
    killReason,
  });
  const metrics = computeMetrics(events);
  return {
    outcome: outcomes.outcome,
    outcomeDetail: outcomes.detail,
    metrics,
    errors: {
      parse: parseErrors,
      unknownEventTypes: unknownTypeCount,
      provider: providerErrorMessages(events),
      assistant: assistantErrorMessages(events),
    },
    lastStopReason: lastMessageEnd(events)?.stopReason ?? null,
  };
}

/**
 * Outcomes that mean the arm produced no usable model interaction at all
 * (pi could not start or its protocol stream was unusable). A run where
 * every arm lands here is an unusable infra/protocol run and the CLI exits
 * nonzero; anything else stays reportable even when the tree mismatches.
 */
export function isUnusableOutcome(outcome) {
  return (
    outcome === "process-error" ||
    outcome === "parse-error" ||
    outcome === "output-limit" ||
    outcome === "no-agent-end"
  );
}

/**
 * Pure outcome classification, exported separately for verify + tests.
 *
 * Precedence, strongest first: kill reasons (timeout, max-calls), spawn
 * failure, then a nonzero exit (final lifecycle wins over event traces),
 * then the FINAL agent_end / retry / message lifecycle. Provider retries
 * that recover are not permanent failures: only the last auto_retry_end
 * counts, and only the last agent_end decides completion.
 */
export function classifyOutcome({
  events,
  parseErrors,
  unknownTypeCount = 0,
  exitCode = 0,
  killReason = null,
}) {
  if (killReason === "timeout")
    return { outcome: "timeout", detail: "killed by timeout" };
  if (killReason === "max-calls")
    return { outcome: "tool-call-limit", detail: "killed at max-calls cap" };
  if (killReason === "output-limit")
    return {
      outcome: "output-limit",
      detail: "killed after an oversized protocol line",
    };
  if (killReason === "spawn-error")
    return { outcome: "process-error", detail: "failed to spawn pi" };

  const agentEnds = events.filter((event) => event.type === "agent_end");
  const agentEnd = agentEnds[agentEnds.length - 1];
  const retryEnds = events.filter((event) => event.type === "auto_retry_end");
  const lastRetryFailed =
    retryEnds.length > 0 && !retryEnds[retryEnds.length - 1].success;
  const last = lastMessageEnd(events);
  const finalStopBad =
    last && (last.stopReason === "error" || last.stopReason === "aborted");

  if (exitCode !== 0) {
    const signal = events.length > 0 ? " after agent events" : "";
    return {
      outcome: "process-error",
      detail: `exit code ${exitCode}${signal}`,
    };
  }

  if (agentEnd) {
    if (agentEnd.willRetry) {
      return {
        outcome: "provider-error",
        detail: "final agent_end with willRetry=true",
      };
    }
    if (lastRetryFailed) {
      return {
        outcome: "provider-error",
        detail: `auto_retry attempt ${retryEnds[retryEnds.length - 1].attempt} failed`,
      };
    }
    if (finalStopBad) {
      return {
        outcome: "assistant-error",
        detail: `final message stopReason=${last.stopReason}`,
      };
    }
    return { outcome: "completed", detail: null };
  }

  // No agent_end: record the specific visible failure instead of falling
  // back to a generic process/exit classification.
  if (lastRetryFailed) {
    return {
      outcome: "provider-error",
      detail: `auto_retry attempt ${retryEnds[retryEnds.length - 1].attempt} failed (no agent_end)`,
    };
  }
  if (finalStopBad) {
    return {
      outcome: "assistant-error",
      detail: `final message stopReason=${last.stopReason} (no agent_end)`,
    };
  }
  if (events.length === 0 && parseErrors.length > 0) {
    return {
      outcome: "parse-error",
      detail: `${parseErrors.length} unparseable line(s)`,
    };
  }
  return {
    outcome: "no-agent-end",
    detail: `exited ${exitCode} without agent_end`,
  };
}

function lastMessageEnd(events) {
  for (let index = events.length - 1; index >= 0; index--) {
    if (events[index].type === "message_end") return events[index];
  }
  return undefined;
}

/**
 * Token accounting. Primary source: the per-turn usage each assistant
 * message_end reports is summed across turns. Fallback (no message_end
 * usage): the latest per-message message_update usage, which pi reports
 * cumulatively when it streams usage.
 */
export function computeTokens(events) {
  const messageUsage = events
    .filter((event) => event.type === "message_end" && event.usage?.total > 0)
    .map((event) => event.usage);
  if (messageUsage.length > 0) {
    return {
      input: sum(messageUsage, "input"),
      output: sum(messageUsage, "output"),
      cacheRead: sum(messageUsage, "cacheRead"),
      cacheWrite: sum(messageUsage, "cacheWrite"),
      reasoning: sum(messageUsage, "reasoning"),
      total: sum(messageUsage, "total"),
      costTotal: sum(messageUsage, "costTotal"),
      source: "summed",
    };
  }
  const updates = events.filter(
    (event) => event.type === "message_update" && event.usage?.total > 0,
  );
  if (updates.length > 0) {
    const usage = updates[updates.length - 1].usage;
    return { ...usage, source: "cumulative" };
  }
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    total: 0,
    costTotal: 0,
    source: "none",
  };
}

function sum(entries, key) {
  return entries.reduce((total, entry) => total + (entry[key] ?? 0), 0);
}

/**
 * Tool metrics: counts, error counts, edit argument bytes, and the
 * first-edit tri-state ("none" | "success" | "error").
 */
export function computeMetrics(events) {
  const starts = events.filter(
    (event) => event.type === "tool_execution_start",
  );
  const ends = events.filter((event) => event.type === "tool_execution_end");
  const endById = new Map(ends.map((event) => [event.id, event]));
  const errorIds = new Set(
    ends.filter((event) => event.isError).map((event) => event.id),
  );
  const byName = {};
  let editArgsBytes = 0;
  let readArgsBytes = 0;
  for (const start of starts) {
    byName[start.name] = (byName[start.name] ?? 0) + 1;
    if (start.name === "edit") editArgsBytes += start.argsBytes;
    if (start.name === "read") readArgsBytes += start.argsBytes;
  }

  const firstEditIndex = starts.findIndex((start) => start.name === "edit");
  let firstEdit;
  if (firstEditIndex === -1) {
    firstEdit = { status: "none", argsBytes: 0, index: null };
  } else {
    const start = starts[firstEditIndex];
    const end = endById.get(start.id);
    const status = end ? (end.isError ? "error" : "success") : "error";
    firstEdit = { status, argsBytes: start.argsBytes, index: firstEditIndex };
  }

  const toolErrors = ends.filter((event) => event.isError).length;
  return {
    tokens: computeTokens(events),
    toolCalls: {
      total: starts.length,
      read: byName.read ?? 0,
      edit: byName.edit ?? 0,
      errors: toolErrors,
      errorTools: Object.fromEntries(
        Object.entries(countErrorsByTool(events)).sort(([a], [b]) =>
          a < b ? -1 : a > b ? 1 : 0,
        ),
      ),
      byName: Object.fromEntries(
        Object.entries(byName).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      ),
    },
    editArgsBytes,
    readArgsBytes,
    firstEdit,
  };
}

/** Provider/model identity as reported by pi's final message, if any. */
export function reportedIdentity(events) {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event.type === "message_end" && event.model) {
      return { provider: event.provider, model: event.model };
    }
  }
  return null;
}

function countErrorsByTool(events) {
  const counts = {};
  const startsById = new Map(
    events
      .filter((event) => event.type === "tool_execution_start")
      .map((event) => [event.id, event]),
  );
  for (const event of events) {
    if (event.type !== "tool_execution_end" || !event.isError) continue;
    const name = startsById.get(event.id)?.name ?? event.name ?? "unknown";
    counts[name] = (counts[name] ?? 0) + 1;
  }
  return counts;
}

function providerErrorMessages(events) {
  const messages = [];
  for (const event of events) {
    if (event.type === "auto_retry_start" && event.errorMessage) {
      messages.push({
        kind: "auto_retry",
        attempt: event.attempt,
        message: event.errorMessage,
      });
    }
    if (event.type === "auto_retry_end" && event.finalError) {
      messages.push({
        kind: "auto_retry_final",
        attempt: event.attempt,
        message: event.finalError,
      });
    }
    if (event.type === "compaction_end" && event.errorMessage) {
      messages.push({ kind: "compaction_end", message: event.errorMessage });
    }
  }
  return messages;
}

function assistantErrorMessages(events) {
  return events
    .filter(
      (event) =>
        event.type === "message_end" &&
        (event.stopReason === "error" || event.stopReason === "aborted") &&
        event.errorMessage,
    )
    .map((event) => ({
      stopReason: event.stopReason,
      message: event.errorMessage,
    }));
}
