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
        nextRequiredInputs: buildNextRequiredInputs({
            officeStandardsComplete,
            officeStandardsCompleteness,
            dataCompletenessRows,
            writePlanProposalValid,
            writePlanProposal,
        }),
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

function buildNextRequiredInputs({
    officeStandardsComplete,
    officeStandardsCompleteness,
    dataCompletenessRows,
    writePlanProposalValid,
    writePlanProposal,
}) {
    const inputs = [];
    if (!officeStandardsComplete) {
        inputs.push({
            inputType: "office_standards",
            status: "required",
            mergeTarget: "analyze_mep_system.officeStandards",
            sourceArtifact: "docs/revit-mep-office-standards-input-template.json",
            missingStandardCount: Array.isArray(officeStandardsCompleteness?.missingStandards)
                ? officeStandardsCompleteness.missingStandards.length
                : 0,
            missingStandards: Array.isArray(officeStandardsCompleteness?.missingStandards)
                ? officeStandardsCompleteness.missingStandards
                : [],
            template: officeStandardsCompleteness?.officeStandardsInputTemplate || null,
        });
    }
    const incompleteRows = dataCompletenessRows.filter((row) => !row.completeForProductionReview);
    if (incompleteRows.length > 0) {
        inputs.push({
            inputType: "project_critical_data",
            status: "required",
            mergeTarget: "analyze_mep_system arguments",
            sourceArtifact: "docs/revit-mep-project-critical-data-template.json",
            blockedProposalCount: incompleteRows.length,
            requiredArgumentGroups: requiredArgumentGroupsForRows(incompleteRows),
            blockedProposalRows: incompleteRows,
        });
    }
    if (!writePlanProposalValid) {
        const errors = Array.isArray(writePlanProposal?.validation?.errors)
            ? writePlanProposal.validation.errors
            : [];
        inputs.push({
            inputType: "write_plan_proposal_validation",
            status: "required",
            mergeTarget: "analyze_mep_system.officeStandards and proposal inputs",
            validationErrorCount: errors.length,
            validationErrors: errors,
            guidance: "Adjust allowed parameter names, exact schema mappings, target identities, or proposal request data before preview/commit.",
        });
    }
    return inputs;
}

function requiredArgumentGroupsForRows(rows) {
    const groups = new Set();
    for (const row of rows) {
        if (row.discipline === "hvac" && row.proposalName === "ductSizingProposal") {
            groups.add("hvacDuctSizingTargetElementIds");
            groups.add("hvacDesignFlowsByElementId");
            groups.add("localLossElementIds");
            groups.add("criticalPathLocalLossPressurePa");
            groups.add("criticalPathLocalLossComplete");
        }
        else if (row.discipline === "hydronic" && row.proposalName === "pipeSizingProposal") {
            groups.add("hydronicPipeSizingTargetElementIds");
            groups.add("hydronicDesignFlowsByElementId");
            groups.add("localLossElementIds");
            groups.add("criticalPathLocalLossPressurePa");
            groups.add("criticalPathLocalLossComplete");
        }
        else if (row.discipline === "domestic_water" && row.proposalName === "pipeSizingProposal") {
            groups.add("domesticWaterPipeSizingRequests");
        }
        else if (row.discipline === "sanitary" && row.proposalName === "pipeSizingProposal") {
            groups.add("sanitaryStormPipeSizingRequests");
        }
        else if ((row.discipline === "fire" || row.discipline === "sprinkler") && row.proposalName === "pipeSizingProposal") {
            groups.add("firePipeSizingRequests");
        }
        else {
            groups.add(`${row.discipline}.${row.proposalName}`);
        }
    }
    return [...groups].sort();
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
