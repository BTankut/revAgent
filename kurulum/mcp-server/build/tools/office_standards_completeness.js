export function summarizeOfficeStandardsCompleteness(analyses = []) {
    const rows = [];
    const missing = new Set();
    for (const analysis of Array.isArray(analyses) ? analyses : []) {
        const missingStandards = Array.isArray(analysis?.missingStandards)
            ? analysis.missingStandards.filter((standard) => standard !== null && standard !== undefined).map(String)
            : [];
        for (const standard of missingStandards) {
            missing.add(standard);
        }
        rows.push({
            discipline: analysis?.discipline || "general",
            engine: analysis?.engine || "",
            requiresOfficeStandard: Boolean(analysis?.requiresOfficeStandard || missingStandards.length > 0),
            missingStandards,
            status: missingStandards.length > 0 ? "blocked_missing_office_standard" : "standards_available",
            canCommit: false,
        });
    }
    const missingStandards = [...missing].sort();
    return {
        completeForProductionReview: missingStandards.length === 0 && rows.every((row) => !row.requiresOfficeStandard),
        requiresOfficeStandard: missingStandards.length > 0 || rows.some((row) => row.requiresOfficeStandard),
        missingStandards,
        officeStandardsInputTemplate: buildOfficeStandardsInputTemplate(missingStandards),
        rows,
        assumptions: [
            "This summary only checks configured office-standard presence reported by each analysis engine.",
            "Complete standards do not replace engineer review, model preflight, preview, explicit approval, and verify.",
        ],
        canCommit: false,
    };
}

export function buildOfficeStandardsInputTemplate(missingStandards = []) {
    const paths = [...new Set((Array.isArray(missingStandards) ? missingStandards : [])
        .filter((standard) => standard !== null && standard !== undefined)
        .map(String))]
        .sort();
    const officeStandards = {};
    for (const standardPath of paths) {
        assignTemplateValue(officeStandards, standardPath, placeholderValueForStandard(standardPath));
    }
    return {
        mergeTarget: "analyze_mep_system.officeStandards",
        requiredMissingStandardPaths: paths,
        officeStandards,
        notes: [
            "Replace null and empty-array placeholders with approved office/project standards before production review.",
            "Pass the officeStandards object as the analyze_mep_system officeStandards override; it is merged over runtime defaults.",
        ],
    };
}

function assignTemplateValue(target, standardPath, value) {
    const parts = standardPath.split(".").filter(Boolean);
    if (parts.length === 0) return;
    let cursor = target;
    for (let i = 0; i < parts.length - 1; i++) {
        const part = parts[i];
        if (!cursor[part] || typeof cursor[part] !== "object" || Array.isArray(cursor[part])) {
            cursor[part] = {};
        }
        cursor = cursor[part];
    }
    cursor[parts[parts.length - 1]] = value;
}

function placeholderValueForStandard(standardPath) {
    const last = standardPath.split(".").pop() || "";
    if (/rules|table|curve|ids/i.test(last)) {
        return [];
    }
    return null;
}
