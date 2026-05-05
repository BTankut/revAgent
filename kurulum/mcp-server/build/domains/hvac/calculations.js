import { analyzeWeightedNetwork } from "../network/calculations.js";

const defaultAir = {
    densityKgM3: 1.2,
    dynamicViscosityPaS: 1.81e-5,
    roughnessM: 0.00015,
};

const defaultRectangularSizesMm = [
    150, 200, 250, 300, 350, 400, 450, 500, 550, 600,
    700, 800, 900, 1000, 1100, 1200, 1400, 1600,
];

export function flowM3hToM3s(flowM3h) {
    return Number(flowM3h) / 3600.0;
}

export function rectangularDuctAreaM2(widthMm, heightMm) {
    return (Number(widthMm) / 1000.0) * (Number(heightMm) / 1000.0);
}

export function rectangularHydraulicDiameterM(widthMm, heightMm) {
    const widthM = Number(widthMm) / 1000.0;
    const heightM = Number(heightMm) / 1000.0;
    if (widthM <= 0 || heightM <= 0) return 0;
    return (2.0 * widthM * heightM) / (widthM + heightM);
}

export function ductVelocityMps(flowM3h, widthMm, heightMm) {
    const area = rectangularDuctAreaM2(widthMm, heightMm);
    if (area <= 0) return 0;
    return flowM3hToM3s(flowM3h) / area;
}

export function darcyFrictionFactor({ reynolds, diameterM, roughnessM }) {
    const re = Number(reynolds);
    const diameter = Number(diameterM);
    const roughness = Number(roughnessM);
    if (re <= 0 || diameter <= 0) return 0;
    if (re < 2300) return 64.0 / re;
    const term = roughness / (3.7 * diameter) + 5.74 / Math.pow(re, 0.9);
    return 0.25 / Math.pow(Math.log10(term), 2);
}

export function ductFrictionLossPaPerM(flowM3h, widthMm, heightMm, air = {}) {
    const props = { ...defaultAir, ...(air || {}) };
    const velocity = ductVelocityMps(flowM3h, widthMm, heightMm);
    const hydraulicDiameter = rectangularHydraulicDiameterM(widthMm, heightMm);
    if (hydraulicDiameter <= 0) {
        return invalidResult("Invalid duct dimensions.");
    }
    const reynolds = props.densityKgM3 * velocity * hydraulicDiameter / props.dynamicViscosityPaS;
    const frictionFactor = darcyFrictionFactor({
        reynolds,
        diameterM: hydraulicDiameter,
        roughnessM: props.roughnessM,
    });
    const pressureLossPaPerM = frictionFactor * props.densityKgM3 * velocity * velocity / (2.0 * hydraulicDiameter);
    return {
        success: true,
        method: "Darcy-Weisbach with Swamee-Jain turbulent friction factor",
        assumptions: {
            densityKgM3: props.densityKgM3,
            dynamicViscosityPaS: props.dynamicViscosityPaS,
            roughnessM: props.roughnessM,
        },
        input: {
            flowM3h: Number(flowM3h),
            widthMm: Number(widthMm),
            heightMm: Number(heightMm),
        },
        output: {
            flowM3s: flowM3hToM3s(flowM3h),
            areaM2: rectangularDuctAreaM2(widthMm, heightMm),
            hydraulicDiameterM: hydraulicDiameter,
            velocityMps: velocity,
            reynolds,
            frictionFactor,
            pressureLossPaPerM,
        },
        riskLevel: "medium",
    };
}

export function sizeRectangularDuctEqualFriction({
    flowM3h,
    targetPaPerM,
    maxVelocityMps,
    aspectRatioMax = 4,
    sizesMm = defaultRectangularSizesMm,
    air,
}) {
    const missingStandards = [];
    if (!isFinitePositive(targetPaPerM)) missingStandards.push("hvac.ductEqualFrictionTargetPaPerM");
    if (!isFinitePositive(maxVelocityMps)) missingStandards.push("hvac.ductVelocityLimitsMps");
    if (missingStandards.length > 0) {
        return {
            success: false,
            requiresOfficeStandard: true,
            missingStandards,
            assumptions: [],
            canCommit: false,
        };
    }

    const candidates = [];
    const sortedSizes = [...sizesMm].map(Number).filter((value) => value > 0).sort((a, b) => a - b);
    for (const widthMm of sortedSizes) {
        for (const heightMm of sortedSizes) {
            const aspect = Math.max(widthMm, heightMm) / Math.min(widthMm, heightMm);
            if (aspect > Number(aspectRatioMax)) continue;
            const result = ductFrictionLossPaPerM(flowM3h, widthMm, heightMm, air);
            if (!result.success) continue;
            const velocity = result.output.velocityMps;
            const pressureLoss = result.output.pressureLossPaPerM;
            if (velocity <= Number(maxVelocityMps) && pressureLoss <= Number(targetPaPerM)) {
                candidates.push({
                    widthMm,
                    heightMm,
                    areaM2: result.output.areaM2,
                    velocityMps: velocity,
                    pressureLossPaPerM: pressureLoss,
                    hydraulicDiameterM: result.output.hydraulicDiameterM,
                    frictionFactor: result.output.frictionFactor,
                });
            }
        }
    }

    candidates.sort((a, b) => {
        if (a.areaM2 !== b.areaM2) return a.areaM2 - b.areaM2;
        const aAspect = Math.max(a.widthMm, a.heightMm) / Math.min(a.widthMm, a.heightMm);
        const bAspect = Math.max(b.widthMm, b.heightMm) / Math.min(b.widthMm, b.heightMm);
        return aAspect - bAspect;
    });

    return {
        success: candidates.length > 0,
        method: "Grid search over configured rectangular duct sizes using Darcy-Weisbach friction loss",
        assumptions: [
            "Duct fitting/accessory local losses are not included.",
            "Result is a sizing proposal until office standards and project constraints are confirmed.",
        ],
        input: {
            flowM3h: Number(flowM3h),
            targetPaPerM: Number(targetPaPerM),
            maxVelocityMps: Number(maxVelocityMps),
            aspectRatioMax: Number(aspectRatioMax),
        },
        selected: candidates[0] || null,
        candidateCount: candidates.length,
        canCommit: false,
        riskLevel: "medium",
    };
}

export function buildHvacDuctResizeProposal({
    ductSamples = [],
    designFlowsByElementId = {},
    defaultFlowM3h,
    targetPaPerM,
    maxVelocityMps,
    aspectRatioMax = 4,
    sizesMm = defaultRectangularSizesMm,
    air,
    localLossExtraction,
    localLossPressurePa,
    criticalPathLocalLossComplete = false,
    targetElementIds = [],
} = {}) {
    const missingStandards = [];
    if (!isFinitePositive(targetPaPerM)) missingStandards.push("hvac.ductEqualFrictionTargetPaPerM");
    if (!isFinitePositive(maxVelocityMps)) missingStandards.push("hvac.ductVelocityLimitsMps");
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

    const localLossContext = criticalPathLocalLossContext({
        localLossExtraction,
        localLossPressurePa,
        criticalPathLocalLossComplete,
    });
    const warnings = [...localLossContext.warnings];
    const targetSet = numericSet(targetElementIds);
    const rows = [];
    const writePlanSteps = [];
    let skippedNoFlowCount = 0;
    let skippedNoSizeCount = 0;

    for (const sample of Array.isArray(ductSamples) ? ductSamples : []) {
        const elementId = positiveInteger(sample?.elementId);
        if (targetSet.size > 0 && (!elementId || !targetSet.has(elementId))) continue;
        const flowM3h = flowForElement({ sample, designFlowsByElementId, defaultFlowM3h });
        if (!isFinitePositive(flowM3h)) {
            skippedNoFlowCount++;
            continue;
        }
        const currentWidthMm = Number(sample?.widthMm);
        const currentHeightMm = Number(sample?.heightMm);
        const lengthM = Number(sample?.lengthM);
        const sizing = sizeRectangularDuctEqualFriction({
            flowM3h,
            targetPaPerM,
            maxVelocityMps,
            aspectRatioMax,
            sizesMm,
            air,
        });
        if (!sizing.success || !sizing.selected) {
            skippedNoSizeCount++;
            continue;
        }
        const currentFriction = isFinitePositive(currentWidthMm) && isFinitePositive(currentHeightMm)
            ? ductFrictionLossPaPerM(flowM3h, currentWidthMm, currentHeightMm, air)
            : null;
        const selected = sizing.selected;
        const selectedLinearPressureLossPa = Number.isFinite(lengthM) && lengthM > 0
            ? selected.pressureLossPaPerM * lengthM
            : null;
        const currentLinearPressureLossPa = currentFriction?.success && Number.isFinite(lengthM) && lengthM > 0
            ? currentFriction.output.pressureLossPaPerM * lengthM
            : null;
        const resizeRequired = isFinitePositive(currentWidthMm) && isFinitePositive(currentHeightMm)
            ? Math.abs(Number(selected.widthMm) - currentWidthMm) > 1e-6 ||
                Math.abs(Number(selected.heightMm) - currentHeightMm) > 1e-6
            : true;
        const row = {
            rowType: "hvac_duct_sizing_proposal",
            elementId,
            uniqueId: sample?.uniqueId || "",
            systemName: sample?.systemName || "(unassigned)",
            lengthM: Number.isFinite(lengthM) ? lengthM : null,
            designFlowM3h: Number(flowM3h),
            currentWidthMm: Number.isFinite(currentWidthMm) ? currentWidthMm : null,
            currentHeightMm: Number.isFinite(currentHeightMm) ? currentHeightMm : null,
            selectedWidthMm: selected.widthMm,
            selectedHeightMm: selected.heightMm,
            currentVelocityMps: currentFriction?.success ? currentFriction.output.velocityMps : null,
            selectedVelocityMps: selected.velocityMps,
            currentPressureLossPaPerM: currentFriction?.success ? currentFriction.output.pressureLossPaPerM : null,
            selectedPressureLossPaPerM: selected.pressureLossPaPerM,
            currentLinearPressureLossPa,
            selectedLinearPressureLossPa,
            criticalPathLocalLossPressurePa: localLossContext.pressurePa,
            localLossDatasetComplete: localLossContext.complete,
            resizeRequired,
            status: localLossContext.complete ? "proposal_ready_for_review" : "needs_complete_critical_path_local_loss",
            source: "ductSamples + designFlowsByElementId/defaultFlowM3h",
            canCommit: false,
        };
        rows.push(row);
        if (resizeRequired && elementId) {
            writePlanSteps.push({
                stepId: `resize-duct-${elementId}`,
                operation: "resize_duct",
                dependsOn: [],
                targets: { elementId },
                arguments: {
                    width: selected.widthMm,
                    height: selected.heightMm,
                    unit: "mm",
                },
                preconditions: [
                    `Design flow confirmed at ${round(flowM3h, 3)} m3/h.`,
                    `Equal-friction target ${round(targetPaPerM, 3)} Pa/m and velocity limit ${round(maxVelocityMps, 3)} m/s applied.`,
                    localLossContext.complete
                        ? "Critical-path local-loss dataset is targeted and pressure-checked."
                        : "Complete critical-path local-loss dataset must be confirmed before commit.",
                ],
                riskLevel: "medium",
            });
        }
    }

    if (rows.length === 0 && targetSet.size > 0) {
        warnings.push("No duct samples matched the requested HVAC duct sizing target element ids.");
    }
    if (skippedNoFlowCount > 0) {
        warnings.push(`Skipped ${skippedNoFlowCount} duct sample(s) without a design airflow.`);
    }
    if (skippedNoSizeCount > 0) {
        warnings.push(`Skipped ${skippedNoSizeCount} duct sample(s) with no configured size satisfying equal-friction and velocity limits.`);
    }
    const dataCompleteness = proposalDataCompleteness({
        sampleCount: Array.isArray(ductSamples) ? ductSamples.length : 0,
        targetCount: targetSet.size,
        rowCount: rows.length,
        writePlanStepCount: writePlanSteps.length,
        skippedNoFlowCount,
        skippedNoSizeCount,
        localLossContext,
        targetLabel: "duct",
    });

    return {
        success: rows.length > 0,
        method: "HVAC duct resize proposal from live duct samples, design airflow, office equal-friction/velocity limits, and critical-path local-loss context",
        status: rows.length === 0
            ? "blocked_no_sizable_duct_samples"
            : localLossContext.complete
                ? "proposal_ready_for_review"
                : "needs_complete_critical_path_local_loss",
        assumptions: [
            "Duct samples are read-only Revit length/size observations; design airflows must be supplied or explicitly defaulted.",
            "Local-loss pressure is treated as critical-path context, not silently distributed across duct segments.",
            "Generated resize_duct steps are proposals only and remain canCommit=false until the engineer approves a write plan.",
        ],
        input: {
            sampleCount: Array.isArray(ductSamples) ? ductSamples.length : 0,
            targetElementIds: [...targetSet],
            defaultFlowM3h: isFinitePositive(defaultFlowM3h) ? Number(defaultFlowM3h) : null,
            targetPaPerM: Number(targetPaPerM),
            maxVelocityMps: Number(maxVelocityMps),
            aspectRatioMax: Number(aspectRatioMax),
        },
        localLossContext,
        dataCompleteness,
        rows,
        writePlanSteps,
        warnings,
        canCommit: false,
        riskLevel: "high",
    };
}

function proposalDataCompleteness({
    sampleCount,
    targetCount,
    rowCount,
    writePlanStepCount,
    skippedNoFlowCount,
    skippedNoSizeCount,
    localLossContext,
    targetLabel,
}) {
    const blockers = [];
    if (rowCount <= 0) blockers.push(`No sizable ${targetLabel} samples produced proposal rows.`);
    if (targetCount > 0 && rowCount < targetCount) blockers.push(`Only ${rowCount} of ${targetCount} requested ${targetLabel} targets produced proposal rows.`);
    if (skippedNoFlowCount > 0) blockers.push(`${skippedNoFlowCount} ${targetLabel} sample(s) lack confirmed design flow.`);
    if (skippedNoSizeCount > 0) blockers.push(`${skippedNoSizeCount} ${targetLabel} sample(s) have no configured size satisfying limits.`);
    if (!localLossContext.complete) blockers.push("Complete selected critical-path local-loss dataset is missing or inconsistent.");
    return {
        sampleCount,
        targetCount,
        proposalRowCount: rowCount,
        writePlanStepCount,
        skippedNoFlowCount,
        skippedNoSizeCount,
        localLossDatasetComplete: localLossContext.complete,
        completeForProductionReview: blockers.length === 0,
        blockers,
    };
}

export function calculateFanPressureBasis({
    network,
    equipmentLossPa = 0,
    localLossPressurePa = 0,
    terminalAllowancePa = 0,
    safetyFactor = 1.1,
} = {}) {
    const traversal = analyzeWeightedNetwork(network || {});
    if (!traversal.success) {
        return {
            success: false,
            errors: traversal.errors || [],
            warnings: traversal.warnings || [],
            canCommit: false,
        };
    }
    if (!traversal.criticalPath) {
        return {
            success: false,
            errors: ["At least one reachable terminal demand or terminal node is required."],
            warnings: traversal.warnings || [],
            canCommit: false,
        };
    }
    const terminalDemands = network?.terminalDemands || {};
    const requiredFlowM3h = Object.values(terminalDemands).reduce((sum, value) => {
        const demand = Number(value);
        return sum + (Number.isFinite(demand) && demand > 0 ? demand : 0);
    }, 0);
    const basePressurePa = Number(traversal.criticalPath.totalLossPa || 0) +
        Math.max(0, Number(equipmentLossPa || 0)) +
        Math.max(0, Number(localLossPressurePa || 0)) +
        Math.max(0, Number(terminalAllowancePa || 0));
    const factor = Number.isFinite(Number(safetyFactor)) && Number(safetyFactor) > 0
        ? Number(safetyFactor)
        : 1.0;
    return {
        success: true,
        method: "Fan basis from weighted connector/network critical path plus equipment and terminal allowance",
        assumptions: [
            "Network edge loss is supplied by upstream calculation or read-only model analysis.",
            "Terminal demand values are treated as airflow in m3/h.",
            "Selection is a basis/proposal only; no equipment replacement is committed.",
        ],
        input: {
            equipmentLossPa: Number(equipmentLossPa || 0),
            localLossPressurePa: Number(localLossPressurePa || 0),
            terminalAllowancePa: Number(terminalAllowancePa || 0),
            safetyFactor: factor,
        },
        output: {
            requiredFlowM3h,
            criticalPathLossPa: traversal.criticalPath.totalLossPa,
            localLossPressurePa: Math.max(0, Number(localLossPressurePa || 0)),
            basePressurePa,
            requiredPressurePa: basePressurePa * factor,
            criticalPath: traversal.criticalPath,
        },
        traversal,
        canCommit: false,
        riskLevel: "high",
    };
}

function invalidResult(message) {
    return {
        success: false,
        error: message,
        canCommit: false,
    };
}

function criticalPathLocalLossContext({ localLossExtraction, localLossPressurePa, criticalPathLocalLossComplete }) {
    const warnings = [];
    if (localLossExtraction) {
        const pressurePa = finiteOrZero(
            localLossExtraction.pressureContribution?.totalPressureDropPa ??
            localLossExtraction.totalPressureDropPa
        );
        const targeted = localLossExtraction.targetedByCriticalPath === true ||
            localLossExtraction.criticalPathSelection?.success === true;
        const consistent = localLossExtraction.selectedPathPressureCheck?.consistent !== false;
        const extractionWarnings = Array.isArray(localLossExtraction.warnings)
            ? localLossExtraction.warnings.map(String)
            : [];
        const truncated = extractionWarnings.some((warning) => /truncated|uninspected/i.test(warning));
        if (!targeted) warnings.push("Critical-path local-loss extraction is not tied to a selected connector path.");
        if (!consistent) warnings.push("Critical-path local-loss pressure check is inconsistent.");
        if (truncated) warnings.push("Critical-path local-loss extraction was truncated or incomplete.");
        return {
            source: "localLossExtraction.pressureContribution.totalPressureDropPa",
            pressurePa,
            pressureKPa: pressurePa / 1000.0,
            targetedByCriticalPath: targeted,
            pressureCheckConsistent: consistent,
            complete: targeted && consistent && !truncated,
            warnings,
            canCommit: false,
        };
    }
    if (Number.isFinite(Number(localLossPressurePa))) {
        const pressurePa = Math.max(0, Number(localLossPressurePa));
        if (criticalPathLocalLossComplete !== true) {
            warnings.push("Critical-path local-loss pressure was supplied directly but not marked as a complete targeted dataset.");
        }
        return {
            source: "criticalPathLocalLossPressurePa",
            pressurePa,
            pressureKPa: pressurePa / 1000.0,
            targetedByCriticalPath: Boolean(criticalPathLocalLossComplete),
            pressureCheckConsistent: Boolean(criticalPathLocalLossComplete),
            complete: Boolean(criticalPathLocalLossComplete),
            warnings,
            canCommit: false,
        };
    }
    warnings.push("Complete critical-path local-loss pressure dataset is required before production final sizing.");
    return {
        source: "none",
        pressurePa: 0,
        pressureKPa: 0,
        targetedByCriticalPath: false,
        pressureCheckConsistent: false,
        complete: false,
        warnings,
        canCommit: false,
    };
}

function flowForElement({ sample, designFlowsByElementId, defaultFlowM3h }) {
    const elementId = sample?.elementId;
    const candidates = [
        designFlowsByElementId?.[elementId],
        designFlowsByElementId?.[String(elementId)],
        sample?.designFlowM3h,
        defaultFlowM3h,
    ];
    for (const candidate of candidates) {
        if (isFinitePositive(candidate)) return Number(candidate);
    }
    return null;
}

function numericSet(values) {
    const result = new Set();
    for (const value of Array.isArray(values) ? values : []) {
        const numeric = positiveInteger(value);
        if (numeric) result.add(numeric);
    }
    return result;
}

function positiveInteger(value) {
    const numeric = Number.parseInt(String(value), 10);
    return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function finiteOrZero(value) {
    return Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
}

function round(value, decimals) {
    const factor = Math.pow(10, decimals);
    return Math.round(Number(value) * factor) / factor;
}

function isFinitePositive(value) {
    return value !== null && value !== undefined && Number.isFinite(Number(value)) && Number(value) > 0;
}
