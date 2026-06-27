import { z } from "zod";
import { normalizeBroadScanResult } from "../utils/broadScanResult.js";
import { buildReconciliationTokenProfile, cleanReconciliationText, normalizeReconciliationText, } from "./reconcile_normalization.js";
export const DEFAULT_RECONCILIATION_CONFIG = {
    score: {
        exact: 100,
        diceTokenOverlap: 35,
        code: 20,
        dimension: 20,
        order: 15,
        context: 10,
    },
    thresholds: {
        highConfidenceMin: 86,
        highConfidenceMax: 99,
        candidateMin: 65,
        possibleRenameMin: 72,
        possibleRenameMax: 85,
        ambiguousMin: 65,
        ambiguousMax: 71,
        candidateGap: 8,
        tieGap: 8,
    },
    caps: {
        conflictingCode: 64,
        conflictingDimension: 60,
        unitMismatch: 79,
    },
    candidateGeneration: {
        minSharedSignificantWordTokens: 2,
    },
    contextFields: ["system", "unit", "quantity", "discipline"],
};
const scoreConfigSchema = z.object({
    exact: z.number().min(0).max(100).optional(),
    diceTokenOverlap: z.number().min(0).max(100).optional(),
    code: z.number().min(0).max(100).optional(),
    dimension: z.number().min(0).max(100).optional(),
    order: z.number().min(0).max(100).optional(),
    context: z.number().min(0).max(100).optional(),
}).strict();
const thresholdConfigSchema = z.object({
    highConfidenceMin: z.number().min(0).max(100).optional(),
    highConfidenceMax: z.number().min(0).max(100).optional(),
    candidateMin: z.number().min(0).max(100).optional(),
    possibleRenameMin: z.number().min(0).max(100).optional(),
    possibleRenameMax: z.number().min(0).max(100).optional(),
    ambiguousMin: z.number().min(0).max(100).optional(),
    ambiguousMax: z.number().min(0).max(100).optional(),
    candidateGap: z.number().min(0).max(100).optional(),
    tieGap: z.number().min(0).max(100).optional(),
}).strict();
const capConfigSchema = z.object({
    conflictingCode: z.number().min(0).max(100).optional(),
    conflictingDimension: z.number().min(0).max(100).optional(),
    unitMismatch: z.number().min(0).max(100).optional(),
}).strict();
const candidateGenerationConfigSchema = z.object({
    minSharedSignificantWordTokens: z.number().int().min(0).max(20).optional(),
}).strict();
export const reconciliationConfigSchema = z.object({
    score: scoreConfigSchema.optional(),
    thresholds: thresholdConfigSchema.optional(),
    caps: capConfigSchema.optional(),
    candidateGeneration: candidateGenerationConfigSchema.optional(),
    contextFields: z.array(z.string().min(1)).optional(),
}).strict();
export const reconciliationInputSchema = z.object({
    excelRecords: z.array(z.record(z.unknown())).optional(),
    scheduleRecords: z.array(z.record(z.unknown())).optional(),
    excelResult: z.record(z.unknown()).optional(),
    scheduleResult: z.record(z.unknown()).optional(),
    config: reconciliationConfigSchema.optional(),
}).strict();
export function reconcileScheduleExcelRecords(rawInput) {
    const startedAtMs = Date.now();
    const parsed = reconciliationInputSchema.safeParse(rawInput);
    if (!parsed.success) {
        return normalizeBroadScanResult({
            success: true,
            guarded: true,
            state: "guarded",
            action: "reconcile_schedule_excel",
            stage: "matching_scoring",
            reconciliationContractVersion: 1,
            reason: "reconciliation_input_required",
            message: "Provide excelRecords and scheduleRecords, or normalized ingestion result envelopes containing those arrays.",
            validationIssues: parsed.error.issues.map((issue) => issue.message),
            partial: false,
            scanStoppedReason: "needs_scope",
        }, {
            action: "reconcile_schedule_excel",
            partial: false,
            scanStoppedReason: "needs_scope",
            elapsedMs: Date.now() - startedAtMs,
            summary: {},
            evidenceRows: [],
        });
    }
    const config = resolveConfig(parsed.data.config);
    const excelRecords = extractRecords("excel", parsed.data.excelRecords ?? getArray(parsed.data.excelResult, "excelRecords"));
    const scheduleRecords = extractRecords("schedule", parsed.data.scheduleRecords ?? getArray(parsed.data.scheduleResult, "scheduleRecords"));
    const reviewRows = buildReviewRows(excelRecords, scheduleRecords, config);
    const summary = buildSummary(excelRecords, scheduleRecords, reviewRows);
    return normalizeBroadScanResult({
        success: true,
        guarded: false,
        state: "review_ready",
        action: "reconcile_schedule_excel",
        stage: "matching_scoring",
        reconciliationContractVersion: 1,
        partial: false,
        scanStoppedReason: "completed",
        reviewRows,
        reviewTable: buildReviewTable(reviewRows),
        suggestedNextActions: ["review_ambiguous", "accept_match", "create_schedule_row", "remove_or_ignore_schedule_row", "rename_excel_or_schedule_text"],
        scoringConfig: config,
    }, {
        action: "reconcile_schedule_excel",
        partial: false,
        scanStoppedReason: "completed",
        elapsedMs: Date.now() - startedAtMs,
        summary,
        evidenceRows: reviewRows.map((row) => ({
            sourceType: "reconciliationReviewRow",
            bucket: row.bucket,
            score: row.score,
            excelRowId: row.excelRow?.excelRowId ?? row.excelRow?.recordId ?? null,
            scheduleRowId: row.scheduleRow?.scheduleRowId ?? row.scheduleRow?.recordId ?? null,
            reason: row.reason,
        })),
    });
}
export function scoreReconciliationPair(excelRecord, scheduleRecord, rawConfig) {
    return scorePair(normalizeRecord("excel", excelRecord), normalizeRecord("schedule", scheduleRecord), resolveConfig(rawConfig));
}
function buildReviewRows(excelRecords, scheduleRecords, config) {
    const rows = [];
    const coveredExcelIds = new Set();
    const coveredScheduleIds = new Set();
    const duplicateExcelKeys = duplicateKeys(excelRecords);
    const duplicateScheduleKeys = duplicateKeys(scheduleRecords);
    for (const excel of excelRecords) {
        const candidates = buildCandidates(excel, scheduleRecords, config);
        const exactDuplicate = excel.normalizedKey.length > 0 && (duplicateExcelKeys.has(excel.normalizedKey) || duplicateScheduleKeys.has(excel.normalizedKey));
        const top = candidates[0] || null;
        if (exactDuplicate && candidates.some((candidate) => candidate.score === config.score.exact || candidate.schedule.normalizedKey === excel.normalizedKey)) {
            const duplicateCandidates = candidates
                .filter((candidate) => candidate.schedule.normalizedKey === excel.normalizedKey || candidate.score >= config.thresholds.candidateMin)
                .slice(0, 5);
            rows.push(buildReviewRow("ambiguousMatches", duplicateCandidates[0] || null, excel, null, duplicateCandidates, "duplicate_exact_key", "review_ambiguous"));
            coveredExcelIds.add(excel.id);
            duplicateCandidates.forEach((candidate) => coveredScheduleIds.add(candidate.schedule.id));
            continue;
        }
        if (!top || (top.score < config.thresholds.candidateMin && top.hardConflicts.length === 0)) {
            rows.push(buildMissingInScheduleRow(excel));
            coveredExcelIds.add(excel.id);
            continue;
        }
        if (coveredScheduleIds.has(top.schedule.id)) {
            rows.push(buildReviewRow("ambiguousMatches", top, excel, top.schedule, candidates.slice(0, 5), "schedule_row_already_claimed", "review_ambiguous"));
            coveredExcelIds.add(excel.id);
            continue;
        }
        const bucket = classifyCandidate(top, candidates[1] || null, config);
        rows.push(buildReviewRow(bucket.bucket, top, excel, top.schedule, candidates.slice(0, 5), bucket.reason, bucket.action));
        coveredExcelIds.add(excel.id);
        coveredScheduleIds.add(top.schedule.id);
        if (bucket.bucket === "ambiguousMatches") {
            candidates
                .filter((candidate) => candidate.score >= config.thresholds.candidateMin)
                .slice(0, 5)
                .forEach((candidate) => coveredScheduleIds.add(candidate.schedule.id));
        }
    }
    for (const schedule of scheduleRecords) {
        if (!coveredScheduleIds.has(schedule.id)) {
            rows.push(buildMissingInExcelRow(schedule));
        }
    }
    return rows.sort(compareReviewRows);
}
function classifyCandidate(top, second, config) {
    const gap = second ? top.score - second.score : Number.POSITIVE_INFINITY;
    const bestScoreTie = second !== null && top.score === second.score;
    if (bestScoreTie || gap < config.thresholds.tieGap || (top.score >= config.thresholds.ambiguousMin && top.score <= config.thresholds.ambiguousMax)) {
        return { bucket: "ambiguousMatches", reason: bestScoreTie ? "best_score_tie" : gap < config.thresholds.tieGap ? "candidate_gap_below_threshold" : "ambiguous_score_band", action: "review_ambiguous" };
    }
    if (top.components.exact > 0 && top.hardConflicts.length === 0 && top.score === config.score.exact) {
        return { bucket: "exactMatches", reason: "exact_normalized_key", action: "accept_match" };
    }
    const hasRenameSignal = (top.sharedCodeTokens.length > 0 || top.sharedDimensionTokens.length > 0) && top.descriptiveTokensDiffer;
    if (!top.hardConflicts.length && top.score >= config.thresholds.highConfidenceMin && hasRenameSignal) {
        return { bucket: "possibleRenames", reason: "shared_key_tokens_with_description_change", action: "rename_excel_or_schedule_text" };
    }
    if (top.score >= config.thresholds.highConfidenceMin && top.score <= config.thresholds.highConfidenceMax && !top.capped && gap >= config.thresholds.candidateGap) {
        return { bucket: "highConfidenceMatches", reason: "high_confidence_score_and_gap", action: "accept_match" };
    }
    if (!top.hardConflicts.length && ((top.score >= config.thresholds.highConfidenceMin && hasRenameSignal) || (top.score >= config.thresholds.possibleRenameMin && top.score <= config.thresholds.possibleRenameMax))) {
        return { bucket: "possibleRenames", reason: hasRenameSignal ? "shared_key_tokens_with_description_change" : "possible_rename_score_band", action: "rename_excel_or_schedule_text" };
    }
    return { bucket: "ambiguousMatches", reason: top.hardConflicts.length > 0 ? "hard_conflict_requires_review" : "requires_review", action: "review_ambiguous" };
}
function buildCandidates(excel, scheduleRecords, config) {
    return scheduleRecords
        .filter((schedule) => shouldGenerateCandidate(excel, schedule, config))
        .map((schedule) => ({ ...scorePair(excel, schedule, config), excel, schedule }))
        .sort(compareCandidates);
}
function shouldGenerateCandidate(excel, schedule, config) {
    if (excel.normalizedKey.length > 0 && excel.normalizedKey === schedule.normalizedKey) {
        return true;
    }
    if (intersect(tokenValues(excel, "code"), tokenValues(schedule, "code")).length > 0) {
        return true;
    }
    if (intersect(tokenValues(excel, "dimension"), tokenValues(schedule, "dimension")).length > 0) {
        return true;
    }
    return intersect(tokenValues(excel, "word"), tokenValues(schedule, "word")).length >= config.candidateGeneration.minSharedSignificantWordTokens;
}
function scorePair(excel, schedule, config) {
    const exact = excel.normalizedKey.length > 0 && excel.normalizedKey === schedule.normalizedKey;
    const excelTokenValues = unique(excel.tokenProfile.tokens.map((token) => token.value));
    const scheduleTokenValues = unique(schedule.tokenProfile.tokens.map((token) => token.value));
    const matchedTokens = intersect(excelTokenValues, scheduleTokenValues);
    const differingTokens = unique(excelTokenValues.concat(scheduleTokenValues).filter((token) => !matchedTokens.includes(token)));
    const sharedCodeTokens = intersect(tokenValues(excel, "code"), tokenValues(schedule, "code"));
    const sharedDimensionTokens = intersect(tokenValues(excel, "dimension"), tokenValues(schedule, "dimension"));
    const hardConflicts = hardConflictsFor(excel, schedule);
    const components = {
        exact: exact ? config.score.exact : 0,
        dice: exact ? 0 : roundScore(diceCoefficient(excelTokenValues, scheduleTokenValues) * config.score.diceTokenOverlap),
        code: exact ? 0 : proportionalTokenScore(tokenValues(excel, "code"), tokenValues(schedule, "code"), config.score.code),
        dimension: exact ? 0 : proportionalTokenScore(tokenValues(excel, "dimension"), tokenValues(schedule, "dimension"), config.score.dimension),
        order: exact ? 0 : roundScore(orderContinuity(excelTokenValues, scheduleTokenValues) * config.score.order),
        context: exact ? 0 : contextScore(excel, schedule, config),
    };
    const rawScore = exact ? config.score.exact : clampScore(components.dice + components.code + components.dimension + components.order + components.context);
    let score = rawScore;
    for (const conflict of hardConflicts) {
        if (conflict === "conflicting_code")
            score = Math.min(score, config.caps.conflictingCode);
        if (conflict === "conflicting_dimension")
            score = Math.min(score, config.caps.conflictingDimension);
        if (conflict === "unit_mismatch")
            score = Math.min(score, config.caps.unitMismatch);
    }
    return {
        score: clampScore(score),
        rawScore: clampScore(rawScore),
        components,
        matchedTokens,
        differingTokens,
        hardConflicts,
        sharedCodeTokens,
        sharedDimensionTokens,
        descriptiveTokensDiffer: descriptiveTokensDiffer(excel, schedule),
        capped: score < rawScore,
    };
}
function hardConflictsFor(excel, schedule) {
    const conflicts = [];
    const excelCodes = tokenValues(excel, "code");
    const scheduleCodes = tokenValues(schedule, "code");
    if (excelCodes.length > 0 && scheduleCodes.length > 0 && intersect(excelCodes, scheduleCodes).length === 0) {
        conflicts.push("conflicting_code");
    }
    const excelDimensions = tokenValues(excel, "dimension");
    const scheduleDimensions = tokenValues(schedule, "dimension");
    if (excelDimensions.length > 0 && scheduleDimensions.length > 0 && intersect(excelDimensions, scheduleDimensions).length === 0) {
        conflicts.push("conflicting_dimension");
    }
    const excelUnits = unitValues(excel);
    const scheduleUnits = unitValues(schedule);
    if (excelUnits.length > 0 && scheduleUnits.length > 0 && intersect(excelUnits, scheduleUnits).length === 0) {
        conflicts.push("unit_mismatch");
    }
    return conflicts;
}
function buildReviewRow(bucket, candidate, excel, schedule, candidateRows, reason, recommendedNextAction) {
    return {
        bucket,
        score: candidate?.score ?? 0,
        rawScore: candidate?.rawScore ?? 0,
        reason,
        matchedTokens: candidate?.matchedTokens ?? [],
        differingTokens: candidate?.differingTokens ?? [],
        hardConflicts: candidate?.hardConflicts ?? [],
        scoreComponents: candidate?.components ?? null,
        excelRow: excel ? publicRecord(excel) : null,
        scheduleRow: schedule ? publicRecord(schedule) : null,
        candidateRows: candidateRows.map((item) => ({
            score: item.score,
            rawScore: item.rawScore,
            scheduleRow: publicRecord(item.schedule),
            matchedTokens: item.matchedTokens,
            hardConflicts: item.hardConflicts,
        })),
        recommendedNextAction,
    };
}
function buildMissingInScheduleRow(excel) {
    return {
        bucket: "missingInSchedule",
        score: 0,
        rawScore: 0,
        reason: "no_schedule_candidate_at_threshold",
        matchedTokens: [],
        differingTokens: excel.tokenProfile.tokens.map((token) => token.value),
        hardConflicts: [],
        scoreComponents: null,
        excelRow: publicRecord(excel),
        scheduleRow: null,
        candidateRows: [],
        recommendedNextAction: "create_schedule_row",
    };
}
function buildMissingInExcelRow(schedule) {
    return {
        bucket: "missingInExcel",
        score: 0,
        rawScore: 0,
        reason: "no_excel_candidate_at_threshold",
        matchedTokens: [],
        differingTokens: schedule.tokenProfile.tokens.map((token) => token.value),
        hardConflicts: [],
        scoreComponents: null,
        excelRow: null,
        scheduleRow: publicRecord(schedule),
        candidateRows: [],
        recommendedNextAction: "remove_or_ignore_schedule_row",
    };
}
function publicRecord(record) {
    return {
        ...record.raw,
        recordId: record.id,
        normalizedKey: record.normalizedKey,
        tokenProfile: record.tokenProfile,
    };
}
function extractRecords(side, records) {
    return Array.isArray(records)
        ? records
            .filter((record) => Boolean(record) && typeof record === "object" && !Array.isArray(record))
            .map((record, index) => normalizeRecord(side, record, index))
        : [];
}
function normalizeRecord(side, record, index = 0) {
    const id = side === "excel"
        ? cleanReconciliationText(record.excelRowId || record.recordId || record.id)
        : cleanReconciliationText(record.scheduleRowId || record.recordId || record.id);
    const mappedValues = isObject(record.mappedValues) ? record.mappedValues : {};
    const tokenProfile = normalizeTokenProfile(record, [record.identityText, record.comparisonText]);
    return {
        side,
        id: id || `${side}:${tokenProfile.normalizedKey || "row"}:${index}`,
        normalizedKey: cleanReconciliationText(record.normalizedKey) || tokenProfile.normalizedKey,
        tokenProfile,
        raw: record,
        mappedValues,
    };
}
function normalizeTokenProfile(record, fallbackParts) {
    const rawProfile = isObject(record.tokenProfile) ? record.tokenProfile : null;
    if (rawProfile && Array.isArray(rawProfile.tokens) && typeof rawProfile.normalizedKey === "string") {
        return {
            profileVersion: 1,
            normalizedKey: cleanReconciliationText(rawProfile.normalizedKey),
            tokens: rawProfile.tokens
                .filter((token) => isObject(token) && typeof token.type === "string" && typeof token.value === "string")
                .map((token) => ({ type: token.type, value: cleanReconciliationText(token.value) }))
                .filter((token) => token.value.length > 0),
        };
    }
    return buildReconciliationTokenProfile(fallbackParts);
}
function getArray(source, field) {
    return isObject(source) && Array.isArray(source[field])
        ? source[field].filter((item) => isObject(item))
        : [];
}
function resolveConfig(rawConfig) {
    const parsed = reconciliationConfigSchema.safeParse(rawConfig || {});
    const input = parsed.success ? parsed.data : {};
    return {
        score: { ...DEFAULT_RECONCILIATION_CONFIG.score, ...(input.score || {}) },
        thresholds: { ...DEFAULT_RECONCILIATION_CONFIG.thresholds, ...(input.thresholds || {}) },
        caps: { ...DEFAULT_RECONCILIATION_CONFIG.caps, ...(input.caps || {}) },
        candidateGeneration: { ...DEFAULT_RECONCILIATION_CONFIG.candidateGeneration, ...(input.candidateGeneration || {}) },
        contextFields: input.contextFields || DEFAULT_RECONCILIATION_CONFIG.contextFields,
    };
}
function buildSummary(excelRecords, scheduleRecords, reviewRows) {
    const counts = Object.fromEntries(["exactMatches", "highConfidenceMatches", "possibleRenames", "ambiguousMatches", "missingInSchedule", "missingInExcel"].map((bucket) => [bucket, 0]));
    for (const row of reviewRows) {
        counts[row.bucket] = (counts[row.bucket] || 0) + 1;
    }
    return {
        excelRows: excelRecords.length,
        scheduleRows: scheduleRecords.length,
        ...counts,
        reviewRowCount: reviewRows.length,
    };
}
function buildReviewTable(reviewRows) {
    const columns = [
        { key: "bucket", label: "Bucket" },
        { key: "score", label: "Score" },
        { key: "reason", label: "Reason" },
        { key: "excelRowId", label: "Excel Row" },
        { key: "scheduleRowId", label: "Schedule Row" },
        { key: "excelText", label: "Excel Text" },
        { key: "scheduleText", label: "Schedule Text" },
        { key: "hardConflicts", label: "Hard Conflicts" },
        { key: "recommendedNextAction", label: "Recommended Action" },
    ];
    return {
        columns,
        rows: reviewRows.map((row) => ({
            bucket: row.bucket,
            score: row.score,
            reason: row.reason,
            excelRowId: row.excelRow?.excelRowId ?? row.excelRow?.recordId ?? "",
            scheduleRowId: row.scheduleRow?.scheduleRowId ?? row.scheduleRow?.recordId ?? "",
            excelText: row.excelRow ? [row.excelRow.identityText, row.excelRow.comparisonText].filter(Boolean).join(" | ") : "",
            scheduleText: row.scheduleRow ? [row.scheduleRow.identityText, row.scheduleRow.comparisonText].filter(Boolean).join(" | ") : "",
            hardConflicts: (row.hardConflicts || []).join(", "),
            recommendedNextAction: row.recommendedNextAction,
        })),
    };
}
function tokenValues(record, type) {
    return unique(record.tokenProfile.tokens.filter((token) => token.type === type).map((token) => token.value));
}
function unitValues(record) {
    const values = tokenValues(record, "unit");
    for (const dimension of tokenValues(record, "dimension")) {
        const unit = dimension.match(/^[A-Z]+|[A-Z]+$/)?.[0];
        if (unit)
            values.push(unit);
    }
    const mappedUnit = normalizeReconciliationText(record.mappedValues.unit);
    if (mappedUnit)
        values.push(mappedUnit);
    return unique(values);
}
function proportionalTokenScore(left, right, maxScore) {
    if (left.length === 0 || right.length === 0) {
        return 0;
    }
    const shared = intersect(left, right).length;
    const denominator = Math.max(left.length, right.length);
    return roundScore((shared / denominator) * maxScore);
}
function contextScore(excel, schedule, config) {
    const comparable = config.contextFields
        .map((field) => [normalizeReconciliationText(excel.mappedValues[field]), normalizeReconciliationText(schedule.mappedValues[field])])
        .filter(([left, right]) => left.length > 0 && right.length > 0);
    if (comparable.length === 0) {
        return 0;
    }
    const matches = comparable.filter(([left, right]) => left === right).length;
    return roundScore((matches / comparable.length) * config.score.context);
}
function diceCoefficient(left, right) {
    if (left.length === 0 && right.length === 0) {
        return 1;
    }
    if (left.length === 0 || right.length === 0) {
        return 0;
    }
    return (2 * intersect(left, right).length) / (left.length + right.length);
}
function orderContinuity(left, right) {
    const minLength = Math.min(left.length, right.length);
    if (minLength === 0) {
        return 0;
    }
    return longestCommonSubsequenceLength(left, right) / minLength;
}
function longestCommonSubsequenceLength(left, right) {
    const table = Array.from({ length: left.length + 1 }, () => Array(right.length + 1).fill(0));
    for (let row = 1; row <= left.length; row++) {
        for (let column = 1; column <= right.length; column++) {
            table[row][column] = left[row - 1] === right[column - 1]
                ? table[row - 1][column - 1] + 1
                : Math.max(table[row - 1][column], table[row][column - 1]);
        }
    }
    return table[left.length][right.length];
}
function descriptiveTokensDiffer(excel, schedule) {
    const left = tokenValues(excel, "word");
    const right = tokenValues(schedule, "word");
    return left.length > 0 && right.length > 0 && !sameSet(left, right);
}
function duplicateKeys(records) {
    const counts = new Map();
    for (const record of records) {
        if (record.normalizedKey.length > 0) {
            counts.set(record.normalizedKey, (counts.get(record.normalizedKey) || 0) + 1);
        }
    }
    return new Set([...counts.entries()].filter(([, count]) => count > 1).map(([key]) => key));
}
function compareCandidates(left, right) {
    if (right.score !== left.score)
        return right.score - left.score;
    return left.schedule.id.localeCompare(right.schedule.id);
}
function compareReviewRows(left, right) {
    const bucketOrder = {
        exactMatches: 0,
        highConfidenceMatches: 1,
        possibleRenames: 2,
        ambiguousMatches: 3,
        missingInSchedule: 4,
        missingInExcel: 5,
    };
    const leftBucket = bucketOrder[left.bucket] ?? 99;
    const rightBucket = bucketOrder[right.bucket] ?? 99;
    if (leftBucket !== rightBucket)
        return leftBucket - rightBucket;
    if ((right.score || 0) !== (left.score || 0))
        return (right.score || 0) - (left.score || 0);
    const leftId = left.excelRow?.recordId || left.scheduleRow?.recordId || "";
    const rightId = right.excelRow?.recordId || right.scheduleRow?.recordId || "";
    return String(leftId).localeCompare(String(rightId));
}
function intersect(left, right) {
    const rightSet = new Set(right);
    return unique(left.filter((item) => rightSet.has(item)));
}
function unique(values) {
    return [...new Set(values.filter((value) => cleanReconciliationText(value).length > 0))];
}
function sameSet(left, right) {
    const leftSet = new Set(left);
    const rightSet = new Set(right);
    if (leftSet.size !== rightSet.size)
        return false;
    return [...leftSet].every((value) => rightSet.has(value));
}
function roundScore(value) {
    return Math.round(value);
}
function clampScore(value) {
    return Math.max(0, Math.min(100, Math.round(value)));
}
function isObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
