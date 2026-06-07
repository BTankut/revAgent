import { z } from "zod";
import {
    buildBroadScanFailureResult,
    buildBroadScanGuardedResult,
    normalizeBroadScanResult,
    normalizeBroadScanStopReason,
    readNativeResultArray,
    readNativeResultField,
    type BroadScanStopReason,
} from "../utils/broadScanResult.js";
import {
    buildReconciliationTokenProfile,
    cleanReconciliationText,
    normalizeReconciliationAlias,
    normalizeReconciliationHeader,
    RECONCILIATION_ALL_ROLES,
    RECONCILIATION_REQUIRED_ROLES,
    RECONCILIATION_ROLE_ALIASES,
    type ReconciliationColumnRole,
} from "./reconcile_normalization.js";

type JsonObject = Record<string, any>;
type ColumnRole = ReconciliationColumnRole;
type ColumnRef = string | number;

const ACTION = "reconcile_schedule_records";
const ADAPTER_STAGE = "schedule_record_adapter";
const VISIBILITY_BASIS = "displayedScheduleCells";
const DEFAULT_SECTIONS = ["body"];
const ALL_ROLES = RECONCILIATION_ALL_ROLES;
const REQUIRED_ROLES = RECONCILIATION_REQUIRED_ROLES;
const ROLE_ALIASES = RECONCILIATION_ROLE_ALIASES;

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
    columnHeaders: z.array(z.string()).optional(),
    sections: z.array(z.enum(["header", "body", "footer"])).optional(),
}).strict();

export const revitScheduleSourceSchema = z.object({
    kind: z.literal("revit_schedule"),
    scheduleIds: z.array(z.union([z.number().int().positive(), z.string().min(1)])).optional(),
    nameQuery: z.string().min(1).optional(),
    sections: z.array(z.enum(["header", "body", "footer"])).optional(),
    columnMapping: scheduleColumnMappingSchema.optional(),
    columnHeaders: z.array(z.string()).optional(),
}).strict();

export const scheduleAdapterSourceSchema = z.discriminatedUnion("kind", [
    inspectSchedulesResultSourceSchema,
    revitScheduleSourceSchema,
]);

export type ScheduleAdapterSource = z.infer<typeof scheduleAdapterSourceSchema>;
export type ScheduleColumnMapping = z.infer<typeof scheduleColumnMappingSchema>;

type HeaderLabel = {
    column: number;
    header: string;
};

type ScheduleCell = {
    column: number;
    text: string;
};

type ScheduleRow = {
    scheduleId: string;
    scheduleName: string | null;
    section: string;
    row: number;
    cells: ScheduleCell[];
};

type ResolvedMapping = {
    mapping: Partial<Record<ColumnRole, number>>;
    notices: string[];
    warnings: string[];
};

type MappingError = {
    error: JsonObject;
};

type AliasMatch = {
    header: string;
    column: number;
    priority: number;
};

export function adaptScheduleSource(rawInput: ScheduleAdapterSource): JsonObject {
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
        return buildGuardedResult("revit_schedule_bridge_deferred", "Live revit_schedule bridge execution is deferred to PR4. Pass kind:\"inspect_schedules_result\" with a normalized inspect_schedules result for PR2.", {
            sourceKind: parsed.data.kind,
            sections: normalizeSections(parsed.data.sections),
            scanPolicy: {
                sourceKind: parsed.data.kind,
                bridgeExecution: "deferred_to_pr4",
                scheduleIds: parsed.data.scheduleIds || [],
                nameQuery: parsed.data.nameQuery || null,
                sections: normalizeSections(parsed.data.sections),
                columnMapping: parsed.data.columnMapping || null,
                visibilityBasis: VISIBILITY_BASIS,
            },
            elapsedMs: Date.now() - startedAtMs,
            suggestedNextScopes: ["schedule.kind=inspect_schedules_result", "schedule.result"],
        });
    }

    return adaptInspectSchedulesResult(parsed.data, Date.now() - startedAtMs);
}

function adaptInspectSchedulesResult(source: z.infer<typeof inspectSchedulesResultSourceSchema>, elapsedMs: number): JsonObject {
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
    const schedules = readNativeResultArray(payload, "schedules");
    const warnings = readNativeStringArray(payload, "warnings");
    const notices = readNativeStringArray(payload, "notices");
    const records: JsonObject[] = [];
    let scannedRows = 0;
    let scannedCells = 0;

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

        for (const section of readNativeResultArray(schedule, "sections")) {
            const sectionName = normalizeSectionName(readNativeResultField(section, "section"));
            if (!sections.includes(sectionName)) {
                continue;
            }
            for (const row of readSectionRows(section, scheduleId, scheduleName, sectionName)) {
                scannedRows++;
                scannedCells += row.cells.length;
                const record = buildScheduleRecord(row, resolvedMapping.mapping);
                if (record) {
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
        notices,
        lastRead: {
            lastReadSection: readNativeResultField(payload, "lastReadSection") ?? lastRecord?.section ?? null,
            lastReadRow: readNativeResultField(payload, "lastReadRow") ?? lastRecord?.row ?? null,
            lastReadColumn: readNativeResultField(payload, "lastReadColumn") ?? null,
            lastReadItemId: readNativeResultField(payload, "lastReadItemId") ?? lastRecord?.scheduleRowId ?? null,
        },
    });
}

function buildScheduleRecord(row: ScheduleRow, mapping: Partial<Record<ColumnRole, number>>): JsonObject | null {
    const byColumn = new Map<number, string>();
    for (const cell of row.cells) {
        byColumn.set(cell.column, cell.text);
    }
    const mappedValues: JsonObject = {};
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

function readSectionRows(section: JsonObject, scheduleId: string, scheduleName: string | null, sectionName: string): ScheduleRow[] {
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
            .filter((cell): cell is ScheduleCell => cell.column !== null);
        return [{ scheduleId, scheduleName, section: sectionName, row, cells }];
    });
}

function extractHeaderLabels(schedule: JsonObject, fallbackHeaders?: string[]): HeaderLabel[] {
    const labels = new Map<number, string>();
    for (const section of readNativeResultArray(schedule, "sections")) {
        if (normalizeSectionName(readNativeResultField(section, "section")) !== "header") {
            continue;
        }
        for (const row of readSectionRows(section, stringifyId(readNativeResultField(schedule, "id")) || "unknown", cleanOrNull(readNativeResultField(schedule, "name")), "header")) {
            for (const cell of row.cells) {
                if (!labels.has(cell.column) && cell.text.length > 0) {
                    labels.set(cell.column, cell.text);
                }
            }
        }
    }
    if (Array.isArray(fallbackHeaders)) {
        fallbackHeaders.forEach((header, index) => {
            const cleanHeader = cleanReconciliationText(header);
            if (cleanHeader.length > 0 && !labels.has(index)) {
                labels.set(index, cleanHeader);
            }
        });
    }
    return [...labels.entries()]
        .sort(([left], [right]) => left - right)
        .map(([column, header]) => ({ column, header }));
}

function resolveColumnMapping(headers: HeaderLabel[], explicitMapping?: ScheduleColumnMapping): ResolvedMapping | MappingError {
    const warnings: string[] = [];
    const notices: string[] = [];
    const mapping: Partial<Record<ColumnRole, number>> = {};
    const assignedColumns = new Set<number>();

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

function resolveColumnRef(ref: ColumnRef, headers: HeaderLabel[]): number | null {
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

function getAliasPriority(role: ColumnRole, header: string): number {
    const normalized = normalizeReconciliationAlias(header);
    const aliases = ROLE_ALIASES[role];
    for (let index = 0; index < aliases.length; index++) {
        if (normalizeReconciliationAlias(aliases[index]) === normalized) {
            return index;
        }
    }
    return Number.POSITIVE_INFINITY;
}

function findAllColumnAliases(role: ColumnRole, headers: HeaderLabel[]): AliasMatch[] {
    return headers
        .map((header) => ({ header: header.header, column: header.column, priority: getAliasPriority(role, header.header) }))
        .filter((match) => Number.isFinite(match.priority));
}

function selectAliasMatch(matches: AliasMatch[], assignedColumns: Set<number>): { kind: "resolved"; match: AliasMatch } | { kind: "ambiguous"; candidates: string[] } {
    const unassignedMatches = matches.filter((match) => !assignedColumns.has(match.column));
    const candidates = unassignedMatches.length > 0 ? unassignedMatches : matches;
    const bestPriority = Math.min(...candidates.map((match) => match.priority));
    const bestCandidates = candidates.filter((match) => match.priority === bestPriority);
    if (bestCandidates.length === 1) {
        return { kind: "resolved", match: bestCandidates[0] };
    }
    return { kind: "ambiguous", candidates: bestCandidates.map((match) => match.header) };
}

function buildScanPolicy(source: z.infer<typeof inspectSchedulesResultSourceSchema>, sections: string[]) {
    return {
        sourceKind: source.kind,
        sections,
        columnMapping: source.columnMapping || null,
        numericColumnBase: "zero_based_revit_schedule_column",
        visibilityBasis: VISIBILITY_BASIS,
    };
}

function buildGuardedResult(reason: string, message: string, extra: JsonObject = {}) {
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

function buildFailureResult(error: string, extra: JsonObject = {}) {
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

function normalizeSections(values: unknown): string[] {
    const rawValues = Array.isArray(values) && values.length > 0 ? values : DEFAULT_SECTIONS;
    return [...new Set(rawValues.map(normalizeSectionName))]
        .filter((value) => ["header", "body", "footer"].includes(value));
}

function normalizeSectionName(value: unknown): string {
    const normalized = cleanReconciliationText(value).toLowerCase();
    return ["header", "body", "footer"].includes(normalized) ? normalized : "body";
}

function readNativeStringArray(payload: JsonObject, field: string): string[] {
    const value = readNativeResultField(payload, field);
    if (!Array.isArray(value)) {
        return [];
    }
    return value.map(cleanReconciliationText).filter((item) => item.length > 0);
}

function finiteNumberOrNull(value: unknown): number | null {
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

function stringifyId(value: unknown): string | null {
    return cleanOrNull(value);
}

function cleanOrNull(value: unknown): string | null {
    const text = cleanReconciliationText(value);
    return text.length > 0 ? text : null;
}
