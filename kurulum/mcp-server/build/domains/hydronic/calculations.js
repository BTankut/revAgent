import { analyzeWeightedNetwork, inferFlowDirections } from "../network/calculations.js";

const defaultWater = {
    densityKgM3: 998.2,
    dynamicViscosityPaS: 0.001003,
    roughnessM: 0.000045,
};

const defaultPipeDiametersMm = [
    15, 20, 25, 32, 40, 50, 65, 80, 100, 125, 150, 200,
];

export function flowLsToM3s(flowLs) {
    return Number(flowLs) / 1000.0;
}

export function circularAreaM2(diameterMm) {
    const diameterM = Number(diameterMm) / 1000.0;
    return Math.PI * diameterM * diameterM / 4.0;
}

export function pipeVelocityMps(flowLs, diameterMm) {
    const area = circularAreaM2(diameterMm);
    if (area <= 0) return 0;
    return flowLsToM3s(flowLs) / area;
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

export function pipeFrictionLossPaPerM(flowLs, diameterMm, water = {}) {
    const props = { ...defaultWater, ...(water || {}) };
    const diameterM = Number(diameterMm) / 1000.0;
    if (diameterM <= 0) {
        return {
            success: false,
            error: "Invalid pipe diameter.",
            canCommit: false,
        };
    }
    const velocity = pipeVelocityMps(flowLs, diameterMm);
    const reynolds = props.densityKgM3 * velocity * diameterM / props.dynamicViscosityPaS;
    const frictionFactor = darcyFrictionFactor({
        reynolds,
        diameterM,
        roughnessM: props.roughnessM,
    });
    const pressureLossPaPerM = frictionFactor * props.densityKgM3 * velocity * velocity / (2.0 * diameterM);
    return {
        success: true,
        method: "Darcy-Weisbach with Swamee-Jain turbulent friction factor",
        assumptions: {
            densityKgM3: props.densityKgM3,
            dynamicViscosityPaS: props.dynamicViscosityPaS,
            roughnessM: props.roughnessM,
        },
        input: {
            flowLs: Number(flowLs),
            diameterMm: Number(diameterMm),
        },
        output: {
            flowM3s: flowLsToM3s(flowLs),
            areaM2: circularAreaM2(diameterMm),
            velocityMps: velocity,
            reynolds,
            frictionFactor,
            pressureLossPaPerM,
        },
        riskLevel: "medium",
    };
}

export function sizePipeByVelocityOrFriction({
    flowLs,
    maxVelocityMps,
    maxPressureLossPaPerM,
    diametersMm = defaultPipeDiametersMm,
    water,
}) {
    const missingStandards = [];
    if (!isFinitePositive(maxVelocityMps)) missingStandards.push("hydronic.pipeVelocityLimitsMps");
    if (!isFinitePositive(maxPressureLossPaPerM)) missingStandards.push("hydronic.pipeFrictionLimitPaPerM");
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
    for (const diameterMm of [...diametersMm].map(Number).filter((value) => value > 0).sort((a, b) => a - b)) {
        const result = pipeFrictionLossPaPerM(flowLs, diameterMm, water);
        if (!result.success) continue;
        if (result.output.velocityMps <= Number(maxVelocityMps) &&
            result.output.pressureLossPaPerM <= Number(maxPressureLossPaPerM)) {
            candidates.push({
                diameterMm,
                velocityMps: result.output.velocityMps,
                pressureLossPaPerM: result.output.pressureLossPaPerM,
                frictionFactor: result.output.frictionFactor,
            });
        }
    }
    return {
        success: candidates.length > 0,
        method: "Smallest configured diameter satisfying velocity and friction limits",
        assumptions: [
            "Fittings, valves, accessories, and equipment local losses are not included.",
            "Result is a sizing proposal until office standards and project constraints are confirmed.",
        ],
        input: {
            flowLs: Number(flowLs),
            maxVelocityMps: Number(maxVelocityMps),
            maxPressureLossPaPerM: Number(maxPressureLossPaPerM),
        },
        selected: candidates[0] || null,
        candidateCount: candidates.length,
        canCommit: false,
        riskLevel: "medium",
    };
}

export function calculatePumpHeadBasis({
    network,
    equipmentLossKPa = 0,
    terminalLossKPa = 0,
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
    const requiredFlowLs = Object.values(terminalDemands).reduce((sum, value) => {
        const demand = Number(value);
        return sum + (Number.isFinite(demand) && demand > 0 ? demand : 0);
    }, 0);
    const criticalCircuitLossKPa = Number(traversal.criticalPath.totalLossPa || 0) / 1000.0;
    const baseHeadKPa = criticalCircuitLossKPa +
        Math.max(0, Number(equipmentLossKPa || 0)) +
        Math.max(0, Number(terminalLossKPa || 0));
    const factor = Number.isFinite(Number(safetyFactor)) && Number(safetyFactor) > 0
        ? Number(safetyFactor)
        : 1.0;
    return {
        success: true,
        method: "Pump head basis from weighted network critical circuit plus equipment and terminal losses",
        assumptions: [
            "Network edge loss is supplied by upstream calculation or read-only model analysis.",
            "Terminal demand values are treated as water flow in L/s.",
            "Selection is a basis/proposal only; no equipment replacement is committed.",
        ],
        input: {
            equipmentLossKPa: Number(equipmentLossKPa || 0),
            terminalLossKPa: Number(terminalLossKPa || 0),
            safetyFactor: factor,
        },
        output: {
            requiredFlowLs,
            criticalCircuitLossKPa,
            baseHeadKPa,
            requiredHeadKPa: baseHeadKPa * factor,
            criticalPath: traversal.criticalPath,
        },
        traversal,
        canCommit: false,
        riskLevel: "high",
    };
}

export function calculateHydronicBalance({
    network,
    pumpHeadKPa,
    terminalPressureAllowanceKPa = 0,
} = {}) {
    const inferred = inferFlowDirections(network || {});
    if (!inferred.success) {
        return {
            success: false,
            errors: inferred.errors || [],
            warnings: inferred.warnings || [],
            canCommit: false,
        };
    }
    const reachableTerminalPaths = inferred.terminalPaths.filter((path) => path.reachable && path.demand > 0);
    if (reachableTerminalPaths.length === 0) {
        return {
            success: false,
            errors: ["At least one reachable terminal demand is required for balancing."],
            warnings: inferred.warnings || [],
            canCommit: false,
        };
    }
    const criticalPath = reachableTerminalPaths.reduce((selected, candidate) => {
        if (!selected || candidate.totalLossPa > selected.totalLossPa) return candidate;
        return selected;
    }, null);
    const criticalLossKPa = Number(criticalPath.totalLossPa || 0) / 1000.0;
    const allowanceKPa = Math.max(0, Number(terminalPressureAllowanceKPa || 0));
    const requiredPumpHeadKPa = criticalLossKPa + allowanceKPa;
    const availablePumpHeadKPa = Number(pumpHeadKPa);
    const hasPumpHead = Number.isFinite(availablePumpHeadKPa) && availablePumpHeadKPa > 0;
    const terminalBalance = reachableTerminalPaths.map((path) => {
        const pathLossKPa = Number(path.totalLossPa || 0) / 1000.0;
        const balancingLossKPa = Math.max(0, criticalLossKPa - pathLossKPa);
        return {
            terminalNodeId: path.terminalNodeId,
            flowLs: path.demand,
            pathLossKPa,
            balancingLossKPa,
            requiredTerminalSetpointKPa: pathLossKPa + balancingLossKPa + allowanceKPa,
            availableResidualKPa: hasPumpHead ? availablePumpHeadKPa - pathLossKPa - allowanceKPa : null,
            meetsAvailablePumpHead: hasPumpHead ? availablePumpHeadKPa >= pathLossKPa + allowanceKPa : null,
            isCritical: path.terminalNodeId === criticalPath.terminalNodeId,
            pathNodeIds: path.nodeIds,
        };
    });
    return {
        success: true,
        method: "Hydronic terminal balance from inferred branch flows and critical-circuit equalization",
        assumptions: [
            "Uses inferred least-loss root-to-terminal flow directions.",
            "Balancing loss is the additional terminal/branch resistance needed to match the critical circuit.",
            "This is not a full looped hydraulic solver; pump/valve authority and flow split require detailed standards and manufacturer data.",
        ],
        output: {
            totalFlowLs: inferred.totalDemand,
            criticalTerminalNodeId: criticalPath.terminalNodeId,
            criticalCircuitLossKPa: criticalLossKPa,
            terminalPressureAllowanceKPa: allowanceKPa,
            requiredPumpHeadKPa,
            availablePumpHeadKPa: hasPumpHead ? availablePumpHeadKPa : null,
            pumpHeadAdequate: hasPumpHead ? availablePumpHeadKPa >= requiredPumpHeadKPa : null,
            terminalBalance,
            directedEdges: inferred.directedEdges,
        },
        inference: inferred,
        canCommit: false,
        riskLevel: "high",
    };
}

function isFinitePositive(value) {
    return value !== null && value !== undefined && Number.isFinite(Number(value)) && Number(value) > 0;
}
