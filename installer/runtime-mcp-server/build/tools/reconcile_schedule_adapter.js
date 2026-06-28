import { z } from "zod";
import { buildBroadScanFailureResult, buildBroadScanGuardedResult, normalizeBroadScanResult, normalizeBroadScanStopReason, readNativeResultArray, readNativeResultField, } from "../utils/broadScanResult.js";
import { sendRevitCommand } from "../utils/revitToolHelpers.js";
import { normalizeScheduleResult } from "./inspect_schedules.js";
import { buildReconciliationTokenProfile, cleanReconciliationText, normalizeReconciliationAlias, normalizeReconciliationHeader, RECONCILIATION_ALL_ROLES, RECONCILIATION_REQUIRED_ROLES, RECONCILIATION_ROLE_ALIASES, } from "./reconcile_normalization.js";
const ACTION = "reconcile_schedule_records";
const ADAPTER_STAGE = "schedule_record_adapter";
const VISIBILITY_BASIS = "displayedScheduleCells";
const DEFAULT_SECTIONS = ["body"];
const ALL_ROLES = RECONCILIATION_ALL_ROLES;
const REQUIRED_ROLES = RECONCILIATION_REQUIRED_ROLES;
const ROLE_ALIASES = RECONCILIATION_ROLE_ALIASES;
const columnHeaderObjectSchema = z.object({
    column: z.number().int().nonnegative(),
    header: z.string().min(1),
}).strict();
const columnHeadersSchema = z.union([
    z.array(z.string()),
    z.array(columnHeaderObjectSchema),
    z.record(z.union([z.string().min(1), z.number().int().nonnegative()])),
]);
const headerDataModeSchema = z.enum(["auto", "always", "never"]);
export const scheduleColumnMappingSchema = z.object({
    identity: z.union([z.string().min(1), z.number().int().nonnegative()]).optional(),
    comparisonText: z.union([z.string().min(1), z.number().int().nonnegative()]).optional(),
    code: z.union([z.string().min(1), z.number().int().nonnegative()]).optional(),
    description: z.union([z.string().min(1), z.number().int().nonnegative()]).optional(),
    quantity: z.union([z.string().min(1), z.number().int().nonnegative()]).optional(),
    unit: z.union([z.string().min(1), z.number().int().nonnegative()]).optional(),
    system: z.union([z.string().min(1), z.number().int().nonnegative()]).optional(),
    discipline: z.union([z.string().min(1), z.number().int().nonnegative()]).optional(),
    notes: z.union([z.string().min(1), z.number().int().nonnegative()]).optional(),
}).strict();
export const inspectSchedulesResultSourceSchema = z.object({
    kind: z.literal("inspect_schedules_result"),
    result: z.record(z.unknown()),
    columnMapping: scheduleColumnMappingSchema.optional(),
    columnHeaders: columnHeadersSchema.optional(),
    sections: z.array(z.enum(["header", "body", "footer"])).optional(),
    headerDataMode: headerDataModeSchema.optional(),
}).strict();
export const revitScheduleSourceSchema = z.object({
    kind: z.literal("revit_schedule"),
    scheduleIds: z.array(z.union([z.number().int().positive(), z.string().min(1)])).optional(),
    nameQuery: z.string().min(1).optional(),
    sections: z.array(z.enum(["header", "body", "footer"])).optional(),
    columnMapping: scheduleColumnMappingSchema.optional(),
    columnHeaders: columnHeadersSchema.optional(),
    headerDataMode: headerDataModeSchema.optional(),
    target: z.string().optional(),
    host: z.string().optional(),
    port: z.number().int().positive().max(65535).optional(),
    taskName: z.string().optional(),
    taskId: z.string().optional(),
    parentTaskName: z.string().optional(),
    parentTaskId: z.string().optional(),
    allowExpensiveSearch: z.boolean().optional(),
    searchBudget: z.enum(["fast", "balanced", "deep"]).optional(),
    maxElapsedMs: z.number().int().positive().max(119000).optional(),
    maxSchedules: z.number().int().positive().max(200).optional(),
    maxRowsPerSection: z.number().int().min(0).max(1000).optional(),
    maxColumnsPerSection: z.number().int().min(0).max(200).optional(),
    startRow: z.number().int().min(0).max(100000).optional(),
    startColumn: z.number().int().min(0).max(10000).optional(),
    maxCells: z.number().int().positive().max(500000).optional(),
    maxResponseBytes: z.number().int().min(4096).max(16 * 1024 * 1024).optional(),
    maxCellTextChars: z.number().int().min(20).max(1000).optional(),
    timeoutMs: z.number().int().positive().max(120000).optional(),
}).strict();
export const scheduleAdapterSourceSchema = z.discriminatedUnion("kind", [
    inspectSchedulesResultSourceSchema,
    revitScheduleSourceSchema,
]);
export async function adaptScheduleSource(rawInput, options = {}) {
    const startedAtMs = Date.now();
    const parsed = scheduleAdapterSourceSchema.safeParse(rawInput);
    if (!parsed.success) {
        return buildGuardedResult("needs_scope", "Schedule adapter input failed schema validation.", {
            validationIssues: parsed.error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`),
            elapsedMs: Date.now() - startedAtMs,
            suggestedNextScopes: ["schedule.kind", "schedule.result", "schedule.columnMapping.identity", "schedule.columnMapping.comparisonText"],
        });
    }
    if (parsed.data.kind === "revit_schedule") {
        return adaptLiveRevitScheduleSource(parsed.data, startedAtMs, options);
    }
    return adaptInspectSchedulesResult(parsed.data, Date.now() - startedAtMs);
}
async function adaptLiveRevitScheduleSource(source, startedAtMs, options) {
    const hasScheduleScope = Boolean((Array.isArray(source.scheduleIds) && source.scheduleIds.length > 0) ||
        String(source.nameQuery || "").trim());
    if (!hasScheduleScope && source.allowExpensiveSearch !== true) {
        return buildGuardedResult("needs_scope", "Direct live schedule reconciliation requires scheduleIds or nameQuery. Set allowExpensiveSearch=true only when a broad schedule scan is intentional.", {
            sourceKind: source.kind,
            elapsedMs: Date.now() - startedAtMs,
            suggestedNextScopes: ["schedule.scheduleIds", "schedule.nameQuery", "schedule.allowExpensiveSearch=true"],
            scanPolicy: {
                sourceKind: source.kind,
                bridgeExecution: "inspect_schedules",
                scheduleIds: [],
                nameQuery: null,
                allowExpensiveSearch: false,
                visibilityBasis: VISIBILITY_BASIS,
            },
        });
    }
    const adapterSections = normalizeSections(source.sections);
    const inspectSections = ["header", ...adapterSections.filter((section) => section !== "header")];
    const inspectArgs = {
        query: source.nameQuery,
        nameQuery: source.nameQuery,
        scheduleIds: source.scheduleIds,
        sections: inspectSections,
        includeCells: true,
        scanCells: false,
        allowExpensiveSearch: source.allowExpensiveSearch,
        searchBudget: source.searchBudget,
        maxElapsedMs: source.maxElapsedMs,
        maxSchedules: source.maxSchedules,
        maxRowsPerSection: source.maxRowsPerSection,
        maxColumnsPerSection: source.maxColumnsPerSection,
        startRow: source.startRow,
        startColumn: source.startColumn,
        maxCells: source.maxCells,
        maxResponseBytes: source.maxResponseBytes,
        maxCellTextChars: source.maxCellTextChars,
        responseMode: "full",
        timeoutMs: source.timeoutMs,
        taskName: source.taskName || "Inspect live Revit schedule for reconciliation",
        taskId: source.taskId,
        parentTaskName: source.parentTaskName,
        parentTaskId: source.parentTaskId,
    };
    const sendCommand = options.sendCommand || sendRevitCommand;
    const response = await sendCommand("inspect_schedules", inspectArgs, {
        target: source.target,
        host: source.host,
        port: source.port,
        timeoutMs: source.timeoutMs,
        taskName: inspectArgs.taskName,
        taskId: source.taskId,
        parentTaskName: source.parentTaskName,
        parentTaskId: source.parentTaskId,
        toolName: "reconcile_schedule_excel",
    });
    const elapsedMs = Date.now() - startedAtMs;
    const inspectPayload = normalizeScheduleResult(response && response.result ? response.result : response, inspectArgs, elapsedMs);
    const adapted = adaptInspectSchedulesResult({
        kind: "inspect_schedules_result",
        result: inspectPayload,
        columnMapping: source.columnMapping,
        columnHeaders: source.columnHeaders,
        sections: source.sections,
        headerDataMode: source.headerDataMode,
    }, elapsedMs);
    adapted.sourceKind = "revit_schedule";
    adapted.bridgeSourceKind = "inspect_schedules_result";
    adapted.scanPolicy = {
        ...(adapted.scanPolicy || {}),
        sourceKind: "revit_schedule",
        bridgeExecution: "inspect_schedules",
        inspectSections,
        scheduleIds: source.scheduleIds || [],
        nameQuery: source.nameQuery || null,
        allowExpensiveSearch: source.allowExpensiveSearch === true,
    };
    adapted.notices = [
        ...readNativeStringArray(adapted, "notices"),
        "Live Revit schedule input was read through bounded inspect_schedules before reconciliation.",
    ];
    return adapted;
}
function adaptInspectSchedulesResult(source, elapsedMs) {
    const payload = source.result;
    const inputState = cleanReconciliationText(readNativeResultField(payload, "state")).toLowerCase();
    if (readNativeResultField(payload, "success") === false || inputState === "failed" || readNativeResultField(payload, "error")) {
        return buildFailureResult(cleanReconciliationText(readNativeResultField(payload, "error")) || "inspect_schedules_result failed before schedule adaptation.", {
            sourceKind: source.kind,
            elapsedMs,
            warnings: readNativeStringArray(payload, "warnings"),
            notices: readNativeStringArray(payload, "notices"),
        });
    }
    if (readNativeResultField(payload, "guarded") === true) {
        return buildGuardedResult(cleanReconciliationText(readNativeResultField(payload, "reason")) || "needs_scope", "inspect_schedules_result was guarded before schedule adaptation.", {
            sourceKind: source.kind,
            elapsedMs,
            warnings: readNativeStringArray(payload, "warnings"),
            notices: readNativeStringArray(payload, "notices"),
            summary: readNativeResultField(payload, "summary") || {},
            suggestedNextScopes: ["inspect_schedules responseMode=\"full\"", "schedule.result", "schedule.columnMapping.identity", "schedule.columnMapping.comparisonText"],
        });
    }
    const sections = normalizeSections(source.sections);
    const explicitSections = Array.isArray(source.sections) && source.sections.length > 0;
    const headerDataMode = normalizeHeaderDataMode(source.headerDataMode);
    const schedules = readNativeResultArray(payload, "schedules");
    const warnings = readNativeStringArray(payload, "warnings");
    const notices = readNativeStringArray(payload, "notices");
    const records = [];
    let scannedRows = 0;
    let scannedCells = 0;
    let skippedHeaderLikeRows = 0;
    let headerAsDataScheduleCount = 0;
    let headerAsDataRows = 0;
    for (const schedule of schedules) {
        const scheduleId = stringifyId(readNativeResultField(schedule, "id"));
        if (!scheduleId) {
            warnings.push("Skipped a schedule without id while adapting schedule records.");
            continue;
        }
        const scheduleName = cleanOrNull(readNativeResultField(schedule, "name"));
        const headerLabels = extractHeaderLabels(schedule, source.columnHeaders);
        const resolvedMapping = resolveColumnMapping(headerLabels, source.columnMapping);
        if ("error" in resolvedMapping) {
            return buildGuardedResult("schedule_column_mapping_required", "Resolve identity and comparisonText schedule column mapping before adaptation.", {
                sourceKind: source.kind,
                scheduleId,
                scheduleName,
                mappingError: resolvedMapping.error,
                summary: {
                    scheduleId,
                    scheduleName,
                    headers: headerLabels.map((label) => ({ column: label.column, header: label.header })),
                },
                scanPolicy: buildScanPolicy(source, sections),
                suggestedNextScopes: ["schedule.columnMapping.identity", "schedule.columnMapping.comparisonText", "inspect_schedules responseMode=\"full\""],
                warnings,
                notices,
            });
        }
        const sectionPlan = resolveScheduleDataSections(schedule, sections, explicitSections, headerDataMode);
        if (sectionPlan.headerAsData) {
            headerAsDataScheduleCount++;
        }
        for (const section of readNativeResultArray(schedule, "sections")) {
            const sectionName = normalizeSectionName(readNativeResultField(section, "section"));
            if (!sectionPlan.sections.includes(sectionName)) {
                continue;
            }
            const readingHeaderAsData = sectionName === "header" && sectionPlan.headerAsData;
            for (const row of readSectionRows(section, scheduleId, scheduleName, sectionName)) {
                scannedRows++;
                scannedCells += row.cells.length;
                if (readingHeaderAsData && isScheduleTitleRow(row, scheduleName)) {
                    skippedHeaderLikeRows++;
                    continue;
                }
                if (sectionName === "body" && isHeaderLikeBodyRow(row, resolvedMapping.mapping, headerLabels, { matchSameColumnHeader: true })) {
                    skippedHeaderLikeRows++;
                    continue;
                }
                if (readingHeaderAsData && isHeaderLikeBodyRow(row, resolvedMapping.mapping, headerLabels, { matchSameColumnHeader: false })) {
                    skippedHeaderLikeRows++;
                    continue;
                }
                const record = buildScheduleRecord(row, resolvedMapping.mapping);
                if (record) {
                    if (readingHeaderAsData) {
                        headerAsDataRows++;
                    }
                    records.push(record);
                }
            }
        }
    }
    const partial = readNativeResultField(payload, "partial") === true;
    const scanStoppedReason = normalizeBroadScanStopReason(readNativeResultField(payload, "scanStoppedReason"), partial ? "max_items" : "completed");
    const lastRecord = records.length > 0 ? records[records.length - 1] : null;
    return normalizeBroadScanResult({
        success: true,
        guarded: false,
        state: "completed",
        action: ACTION,
        stage: ADAPTER_STAGE,
        adapterContractVersion: 1,
        sourceKind: source.kind,
        visibilityBasis: VISIBILITY_BASIS,
        scheduleRecords: records,
        partial,
        scanStoppedReason,
        elapsedMs,
    }, {
        action: ACTION,
        partial,
        scanStoppedReason,
        elapsedMs,
        scanPolicy: buildScanPolicy(source, sections),
        summary: {
            sourceKind: source.kind,
            scheduleCount: schedules.length,
            scannedRows,
            scannedCells,
            skippedHeaderLikeRows,
            headerAsDataScheduleCount,
            headerAsDataRows,
            scheduleRecordCount: records.length,
            visibilityBasis: VISIBILITY_BASIS,
            partial,
            scanStoppedReason,
        },
        evidenceRows: records.map((record) => ({
            sourceType: "scheduleRecord",
            scheduleRowId: record.scheduleRowId,
            scheduleId: record.scheduleId,
            scheduleName: record.scheduleName,
            section: record.section,
            row: record.row,
            identityText: record.identityText,
            comparisonText: record.comparisonText,
            normalizedKey: record.normalizedKey,
            visibilityBasis: VISIBILITY_BASIS,
        })),
        warnings,
        notices: [
            ...notices,
            ...(headerAsDataScheduleCount > 0
                ? [`Read Header section rows as schedule data for ${headerAsDataScheduleCount} schedule(s).`]
                : []),
            ...(skippedHeaderLikeRows > 0
                ? [`Skipped ${skippedHeaderLikeRows} header-like schedule row(s) during schedule adaptation.`]
                : []),
        ],
        lastRead: {
            lastReadSection: readNativeResultField(payload, "lastReadSection") ?? lastRecord?.section ?? null,
            lastReadRow: readNativeResultField(payload, "lastReadRow") ?? lastRecord?.row ?? null,
            lastReadColumn: readNativeResultField(payload, "lastReadColumn") ?? null,
            lastReadItemId: readNativeResultField(payload, "lastReadItemId") ?? lastRecord?.scheduleRowId ?? null,
        },
    });
}
function isHeaderLikeBodyRow(row, mapping, headerLabels, options) {
    const byColumn = new Map();
    for (const cell of row.cells) {
        byColumn.set(cell.column, cell.text);
    }
    const requiredMappedRoles = REQUIRED_ROLES.filter((role) => typeof mapping[role] === "number");
    if (requiredMappedRoles.length === 0) {
        return false;
    }
    const rolesByColumn = new Map();
    for (const role of requiredMappedRoles) {
        const column = mapping[role];
        if (typeof column === "number") {
            rolesByColumn.set(column, [...(rolesByColumn.get(column) || []), role]);
        }
    }
    return [...rolesByColumn.entries()].every(([column, roles]) => {
        const text = cleanReconciliationText(byColumn.get(column));
        if (!text) {
            return false;
        }
        const normalizedText = normalizeReconciliationHeader(text);
        const sameColumnHeader = options.matchSameColumnHeader && headerLabels.some((label) => label.column === column && normalizeReconciliationHeader(label.header) === normalizedText);
        if (sameColumnHeader) {
            return true;
        }
        return roles.some((role) => {
            if (Number.isFinite(getAliasPriority(role, text))) {
                return true;
            }
            if (role === "identity" && ["number", "no", "numara"].includes(normalizedText)) {
                return true;
            }
            return role === "comparisonText" && ["name", "description", "desc", "text", "aciklama"].includes(normalizedText);
        });
    });
}
function isScheduleTitleRow(row, scheduleName) {
    const normalizedScheduleName = normalizeReconciliationHeader(scheduleName || "");
    if (!normalizedScheduleName) {
        return false;
    }
    const nonEmptyCells = row.cells
        .map((cell) => normalizeReconciliationHeader(cell.text))
        .filter((text) => text.length > 0);
    return nonEmptyCells.length === 1 && nonEmptyCells[0] === normalizedScheduleName;
}
function buildScheduleRecord(row, mapping) {
    const byColumn = new Map();
    for (const cell of row.cells) {
        byColumn.set(cell.column, cell.text);
    }
    const mappedValues = {};
    for (const role of ALL_ROLES) {
        const column = mapping[role];
        if (typeof column === "number") {
            mappedValues[role] = cleanReconciliationText(byColumn.get(column));
        }
    }
    const identityText = cleanReconciliationText(mappedValues.identity);
    const comparisonText = cleanReconciliationText(mappedValues.comparisonText);
    if (!identityText && !comparisonText) {
        return null;
    }
    const tokenProfile = buildReconciliationTokenProfile([identityText, comparisonText]);
    return {
        scheduleRowId: `${row.scheduleId}:${row.section}:${row.row}`,
        scheduleId: row.scheduleId,
        scheduleName: row.scheduleName,
        section: row.section,
        row: row.row,
        rawCells: row.cells.map((cell) => ({ column: cell.column, text: cell.text })),
        mappedValues,
        identityText,
        comparisonText,
        normalizedKey: tokenProfile.normalizedKey,
        tokenProfile,
        visibilityBasis: VISIBILITY_BASIS,
    };
}
function readSectionRows(section, scheduleId, scheduleName, sectionName) {
    const rowObjects = readNativeResultArray(section, "rows");
    const compatibleCellRows = readNativeResultArray(section, "cells");
    const rows = rowObjects.length > 0 ? rowObjects : compatibleCellRows;
    return rows.flatMap((rowObject) => {
        const row = finiteNumberOrNull(readNativeResultField(rowObject, "row"));
        if (row === null) {
            return [];
        }
        const cells = readNativeResultArray(rowObject, "cells")
            .map((cell) => ({
            column: finiteNumberOrNull(readNativeResultField(cell, "column")),
            text: cleanReconciliationText(readNativeResultField(cell, "text")),
        }))
            .filter((cell) => cell.column !== null);
        return [{ scheduleId, scheduleName, section: sectionName, row, cells }];
    });
}
function resolveScheduleDataSections(schedule, sections, explicitSections, headerDataMode) {
    const includesHeader = sections.includes("header");
    if (includesHeader) {
        return { sections, headerAsData: true };
    }
    if (headerDataMode === "never") {
        return { sections, headerAsData: false };
    }
    const hasHeaderRows = hasReadableRowsInSections(schedule, ["header"]);
    if (!hasHeaderRows) {
        return { sections, headerAsData: false };
    }
    if (headerDataMode === "always") {
        return { sections: [...sections, "header"], headerAsData: true };
    }
    if (!explicitSections && !hasReadableRowsInSections(schedule, sections)) {
        return { sections: [...sections, "header"], headerAsData: true };
    }
    return { sections, headerAsData: false };
}
function hasReadableRowsInSections(schedule, sections) {
    const scheduleId = stringifyId(readNativeResultField(schedule, "id")) || "unknown";
    const scheduleName = cleanOrNull(readNativeResultField(schedule, "name"));
    for (const section of readNativeResultArray(schedule, "sections")) {
        const sectionName = normalizeSectionName(readNativeResultField(section, "section"));
        if (!sections.includes(sectionName)) {
            continue;
        }
        if (readSectionRows(section, scheduleId, scheduleName, sectionName).some((row) => row.cells.length > 0)) {
            return true;
        }
    }
    return false;
}
function extractHeaderLabels(schedule, fallbackHeaders) {
    const labels = [];
    const seen = new Set();
    const addLabel = (column, header) => {
        const cleanHeader = cleanReconciliationText(header);
        if (cleanHeader.length === 0) {
            return;
        }
        const key = `${column}:${normalizeReconciliationHeader(cleanHeader)}`;
        if (seen.has(key)) {
            return;
        }
        seen.add(key);
        labels.push({ column, header: cleanHeader });
    };
    for (const label of extractNativeFieldHeaderLabels(schedule)) {
        addLabel(label.column, label.header);
    }
    for (const section of readNativeResultArray(schedule, "sections")) {
        if (normalizeSectionName(readNativeResultField(section, "section")) !== "header") {
            continue;
        }
        for (const row of readSectionRows(section, stringifyId(readNativeResultField(schedule, "id")) || "unknown", cleanOrNull(readNativeResultField(schedule, "name")), "header")) {
            for (const cell of row.cells) {
                addLabel(cell.column, cell.text);
            }
        }
    }
    for (const label of normalizeFallbackHeaderLabels(fallbackHeaders)) {
        addLabel(label.column, label.header);
    }
    return labels.sort((left, right) => left.column - right.column);
}
function extractNativeFieldHeaderLabels(schedule) {
    const labels = [];
    const addLabel = (column, header) => {
        if (column === null) {
            return;
        }
        const cleanHeader = cleanReconciliationText(header);
        if (cleanHeader.length > 0) {
            labels.push({ column, header: cleanHeader });
        }
    };
    for (const field of readNativeResultArray(schedule, "fields")) {
        if (readNativeResultField(field, "isHidden") === true) {
            continue;
        }
        const column = finiteNumberOrNull(readNativeResultField(field, "column"))
            ?? finiteNumberOrNull(readNativeResultField(field, "visibleColumn"));
        addLabel(column, readNativeResultField(field, "columnHeading"));
        addLabel(column, readNativeResultField(field, "heading"));
        addLabel(column, readNativeResultField(field, "label"));
        addLabel(column, readNativeResultField(field, "name"));
        addLabel(column, readNativeResultField(field, "fieldName"));
        addLabel(column, readNativeResultField(field, "parameterName"));
    }
    return labels;
}
function normalizeFallbackHeaderLabels(fallbackHeaders) {
    if (!fallbackHeaders) {
        return [];
    }
    if (Array.isArray(fallbackHeaders)) {
        return fallbackHeaders
            .map((entry, index) => {
            if (typeof entry === "string") {
                return { column: index, header: cleanReconciliationText(entry) };
            }
            return {
                column: entry.column,
                header: cleanReconciliationText(entry.header),
            };
        })
            .filter((label) => label.header.length > 0);
    }
    const labels = [];
    for (const [rawKey, rawValue] of Object.entries(fallbackHeaders)) {
        const keyAsColumn = finiteNumberOrNull(rawKey);
        if (keyAsColumn !== null && typeof rawValue === "string") {
            const header = cleanReconciliationText(rawValue);
            if (header.length > 0) {
                labels.push({ column: keyAsColumn, header });
            }
            continue;
        }
        if (typeof rawValue === "number") {
            const header = cleanReconciliationText(rawKey);
            if (header.length > 0) {
                labels.push({ column: rawValue, header });
            }
        }
    }
    return labels.sort((left, right) => left.column - right.column);
}
function resolveColumnMapping(headers, explicitMapping) {
    const warnings = [];
    const notices = [];
    const mapping = {};
    const assignedColumns = new Set();
    for (const role of ALL_ROLES) {
        const explicit = explicitMapping?.[role];
        if (explicit !== undefined) {
            const resolved = resolveColumnRef(explicit, headers);
            if (resolved === null) {
                return { error: { role, reason: "unresolved_column_ref", value: explicit } };
            }
            mapping[role] = resolved;
            assignedColumns.add(resolved);
        }
    }
    for (const role of ALL_ROLES) {
        if (mapping[role] !== undefined) {
            continue;
        }
        const matches = findAllColumnAliases(role, headers);
        if (matches.length === 0) {
            continue;
        }
        const selected = selectAliasMatch(matches, assignedColumns);
        if (selected.kind === "ambiguous") {
            return { error: { role, reason: "ambiguous_alias", candidates: selected.candidates } };
        }
        mapping[role] = selected.match.column;
        assignedColumns.add(selected.match.column);
    }
    for (const role of REQUIRED_ROLES) {
        if (mapping[role] === undefined) {
            return { error: { role, reason: "missing_required_role" } };
        }
    }
    return { mapping, warnings, notices };
}
function resolveColumnRef(ref, headers) {
    if (typeof ref === "number") {
        if (headers.length > 0 && !headers.some((item) => item.column === ref)) {
            return null;
        }
        return ref;
    }
    const trimmed = ref.trim();
    const normalized = normalizeReconciliationHeader(trimmed);
    const matches = headers.filter((item) => normalizeReconciliationHeader(item.header) === normalized);
    return matches.length === 1 ? matches[0].column : null;
}
function getAliasPriority(role, header) {
    const normalized = normalizeReconciliationAlias(header);
    const aliases = ROLE_ALIASES[role];
    for (let index = 0; index < aliases.length; index++) {
        if (normalizeReconciliationAlias(aliases[index]) === normalized) {
            return index;
        }
    }
    return Number.POSITIVE_INFINITY;
}
function findAllColumnAliases(role, headers) {
    return headers
        .map((header) => ({ header: header.header, column: header.column, priority: getAliasPriority(role, header.header) }))
        .filter((match) => Number.isFinite(match.priority));
}
function selectAliasMatch(matches, assignedColumns) {
    const unassignedMatches = matches.filter((match) => !assignedColumns.has(match.column));
    const candidates = unassignedMatches.length > 0 ? unassignedMatches : matches;
    const bestPriority = Math.min(...candidates.map((match) => match.priority));
    const bestCandidates = candidates.filter((match) => match.priority === bestPriority);
    if (bestCandidates.length === 1) {
        return { kind: "resolved", match: bestCandidates[0] };
    }
    const bestColumns = [...new Set(bestCandidates.map((match) => match.column))];
    if (bestColumns.length === 1) {
        return { kind: "resolved", match: bestCandidates[0] };
    }
    return { kind: "ambiguous", candidates: bestCandidates.map((match) => match.header) };
}
function buildScanPolicy(source, sections) {
    return {
        sourceKind: source.kind,
        sections,
        headerDataMode: normalizeHeaderDataMode(source.headerDataMode),
        columnMapping: source.columnMapping || null,
        numericColumnBase: "zero_based_revit_schedule_column",
        visibilityBasis: VISIBILITY_BASIS,
    };
}
function buildGuardedResult(reason, message, extra = {}) {
    const { warnings = [], notices = [], elapsedMs, scanPolicy, summary, suggestedNextScopes = [], ...extraWithoutMessages } = extra;
    return buildBroadScanGuardedResult({
        action: ACTION,
        reason,
        message,
        elapsedMs,
        extra: {
            stage: ADAPTER_STAGE,
            adapterContractVersion: 1,
            visibilityBasis: VISIBILITY_BASIS,
            ...extraWithoutMessages,
        },
        summary: summary || {},
        evidenceRows: [],
        scanPolicy: scanPolicy || {},
        suggestedNextScopes,
        warnings,
        notices,
    });
}
function buildFailureResult(error, extra = {}) {
    const { warnings = [], notices = [], elapsedMs, scanPolicy, summary, ...extraWithoutMessages } = extra;
    return buildBroadScanFailureResult({
        action: ACTION,
        error,
        elapsedMs,
        extra: {
            stage: ADAPTER_STAGE,
            adapterContractVersion: 1,
            visibilityBasis: VISIBILITY_BASIS,
            ...extraWithoutMessages,
        },
        summary: summary || {},
        evidenceRows: [],
        scanPolicy: scanPolicy || {},
        warnings,
        notices,
    });
}
function normalizeSections(values) {
    const rawValues = Array.isArray(values) && values.length > 0 ? values : DEFAULT_SECTIONS;
    return [...new Set(rawValues.map(normalizeSectionName))]
        .filter((value) => ["header", "body", "footer"].includes(value));
}
function normalizeHeaderDataMode(value) {
    return value === "always" || value === "never" ? value : "auto";
}
function normalizeSectionName(value) {
    const normalized = cleanReconciliationText(value).toLowerCase();
    return ["header", "body", "footer"].includes(normalized) ? normalized : "body";
}
function readNativeStringArray(payload, field) {
    const value = readNativeResultField(payload, field);
    if (!Array.isArray(value)) {
        return [];
    }
    return value.map(cleanReconciliationText).filter((item) => item.length > 0);
}
function finiteNumberOrNull(value) {
    if (typeof value === "number") {
        return Number.isFinite(value) ? value : null;
    }
    if (typeof value === "string") {
        const trimmed = value.trim();
        if (trimmed.length === 0) {
            return null;
        }
        const parsed = Number(trimmed);
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
}
function stringifyId(value) {
    return cleanOrNull(value);
}
function cleanOrNull(value) {
    const text = cleanReconciliationText(value);
    return text.length > 0 ? text : null;
}
