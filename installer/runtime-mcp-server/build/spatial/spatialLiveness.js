export function spatialSourceKey(source) {
    const placement = source.linkInstanceUniqueId?.trim() || "host";
    return `${source.documentKey}::${placement}`;
}
function assertSequence(value, field) {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new RangeError(`${field} must be a non-negative safe integer.`);
    }
}
function unknownSourceResult(sourceKey, source, code, liveSequence) {
    const reason = {
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
function evaluateSource(source, liveSource, classifyChange) {
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
        return unknownSourceResult(sourceKey, source, "change_sequence_unknown", liveSource.changeSequence);
    }
    if (liveSource.documentSessionId !== source.documentSessionId) {
        return unknownSourceResult(sourceKey, source, "document_session_changed", liveSource.changeSequence);
    }
    const snapshotTrackerSession = source.trackerSessionId?.trim() || null;
    const liveTrackerSession = liveSource.trackerSessionId?.trim() || null;
    if (!snapshotTrackerSession || !liveTrackerSession) {
        return unknownSourceResult(sourceKey, source, "tracker_session_unavailable", liveSource.changeSequence);
    }
    if (snapshotTrackerSession !== liveTrackerSession) {
        return unknownSourceResult(sourceKey, source, "tracker_session_changed", liveSource.changeSequence);
    }
    if (liveSource.changeSequence < source.changeSequence) {
        return unknownSourceResult(sourceKey, source, "sequence_regressed", liveSource.changeSequence);
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
        return unknownSourceResult(sourceKey, source, "journal_gap", liveSource.changeSequence);
    }
    const relevantEntries = [...liveSource.journal]
        .filter((entry) => entry.sequence > source.changeSequence && entry.sequence <= liveSource.changeSequence)
        .sort((left, right) => left.sequence - right.sequence);
    let expectedSequence = source.changeSequence + 1;
    for (const entry of relevantEntries) {
        assertSequence(entry.sequence, "journal sequence");
        if (entry.sequence !== expectedSequence) {
            return unknownSourceResult(sourceKey, source, "journal_incomplete", liveSource.changeSequence);
        }
        expectedSequence += 1;
    }
    if (expectedSequence !== liveSource.changeSequence + 1) {
        return unknownSourceResult(sourceKey, source, "journal_incomplete", liveSource.changeSequence);
    }
    const reasons = [];
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
export function evaluateSpatialLiveness(input) {
    if (input.snapshotSources.length === 0) {
        throw new Error("Spatial liveness evaluation requires at least one snapshot source.");
    }
    const liveByKey = new Map();
    for (const source of input.liveSources) {
        const key = spatialSourceKey(source);
        if (liveByKey.has(key)) {
            throw new Error(`Duplicate live spatial source: ${key}`);
        }
        liveByKey.set(key, source);
    }
    const seenSnapshotSources = new Set();
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
    const liveness = sources.some((source) => source.liveness === "unknown")
        ? "unknown"
        : sources.some((source) => source.liveness === "stale")
            ? "stale"
            : "current";
    return { liveness, sources, reasons, warnings };
}
