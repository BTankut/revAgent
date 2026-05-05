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

function isPositive(value) {
    return value !== null && value !== undefined && Number.isFinite(Number(value)) && Number(value) > 0;
}
