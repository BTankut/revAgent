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

export function buildBoqRows({ analyses = [] } = {}) {
    const rows = [];
    for (const analysis of Array.isArray(analyses) ? analyses : []) {
        const revitRead = analysis.revitRead && analysis.revitRead.result ? analysis.revitRead.result : analysis.revitRead;
        if (!revitRead || revitRead.success === false) continue;
        const discipline = analysis.discipline || "general";
        const engine = analysis.engine || "";
        addCountRows(rows, {
            discipline,
            engine,
            counts: revitRead.counts,
            source: "revitRead.counts",
        });
        if (Number.isFinite(Number(revitRead.ductLengthMeters)) && Number(revitRead.ductLengthMeters) > 0) {
            rows.push(quantityRow({
                discipline,
                engine,
                category: "Ducts",
                item: "Total duct length",
                quantity: Number(revitRead.ductLengthMeters),
                unit: "m",
                source: "revitRead.ductLengthMeters",
            }));
        }
        if (Number.isFinite(Number(revitRead.pipeLengthMeters)) && Number(revitRead.pipeLengthMeters) > 0) {
            rows.push(quantityRow({
                discipline,
                engine,
                category: "Pipes",
                item: "Total pipe length",
                quantity: Number(revitRead.pipeLengthMeters),
                unit: "m",
                source: "revitRead.pipeLengthMeters",
            }));
        }
        addSystemCountRows(rows, {
            discipline,
            engine,
            systemCounts: revitRead.systemElementCounts || revitRead.systemPipeCounts,
        });
    }
    return rows;
}

export function buildHydraulicResistanceRows({ analyses = [] } = {}) {
    const rows = [];
    for (const analysis of Array.isArray(analyses) ? analyses : []) {
        const calibration = analysis.resistanceCalibration;
        if (!calibration || !Array.isArray(calibration.rows)) continue;
        for (const row of calibration.rows) {
            rows.push({
                rowType: "hydraulic_resistance",
                discipline: analysis.discipline || "hydronic",
                engine: analysis.engine || "",
                elementId: row.elementId,
                uniqueId: row.uniqueId || "",
                systemName: row.systemName || "(unassigned)",
                lengthM: row.lengthM,
                diameterMm: row.diameterMm,
                referenceFlowLs: row.referenceFlowLs,
                resistancePaPerFlow2: row.resistancePaPerFlow2,
                pressureLossPaAtReferenceFlow: row.pressureLossPaAtReferenceFlow,
                velocityMpsAtReferenceFlow: row.velocityMpsAtReferenceFlow,
                source: "resistanceCalibration.rows",
                canCommit: false,
            });
        }
    }
    return rows;
}

export function buildLocalLossRows({ analyses = [] } = {}) {
    const rows = [];
    for (const analysis of Array.isArray(analyses) ? analyses : []) {
        const extraction = analysis.localLossExtraction;
        if (!extraction || !Array.isArray(extraction.rows)) continue;
        for (const row of extraction.rows) {
            rows.push({
                rowType: row.rowType || "local_loss_parameter",
                discipline: row.discipline || analysis.discipline || "general",
                engine: analysis.engine || "",
                elementId: row.elementId,
                uniqueId: row.uniqueId || "",
                category: row.category || "",
                systemName: row.systemName || "(unassigned)",
                familyName: row.familyName || "",
                typeName: row.typeName || "",
                parameterName: row.parameterName || "",
                parameterSource: row.parameterSource || "instance",
                valueKind: row.valueKind || "unknown",
                numericValue: row.numericValue,
                displayValue: row.displayValue || "",
                storageType: row.storageType || "",
                source: "localLossExtraction.rows",
                canCommit: false,
            });
        }
    }
    return rows;
}

export function buildLocalLossPressureRows({ analyses = [] } = {}) {
    const rows = [];
    for (const analysis of Array.isArray(analyses) ? analyses : []) {
        const contribution = analysis.localLossExtraction?.pressureContribution;
        if (!contribution) continue;
        rows.push({
            rowType: "local_loss_pressure_total",
            discipline: analysis.discipline || contribution.discipline || "general",
            engine: analysis.engine || "",
            systemName: "(all sampled)",
            category: "(all sampled)",
            pressureDropPa: contribution.totalPressureDropPa,
            pressureDropKPa: contribution.totalPressureDropKPa,
            pressureDropParameterCount: contribution.pressureDropParameterCount,
            source: "localLossExtraction.pressureContribution",
            canCommit: false,
        });
        for (const row of contribution.bySystem || []) {
            rows.push({
                rowType: "local_loss_pressure_by_system",
                discipline: analysis.discipline || contribution.discipline || "general",
                engine: analysis.engine || "",
                systemName: row.systemName || "(unassigned)",
                category: "",
                pressureDropPa: row.pressureDropPa,
                pressureDropKPa: row.pressureDropKPa,
                source: "localLossExtraction.pressureContribution.bySystem",
                canCommit: false,
            });
        }
        for (const row of contribution.byCategory || []) {
            rows.push({
                rowType: "local_loss_pressure_by_category",
                discipline: analysis.discipline || contribution.discipline || "general",
                engine: analysis.engine || "",
                systemName: "",
                category: row.category || "(uncategorized)",
                pressureDropPa: row.pressureDropPa,
                pressureDropKPa: row.pressureDropKPa,
                source: "localLossExtraction.pressureContribution.byCategory",
                canCommit: false,
            });
        }
    }
    return rows;
}

export function buildAnalysisReport({ analyses = [], delimiter = defaultDelimiter } = {}) {
    const issueRows = buildAnalysisIssueRows({ analyses });
    const designLogRows = buildDesignLogRows({ analyses });
    const boqRows = buildBoqRows({ analyses });
    const hydraulicResistanceRows = buildHydraulicResistanceRows({ analyses });
    const localLossRows = buildLocalLossRows({ analyses });
    const localLossPressureRows = buildLocalLossPressureRows({ analyses });
    return {
        success: true,
        mutateModel: false,
        reportKinds: ["issue_list", "design_log", "boq", "hydraulic_resistance", "local_loss", "local_loss_pressure"],
        issueRows,
        designLogRows,
        boqRows,
        hydraulicResistanceRows,
        localLossRows,
        localLossPressureRows,
        issueCsv: toDelimitedText(issueRows, { delimiter }),
        designLogCsv: toDelimitedText(designLogRows, { delimiter }),
        boqCsv: toDelimitedText(boqRows, { delimiter }),
        hydraulicResistanceCsv: toDelimitedText(hydraulicResistanceRows, { delimiter }),
        localLossCsv: toDelimitedText(localLossRows, { delimiter }),
        localLossPressureCsv: toDelimitedText(localLossPressureRows, { delimiter }),
        writePlanOperations: [
            "export_boq_report",
            "export_clash_report",
            "create_schedule_or_update_schedule",
        ],
        assumptions: [
            "Report builder returns deterministic rows and CSV text only; file export is handled by approved write-plan/report steps.",
            "BOQ rows are populated from live read-only Revit summaries when analyses include revitRead counts and lengths.",
            "Hydraulic resistance rows are populated from live read-only Revit pipe length/diameter samples when hydronic resistance calibration is requested.",
            "Local-loss rows are populated from live read-only fitting/accessory/equipment parameter extraction when local-loss sampling is requested.",
            "Local-loss pressure rows aggregate numeric pressure-drop parameters for use as fan pressure or pump head basis inputs after critical-path validation.",
            "Identity columns are emitted as text-compatible values for spreadsheet workflows.",
        ],
        canCommit: false,
    };
}

function addCountRows(rows, { discipline, engine, counts, source }) {
    if (!counts || typeof counts !== "object") return;
    for (const [key, value] of Object.entries(counts)) {
        const quantity = Number(value);
        if (!Number.isFinite(quantity) || quantity < 0) continue;
        rows.push(quantityRow({
            discipline,
            engine,
            category: labelFromKey(key),
            item: labelFromKey(key),
            quantity,
            unit: "ea",
            source,
        }));
    }
}

function addSystemCountRows(rows, { discipline, engine, systemCounts }) {
    if (!systemCounts || typeof systemCounts !== "object") return;
    for (const [systemName, value] of Object.entries(systemCounts)) {
        const quantity = Number(value);
        if (!Number.isFinite(quantity) || quantity < 0) continue;
        rows.push(quantityRow({
            discipline,
            engine,
            category: "System element count",
            item: systemName || "(unassigned)",
            quantity,
            unit: "ea",
            source: "revitRead.systemCounts",
        }));
    }
}

function quantityRow({ discipline, engine, category, item, quantity, unit, source }) {
    return {
        rowType: "boq_quantity",
        discipline,
        engine,
        category,
        item,
        quantity,
        unit,
        source,
        canCommit: false,
    };
}

function labelFromKey(key) {
    return String(key || "")
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .replace(/[_-]+/g, " ")
        .trim()
        .replace(/\b\w/g, (letter) => letter.toUpperCase());
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
