import { pipeFrictionLossPaPerM, sizePipeByVelocityOrFriction } from "../hydronic/calculations.js";

export function calculateFixtureDemand({ fixtures = [], fixtureUnitTable = null } = {}) {
    if (!fixtureUnitTable) {
        return missingStandard("domesticWater.fixtureUnitTable");
    }
    const rows = [];
    let coldFixtureUnits = 0;
    let hotFixtureUnits = 0;
    let totalFixtureUnits = 0;
    for (const fixture of fixtures) {
        const count = Number(fixture.count || 0);
        const type = fixture.fixtureType || fixture.type || "";
        const basis = fixtureUnitTable[type];
        if (!basis) {
            rows.push({
                fixtureType: type,
                count,
                error: "Fixture type is not in the configured fixture unit table.",
            });
            continue;
        }
        const cold = count * Number(basis.coldFixtureUnits || 0);
        const hot = count * Number(basis.hotFixtureUnits || 0);
        const total = count * Number(basis.totalFixtureUnits || basis.coldFixtureUnits || 0);
        coldFixtureUnits += cold;
        hotFixtureUnits += hot;
        totalFixtureUnits += total;
        rows.push({
            fixtureType: type,
            count,
            coldFixtureUnits: cold,
            hotFixtureUnits: hot,
            totalFixtureUnits: total,
        });
    }
    return {
        success: rows.every((row) => !row.error),
        method: "Configured fixture-unit summation",
        rows,
        totals: {
            coldFixtureUnits,
            hotFixtureUnits,
            totalFixtureUnits,
        },
        assumptions: [
            "Demand conversion from fixture units to flow is not performed without the configured office standard curve.",
        ],
        canCommit: false,
        riskLevel: "medium",
    };
}

export function convertFixtureUnitsToDemand({ fixtureUnits, demandCurve = null } = {}) {
    if (!Array.isArray(demandCurve) || demandCurve.length < 2) {
        return missingStandard("domesticWater.fixtureUnitDemandCurve");
    }
    const fixtureUnitValue = Number(fixtureUnits);
    if (!Number.isFinite(fixtureUnitValue) || fixtureUnitValue < 0) {
        return {
            success: false,
            error: "fixtureUnits must be a non-negative number",
            canCommit: false,
        };
    }
    const points = demandCurve
        .map((point) => ({
            fixtureUnits: Number(point.fixtureUnits),
            flowLs: Number(point.flowLs),
        }))
        .filter((point) => Number.isFinite(point.fixtureUnits) && point.fixtureUnits >= 0 && Number.isFinite(point.flowLs) && point.flowLs >= 0)
        .sort((a, b) => a.fixtureUnits - b.fixtureUnits);
    if (points.length < 2) {
        return missingStandard("domesticWater.fixtureUnitDemandCurve");
    }
    let lower = points[0];
    let upper = points[points.length - 1];
    for (let index = 0; index < points.length - 1; index++) {
        if (fixtureUnitValue >= points[index].fixtureUnits && fixtureUnitValue <= points[index + 1].fixtureUnits) {
            lower = points[index];
            upper = points[index + 1];
            break;
        }
    }
    const span = upper.fixtureUnits - lower.fixtureUnits;
    const ratio = span > 0 ? (fixtureUnitValue - lower.fixtureUnits) / span : 0;
    const flowLs = lower.flowLs + ratio * (upper.flowLs - lower.flowLs);
    return {
        success: true,
        method: "Configured domestic fixture-unit demand curve with linear interpolation",
        input: {
            fixtureUnits: fixtureUnitValue,
            lowerPoint: lower,
            upperPoint: upper,
        },
        output: {
            demandFlowLs: Math.max(0, flowLs),
        },
        assumptions: [
            "Demand curve must be supplied from the office standard or governing design basis.",
            "Interpolation is a proposal foundation; final domestic water design remains engineer-reviewed.",
        ],
        canCommit: false,
        riskLevel: "medium",
    };
}

export function calculateDomesticWaterPressureLoss({
    flowLs,
    diameterMm,
    lengthM,
    staticLiftM = 0,
    water,
} = {}) {
    const length = Number(lengthM);
    if (!Number.isFinite(length) || length < 0) {
        return {
            success: false,
            error: "lengthM must be a non-negative number",
            canCommit: false,
        };
    }
    const friction = pipeFrictionLossPaPerM(flowLs, diameterMm, water);
    if (!friction.success) return friction;
    const densityKgM3 = Number(friction.assumptions?.densityKgM3 || water?.densityKgM3 || 998.2);
    const staticPressurePa = densityKgM3 * 9.80665 * Math.max(0, Number(staticLiftM) || 0);
    const frictionPressurePa = friction.output.pressureLossPaPerM * length;
    return {
        success: true,
        method: "Domestic water pressure loss from Darcy-Weisbach pipe friction plus static lift",
        input: {
            flowLs: Number(flowLs),
            diameterMm: Number(diameterMm),
            lengthM: length,
            staticLiftM: Number(staticLiftM) || 0,
        },
        output: {
            velocityMps: friction.output.velocityMps,
            reynolds: friction.output.reynolds,
            frictionFactor: friction.output.frictionFactor,
            pressureLossPaPerM: friction.output.pressureLossPaPerM,
            frictionPressureLossPa: frictionPressurePa,
            staticPressurePa,
            totalPressureLossPa: frictionPressurePa + staticPressurePa,
            totalPressureLossKPa: (frictionPressurePa + staticPressurePa) / 1000.0,
        },
        assumptions: [
            "Minor losses from fittings, meters, valves, heaters, filters, and backflow devices are excluded unless supplied separately.",
            "Pressure loss is a calculation proposal only and does not imply code-compliant final sizing.",
        ],
        canCommit: false,
        riskLevel: "medium",
    };
}

export function sizeDomesticWaterPipe({
    flowLs,
    maxVelocityMps,
    maxPressureLossPaPerM,
    diametersMm,
    water,
} = {}) {
    const missingStandards = [];
    if (!isPositive(maxVelocityMps)) missingStandards.push("domesticWater.pipeVelocityLimitMps");
    if (!isPositive(maxPressureLossPaPerM)) missingStandards.push("domesticWater.pipeFrictionLimitPaPerM");
    if (missingStandards.length > 0) {
        return {
            success: false,
            requiresOfficeStandard: true,
            missingStandards,
            canCommit: false,
        };
    }
    const sizing = sizePipeByVelocityOrFriction({
        flowLs,
        maxVelocityMps,
        maxPressureLossPaPerM,
        diametersMm,
        water,
    });
    return {
        ...sizing,
        method: "Domestic water pipe size proposal by velocity and friction limits",
        assumptions: [
            "Fixture-unit demand must be converted through an office-approved demand curve before final sizing.",
            "Fittings, valves, meters, equipment, diversity, and minimum code sizes require engineer review.",
        ],
        canCommit: false,
        riskLevel: "medium",
    };
}

export function buildDomesticWaterPipeResizeProposal({
    pipeSizingRequests = [],
    maxVelocityMps,
    maxPressureLossPaPerM,
    diametersMm,
    demandCurve = null,
    water,
} = {}) {
    const missingStandards = [];
    if (!isPositive(maxVelocityMps)) missingStandards.push("domesticWater.pipeVelocityLimitMps");
    if (!isPositive(maxPressureLossPaPerM)) missingStandards.push("domesticWater.pipeFrictionLimitPaPerM");
    if (missingStandards.length > 0) {
        return {
            success: false,
            status: "blocked_missing_office_standard",
            requiresOfficeStandard: true,
            missingStandards,
            rows: [],
            writePlanSteps: [],
            canCommit: false,
            riskLevel: "high",
        };
    }

    const rows = [];
    const writePlanSteps = [];
    const warnings = [];
    let skippedNoDemandCount = 0;
    let skippedNoSizeCount = 0;
    for (const request of Array.isArray(pipeSizingRequests) ? pipeSizingRequests : []) {
        const target = targetForRequest(request);
        const demand = domesticDemandForRequest(request, demandCurve);
        if (!demand.success) {
            skippedNoDemandCount++;
            if (demand.warning) warnings.push(demand.warning);
            continue;
        }
        const sizing = sizeDomesticWaterPipe({
            flowLs: demand.flowLs,
            maxVelocityMps,
            maxPressureLossPaPerM,
            diametersMm,
            water,
        });
        if (!sizing.success || !sizing.selected) {
            skippedNoSizeCount++;
            continue;
        }
        const currentDiameterMm = currentDiameterForRequest(request);
        const lengthM = Number(request?.lengthM);
        const currentFriction = isPositive(currentDiameterMm)
            ? pipeFrictionLossPaPerM(demand.flowLs, currentDiameterMm, water)
            : null;
        const selected = sizing.selected;
        const resizeRequired = isPositive(currentDiameterMm)
            ? Math.abs(Number(selected.diameterMm) - Number(currentDiameterMm)) > 1e-6
            : true;
        const currentLinearPressureLossPa = currentFriction?.success && Number.isFinite(lengthM) && lengthM > 0
            ? currentFriction.output.pressureLossPaPerM * lengthM
            : null;
        const selectedLinearPressureLossPa = Number.isFinite(lengthM) && lengthM > 0
            ? selected.pressureLossPaPerM * lengthM
            : null;
        rows.push({
            rowType: "domestic_water_pipe_sizing_proposal",
            elementId: positiveInteger(request?.elementId),
            eId: isNonEmptyString(request?.eId) ? request.eId.trim() : "",
            uniqueId: request?.uniqueId || "",
            systemName: request?.systemName || "Domestic Water",
            lengthM: Number.isFinite(lengthM) ? lengthM : null,
            fixtureUnits: Number.isFinite(Number(request?.fixtureUnits)) ? Number(request.fixtureUnits) : null,
            designFlowLs: demand.flowLs,
            demandSource: demand.source,
            currentDiameterMm: isPositive(currentDiameterMm) ? Number(currentDiameterMm) : null,
            selectedDiameterMm: selected.diameterMm,
            currentVelocityMps: currentFriction?.success ? currentFriction.output.velocityMps : null,
            selectedVelocityMps: selected.velocityMps,
            currentPressureLossPaPerM: currentFriction?.success ? currentFriction.output.pressureLossPaPerM : null,
            selectedPressureLossPaPerM: selected.pressureLossPaPerM,
            currentLinearPressureLossPa,
            selectedLinearPressureLossPa,
            resizeRequired,
            status: "proposal_ready_for_review",
            source: "domesticWaterPipeSizingRequests + officeStandards.domesticWater",
            canCommit: false,
        });
        if (resizeRequired && target) {
            writePlanSteps.push({
                stepId: `resize-domestic-water-pipe-${target.label}`,
                operation: "resize_pipe",
                dependsOn: [],
                targets: target.targets,
                arguments: {
                    diameter: selected.diameterMm,
                    unit: "mm",
                },
                preconditions: [
                    `Domestic water demand confirmed at ${round(demand.flowLs, 3)} L/s from ${demand.source}.`,
                    `Velocity limit ${round(maxVelocityMps, 3)} m/s and friction limit ${round(maxPressureLossPaPerM, 3)} Pa/m applied.`,
                    "Verify system classification, minimum code size, fittings, valves, meters, heaters, and diversity before commit.",
                ],
                riskLevel: "medium",
            });
        }
    }
    if (skippedNoDemandCount > 0) warnings.push(`Skipped ${skippedNoDemandCount} domestic water pipe sizing request(s) without confirmed flow or fixture-unit demand.`);
    if (skippedNoSizeCount > 0) warnings.push(`Skipped ${skippedNoSizeCount} domestic water pipe sizing request(s) with no configured diameter satisfying limits.`);
    return {
        success: rows.length > 0,
        method: "Domestic water resize_pipe proposal from demand basis and office velocity/friction limits",
        status: rows.length > 0 ? "proposal_ready_for_review" : "blocked_no_sizable_pipe_requests",
        assumptions: [
            "Requests must identify exact Revit pipes by elementId or stable eId before a write-plan commit.",
            "Generated resize_pipe steps are proposal-only and require preview, explicit approval, and verify.",
        ],
        dataCompleteness: proposalDataCompleteness({
            requestCount: Array.isArray(pipeSizingRequests) ? pipeSizingRequests.length : 0,
            rowCount: rows.length,
            writePlanStepCount: writePlanSteps.length,
            skippedNoDemandCount,
            skippedNoSizeCount,
            targetLabel: "domestic water pipe",
        }),
        rows,
        writePlanSteps,
        warnings,
        canCommit: false,
        riskLevel: "high",
    };
}

export function checkRecirculationContinuity({ nodes = [], edges = [], requiredLoopNodeIds = [] } = {}) {
    const graph = new Map();
    for (const node of nodes) graph.set(String(node.id), new Set());
    for (const edge of edges) {
        const a = String(edge.from);
        const b = String(edge.to);
        if (!graph.has(a)) graph.set(a, new Set());
        if (!graph.has(b)) graph.set(b, new Set());
        graph.get(a).add(b);
        graph.get(b).add(a);
    }
    const issues = [];
    for (const nodeId of requiredLoopNodeIds.map(String)) {
        const degree = graph.has(nodeId) ? graph.get(nodeId).size : 0;
        if (degree < 2) {
            issues.push({
                nodeId,
                issue: "recirculation node is not part of a continuous loop",
                degree,
            });
        }
    }
    return {
        success: issues.length === 0,
        method: "Undirected graph degree continuity check",
        issues,
        canCommit: false,
        riskLevel: "medium",
    };
}

function domesticDemandForRequest(request, demandCurve) {
    const explicitFlow = Number(request?.flowLs ?? request?.demandFlowLs);
    if (Number.isFinite(explicitFlow) && explicitFlow > 0) {
        return { success: true, flowLs: explicitFlow, source: "explicit flowLs" };
    }
    const fixtureUnits = Number(request?.fixtureUnits);
    if (Number.isFinite(fixtureUnits) && fixtureUnits >= 0) {
        const demand = convertFixtureUnitsToDemand({ fixtureUnits, demandCurve });
        if (demand.success) {
            return { success: true, flowLs: demand.output.demandFlowLs, source: "fixture-unit demand curve" };
        }
        return {
            success: false,
            warning: `Domestic water request ${targetLabelForRequest(request)} has fixtureUnits but no valid fixture-unit demand curve.`,
        };
    }
    return { success: false };
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
    targetLabel,
}) {
    const blockers = [];
    if (requestCount <= 0) blockers.push(`No ${targetLabel} sizing requests were supplied.`);
    if (rowCount <= 0) blockers.push(`No ${targetLabel} sizing proposal rows were produced.`);
    if (skippedNoDemandCount > 0) blockers.push(`${skippedNoDemandCount} ${targetLabel} sizing request(s) lack confirmed demand.`);
    if (skippedNoSizeCount > 0) blockers.push(`${skippedNoSizeCount} ${targetLabel} sizing request(s) have no configured size satisfying limits.`);
    if (writePlanStepCount <= 0 && rowCount > 0) blockers.push(`No ${targetLabel} resize step was needed or target identity was incomplete.`);
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

function missingStandard(name) {
    return {
        success: false,
        requiresOfficeStandard: true,
        missingStandards: [name],
        canCommit: false,
    };
}
