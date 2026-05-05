const defaultDelimiter = ";";

export function buildAnalysisIssueRows({ analyses = [] } = {}) {
    const rows = [];
    for (const analysis of Array.isArray(analyses) ? analyses : []) {
        const discipline = analysis.discipline || "general";
        const engine = analysis.engine || "";
        for (const standard of analysis.missingStandards || []) {
            rows.push({
                rowType: "missing_standard",
                discipline,
                engine,
                severity: "blocker",
                code: standard,
                message: `Missing office standard: ${standard}`,
                canCommit: false,
            });
        }
        for (const warning of analysis.warnings || []) {
            rows.push({
                rowType: "warning",
                discipline,
                engine,
                severity: "warning",
                code: "analysis_warning",
                message: String(warning),
                canCommit: Boolean(analysis.canCommit),
            });
        }
        if (analysis.revitRead && analysis.revitRead.success === false) {
            rows.push({
                rowType: "revit_read_error",
                discipline,
                engine,
                severity: "error",
                code: "revit_read_failed",
                message: analysis.revitRead.error || "Revit read failed",
                canCommit: false,
            });
        }
        if (analysis.requiresOfficeStandard && (!analysis.missingStandards || analysis.missingStandards.length === 0)) {
            rows.push({
                rowType: "missing_standard",
                discipline,
                engine,
                severity: "blocker",
                code: "office_standard_required",
                message: "Office standard is required before commit-level engineering decisions.",
                canCommit: false,
            });
        }
    }
    return rows;
}

export function buildDesignLogRows({ analyses = [] } = {}) {
    const rows = [];
    for (const analysis of Array.isArray(analyses) ? analyses : []) {
        rows.push({
            rowType: "analysis_summary",
            discipline: analysis.discipline || "general",
            engine: analysis.engine || "",
            status: analysis.status || "",
            requiresOfficeStandard: Boolean(analysis.requiresOfficeStandard),
            missingStandards: (analysis.missingStandards || []).join(", "),
            canCommit: Boolean(analysis.canCommit),
            methods: (analysis.engineeringMethods || analysis.checksAvailable || []).join(" | "),
            assumptions: (analysis.assumptions || []).join(" | "),
        });
    }
    return rows;
}

export function buildAnalysisReport({ analyses = [], delimiter = defaultDelimiter } = {}) {
    const issueRows = buildAnalysisIssueRows({ analyses });
    const designLogRows = buildDesignLogRows({ analyses });
    return {
        success: true,
        mutateModel: false,
        reportKinds: ["issue_list", "design_log"],
        issueRows,
        designLogRows,
        issueCsv: toDelimitedText(issueRows, { delimiter }),
        designLogCsv: toDelimitedText(designLogRows, { delimiter }),
        writePlanOperations: [
            "export_boq_report",
            "export_clash_report",
            "create_schedule_or_update_schedule",
        ],
        assumptions: [
            "Report builder returns deterministic rows and CSV text only; file export is handled by a future approved write-plan/report step.",
            "Identity columns are emitted as text-compatible values for spreadsheet workflows.",
        ],
        canCommit: false,
    };
}

export function toDelimitedText(rows, { delimiter = defaultDelimiter } = {}) {
    const safeRows = Array.isArray(rows) ? rows : [];
    if (safeRows.length === 0) return "";
    const columns = orderedColumns(safeRows);
    const lines = [columns.map((column) => escapeCell(column, delimiter)).join(delimiter)];
    for (const row of safeRows) {
        lines.push(columns.map((column) => escapeCell(row[column], delimiter)).join(delimiter));
    }
    return lines.join("\n");
}

function orderedColumns(rows) {
    const columns = [];
    const seen = new Set();
    for (const row of rows) {
        for (const key of Object.keys(row || {})) {
            if (seen.has(key)) continue;
            seen.add(key);
            columns.push(key);
        }
    }
    return columns;
}

function escapeCell(value, delimiter) {
    const text = spreadsheetSafeText(value);
    if (text.includes(delimiter) || text.includes("\"") || text.includes("\n") || text.includes("\r")) {
        return `"${text.replace(/"/g, "\"\"")}"`;
    }
    return text;
}

function spreadsheetSafeText(value) {
    if (value === null || value === undefined) return "";
    const text = Array.isArray(value) ? value.join(", ") : String(value);
    return /^[=+\-@]/.test(text) ? `'${text}` : text;
}
