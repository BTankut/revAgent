import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildAudit } from "./previewFormatter.js";
import { toDelimitedText } from "../reporting/reportBuilder.js";

export const runtimeReportOperations = [
    "export_boq_report",
    "export_clash_report",
];

export function isRuntimeReportPlan(plan) {
    return Array.isArray(plan?.steps) &&
        plan.steps.length > 0 &&
        plan.steps.every((step) => runtimeReportOperations.includes(step.operation));
}

export function previewRuntimeReportPlan(plan) {
    return {
        success: true,
        mode: "preview",
        planId: plan.planId,
        riskLevel: plan.riskLevel,
        warnings: [],
        errors: [],
        previewRows: buildReportPreviewRows(plan, "preview"),
        files: [],
        mappings: [],
        audit: buildAudit("preview", plan, { runtimeReportExecutor: true }),
        mutateModel: false,
        writesFiles: false,
    };
}

export function commitRuntimeReportPlan(plan) {
    const files = [];
    const previewRows = [];
    for (const step of plan.steps || []) {
        const spec = buildReportSpec(plan, step);
        fs.mkdirSync(path.dirname(spec.outputPath), { recursive: true });
        fs.writeFileSync(spec.outputPath, spec.content, "utf8");
        files.push({
            stepId: step.stepId,
            operation: step.operation,
            format: spec.format,
            outputPath: spec.outputPath,
            rowCount: spec.rows.length,
        });
        previewRows.push(buildReportPreviewRow(plan, step, "written", spec));
    }
    return {
        success: true,
        mode: "commit",
        planId: plan.planId,
        riskLevel: plan.riskLevel,
        warnings: [],
        errors: [],
        previewRows,
        files,
        mappings: [],
        audit: buildAudit("commit", plan, { runtimeReportExecutor: true, fileCount: files.length }),
        mutateModel: false,
        writesFiles: true,
    };
}

function buildReportPreviewRows(plan, status) {
    return (plan.steps || []).map((step) => {
        return buildReportPreviewRow(plan, step, status, buildReportSpec(plan, step));
    });
}

function buildReportPreviewRow(plan, step, status, spec) {
    return {
        planId: plan.planId,
        stepId: step.stepId,
        eId: step.eId || "",
        operation: step.operation,
        target: `file=${spec.outputPath}`,
        proposedChange: `${spec.format} report with ${spec.rows.length} row(s)`,
        riskLevel: step.riskLevel || plan.riskLevel,
        willMutateModel: false,
        willWriteFile: status === "written",
        outputPath: spec.outputPath,
        rowCount: spec.rows.length,
        status,
    };
}

function buildReportSpec(plan, step) {
    const args = step.arguments || {};
    const format = String(args.format || "csv").toLowerCase() === "json" ? "json" : "csv";
    const rows = normalizeRows(args.rows || args.reportRows || []);
    const outputDirectory = outputDirectoryFor(args);
    const fileName = safeFileName(args.fileName || `${plan.planId}-${step.stepId}-${step.operation}.${format}`, format);
    const outputPath = path.join(outputDirectory, fileName);
    const content = format === "json"
        ? `${JSON.stringify({ planId: plan.planId, stepId: step.stepId, operation: step.operation, rows }, null, 2)}\n`
        : `${toDelimitedText(rows, { delimiter: args.delimiter || ";" })}\n`;
    return { format, rows, outputPath, content };
}

function normalizeRows(rows) {
    if (!Array.isArray(rows)) return [];
    return rows.map((row) => {
        if (row && typeof row === "object" && !Array.isArray(row)) return row;
        return { value: row };
    });
}

function outputDirectoryFor(args) {
    const base = args.outputDirectory ||
        process.env.REVIT_MCP_REPORT_OUTPUT_DIR ||
        path.join(os.tmpdir(), "revit-mcp-reports");
    return path.resolve(String(base));
}

function safeFileName(value, format) {
    const extension = format === "json" ? ".json" : ".csv";
    const cleaned = String(value || `report${extension}`)
        .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
        .replace(/^\.+/, "")
        .trim() || `report${extension}`;
    return cleaned.toLowerCase().endsWith(extension) ? cleaned : `${cleaned}${extension}`;
}
