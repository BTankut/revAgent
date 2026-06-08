import type { ToolServer } from "./types.js";
import { z } from "zod";
import {
    buildBroadScanFailureResult,
    buildBroadScanGuardedResult,
} from "../utils/broadScanResult.js";
import { formatJsonContent } from "../utils/revitToolHelpers.js";
import {
    excelIngestionSourceSchema,
    ingestExcelSource,
} from "./reconcile_excel_ingestion.js";
import {
    adaptScheduleSource,
    scheduleAdapterSourceSchema,
} from "./reconcile_schedule_adapter.js";
import {
    reconcileScheduleExcelRecords,
    reconciliationConfigSchema,
} from "./reconcile_matching.js";
import {
    boundedPositiveInt,
    compactObjectRows,
    isDetailedResponseMode,
    responseModeSchema,
} from "../utils/responseMode.js";

type JsonObject = Record<string, any>;

const ACTION = "reconcile_schedule_excel";
const DEFAULT_COMPACT_REVIEW_ROWS = 50;

const TOOL_SCHEMA = z.object({
    excel: excelIngestionSourceSchema.describe("Excel/CSV source. Use kind:\"file\" for .xlsx/.csv/.tsv or kind:\"rows\" for deterministic CI/dry-run records."),
    schedule: scheduleAdapterSourceSchema.describe("Schedule source. Use kind:\"inspect_schedules_result\" with a normalized inspect_schedules result; kind:\"revit_schedule\" is currently guarded and does not call Revit."),
    config: reconciliationConfigSchema.optional().describe("Optional scoring/cap/threshold override. Defaults are conservative and can be tuned from real-data dry-runs."),
    responseMode: responseModeSchema,
    maxReviewRows: z.number().int().positive().max(1000).optional().describe("Compact-mode cap for returned reviewTable/evidenceRows rows. Defaults 50; full/debug returns all reviewRows."),
    maxCandidateRows: z.number().int().positive().max(10).optional().describe("Compatibility input for older callers. Compact mode omits nested candidateRows; full/debug returns all candidates."),
}).strict();

function guardedStageResult(stage: string, reason: string, message: string, extra: JsonObject = {}) {
    const { warnings = [], notices = [], scanPolicy = {}, summary = {}, suggestedNextScopes = [], ...rest } = extra;
    return buildBroadScanGuardedResult({
        action: ACTION,
        reason,
        message,
        extra: {
            stage,
            reconciliationContractVersion: 1,
            ...rest,
        },
        summary,
        evidenceRows: [],
        scanPolicy,
        suggestedNextScopes,
        warnings,
        notices,
    });
}

function failedStageResult(stage: string, error: string, extra: JsonObject = {}) {
    const { warnings = [], notices = [], scanPolicy = {}, summary = {}, suggestedNextScopes = [], ...rest } = extra;
    return buildBroadScanFailureResult({
        action: ACTION,
        error,
        extra: {
            stage,
            reconciliationContractVersion: 1,
            ...rest,
        },
        summary,
        evidenceRows: [],
        scanPolicy,
        suggestedNextScopes,
        warnings,
        notices,
    });
}

function isGuarded(result: JsonObject): boolean {
    return result.guarded === true || result.state === "guarded";
}

function isFailed(result: JsonObject): boolean {
    return result.success === false || result.state === "failed" || Boolean(result.error);
}

function cleanStringArray(value: unknown): string[] {
    return Array.isArray(value)
        ? value.map((item) => String(item ?? "").trim()).filter((item) => item.length > 0)
        : [];
}

function firstNonCompletedStopReason(...results: JsonObject[]): string | null {
    for (const result of results) {
        const reason = String(result.scanStoppedReason || "").trim();
        if (reason && reason !== "completed") {
            return reason;
        }
    }
    return null;
}

const REQUIRED_MAPPING_HINT = {
    requiredRoles: ["identity", "comparisonText"],
    optionalRoles: ["code", "description", "quantity", "unit", "system", "discipline", "notes"],
};

const RECONCILIATION_SCHEMA_EXAMPLES = {
    rowsSource: {
        excel: {
            kind: "rows",
            sheetName: "Items",
            rows: [
                { Identity: "FCU-101", Description: "Fan coil supply DN100", Unit: "PCS" },
            ],
            columnMapping: {
                identity: "Identity",
                comparisonText: "Description",
                unit: "Unit",
            },
        },
        schedule: {
            kind: "inspect_schedules_result",
            result: {
                success: true,
                schedules: [
                    {
                        id: 7001,
                        name: "Mechanical Equipment Schedule",
                        sections: [
                            {
                                section: "header",
                                rows: [{ row: 0, cells: [{ column: 0, text: "Identity" }, { column: 1, text: "Description" }] }],
                            },
                            {
                                section: "body",
                                rows: [{ row: 1, cells: [{ column: 0, text: "FCU-101" }, { column: 1, text: "Fan coil supply DN100" }] }],
                            },
                        ],
                    },
                ],
            },
        },
        responseMode: "compact",
    },
    fileSource: {
        excel: {
            kind: "file",
            path: "C:\\path\\items.xlsx",
            format: "xlsx",
            selection: { sheetName: "Items", headerRow: 1, dataStartRow: 2 },
            columnMapping: {
                identity: "Identity",
                comparisonText: "Description",
            },
        },
        schedule: {
            kind: "inspect_schedules_result",
            result: "inspect_schedules result with responseMode=\"full\" when schedule body cells are needed",
        },
    },
};

function reviewRowKey(row: JsonObject): string {
    return [
        row.bucket,
        row.reason,
        row.score,
        row.excelRow?.excelRowId ?? row.excelRow?.recordId ?? "",
        row.scheduleRow?.scheduleRowId ?? row.scheduleRow?.recordId ?? "",
    ].join("|");
}

function buildCompactReviewTable(rows: JsonObject[], originalTable: JsonObject): JsonObject {
    const columns = Array.isArray(originalTable.columns)
        ? originalTable.columns
        : [
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
        ...originalTable,
        columns,
        rows: rows.map((row) => ({
            bucket: row.bucket,
            score: row.score,
            reason: row.reason,
            excelRowId: row.excelRow?.excelRowId ?? row.excelRow?.recordId ?? "",
            scheduleRowId: row.scheduleRow?.scheduleRowId ?? row.scheduleRow?.recordId ?? "",
            excelText: row.excelRow ? [row.excelRow.identityText, row.excelRow.comparisonText].filter(Boolean).join(" | ") : "",
            scheduleText: row.scheduleRow ? [row.scheduleRow.identityText, row.scheduleRow.comparisonText].filter(Boolean).join(" | ") : "",
            hardConflicts: Array.isArray(row.hardConflicts) ? row.hardConflicts.join(", ") : "",
            recommendedNextAction: row.recommendedNextAction,
        })),
    };
}

export function compactReconciliationResult(result: JsonObject, args: JsonObject): JsonObject {
    const responseMode = args.responseMode || "compact";
    if (isDetailedResponseMode(responseMode)) {
        return {
            ...result,
            responseMode,
        };
    }

    const reviewLimit = boundedPositiveInt(args.maxReviewRows, DEFAULT_COMPACT_REVIEW_ROWS, 1000);
    const compactReview = compactObjectRows(result.reviewRows, {
        limit: reviewLimit,
        key: reviewRowKey,
    });
    const compactEvidence = compactObjectRows(result.evidenceRows, {
        limit: reviewLimit,
    });
    const {
        reviewRows: _reviewRows,
        reviewTable: _reviewTable,
        scoringConfig: _scoringConfig,
        sourceSummary: _sourceSummary,
        ...base
    } = result;
    return {
        ...base,
        responseMode: "compact",
        reviewTable: buildCompactReviewTable(compactReview.rows, result.reviewTable || {}),
        evidenceRows: compactEvidence.rows,
        summary: {
            ...(result.summary || {}),
            compactResponse: true,
            reviewRowCount: compactReview.totalCount,
            returnedReviewRowCount: compactReview.returnedCount,
            omittedReviewRowCount: compactReview.omittedCount,
            duplicateReviewRowCount: compactReview.duplicateCount,
            evidenceRowCount: compactEvidence.totalCount,
            returnedEvidenceRowCount: compactEvidence.returnedCount,
            omittedEvidenceRowCount: compactEvidence.omittedCount,
        },
        notices: [
            ...cleanStringArray(result.notices),
            "Compact response returns summary, reviewTable, evidenceRows, and count metadata only. Use responseMode=\"full\" for reviewRows, token profiles, raw cells, and nested candidates.",
        ],
    };
}

export async function reconcileScheduleExcel(rawArgs: unknown): Promise<JsonObject> {
    const parsed = TOOL_SCHEMA.safeParse(rawArgs);
    if (!parsed.success) {
        return guardedStageResult("input_validation", "reconciliation_input_required", "Provide excel and schedule sources before reconciliation.", {
            validationIssues: parsed.error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`),
            requiredColumnMapping: REQUIRED_MAPPING_HINT,
            schemaExamples: RECONCILIATION_SCHEMA_EXAMPLES,
            suggestedNextScopes: ["excel.kind", "excel.rows", "excel.path", "excel.selection", "excel.columnMapping.identity", "excel.columnMapping.comparisonText", "schedule.kind", "schedule.result", "schedule.columnMapping.identity", "schedule.columnMapping.comparisonText"],
        });
    }

    const excelResult = await ingestExcelSource(parsed.data.excel);
    if (isGuarded(excelResult)) {
        return guardedStageResult("excel_ingestion", excelResult.reason || "excel_ingestion_guarded", excelResult.message || "Excel ingestion was guarded before reconciliation.", {
            excelResult,
            summary: excelResult.summary || {},
            scanPolicy: excelResult.scanPolicy || {},
            suggestedNextScopes: excelResult.suggestedNextScopes || ["excel.selection", "excel.columnMapping.identity", "excel.columnMapping.comparisonText"],
            warnings: excelResult.warnings || [],
            notices: excelResult.notices || [],
        });
    }
    if (isFailed(excelResult)) {
        return failedStageResult("excel_ingestion", excelResult.error || "Excel ingestion failed before reconciliation.", {
            excelResult,
            summary: excelResult.summary || {},
            scanPolicy: excelResult.scanPolicy || {},
            suggestedNextScopes: excelResult.suggestedNextScopes || ["excel.selection", "excel.columnMapping.identity", "excel.columnMapping.comparisonText"],
            warnings: excelResult.warnings || [],
            notices: excelResult.notices || [],
        });
    }

    const scheduleResult = adaptScheduleSource(parsed.data.schedule);
    if (isGuarded(scheduleResult)) {
        return guardedStageResult("schedule_record_adapter", scheduleResult.reason || "schedule_adapter_guarded", scheduleResult.message || "Schedule adaptation was guarded before reconciliation.", {
            scheduleResult,
            summary: scheduleResult.summary || {},
            scanPolicy: scheduleResult.scanPolicy || {},
            suggestedNextScopes: scheduleResult.suggestedNextScopes || ["schedule.result", "schedule.columnMapping.identity", "schedule.columnMapping.comparisonText"],
            warnings: scheduleResult.warnings || [],
            notices: scheduleResult.notices || [],
        });
    }
    if (isFailed(scheduleResult)) {
        return failedStageResult("schedule_record_adapter", scheduleResult.error || "Schedule adaptation failed before reconciliation.", {
            scheduleResult,
            summary: scheduleResult.summary || {},
            scanPolicy: scheduleResult.scanPolicy || {},
            suggestedNextScopes: scheduleResult.suggestedNextScopes || ["schedule.result", "schedule.columnMapping.identity", "schedule.columnMapping.comparisonText"],
            warnings: scheduleResult.warnings || [],
            notices: scheduleResult.notices || [],
        });
    }

    const result = reconcileScheduleExcelRecords({
        excelResult,
        scheduleResult,
        config: parsed.data.config,
    });
    const sourcePartial = excelResult.partial === true || scheduleResult.partial === true;
    const scanStoppedReason = sourcePartial
        ? firstNonCompletedStopReason(scheduleResult, excelResult) || result.scanStoppedReason
        : result.scanStoppedReason;
    return compactReconciliationResult({
        ...result,
        partial: result.partial === true || sourcePartial,
        scanStoppedReason,
        scanPolicy: {
            ...(result.scanPolicy || {}),
            excel: excelResult.scanPolicy || {},
            schedule: scheduleResult.scanPolicy || {},
        },
        warnings: [
            ...cleanStringArray(result.warnings),
            ...cleanStringArray(excelResult.warnings),
            ...cleanStringArray(scheduleResult.warnings),
        ],
        notices: [
            ...cleanStringArray(result.notices),
            ...cleanStringArray(excelResult.notices),
            ...cleanStringArray(scheduleResult.notices),
        ],
        sourceSummary: {
            excel: excelResult.summary || {},
            schedule: scheduleResult.summary || {},
        },
        sourceResults: {
            excel: {
                sourceKind: excelResult.sourceKind,
                format: excelResult.format,
                sheetName: excelResult.sheetName,
                partial: excelResult.partial,
                scanStoppedReason: excelResult.scanStoppedReason,
                recordCount: Array.isArray(excelResult.excelRecords) ? excelResult.excelRecords.length : 0,
            },
            schedule: {
                sourceKind: scheduleResult.sourceKind,
                visibilityBasis: scheduleResult.visibilityBasis,
                partial: scheduleResult.partial,
                scanStoppedReason: scheduleResult.scanStoppedReason,
                recordCount: Array.isArray(scheduleResult.scheduleRecords) ? scheduleResult.scheduleRecords.length : 0,
            },
        },
    }, parsed.data);
}

export function registerReconcileScheduleExcelTool(server: ToolServer) {
    server.tool(
        "reconcile_schedule_excel",
        "[SCHEDULE_EXCEL_RECONCILIATION_REVIEW_ONLY] Review-first/write-free schedule-to-Excel reconciliation. Ingests explicit Excel/CSV data plus normalized inspect_schedules output, normalizes rows, scores deterministic matches, and returns compact review tables by default. excel.kind=\"rows\" expects an object with rows:[...] plus columnMapping.identity and columnMapping.comparisonText; file sources use path/format/selection with the same required mapping. Default responseMode=compact returns summary, reviewTable, evidenceRows, and count metadata only; use responseMode=full/debug for reviewRows, token profiles, raw cells, and nested candidateRows. Does not write Revit or workbook data; route any accepted follow-up write through set_schedule_cells or set_schedule_cells_by_text after human review.",
        {
            excel: TOOL_SCHEMA.shape.excel,
            schedule: TOOL_SCHEMA.shape.schedule,
            config: TOOL_SCHEMA.shape.config,
            responseMode: TOOL_SCHEMA.shape.responseMode,
            maxReviewRows: TOOL_SCHEMA.shape.maxReviewRows,
            maxCandidateRows: TOOL_SCHEMA.shape.maxCandidateRows,
        },
        async (args: JsonObject = {}) => {
            try {
                return formatJsonContent(await reconcileScheduleExcel(args));
            }
            catch (error) {
                return formatJsonContent(failedStageResult("runtime_failure", error instanceof Error ? error.message : String(error)));
            }
        },
    );
}
