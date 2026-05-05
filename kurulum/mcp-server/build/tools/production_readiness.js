export function summarizeProductionReadiness({
    analyses = [],
    officeStandardsCompleteness = null,
    writePlanProposal = null,
} = {}) {
    const dataCompletenessRows = collectDataCompletenessRows(analyses);
    const blockers = [];
    const officeStandardsComplete = Boolean(officeStandardsCompleteness?.completeForProductionReview);
    if (!officeStandardsComplete) {
        const missing = Array.isArray(officeStandardsCompleteness?.missingStandards)
            ? officeStandardsCompleteness.missingStandards
            : [];
        blockers.push(missing.length > 0
            ? `Missing office standards: ${missing.join(", ")}`
            : "Office standards are incomplete for one or more analysis engines.");
    }
    for (const row of dataCompletenessRows) {
        if (row.completeForProductionReview) continue;
        const details = row.blockers.length > 0 ? `: ${row.blockers.join(" | ")}` : "";
        blockers.push(`${row.discipline}.${row.proposalName} data is incomplete${details}`);
    }
    const writePlanProposalValid = writePlanProposal?.validation
        ? writePlanProposal.validation.valid === true
        : true;
    if (!writePlanProposalValid) {
        const errors = Array.isArray(writePlanProposal?.validation?.errors)
            ? writePlanProposal.validation.errors
            : [];
        blockers.push(errors.length > 0
            ? `Generated write-plan proposal is invalid: ${errors.join(" | ")}`
            : "Generated write-plan proposal is invalid.");
    }
    return {
        completeForProductionReview: blockers.length === 0,
        officeStandardsComplete,
        proposalDataComplete: dataCompletenessRows.every((row) => row.completeForProductionReview),
        writePlanProposalValid,
        blockerCount: blockers.length,
        blockers,
        rows: [
            {
                rowType: "office_standards_readiness",
                completeForProductionReview: officeStandardsComplete,
                missingStandardCount: Array.isArray(officeStandardsCompleteness?.missingStandards)
                    ? officeStandardsCompleteness.missingStandards.length
                    : 0,
                status: officeStandardsComplete ? "ready" : "blocked",
                canCommit: false,
            },
            ...dataCompletenessRows,
            {
                rowType: "write_plan_proposal_readiness",
                completeForProductionReview: writePlanProposalValid,
                errorCount: Array.isArray(writePlanProposal?.validation?.errors)
                    ? writePlanProposal.validation.errors.length
                    : 0,
                stepCount: Number(writePlanProposal?.stepCount || 0),
                status: writePlanProposalValid ? "ready" : "blocked",
                canCommit: false,
            },
        ],
        assumptions: [
            "Production readiness is a gate summary only; it is not commit approval.",
            "A ready summary still requires engineer review, write-plan preview, explicit approval, and verify.",
        ],
        canCommit: false,
    };
}

function collectDataCompletenessRows(analyses = []) {
    const rows = [];
    for (const analysis of Array.isArray(analyses) ? analyses : []) {
        appendDataCompletenessRow(rows, analysis, "ductSizingProposal", analysis?.ductSizingProposal);
        appendDataCompletenessRow(rows, analysis, "pipeSizingProposal", analysis?.pipeSizingProposal);
    }
    return rows;
}

function appendDataCompletenessRow(rows, analysis, proposalName, proposal) {
    const completeness = proposal?.dataCompleteness;
    if (!completeness || typeof completeness !== "object") return;
    const blockers = Array.isArray(completeness.blockers)
        ? completeness.blockers.filter((blocker) => blocker !== null && blocker !== undefined).map(String)
        : [];
    rows.push({
        rowType: "proposal_data_readiness",
        discipline: analysis?.discipline || "general",
        engine: analysis?.engine || "",
        proposalName,
        completeForProductionReview: Boolean(completeness.completeForProductionReview),
        requestCount: Number(completeness.requestCount ?? 0),
        sampleCount: Number(completeness.sampleCount ?? 0),
        targetCount: Number(completeness.targetCount ?? 0),
        rowCount: Number(completeness.rowCount ?? 0),
        proposalRowCount: Number(completeness.proposalRowCount ?? completeness.rowCount ?? 0),
        writePlanStepCount: Number(completeness.writePlanStepCount ?? 0),
        skippedNoFlowCount: Number(completeness.skippedNoFlowCount ?? completeness.skippedNoDemandCount ?? 0),
        skippedNoSizeCount: Number(completeness.skippedNoSizeCount ?? 0),
        localLossDatasetComplete: completeness.localLossDatasetComplete,
        blockerCount: blockers.length,
        blockers,
        status: Boolean(completeness.completeForProductionReview) ? "ready" : "blocked",
        canCommit: false,
    });
}
