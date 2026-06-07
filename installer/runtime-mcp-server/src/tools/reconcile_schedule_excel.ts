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

type JsonObject = Record<string, any>;

const ACTION = "reconcile_schedule_excel";
const TOOL_SCHEMA = z.object({
    excel: excelIngestionSourceSchema.describe("Excel/CSV source. Use kind:\"file\" for .xlsx/.csv/.tsv or kind:\"rows\" for deterministic CI/dry-run records."),
    schedule: scheduleAdapterSourceSchema.describe("Schedule source. Use kind:\"inspect_schedules_result\" with a normalized inspect_schedules result; kind:\"revit_schedule\" is currently guarded and does not call Revit."),
    config: reconciliationConfigSchema.optional().describe("Optional scoring/cap/threshold override. Defaults are conservative and can be tuned from real-data dry-runs."),
}).strict();

function guardedStageResult(stage: string, reason: string, message: string, extra: JsonObject = {}) {
    const { warnings = [], notices = [], scanPolicy = {}, summary = {}, ...rest } = extra;
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
        warnings,
        notices,
    });
}

function failedStageResult(stage: string, error: string, extra: JsonObject = {}) {
    const { warnings = [], notices = [], scanPolicy = {}, summary = {}, ...rest } = extra;
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

export async function reconcileScheduleExcel(rawArgs: unknown): Promise<JsonObject> {
    const parsed = TOOL_SCHEMA.safeParse(rawArgs);
    if (!parsed.success) {
        return guardedStageResult("input_validation", "reconciliation_input_required", "Provide excel and schedule sources before reconciliation.", {
            validationIssues: parsed.error.issues.map((issue) => issue.message),
        });
    }

    const excelResult = await ingestExcelSource(parsed.data.excel);
    if (isGuarded(excelResult)) {
        return guardedStageResult("excel_ingestion", excelResult.reason || "excel_ingestion_guarded", excelResult.message || "Excel ingestion was guarded before reconciliation.", {
            excelResult,
            summary: excelResult.summary || {},
            scanPolicy: excelResult.scanPolicy || {},
            warnings: excelResult.warnings || [],
            notices: excelResult.notices || [],
        });
    }
    if (isFailed(excelResult)) {
        return failedStageResult("excel_ingestion", excelResult.error || "Excel ingestion failed before reconciliation.", {
            excelResult,
            summary: excelResult.summary || {},
            scanPolicy: excelResult.scanPolicy || {},
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
            warnings: scheduleResult.warnings || [],
            notices: scheduleResult.notices || [],
        });
    }
    if (isFailed(scheduleResult)) {
        return failedStageResult("schedule_record_adapter", scheduleResult.error || "Schedule adaptation failed before reconciliation.", {
            scheduleResult,
            summary: scheduleResult.summary || {},
            scanPolicy: scheduleResult.scanPolicy || {},
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
    return {
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
    };
}

export function registerReconcileScheduleExcelTool(server: ToolServer) {
    server.tool(
        "reconcile_schedule_excel",
        "[SCHEDULE_EXCEL_RECONCILIATION_REVIEW_ONLY] Review-first/write-free schedule-to-Excel reconciliation. Ingests explicit Excel/CSV data plus normalized inspect_schedules output, normalizes rows, scores deterministic matches, and returns reviewRows/reviewTable only. Does not write Revit or workbook data; route any accepted follow-up write through set_schedule_cells or set_schedule_cells_by_text after human review.",
        {
            excel: TOOL_SCHEMA.shape.excel,
            schedule: TOOL_SCHEMA.shape.schedule,
            config: TOOL_SCHEMA.shape.config,
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
