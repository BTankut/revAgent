export function summarizeProductionSizingReview({
    analyses = [],
    productionReadiness = null,
    writePlanProposal = null,
} = {}) {
    const writePlanSteps = Array.isArray(writePlanProposal?.plan?.steps)
        ? writePlanProposal.plan.steps
        : [];
    const rows = [];
    for (const analysis of Array.isArray(analyses) ? analyses : []) {
        appendSizingRows({
            rows,
            analysis,
            proposalName: "ductSizingProposal",
            proposal: analysis?.ductSizingProposal,
            operation: "resize_duct",
            systemKind: "duct",
            writePlanSteps,
        });
        appendSizingRows({
            rows,
            analysis,
            proposalName: "pipeSizingProposal",
            proposal: analysis?.pipeSizingProposal,
            operation: "resize_pipe",
            systemKind: "pipe",
            writePlanSteps,
        });
    }

    const blockers = [];
    if (productionReadiness?.completeForProductionReview !== true) {
        blockers.push("Production readiness gate is not complete.");
    }
    if (rows.length === 0) {
        blockers.push("No HVAC or hydronic sizing proposal rows are available for production sizing review.");
    }
    const blockedRowCount = rows.filter((row) => row.completeForProductionReview !== true).length;
    if (blockedRowCount > 0) {
        blockers.push(`${blockedRowCount} sizing row(s) are not ready for production final review.`);
    }

    const currentLinearPressureLossPaTotal = sumFinite(rows.map((row) => row.currentLinearPressureLossPa));
    const selectedLinearPressureLossPaTotal = sumFinite(rows.map((row) => row.selectedLinearPressureLossPa));
    const criticalPathLocalLossPressurePaMax = maxFinite(rows.map((row) => row.criticalPathLocalLossPressurePa));
    const currentPathPressureBasisPa = addIfFinite(currentLinearPressureLossPaTotal, criticalPathLocalLossPressurePaMax);
    const selectedPathPressureBasisPa = addIfFinite(selectedLinearPressureLossPaTotal, criticalPathLocalLossPressurePaMax);

    return {
        completeForProductionReview: blockers.length === 0,
        rowCount: rows.length,
        readyRowCount: rows.filter((row) => row.completeForProductionReview === true).length,
        resizeRequiredCount: rows.filter((row) => row.resizeRequired === true).length,
        writePlanStepCount: new Set(rows.map((row) => row.writePlanStepId).filter(Boolean)).size,
        currentLinearPressureLossPaTotal,
        selectedLinearPressureLossPaTotal,
        criticalPathLocalLossPressurePaMax,
        currentPathPressureBasisPa,
        selectedPathPressureBasisPa,
        pressureBasisDeltaPa: subtractIfFinite(selectedPathPressureBasisPa, currentPathPressureBasisPa),
        blockerCount: blockers.length,
        blockers,
        rows,
        assumptions: [
            "Production sizing review is an engineer final-review artefact, not commit approval.",
            "Critical-path local-loss pressure is added once as path context; it is not multiplied per resized segment.",
            "Commit still requires write-plan preview, explicit approval, native execution, and verify.",
        ],
        canCommit: false,
    };
}

function appendSizingRows({
    rows,
    analysis,
    proposalName,
    proposal,
    operation,
    systemKind,
    writePlanSteps,
}) {
    const proposalRows = Array.isArray(proposal?.rows) ? proposal.rows : [];
    const dataComplete = proposal?.dataCompleteness?.completeForProductionReview === true;
    for (const sourceRow of proposalRows) {
        const elementId = positiveInteger(sourceRow?.elementId);
        const step = findWritePlanStep(writePlanSteps, operation, elementId);
        const rowReady = dataComplete &&
            sourceRow?.localLossDatasetComplete === true &&
            sourceRow?.status === "proposal_ready_for_review";
        const currentLinearPressureLossPa = finiteOrNull(sourceRow?.currentLinearPressureLossPa);
        const selectedLinearPressureLossPa = finiteOrNull(sourceRow?.selectedLinearPressureLossPa);
        const criticalPathLocalLossPressurePa = finiteOrNull(sourceRow?.criticalPathLocalLossPressurePa);
        const currentPathPressureBasisPa = addIfFinite(currentLinearPressureLossPa, criticalPathLocalLossPressurePa);
        const selectedPathPressureBasisPa = addIfFinite(selectedLinearPressureLossPa, criticalPathLocalLossPressurePa);
        rows.push({
            rowType: "production_sizing_review",
            discipline: analysis?.discipline || "general",
            engine: analysis?.engine || "",
            proposalName,
            systemKind,
            elementId,
            uniqueId: sourceRow?.uniqueId || "",
            systemName: sourceRow?.systemName || "(unassigned)",
            currentSize: currentSize(sourceRow, systemKind),
            selectedSize: selectedSize(sourceRow, systemKind),
            designFlow: designFlow(sourceRow, systemKind),
            currentVelocityMps: finiteOrNull(sourceRow?.currentVelocityMps),
            selectedVelocityMps: finiteOrNull(sourceRow?.selectedVelocityMps),
            currentPressureLossPaPerM: finiteOrNull(sourceRow?.currentPressureLossPaPerM),
            selectedPressureLossPaPerM: finiteOrNull(sourceRow?.selectedPressureLossPaPerM),
            currentLinearPressureLossPa,
            selectedLinearPressureLossPa,
            criticalPathLocalLossPressurePa,
            currentPathPressureBasisPa,
            selectedPathPressureBasisPa,
            pressureBasisDeltaPa: subtractIfFinite(selectedPathPressureBasisPa, currentPathPressureBasisPa),
            resizeRequired: sourceRow?.resizeRequired === true,
            writePlanStepId: step?.stepId || null,
            completeForProductionReview: rowReady,
            status: rowReady ? "ready_for_engineer_final_review" : "blocked",
            sourceStatus: sourceRow?.status || "",
            canCommit: false,
        });
    }
}

function findWritePlanStep(writePlanSteps, operation, elementId) {
    if (!elementId) return null;
    return writePlanSteps.find((step) => step?.operation === operation &&
        positiveInteger(step?.targets?.elementId) === elementId) || null;
}

function currentSize(row, systemKind) {
    if (systemKind === "duct") {
        return {
            widthMm: finiteOrNull(row?.currentWidthMm),
            heightMm: finiteOrNull(row?.currentHeightMm),
        };
    }
    return { diameterMm: finiteOrNull(row?.currentDiameterMm) };
}

function selectedSize(row, systemKind) {
    if (systemKind === "duct") {
        return {
            widthMm: finiteOrNull(row?.selectedWidthMm),
            heightMm: finiteOrNull(row?.selectedHeightMm),
        };
    }
    return { diameterMm: finiteOrNull(row?.selectedDiameterMm) };
}

function designFlow(row, systemKind) {
    if (systemKind === "duct") {
        return {
            value: finiteOrNull(row?.designFlowM3h),
            unit: "m3/h",
        };
    }
    return {
        value: finiteOrNull(row?.designFlowLs),
        unit: "L/s",
    };
}

function positiveInteger(value) {
    const number = Number(value);
    return Number.isInteger(number) && number > 0 ? number : null;
}

function finiteOrNull(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function sumFinite(values) {
    let total = 0;
    let count = 0;
    for (const value of values) {
        const number = Number(value);
        if (!Number.isFinite(number)) continue;
        total += number;
        count++;
    }
    return count > 0 ? total : null;
}

function maxFinite(values) {
    let result = null;
    for (const value of values) {
        const number = Number(value);
        if (!Number.isFinite(number)) continue;
        result = result === null ? number : Math.max(result, number);
    }
    return result;
}

function addIfFinite(left, right) {
    return Number.isFinite(left) && Number.isFinite(right) ? left + right : null;
}

function subtractIfFinite(left, right) {
    return Number.isFinite(left) && Number.isFinite(right) ? left - right : null;
}
