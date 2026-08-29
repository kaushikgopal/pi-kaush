import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import {
  buildSessionContext,
  type ExtensionContext,
  type SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import {
  createCompactionFromPlan,
  findSummaryProvenance,
  type CompactionAttempt,
  type PreparedCompaction,
} from "./compactor.ts";
import { PlannerFailure, resolvePlannerModel, runPlanner } from "./planner.ts";
import { buildTranscript, digestText } from "./transcript.ts";
import type {
  CompactionSource,
  ExtensionSettings,
  PlannerResult,
  RuntimeState,
  Transcript,
} from "./types.ts";

const MAX_CANDIDATE_AGE_MS = 15 * 60 * 1_000;

interface CandidateSnapshot {
  transcript: Transcript;
  objective: string;
  targetRetainedTokens: number;
  settingsHash: string;
  modelIdentity: string;
  transcriptHash: string;
  createdAt: number;
}

interface CandidateJob {
  snapshot: CandidateSnapshot;
  controller: AbortController;
  promise: Promise<PlannerResult | undefined>;
  settled: boolean;
  planner?: PlannerResult;
}

export class SpeculationController {
  #job: CandidateJob | undefined;
  #generation = 0;

  constructor(
    private readonly state: RuntimeState,
    private readonly onPlannerResponse?: (usage: Usage) => void,
  ) {}

  consider(ctx: ExtensionContext, settings: ExtensionSettings): void {
    if (!settings.speculation.enabled || this.#job !== undefined) return;
    const usage = ctx.getContextUsage();
    if (
      usage?.percent === null ||
      usage?.percent === undefined ||
      usage.percent / 100 < settings.speculation.triggerRatio
    ) {
      return;
    }

    const source = sourceFromActiveSession(ctx);
    const transcript = buildTranscript(source, {
      protectedContext: settings.protectedContext.enabled,
      previousSummaryProvenance: findSummaryProvenance(
        ctx.sessionManager.getBranch(),
        source.previousSummary,
      ),
    });
    const targetRetainedTokens = Math.max(
      Math.min(transcript.estimatedTokens, settings.retention.minimumTokens),
      Math.floor(transcript.estimatedTokens * settings.retention.ratio),
    );
    if (
      transcript.lines.length === 0 ||
      transcript.estimatedTokens - targetRetainedTokens <
        settings.retention.minimumReductionTokens
    ) {
      return;
    }

    let modelIdentity: string;
    try {
      const model = resolvePlannerModel(settings.planner.model, ctx);
      modelIdentity = `${model.provider}/${model.id}`;
    } catch {
      return;
    }

    const generation = this.#generation;
    const controller = new AbortController();
    const snapshot: CandidateSnapshot = {
      transcript,
      objective: this.state.currentObjective,
      targetRetainedTokens,
      settingsHash: settingsHash(settings),
      modelIdentity,
      transcriptHash: digestTranscript(transcript),
      createdAt: Date.now(),
    };
    this.state.counters.speculationGenerated += 1;
    const job: CandidateJob = {
      snapshot,
      controller,
      promise: Promise.resolve(undefined),
      settled: false,
    };
    job.promise = runPlanner(
      {
        transcript,
        objective: snapshot.objective,
        targetRetainedTokens,
      },
      settings.planner,
      { model: ctx.model, modelRegistry: ctx.modelRegistry },
      controller.signal,
      this.onPlannerResponse,
    )
      .catch((error: unknown) => {
        if (
          generation === this.#generation &&
          !(error instanceof PlannerFailure && error.reason === "aborted")
        ) {
          this.state.counters.speculationErrors += 1;
        }
        return undefined;
      })
      .then((planner) => {
        job.settled = true;
        job.planner = planner;
        return planner;
      });

    this.#job = job;
  }

  async consume(
    event: SessionBeforeCompactEvent,
    prepared: PreparedCompaction,
    settings: ExtensionSettings,
    ctx: Pick<ExtensionContext, "model" | "modelRegistry">,
  ): Promise<CompactionAttempt | undefined> {
    const job = this.#job;
    if (job === undefined) return undefined;
    this.#job = undefined;
    if (!job.settled) {
      job.controller.abort();
      this.markStale();
      return undefined;
    }
    const planner = job.planner;
    if (planner === undefined) return undefined;

    let currentModelIdentity: string;
    try {
      const model = resolvePlannerModel(settings.planner.model, ctx);
      currentModelIdentity = `${model.provider}/${model.id}`;
    } catch {
      this.markStale();
      return undefined;
    }

    const prefixLength = commonPrefixLength(
      job.snapshot.transcript,
      prepared.transcript,
    );
    const exactPreparedPrefix =
      prepared.transcript.lines.length <=
        job.snapshot.transcript.lines.length &&
      prefixLength === prepared.transcript.lines.length &&
      digestTranscript(prepared.transcript) ===
        digestTranscriptPrefix(
          job.snapshot.transcript,
          prepared.transcript.lines.length,
        );
    if (
      Date.now() - job.snapshot.createdAt > MAX_CANDIDATE_AGE_MS ||
      job.snapshot.settingsHash !== settingsHash(settings) ||
      job.snapshot.modelIdentity !== currentModelIdentity ||
      job.snapshot.objective !== prepared.objective ||
      event.customInstructions?.trim() ||
      !exactPreparedPrefix ||
      digestTranscript(job.snapshot.transcript) !== job.snapshot.transcriptHash
    ) {
      this.markStale();
      return undefined;
    }

    const compatibleRanges = planner.ranges.filter(
      (range) => range.start >= 1 && range.end <= prefixLength,
    );
    const discardedForPrefix = planner.ranges.length - compatibleRanges.length;
    if (
      discardedForPrefix > 0 &&
      planner.parseMode !== "tool" &&
      planner.parseMode !== "tool-recovered"
    ) {
      this.markStale();
      return undefined;
    }
    const firstPrefixDiscard = planner.ranges.findIndex(
      (range) => range.start < 1 || range.end > prefixLength,
    );
    const prefixDiagnostics = {
      ...planner.responseDiagnostics,
      parseMode: "tool-recovered" as const,
      acceptedRangeRecords: compatibleRanges.length,
      discardedRangeRecords:
        (planner.responseDiagnostics.discardedRangeRecords ?? 0) +
        discardedForPrefix,
      outOfBoundsRangeRecords:
        (planner.responseDiagnostics.outOfBoundsRangeRecords ?? 0) +
        discardedForPrefix,
    };
    delete prefixDiagnostics.firstDiscardedRecord;
    if (
      (planner.responseDiagnostics.discardedRangeRecords ?? 0) === 0 &&
      (planner.responseDiagnostics.duplicateRangeRecords ?? 0) === 0
    ) {
      prefixDiagnostics.firstDiscardedRecord = firstPrefixDiscard + 1;
    }
    const compatiblePlanner: PlannerResult = {
      ...planner,
      ranges: compatibleRanges,
      proposedCount: compatibleRanges.length,
      ...(discardedForPrefix === 0
        ? {}
        : {
            parseMode: "tool-recovered",
            responseDiagnostics: prefixDiagnostics,
          }),
    };
    const attempt = createCompactionFromPlan(
      event,
      prepared,
      compatiblePlanner,
      settings,
      "speculative",
    );
    if (attempt === undefined) {
      this.markStale();
      return undefined;
    }
    this.state.counters.speculationHits += 1;
    return attempt;
  }

  invalidate(countAsStale = true): void {
    const hadJob = this.#job !== undefined;
    this.#generation += 1;
    this.#job?.controller.abort();
    this.#job = undefined;
    if (hadJob && countAsStale) this.state.counters.speculationStale += 1;
  }

  private markStale(): void {
    this.state.counters.speculationStale += 1;
  }
}

function sourceFromActiveSession(ctx: ExtensionContext): CompactionSource {
  const context = buildSessionContext(
    [...ctx.sessionManager.getEntries()],
    ctx.sessionManager.getLeafId(),
  );
  const messages = [...context.messages];
  let previousSummary: string | undefined;
  const first = messages[0] as AgentMessage | undefined;
  if (first !== undefined && first.role === "compactionSummary") {
    previousSummary = first.summary;
    messages.shift();
  }
  return {
    previousSummary,
    messagesToSummarize: messages,
    turnPrefixMessages: [],
  };
}

function settingsHash(settings: ExtensionSettings): string {
  return digest(
    JSON.stringify({
      retention: settings.retention,
      planner: settings.planner,
      protectedContext: settings.protectedContext,
    }),
  );
}

function digest(value: string): string {
  return digestText(value);
}

function commonPrefixLength(left: Transcript, right: Transcript): number {
  const maximum = Math.min(left.lines.length, right.lines.length);
  let index = 0;
  while (index < maximum) {
    const a = left.lines[index];
    const b = right.lines[index];
    if (
      a?.text !== b?.text ||
      a?.kind !== b?.kind ||
      a?.protected !== b?.protected
    ) {
      break;
    }
    index += 1;
  }
  return index;
}

function digestTranscript(transcript: Transcript): string {
  return digestTranscriptPrefix(transcript, transcript.lines.length);
}

function digestTranscriptPrefix(
  transcript: Transcript,
  length: number,
): string {
  return digest(
    JSON.stringify(
      transcript.lines
        .slice(0, length)
        .map((line) => [line.text, line.kind, line.protected]),
    ),
  );
}
