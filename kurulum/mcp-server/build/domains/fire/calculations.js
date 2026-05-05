import { pipeFrictionLossPaPerM, sizePipeByVelocityOrFriction } from "../hydronic/calculations.js";

export function checkSprinklerCoverage({
    roomWidthM,
    roomLengthM,
    sprinklers = [],
    maxSpacingM = null,
    maxCoverageM2 = null,
    maxWallDistanceM = null,
} = {}) {
    const missingStandards = [];
    if (!isPositive(maxSpacingM)) missingStandards.push("fire.sprinklerSpacingRules.maxSpacingM");
    if (!isPositive(maxCoverageM2)) missingStandards.push("fire.sprinklerSpacingRules.maxCoverageM2");
    if (missingStandards.length > 0) {
        return {
            success: false,
            requiresOfficeStandard: true,
            missingStandards,
            canCommit: false,
        };
    }
    const width = Number(roomWidthM);
    const length = Number(roomLengthM);
    const wallLimit = isPositive(maxWallDistanceM) ? Number(maxWallDistanceM) : Number(maxSpacingM) / 2.0;
    const issues = [];
    const roomAreaM2 = width * length;
    const coveragePerSprinklerM2 = sprinklers.length > 0 ? roomAreaM2 / sprinklers.length : Infinity;
    if (coveragePerSprinklerM2 > Number(maxCoverageM2)) {
        issues.push({
            issue: "coverage_area_exceeds_limit",
            coveragePerSprinklerM2,
            maxCoverageM2: Number(maxCoverageM2),
        });
    }
    for (let i = 0; i < sprinklers.length; i++) {
        const s = sprinklers[i];
        const wallDistance = Math.min(Number(s.x), Number(s.y), width - Number(s.x), length - Number(s.y));
        if (wallDistance > wallLimit) {
            issues.push({
                issue: "wall_distance_exceeds_limit",
                sprinklerIndex: i,
                wallDistanceM: wallDistance,
                maxWallDistanceM: wallLimit,
            });
        }
        for (let j = i + 1; j < sprinklers.length; j++) {
            const other = sprinklers[j];
            const distance = Math.hypot(Number(s.x) - Number(other.x), Number(s.y) - Number(other.y));
            if (distance > Number(maxSpacingM)) {
                issues.push({
                    issue: "sprinkler_spacing_exceeds_limit",
                    sprinklerIndexes: [i, j],
                    distanceM: distance,
                    maxSpacingM: Number(maxSpacingM),
                });
            }
        }
    }
    return {
        success: issues.length === 0,
        method: "Rectangular room sprinkler spacing/coverage screening",
        assumptions: [
            "Obstructions, ceiling features, hazard classification, and code-specific hydraulic criteria are not evaluated.",
            "Result is a coverage screening proposal, not final fire protection design.",
        ],
        output: {
            roomAreaM2,
            sprinklerCount: sprinklers.length,
            coveragePerSprinklerM2,
            wallLimitM: wallLimit,
        },
        issues,
        canCommit: false,
        riskLevel: "critical",
    };
}

export function checkFireCabinetCoverage({
    cabinets = [],
    targetPoints = [],
    maxHoseReachM = null,
} = {}) {
    if (!isPositive(maxHoseReachM)) {
        return {
            success: false,
            requiresOfficeStandard: true,
            missingStandards: ["fire.fireCabinetMaxHoseReachM"],
            canCommit: false,
        };
    }
    const reach = Number(maxHoseReachM);
    const rows = [];
    const issues = [];
    for (const [index, target] of (Array.isArray(targetPoints) ? targetPoints : []).entries()) {
        const nearest = nearestCabinet(target, cabinets);
        const covered = nearest !== null && nearest.distanceM <= reach;
        const row = {
            targetIndex: index,
            nearestCabinetIndex: nearest?.index ?? null,
            distanceM: nearest?.distanceM ?? null,
            maxHoseReachM: reach,
            covered,
        };
        rows.push(row);
        if (!covered) {
            issues.push({
                targetIndex: index,
                issue: "target point is outside configured fire cabinet hose reach",
                nearestCabinetDistanceM: nearest?.distanceM ?? null,
                maxHoseReachM: reach,
            });
        }
    }
    return {
        success: issues.length === 0,
        method: "Fire cabinet coverage screening by nearest hose reach",
        rows,
        issues,
        assumptions: [
            "Target points must be supplied by room/egress coverage logic or engineer selection.",
            "Obstructions, hose route geometry, cabinet mounting rules, and local fire authority criteria are not evaluated.",
        ],
        canCommit: false,
        riskLevel: "critical",
    };
}

export function calculateFireCabinetDemand({
    cabinetCount,
    flowLpmPerCabinet = null,
    simultaneousCabinetCount = null,
} = {}) {
    if (!isPositive(flowLpmPerCabinet)) {
        return {
            success: false,
            requiresOfficeStandard: true,
            missingStandards: ["fire.fireCabinetFlowLpm"],
            canCommit: false,
        };
    }
    const count = Math.max(0, Number(cabinetCount) || 0);
    const simultaneous = isPositive(simultaneousCabinetCount)
        ? Math.min(count, Number(simultaneousCabinetCount))
        : count;
    const totalFlowLpm = simultaneous * Number(flowLpmPerCabinet);
    return {
        success: count > 0 && simultaneous > 0,
        method: "Fire cabinet demand basis from configured cabinet flow and simultaneous count",
        input: {
            cabinetCount: count,
            flowLpmPerCabinet: Number(flowLpmPerCabinet),
            simultaneousCabinetCount: simultaneous,
        },
        output: {
            totalFlowLpm,
            totalFlowLs: totalFlowLpm / 60.0,
        },
        assumptions: [
            "Simultaneous cabinet count must follow office/fire authority criteria.",
            "Demand is a basis for review and is not a final fire hydraulic design.",
        ],
        canCommit: false,
        riskLevel: "critical",
    };
}

export function calculateFirePumpBasis({
    cabinetDemand,
    sprinklerDemandLpm = 0,
    residualPressureBar = null,
    staticLiftM = 0,
    pipeLossKPa = 0,
    equipmentLossKPa = 0,
    safetyFactor = 1.0,
} = {}) {
    if (!isPositive(residualPressureBar)) {
        return {
            success: false,
            requiresOfficeStandard: true,
            missingStandards: ["fire.fireCabinetPressureBar"],
            canCommit: false,
        };
    }
    const cabinetFlowLpm = Number(cabinetDemand?.output?.totalFlowLpm ?? cabinetDemand?.totalFlowLpm ?? 0);
    const totalFlowLpm = Math.max(0, cabinetFlowLpm) + Math.max(0, Number(sprinklerDemandLpm) || 0);
    const staticPressureKPa = 9.80665 * Math.max(0, Number(staticLiftM) || 0);
    const residualPressureKPa = Number(residualPressureBar) * 100.0;
    const basePressureKPa = residualPressureKPa +
        staticPressureKPa +
        Math.max(0, Number(pipeLossKPa) || 0) +
        Math.max(0, Number(equipmentLossKPa) || 0);
    const factor = isPositive(safetyFactor) ? Number(safetyFactor) : 1.0;
    return {
        success: totalFlowLpm > 0,
        method: "Fire pump flow/pressure basis from cabinet demand, sprinkler demand, residual pressure, static lift, and supplied losses",
        input: {
            cabinetFlowLpm,
            sprinklerDemandLpm: Math.max(0, Number(sprinklerDemandLpm) || 0),
            residualPressureBar: Number(residualPressureBar),
            staticLiftM: Number(staticLiftM) || 0,
            pipeLossKPa: Number(pipeLossKPa) || 0,
            equipmentLossKPa: Number(equipmentLossKPa) || 0,
            safetyFactor: factor,
        },
        output: {
            requiredFlowLpm: totalFlowLpm,
            requiredFlowLs: totalFlowLpm / 60.0,
            residualPressureKPa,
            staticPressureKPa,
            basePressureKPa,
            requiredPressureKPa: basePressureKPa * factor,
            requiredPressureBar: basePressureKPa * factor / 100.0,
        },
        assumptions: [
            "Sprinkler demand, hose streams, duration, authority criteria, and pump selection rules must be confirmed by the fire engineer.",
            "This is a pump basis proposal only and must not trigger equipment replacement automatically.",
        ],
        canCommit: false,
        riskLevel: "critical",
    };
}

export function buildFireProtectionPipeResizeProposal({
    pipeSizingRequests = [],
    flowLpmPerCabinet = null,
    simultaneousFireCabinetCount = null,
    maxVelocityMps = null,
    maxPressureLossPaPerM = null,
    diametersMm,
    water,
} = {}) {
    const missingStandards = [];
    if (!isPositive(maxVelocityMps)) missingStandards.push("fire.pipeVelocityLimitMps");
    if (!isPositive(maxPressureLossPaPerM)) missingStandards.push("fire.pipeFrictionLimitPaPerM");
    if (missingStandards.length > 0) {
        return {
            success: false,
            status: "blocked_missing_office_standard",
            requiresOfficeStandard: true,
            missingStandards,
            rows: [],
            writePlanSteps: [],
            canCommit: false,
            riskLevel: "critical",
        };
    }

    const rows = [];
    const writePlanSteps = [];
    const warnings = [];
    let skippedNoDemandCount = 0;
    let skippedNoSizeCount = 0;
    for (const request of Array.isArray(pipeSizingRequests) ? pipeSizingRequests : []) {
        const target = targetForRequest(request);
        const demand = fireDemandForRequest({
            request,
            flowLpmPerCabinet,
            simultaneousFireCabinetCount,
        });
        if (!demand.success) {
            skippedNoDemandCount++;
            if (demand.warning) warnings.push(demand.warning);
            continue;
        }
        const sizing = sizePipeByVelocityOrFriction({
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
            rowType: "fire_pipe_sizing_proposal",
            elementId: positiveInteger(request?.elementId),
            eId: isNonEmptyString(request?.eId) ? request.eId.trim() : "",
            uniqueId: request?.uniqueId || "",
            systemName: request?.systemName || "Fire Protection",
            demandType: demand.demandType,
            lengthM: Number.isFinite(lengthM) ? lengthM : null,
            cabinetCount: Number.isFinite(Number(request?.cabinetCount)) ? Number(request.cabinetCount) : null,
            sprinklerDemandLpm: Number.isFinite(Number(request?.sprinklerDemandLpm)) ? Number(request.sprinklerDemandLpm) : 0,
            designFlowLpm: demand.flowLpm,
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
            status: "proposal_ready_for_fire_engineer_review",
            source: "firePipeSizingRequests + officeStandards.fire",
            canCommit: false,
        });
        if (resizeRequired && target) {
            writePlanSteps.push({
                stepId: `resize-fire-pipe-${target.label}`,
                operation: "resize_pipe",
                dependsOn: [],
                targets: target.targets,
                arguments: {
                    diameter: selected.diameterMm,
                    unit: "mm",
                },
                preconditions: [
                    `Fire protection demand confirmed at ${round(demand.flowLpm, 3)} L/min from ${demand.source}.`,
                    `Velocity limit ${round(maxVelocityMps, 3)} m/s and friction limit ${round(maxPressureLossPaPerM, 3)} Pa/m applied.`,
                    "Fire authority basis, hydraulic standard, hose streams, sprinkler demand, residual pressure, and pump basis must be approved before commit.",
                ],
                riskLevel: "critical",
            });
        }
    }
    if (skippedNoDemandCount > 0) warnings.push(`Skipped ${skippedNoDemandCount} fire pipe sizing request(s) without confirmed fire flow demand.`);
    if (skippedNoSizeCount > 0) warnings.push(`Skipped ${skippedNoSizeCount} fire pipe sizing request(s) with no configured diameter satisfying limits.`);
    return {
        success: rows.length > 0,
        method: "Fire protection resize_pipe proposal from fire demand basis and office velocity/friction limits",
        status: rows.length > 0 ? "proposal_ready_for_fire_engineer_review" : "blocked_no_sizable_fire_pipe_requests",
        assumptions: [
            "Fire pipe sizing requests must identify exact Revit pipes by elementId or stable eId before a write-plan commit.",
            "Generated resize_pipe steps are proposal-only and require fire-engineer review, preview, explicit approval, and verify.",
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
        riskLevel: "critical",
    };
}

function nearestCabinet(target, cabinets) {
    let nearest = null;
    for (const [index, cabinet] of (Array.isArray(cabinets) ? cabinets : []).entries()) {
        const distanceM = Math.hypot(Number(target.x) - Number(cabinet.x), Number(target.y) - Number(cabinet.y));
        if (!Number.isFinite(distanceM)) continue;
        if (!nearest || distanceM < nearest.distanceM) {
            nearest = { index, distanceM };
        }
    }
    return nearest;
}

function fireDemandForRequest({ request, flowLpmPerCabinet, simultaneousFireCabinetCount }) {
    const explicitLpm = Number(request?.flowLpm ?? request?.demandFlowLpm);
    if (Number.isFinite(explicitLpm) && explicitLpm > 0) {
        return {
            success: true,
            flowLpm: explicitLpm,
            flowLs: explicitLpm / 60.0,
            demandType: "explicit_fire_flow",
            source: "explicit flowLpm",
        };
    }
    const explicitLs = Number(request?.flowLs ?? request?.demandFlowLs);
    if (Number.isFinite(explicitLs) && explicitLs > 0) {
        return {
            success: true,
            flowLpm: explicitLs * 60.0,
            flowLs: explicitLs,
            demandType: "explicit_fire_flow",
            source: "explicit flowLs",
        };
    }
    const cabinetCount = Number(request?.cabinetCount);
    const sprinklerDemandLpm = Math.max(0, Number(request?.sprinklerDemandLpm) || 0);
    if (Number.isFinite(cabinetCount) && cabinetCount > 0) {
        const cabinetDemand = calculateFireCabinetDemand({
            cabinetCount,
            flowLpmPerCabinet,
            simultaneousCabinetCount: simultaneousFireCabinetCount,
        });
        if (cabinetDemand.success) {
            const flowLpm = cabinetDemand.output.totalFlowLpm + sprinklerDemandLpm;
            return {
                success: flowLpm > 0,
                flowLpm,
                flowLs: flowLpm / 60.0,
                demandType: sprinklerDemandLpm > 0 ? "cabinet_plus_sprinkler" : "fire_cabinet",
                source: "configured cabinet demand basis",
            };
        }
        return {
            success: false,
            warning: `Fire pipe request ${targetLabelForRequest(request)} has cabinetCount but no valid cabinet flow/simultaneous standard.`,
        };
    }
    if (sprinklerDemandLpm > 0) {
        return {
            success: true,
            flowLpm: sprinklerDemandLpm,
            flowLs: sprinklerDemandLpm / 60.0,
            demandType: "sprinkler",
            source: "explicit sprinklerDemandLpm",
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
}) {
    const blockers = [];
    if (requestCount <= 0) blockers.push("No fire pipe sizing requests were supplied.");
    if (rowCount <= 0) blockers.push("No fire pipe sizing proposal rows were produced.");
    if (skippedNoDemandCount > 0) blockers.push(`${skippedNoDemandCount} fire pipe sizing request(s) lack confirmed demand.`);
    if (skippedNoSizeCount > 0) blockers.push(`${skippedNoSizeCount} fire pipe sizing request(s) have no configured size satisfying demand.`);
    if (writePlanStepCount <= 0 && rowCount > 0) blockers.push("No fire pipe resize step was needed or target identity was incomplete.");
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
