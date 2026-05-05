export function calculateSlopePercent({ startElevationM, endElevationM, lengthM } = {}) {
    const length = Number(lengthM);
    if (!Number.isFinite(length) || length <= 0) {
        return {
            success: false,
            error: "lengthM must be greater than zero",
            canCommit: false,
        };
    }
    const fallM = Number(startElevationM) - Number(endElevationM);
    return {
        success: true,
        fallM,
        slopePercent: (fallM / length) * 100.0,
    };
}

export function validateGravitySlope({ startElevationM, endElevationM, lengthM, minSlopePercent = null } = {}) {
    if (minSlopePercent === null || minSlopePercent === undefined || !Number.isFinite(Number(minSlopePercent)) || Number(minSlopePercent) <= 0) {
        return {
            success: false,
            requiresOfficeStandard: true,
            missingStandards: ["sanitaryStorm.sanitarySlopeRules"],
            canCommit: false,
        };
    }
    const slope = calculateSlopePercent({ startElevationM, endElevationM, lengthM });
    if (!slope.success) return slope;
    const reverseSlope = slope.slopePercent < 0;
    const belowMinimum = slope.slopePercent >= 0 && slope.slopePercent < Number(minSlopePercent);
    const issues = [];
    if (reverseSlope) issues.push("reverse_slope");
    if (belowMinimum) issues.push("below_minimum_slope");
    return {
        success: issues.length === 0,
        method: "Gravity pipe slope validation",
        input: {
            startElevationM: Number(startElevationM),
            endElevationM: Number(endElevationM),
            lengthM: Number(lengthM),
            minSlopePercent: Number(minSlopePercent),
        },
        output: {
            fallM: slope.fallM,
            slopePercent: slope.slopePercent,
            reverseSlope,
            belowMinimum,
        },
        issues,
        canCommit: false,
        riskLevel: "medium",
    };
}

export function sizeGravityPipeByFixtureUnits({ fixtureUnits, sizingTable = null } = {}) {
    if (!Array.isArray(sizingTable) || sizingTable.length === 0) {
        return {
            success: false,
            requiresOfficeStandard: true,
            missingStandards: ["sanitaryStorm.pipeSizingTable"],
            canCommit: false,
        };
    }
    const demand = Number(fixtureUnits);
    if (!Number.isFinite(demand) || demand <= 0) {
        return {
            success: false,
            error: "fixtureUnits must be greater than zero",
            canCommit: false,
        };
    }
    const candidates = sizingTable
        .map((row) => ({
            diameterMm: Number(row.diameterMm),
            maxFixtureUnits: Number(row.maxFixtureUnits),
            minSlopePercent: Number(row.minSlopePercent),
        }))
        .filter((row) => Number.isFinite(row.diameterMm) && row.diameterMm > 0 &&
            Number.isFinite(row.maxFixtureUnits) && row.maxFixtureUnits >= demand)
        .sort((a, b) => a.diameterMm - b.diameterMm);
    return {
        success: candidates.length > 0,
        method: "Smallest configured gravity pipe size satisfying fixture-unit capacity",
        input: {
            fixtureUnits: demand,
        },
        selected: candidates[0] || null,
        candidateCount: candidates.length,
        assumptions: [
            "Sizing table must come from the office standard or governing code basis.",
            "Slope, branch length, stack loading, venting, and local authority requirements must be reviewed before commit.",
        ],
        canCommit: false,
        riskLevel: "medium",
    };
}

export function traceGravityDrainageToStack({ edges = [], fixtureNodeIds = [], stackNodeIds = [] } = {}) {
    const stackSet = new Set((Array.isArray(stackNodeIds) ? stackNodeIds : []).map(String));
    if (stackSet.size === 0) {
        return {
            success: false,
            requiresOfficeStandard: true,
            missingStandards: ["sanitaryStorm.stackNodeIds"],
            canCommit: false,
        };
    }
    const graph = directedGraph(edges);
    const rows = [];
    const issues = [];
    for (const fixtureId of (Array.isArray(fixtureNodeIds) ? fixtureNodeIds : []).map(String)) {
        const path = findDirectedPathToAny(fixtureId, stackSet, graph);
        const reachesStack = path.length > 0;
        const row = {
            fixtureNodeId: fixtureId,
            reachesStack,
            pathNodeIds: path,
            stackNodeId: reachesStack ? path[path.length - 1] : null,
        };
        rows.push(row);
        if (!reachesStack) {
            issues.push({
                fixtureNodeId: fixtureId,
                issue: "fixture branch does not drain to a configured stack node",
            });
        }
    }
    return {
        success: issues.length === 0,
        method: "Directed gravity branch-to-stack reachability check",
        rows,
        issues,
        assumptions: [
            "Edges are expected to point downstream toward the stack.",
            "This is a graph integrity check; invert elevation, pipe slope, and trap/vent code requirements need separate validation.",
        ],
        canCommit: false,
        riskLevel: "medium",
    };
}

export function checkVentContinuity({ edges = [], fixtureNodeIds = [], ventNodeIds = [] } = {}) {
    const ventSet = new Set((Array.isArray(ventNodeIds) ? ventNodeIds : []).map(String));
    if (ventSet.size === 0) {
        return {
            success: false,
            requiresOfficeStandard: true,
            missingStandards: ["sanitaryStorm.ventNodeIds"],
            canCommit: false,
        };
    }
    const graph = undirectedGraph(edges);
    const rows = [];
    const issues = [];
    for (const fixtureId of (Array.isArray(fixtureNodeIds) ? fixtureNodeIds : []).map(String)) {
        const path = findUndirectedPathToAny(fixtureId, ventSet, graph);
        const reachesVent = path.length > 0;
        const row = {
            fixtureNodeId: fixtureId,
            reachesVent,
            pathNodeIds: path,
            ventNodeId: reachesVent ? path[path.length - 1] : null,
        };
        rows.push(row);
        if (!reachesVent) {
            issues.push({
                fixtureNodeId: fixtureId,
                issue: "fixture branch is not connected to a configured vent node",
            });
        }
    }
    return {
        success: issues.length === 0,
        method: "Undirected fixture-to-vent continuity check",
        rows,
        issues,
        assumptions: [
            "Vent sizing, developed length, trap arm limits, and local code criteria are not evaluated in this foundation check.",
        ],
        canCommit: false,
        riskLevel: "medium",
    };
}

export function calculateStormRunoffRational({
    catchmentAreaM2,
    rainfallIntensityMmH = null,
    runoffCoefficient = null,
} = {}) {
    const missingStandards = [];
    if (!isPositive(rainfallIntensityMmH)) missingStandards.push("sanitaryStorm.rainfallIntensityMmH");
    if (!isPositive(runoffCoefficient)) missingStandards.push("sanitaryStorm.runoffCoefficient");
    if (missingStandards.length > 0) {
        return {
            success: false,
            requiresOfficeStandard: true,
            missingStandards,
            canCommit: false,
        };
    }
    const area = Number(catchmentAreaM2);
    if (!Number.isFinite(area) || area <= 0) {
        return {
            success: false,
            error: "catchmentAreaM2 must be greater than zero",
            canCommit: false,
        };
    }
    const flowLs = Number(rainfallIntensityMmH) * area * Number(runoffCoefficient) / 3600.0;
    return {
        success: true,
        method: "Rational-method storm runoff foundation",
        input: {
            catchmentAreaM2: area,
            rainfallIntensityMmH: Number(rainfallIntensityMmH),
            runoffCoefficient: Number(runoffCoefficient),
        },
        output: {
            runoffFlowLs: flowLs,
        },
        assumptions: [
            "Rainfall intensity and runoff coefficient must be supplied by the office standard or governing hydrology basis.",
            "Time of concentration, roof drain limits, ponding, overflow routes, and local code criteria are not evaluated.",
        ],
        canCommit: false,
        riskLevel: "medium",
    };
}

export function sizeStormPipeByFlow({
    runoffFlowLs,
    sizingTable = null,
} = {}) {
    if (!Array.isArray(sizingTable) || sizingTable.length === 0) {
        return {
            success: false,
            requiresOfficeStandard: true,
            missingStandards: ["sanitaryStorm.stormPipeSizingTable"],
            canCommit: false,
        };
    }
    const flow = Number(runoffFlowLs);
    if (!Number.isFinite(flow) || flow <= 0) {
        return {
            success: false,
            error: "runoffFlowLs must be greater than zero",
            canCommit: false,
        };
    }
    const candidates = sizingTable
        .map((row) => ({
            diameterMm: Number(row.diameterMm),
            maxFlowLs: Number(row.maxFlowLs),
            minSlopePercent: Number(row.minSlopePercent),
        }))
        .filter((row) => Number.isFinite(row.diameterMm) && row.diameterMm > 0 &&
            Number.isFinite(row.maxFlowLs) && row.maxFlowLs >= flow)
        .sort((a, b) => a.diameterMm - b.diameterMm);
    return {
        success: candidates.length > 0,
        method: "Smallest configured storm pipe size satisfying runoff flow",
        input: {
            runoffFlowLs: flow,
        },
        selected: candidates[0] || null,
        candidateCount: candidates.length,
        assumptions: [
            "Pipe capacity table must come from the office standard or governing drainage calculation method.",
            "Final storm drainage design requires roof drain, overflow, slope, and local code review.",
        ],
        canCommit: false,
        riskLevel: "medium",
    };
}

export function buildSanitaryStormPipeResizeProposal({
    pipeSizingRequests = [],
    sanitarySizingTable = null,
    stormSizingTable = null,
    rainfallIntensityMmH = null,
    runoffCoefficient = null,
} = {}) {
    const rows = [];
    const writePlanSteps = [];
    const warnings = [];
    let skippedNoDemandCount = 0;
    let skippedNoSizeCount = 0;
    for (const request of Array.isArray(pipeSizingRequests) ? pipeSizingRequests : []) {
        const drainageType = drainageTypeForRequest(request);
        const demand = drainageDemandForRequest({ request, drainageType, rainfallIntensityMmH, runoffCoefficient });
        if (!demand.success) {
            skippedNoDemandCount++;
            if (demand.warning) warnings.push(demand.warning);
            continue;
        }
        const sizing = drainageType === "storm"
            ? sizeStormPipeByFlow({ runoffFlowLs: demand.flowLs, sizingTable: stormSizingTable })
            : sizeGravityPipeByFixtureUnits({ fixtureUnits: demand.fixtureUnits, sizingTable: sanitarySizingTable });
        if (!sizing.success || !sizing.selected) {
            skippedNoSizeCount++;
            warnings.push(`Skipped ${drainageType} pipe request ${targetLabelForRequest(request)}: ${sizing.missingStandards?.join(", ") || sizing.error || "no configured size satisfies the demand"}.`);
            continue;
        }
        const target = targetForRequest(request);
        const currentDiameterMm = currentDiameterForRequest(request);
        const selected = sizing.selected;
        const resizeRequired = isPositive(currentDiameterMm)
            ? Math.abs(Number(selected.diameterMm) - Number(currentDiameterMm)) > 1e-6
            : true;
        rows.push({
            rowType: drainageType === "storm" ? "storm_pipe_sizing_proposal" : "sanitary_pipe_sizing_proposal",
            drainageType,
            elementId: positiveInteger(request?.elementId),
            eId: isNonEmptyString(request?.eId) ? request.eId.trim() : "",
            uniqueId: request?.uniqueId || "",
            systemName: request?.systemName || (drainageType === "storm" ? "Storm Drainage" : "Sanitary"),
            lengthM: Number.isFinite(Number(request?.lengthM)) ? Number(request.lengthM) : null,
            fixtureUnits: demand.fixtureUnits ?? null,
            designFlowLs: demand.flowLs ?? null,
            demandSource: demand.source,
            currentDiameterMm: isPositive(currentDiameterMm) ? Number(currentDiameterMm) : null,
            selectedDiameterMm: selected.diameterMm,
            selectedMinSlopePercent: Number.isFinite(Number(selected.minSlopePercent)) ? Number(selected.minSlopePercent) : null,
            resizeRequired,
            status: "proposal_ready_for_review",
            source: "sanitaryStormPipeSizingRequests + officeStandards.sanitaryStorm",
            canCommit: false,
        });
        if (resizeRequired && target) {
            writePlanSteps.push({
                stepId: `resize-${drainageType}-pipe-${target.label}`,
                operation: "resize_pipe",
                dependsOn: [],
                targets: target.targets,
                arguments: {
                    diameter: selected.diameterMm,
                    unit: "mm",
                },
                preconditions: [
                    drainageType === "storm"
                        ? `Storm runoff/design flow confirmed at ${round(demand.flowLs, 3)} L/s.`
                        : `Sanitary fixture load confirmed at ${round(demand.fixtureUnits, 3)} fixture units.`,
                    `Configured ${drainageType} sizing table selected ${round(selected.diameterMm, 3)} mm pipe.`,
                    "Verify slope, invert continuity, stack/vent relationship, and local code requirements before commit.",
                ],
                riskLevel: "medium",
            });
        }
    }
    if (skippedNoDemandCount > 0) warnings.push(`Skipped ${skippedNoDemandCount} sanitary/storm pipe sizing request(s) without confirmed fixture units or storm flow.`);
    if (skippedNoSizeCount > 0) warnings.push(`Skipped ${skippedNoSizeCount} sanitary/storm pipe sizing request(s) with no configured diameter satisfying demand.`);
    return {
        success: rows.length > 0,
        method: "Sanitary/storm resize_pipe proposal from fixture-unit or runoff demand and configured sizing tables",
        status: rows.length > 0 ? "proposal_ready_for_review" : "blocked_no_sizable_pipe_requests",
        assumptions: [
            "Drainage requests must identify exact Revit pipes by elementId or stable eId before a write-plan commit.",
            "Generated resize_pipe steps are proposal-only and require slope/invert/vent review, preview, explicit approval, and verify.",
        ],
        dataCompleteness: proposalDataCompleteness({
            requestCount: Array.isArray(pipeSizingRequests) ? pipeSizingRequests.length : 0,
            rowCount: rows.length,
            writePlanStepCount: writePlanSteps.length,
            skippedNoDemandCount,
            skippedNoSizeCount,
        }),
        rows,
        writePlanSteps,
        warnings,
        canCommit: false,
        riskLevel: "high",
    };
}

function directedGraph(edges) {
    const graph = new Map();
    for (const edge of Array.isArray(edges) ? edges : []) {
        const from = String(edge.from);
        const to = String(edge.to);
        if (!graph.has(from)) graph.set(from, new Set());
        if (!graph.has(to)) graph.set(to, new Set());
        graph.get(from).add(to);
    }
    return graph;
}

function undirectedGraph(edges) {
    const graph = new Map();
    for (const edge of Array.isArray(edges) ? edges : []) {
        const from = String(edge.from);
        const to = String(edge.to);
        if (!graph.has(from)) graph.set(from, new Set());
        if (!graph.has(to)) graph.set(to, new Set());
        graph.get(from).add(to);
        graph.get(to).add(from);
    }
    return graph;
}

function drainageDemandForRequest({ request, drainageType, rainfallIntensityMmH, runoffCoefficient }) {
    if (drainageType === "storm") {
        const explicitFlow = Number(request?.runoffFlowLs ?? request?.flowLs ?? request?.designFlowLs);
        if (Number.isFinite(explicitFlow) && explicitFlow > 0) {
            return { success: true, flowLs: explicitFlow, source: "explicit storm flow" };
        }
        const runoff = calculateStormRunoffRational({
            catchmentAreaM2: request?.catchmentAreaM2,
            rainfallIntensityMmH,
            runoffCoefficient,
        });
        if (runoff.success) {
            return { success: true, flowLs: runoff.output.runoffFlowLs, source: "rational-method runoff" };
        }
        return {
            success: false,
            warning: `Storm pipe request ${targetLabelForRequest(request)} has no valid runoff flow or catchment/rainfall basis.`,
        };
    }
    const fixtureUnits = Number(request?.fixtureUnits);
    if (Number.isFinite(fixtureUnits) && fixtureUnits > 0) {
        return { success: true, fixtureUnits, source: "fixture units" };
    }
    return {
        success: false,
        warning: `Sanitary pipe request ${targetLabelForRequest(request)} has no valid fixture-unit basis.`,
    };
}

function drainageTypeForRequest(request) {
    const value = String(request?.drainageType || request?.kind || request?.type || "").toLowerCase();
    return value.includes("storm") || value.includes("rain") ? "storm" : "sanitary";
}

function currentDiameterForRequest(request) {
    return Number(request?.currentDiameterMm ?? request?.diameterMm);
}

function targetForRequest(request) {
    const elementId = positiveInteger(request?.elementId);
    if (elementId) {
        return { label: String(elementId), targets: { elementId } };
    }
    if (isNonEmptyString(request?.eId)) {
        const eId = request.eId.trim();
        return { label: safeId(eId), targets: { eId } };
    }
    return null;
}

function targetLabelForRequest(request) {
    return targetForRequest(request)?.label || "(unidentified)";
}

function positiveInteger(value) {
    const numeric = Number(value);
    return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}

function safeId(value) {
    return String(value || "target").replace(/[^A-Za-z0-9_-]+/g, "-");
}

function round(value, digits = 3) {
    const factor = 10 ** digits;
    return Math.round(Number(value) * factor) / factor;
}

function proposalDataCompleteness({
    requestCount,
    rowCount,
    writePlanStepCount,
    skippedNoDemandCount,
    skippedNoSizeCount,
}) {
    const blockers = [];
    if (requestCount <= 0) blockers.push("No sanitary/storm pipe sizing requests were supplied.");
    if (rowCount <= 0) blockers.push("No sanitary/storm pipe sizing proposal rows were produced.");
    if (skippedNoDemandCount > 0) blockers.push(`${skippedNoDemandCount} sanitary/storm pipe sizing request(s) lack confirmed demand.`);
    if (skippedNoSizeCount > 0) blockers.push(`${skippedNoSizeCount} sanitary/storm pipe sizing request(s) have no configured size satisfying demand.`);
    if (writePlanStepCount <= 0 && rowCount > 0) blockers.push("No sanitary/storm resize step was needed or target identity was incomplete.");
    return {
        requestCount,
        rowCount,
        writePlanStepCount,
        skippedNoDemandCount,
        skippedNoSizeCount,
        completeForProductionReview: blockers.length === 0,
        blockers,
    };
}

function isNonEmptyString(value) {
    return typeof value === "string" && value.trim().length > 0;
}

function isPositive(value) {
    return value !== null && value !== undefined && Number.isFinite(Number(value)) && Number(value) > 0;
}

function findDirectedPathToAny(start, targets, graph) {
    return findPathToAny(start, targets, graph);
}

function findUndirectedPathToAny(start, targets, graph) {
    return findPathToAny(start, targets, graph);
}

function findPathToAny(start, targets, graph) {
    const queue = [[start]];
    const visited = new Set([start]);
    while (queue.length > 0) {
        const path = queue.shift();
        const current = path[path.length - 1];
        if (targets.has(current)) return path;
        for (const next of graph.get(current) || []) {
            if (visited.has(next)) continue;
            visited.add(next);
            queue.push([...path, next]);
        }
    }
    return [];
}
