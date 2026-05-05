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
        rows,
        assumptions: [
            "This summary only checks configured office-standard presence reported by each analysis engine.",
            "Complete standards do not replace engineer review, model preflight, preview, explicit approval, and verify.",
        ],
        canCommit: false,
    };
}
