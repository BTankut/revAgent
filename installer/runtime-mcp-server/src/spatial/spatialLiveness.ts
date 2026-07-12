export type SpatialLiveness = "current" | "stale" | "unknown";

export type SpatialChangeImpact = "relevant" | "irrelevant" | "unknown";

export interface SpatialSnapshotSourceRevision {
  documentKey: string;
  documentSessionId: string;
  trackerSessionId?: string | null;
  changeSequence: number;
  changeSequenceState?: string | null;
  linkInstanceUniqueId?: string | null;
}

export interface SpatialChangeJournalEntry {
  sequence: number;
  addedElementIds?: readonly number[];
  modifiedElementIds?: readonly number[];
  deletedElementIds?: readonly number[];
  scopeImpact?: SpatialChangeImpact;
}

export interface SpatialLiveSourceRevision {
  documentKey: string;
  documentSessionId: string;
  trackerSessionId?: string | null;
  changeSequence: number;
  changeSequenceState?: string | null;
  oldestRetainedSequence: number;
  historyCompleteAfterSequence?: number;
  journalTruncated?: boolean;
  linkInstanceUniqueId?: string | null;
  journal: readonly SpatialChangeJournalEntry[];
  externalLinkUpdateAvailable?: boolean;
}

export interface SpatialChangeContext {
  sourceKey: string;
  source: SpatialSnapshotSourceRevision;
  liveSource: SpatialLiveSourceRevision;
  entry: SpatialChangeJournalEntry;
}

export interface SpatialLivenessEvaluationInput {
  snapshotSources: readonly SpatialSnapshotSourceRevision[];
  liveSources: readonly SpatialLiveSourceRevision[];
  /**
   * Optional deterministic scope predicate. When omitted, any journal entry
   * without an explicit scopeImpact is conservatively treated as relevant.
   */
  classifyChange?: (context: SpatialChangeContext) => SpatialChangeImpact;
}

export interface SpatialLivenessReason {
  code:
    | "source_unavailable"
    | "document_session_changed"
    | "tracker_session_unavailable"
    | "tracker_session_changed"
    | "change_sequence_unknown"
    | "sequence_regressed"
    | "journal_gap"
    | "journal_incomplete"
    | "relevant_change"
    | "change_scope_unknown";
  sourceKey: string;
  snapshotSequence: number;
  liveSequence?: number;
  sequence?: number;
}

export interface SpatialSourceLivenessResult {
  sourceKey: string;
  liveness: SpatialLiveness;
  snapshotSequence: number;
  liveSequence?: number;
  reasons: SpatialLivenessReason[];
}

export interface SpatialLivenessResult {
  liveness: SpatialLiveness;
  sources: SpatialSourceLivenessResult[];
  reasons: SpatialLivenessReason[];
  warnings: string[];
}

export function spatialSourceKey(source: {
  documentKey: string;
  linkInstanceUniqueId?: string | null;
}): string {
  const placement = source.linkInstanceUniqueId?.trim() || "host";
  return `${source.documentKey}::${placement}`;
}

function assertSequence(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${field} must be a non-negative safe integer.`);
  }
}

function unknownSourceResult(
  sourceKey: string,
  source: SpatialSnapshotSourceRevision,
  code: SpatialLivenessReason["code"],
  liveSequence?: number,
): SpatialSourceLivenessResult {
  const reason: SpatialLivenessReason = {
    code,
    sourceKey,
    snapshotSequence: source.changeSequence,
    ...(liveSequence === undefined ? {} : { liveSequence }),
  };
  return {
    sourceKey,
    liveness: "unknown",
    snapshotSequence: source.changeSequence,
    ...(liveSequence === undefined ? {} : { liveSequence }),
    reasons: [reason],
  };
}

function evaluateSource(
  source: SpatialSnapshotSourceRevision,
  liveSource: SpatialLiveSourceRevision | undefined,
  classifyChange: SpatialLivenessEvaluationInput["classifyChange"],
): SpatialSourceLivenessResult {
  const sourceKey = spatialSourceKey(source);
  assertSequence(source.changeSequence, "snapshot changeSequence");

  if (!liveSource) {
    return unknownSourceResult(sourceKey, source, "source_unavailable");
  }

  assertSequence(liveSource.changeSequence, "live changeSequence");
  assertSequence(liveSource.oldestRetainedSequence, "oldestRetainedSequence");
  if (liveSource.historyCompleteAfterSequence !== undefined) {
    assertSequence(liveSource.historyCompleteAfterSequence, "historyCompleteAfterSequence");
  }

  const snapshotSequenceState = source.changeSequenceState?.trim().toLowerCase();
  const liveSequenceState = liveSource.changeSequenceState?.trim().toLowerCase();
  const acceptedSequenceStates = new Set(["tracked", "current", "available"]);
  if ((snapshotSequenceState && !acceptedSequenceStates.has(snapshotSequenceState))
    || (liveSequenceState && !acceptedSequenceStates.has(liveSequenceState))) {
    return unknownSourceResult(
      sourceKey,
      source,
      "change_sequence_unknown",
      liveSource.changeSequence,
    );
  }

  if (liveSource.documentSessionId !== source.documentSessionId) {
    return unknownSourceResult(
      sourceKey,
      source,
      "document_session_changed",
      liveSource.changeSequence,
    );
  }

  const snapshotTrackerSession = source.trackerSessionId?.trim() || null;
  const liveTrackerSession = liveSource.trackerSessionId?.trim() || null;
  if (!snapshotTrackerSession || !liveTrackerSession) {
    return unknownSourceResult(
      sourceKey,
      source,
      "tracker_session_unavailable",
      liveSource.changeSequence,
    );
  }
  if (snapshotTrackerSession !== liveTrackerSession) {
    return unknownSourceResult(
      sourceKey,
      source,
      "tracker_session_changed",
      liveSource.changeSequence,
    );
  }

  if (liveSource.changeSequence < source.changeSequence) {
    return unknownSourceResult(
      sourceKey,
      source,
      "sequence_regressed",
      liveSource.changeSequence,
    );
  }

  if (liveSource.changeSequence === source.changeSequence) {
    return {
      sourceKey,
      liveness: "current",
      snapshotSequence: source.changeSequence,
      liveSequence: liveSource.changeSequence,
      reasons: [],
    };
  }

  const historyCompleteAfterSequence = liveSource.historyCompleteAfterSequence
    ?? Math.max(0, liveSource.oldestRetainedSequence - 1);
  if (source.changeSequence < historyCompleteAfterSequence) {
    return unknownSourceResult(
      sourceKey,
      source,
      "journal_gap",
      liveSource.changeSequence,
    );
  }

  const relevantEntries = [...liveSource.journal]
    .filter((entry) => entry.sequence > source.changeSequence && entry.sequence <= liveSource.changeSequence)
    .sort((left, right) => left.sequence - right.sequence);

  let expectedSequence = source.changeSequence + 1;
  for (const entry of relevantEntries) {
    assertSequence(entry.sequence, "journal sequence");
    if (entry.sequence !== expectedSequence) {
      return unknownSourceResult(
        sourceKey,
        source,
        "journal_incomplete",
        liveSource.changeSequence,
      );
    }
    expectedSequence += 1;
  }

  if (expectedSequence !== liveSource.changeSequence + 1) {
    return unknownSourceResult(
      sourceKey,
      source,
      "journal_incomplete",
      liveSource.changeSequence,
    );
  }

  const reasons: SpatialLivenessReason[] = [];
  for (const entry of relevantEntries) {
    const impact = entry.scopeImpact
      ?? classifyChange?.({ sourceKey, source, liveSource, entry })
      ?? "unknown";
    if (impact === "irrelevant") {
      continue;
    }
    reasons.push({
      code: impact === "relevant" ? "relevant_change" : "change_scope_unknown",
      sourceKey,
      snapshotSequence: source.changeSequence,
      liveSequence: liveSource.changeSequence,
      sequence: entry.sequence,
    });
  }

  return {
    sourceKey,
    liveness: reasons.length > 0 ? "stale" : "current",
    snapshotSequence: source.changeSequence,
    liveSequence: liveSource.changeSequence,
    reasons,
  };
}

/**
 * Pure, conservative snapshot liveness evaluation. Unknown dominates stale
 * because a session or journal gap prevents a complete current-state claim.
 */
export function evaluateSpatialLiveness(
  input: SpatialLivenessEvaluationInput,
): SpatialLivenessResult {
  if (input.snapshotSources.length === 0) {
    throw new Error("Spatial liveness evaluation requires at least one snapshot source.");
  }
  const liveByKey = new Map<string, SpatialLiveSourceRevision>();
  for (const source of input.liveSources) {
    const key = spatialSourceKey(source);
    if (liveByKey.has(key)) {
      throw new Error(`Duplicate live spatial source: ${key}`);
    }
    liveByKey.set(key, source);
  }

  const seenSnapshotSources = new Set<string>();
  const sources = input.snapshotSources.map((source) => {
    const key = spatialSourceKey(source);
    if (seenSnapshotSources.has(key)) {
      throw new Error(`Duplicate snapshot spatial source: ${key}`);
    }
    seenSnapshotSources.add(key);
    return evaluateSource(source, liveByKey.get(key), input.classifyChange);
  });

  const reasons = sources.flatMap((source) => source.reasons);
  const warnings = input.liveSources
    .filter((source) => source.externalLinkUpdateAvailable)
    .map((source) => `External link update is available for ${spatialSourceKey(source)}; loaded Revit geometry remains authoritative.`);

  const liveness: SpatialLiveness = sources.some((source) => source.liveness === "unknown")
    ? "unknown"
    : sources.some((source) => source.liveness === "stale")
      ? "stale"
      : "current";

  return { liveness, sources, reasons, warnings };
}
