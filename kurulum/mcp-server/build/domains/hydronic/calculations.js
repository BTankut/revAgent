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
    localLossPressurePa = 0,
    localLossKPa = 0,
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
    const localLossContributionKPa = Math.max(0, Number(localLossKPa || 0)) +
        Math.max(0, Number(localLossPressurePa || 0)) / 1000.0;
    const baseHeadKPa = criticalCircuitLossKPa +
        Math.max(0, Number(equipmentLossKPa || 0)) +
        localLossContributionKPa +
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
            localLossPressurePa: Number(localLossPressurePa || 0),
            localLossKPa: Number(localLossKPa || 0),
            terminalLossKPa: Number(terminalLossKPa || 0),
            safetyFactor: factor,
        },
        output: {
            requiredFlowLs,
            criticalCircuitLossKPa,
            localLossContributionKPa,
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

export function pipeResistanceCoefficient({
    lengthM,
    diameterMm,
    referenceFlowLs = 1,
    water,
} = {}) {
    const flow = Number(referenceFlowLs);
    const length = Number(lengthM);
    if (!Number.isFinite(length) || length <= 0) {
        return {
            success: false,
            error: "lengthM must be positive",
            canCommit: false,
        };
    }
    if (!Number.isFinite(flow) || flow <= 0) {
        return {
            success: false,
            error: "referenceFlowLs must be positive",
            canCommit: false,
        };
    }
    const friction = pipeFrictionLossPaPerM(flow, diameterMm, water);
    if (!friction.success) return friction;
    const pressureLossPa = friction.output.pressureLossPaPerM * length;
    return {
        success: true,
        method: "Resistance coefficient calibrated from Darcy-Weisbach pressure loss at a reference flow",
        input: {
            lengthM: length,
            diameterMm: Number(diameterMm),
            referenceFlowLs: flow,
        },
        output: {
            pressureLossPa,
            resistancePaPerFlow2: pressureLossPa / (flow * flow),
            pressureLossPaPerM: friction.output.pressureLossPaPerM,
            velocityMps: friction.output.velocityMps,
            reynolds: friction.output.reynolds,
            frictionFactor: friction.output.frictionFactor,
        },
        assumptions: [
            "Coefficient uses flow in L/s and pressure in Pa.",
            "Pipe fittings, valves, accessories, elevation change, glycol, and equipment losses are excluded unless supplied separately.",
        ],
        canCommit: false,
        riskLevel: "medium",
    };
}

export function calibratePipeResistanceSamples({ pipeSamples = [], referenceFlowLs = 1, water } = {}) {
    const rows = [];
    const warnings = [];
    for (const sample of Array.isArray(pipeSamples) ? pipeSamples : []) {
        const result = pipeResistanceCoefficient({
            lengthM: sample.lengthM,
            diameterMm: sample.diameterMm,
            referenceFlowLs,
            water,
        });
        if (!result.success) {
            warnings.push(`Skipped pipe ${sample.elementId || ""}: ${result.error || "invalid sample"}`);
            continue;
        }
        rows.push({
            elementId: sample.elementId,
            uniqueId: sample.uniqueId || "",
            systemName: sample.systemName || "(unassigned)",
            lengthM: Number(sample.lengthM),
            diameterMm: Number(sample.diameterMm),
            referenceFlowLs: Number(referenceFlowLs),
            resistancePaPerFlow2: result.output.resistancePaPerFlow2,
            pressureLossPaAtReferenceFlow: result.output.pressureLossPa,
            velocityMpsAtReferenceFlow: result.output.velocityMps,
            reynoldsAtReferenceFlow: result.output.reynolds,
        });
    }
    return {
        success: rows.length > 0,
        method: "Live pipe resistance calibration from Revit length/diameter samples",
        rows,
        warnings,
        assumptions: [
            "Live Revit collector supplies pipe element id, length, diameter, unique id, and system name only.",
            "Resistance coefficients are first-pass Darcy-Weisbach values at the configured reference flow.",
            "Use detailed fittings/accessories/equipment data before production hydraulic balancing.",
        ],
        canCommit: false,
        riskLevel: "high",
    };
}

export function solveHardyCrossLoop({
    loopEdges = [],
    exponent = 2,
    tolerancePa = 0.01,
    maxIterations = 50,
} = {}) {
    const errors = [];
    if (!Array.isArray(loopEdges) || loopEdges.length < 2) {
        errors.push("loopEdges must contain at least two edges");
    }
    const n = Number(exponent);
    if (!Number.isFinite(n) || n <= 1) {
        errors.push("exponent must be greater than 1");
    }
    const edges = (Array.isArray(loopEdges) ? loopEdges : []).map((edge, index) => {
        const resistance = Number(edge.resistancePaPerFlowN ?? edge.resistance ?? 0);
        const flow = Number(edge.initialFlow ?? edge.flow ?? 0);
        if (!Number.isFinite(resistance) || resistance <= 0) {
            errors.push(`loopEdges[${index}].resistancePaPerFlowN must be positive`);
        }
        if (!Number.isFinite(flow)) {
            errors.push(`loopEdges[${index}].initialFlow must be finite`);
        }
        return {
            edgeId: edge.edgeId || `edge-${index + 1}`,
            resistancePaPerFlowN: resistance,
            flow,
        };
    });
    if (errors.length > 0) {
        return { success: false, errors, warnings: [], canCommit: false };
    }

    const iterations = [];
    let converged = false;
    let residualPa = 0;
    let correction = 0;
    const max = Math.max(1, Number.parseInt(String(maxIterations), 10) || 50);
    const tolerance = Math.max(0, Number(tolerancePa) || 0.01);
    for (let iteration = 1; iteration <= max; iteration++) {
        const state = loopState(edges, n);
        residualPa = state.residualPa;
        if (Math.abs(residualPa) <= tolerance) {
            converged = true;
            iterations.push({ iteration, residualPa, correction: 0 });
            break;
        }
        if (state.derivativeSum <= 0) {
            return {
                success: false,
                errors: ["Hardy-Cross derivative sum is zero; check initial flows and resistances"],
                warnings: [],
                canCommit: false,
            };
        }
        correction = -residualPa / state.derivativeSum;
        for (const edge of edges) {
            edge.flow += correction;
        }
        iterations.push({ iteration, residualPa, correction });
        const corrected = loopState(edges, n);
        if (Math.abs(corrected.residualPa) <= tolerance) {
            residualPa = corrected.residualPa;
            converged = true;
            break;
        }
    }
    const finalState = loopState(edges, n);
    return {
        success: true,
        method: "Hardy-Cross single-loop hydraulic balancing",
        assumptions: [
            "All loop edges use the same flow exponent and signed loop orientation.",
            "Resistance coefficients must be supplied by prior pipe/fitting/equipment calculations.",
            "This is a single-loop deterministic foundation; coupled multi-loop network solving remains a production extension.",
        ],
        input: {
            exponent: n,
            tolerancePa: tolerance,
            maxIterations: max,
        },
        output: {
            converged: converged || Math.abs(finalState.residualPa) <= tolerance,
            iterationCount: iterations.length,
            residualPa: finalState.residualPa,
            correction,
            finalEdges: edges.map((edge) => ({
                edgeId: edge.edgeId,
                flow: edge.flow,
                resistancePaPerFlowN: edge.resistancePaPerFlowN,
                headLossPa: signedHeadLoss(edge.flow, edge.resistancePaPerFlowN, n),
            })),
            iterations,
        },
        canCommit: false,
        riskLevel: "high",
    };
}

export function solveHardyCrossNetwork({
    edges = [],
    loops = [],
    exponent = 2,
    tolerancePa = 0.01,
    maxIterations = 50,
} = {}) {
    const errors = [];
    const n = Number(exponent);
    if (!Number.isFinite(n) || n <= 1) {
        errors.push("exponent must be greater than 1");
    }
    const edgeMap = new Map();
    for (const [index, edge] of (Array.isArray(edges) ? edges : []).entries()) {
        const edgeId = edge.edgeId || `edge-${index + 1}`;
        const resistance = Number(edge.resistancePaPerFlowN ?? edge.resistance ?? 0);
        const flow = Number(edge.initialFlow ?? edge.flow ?? 0);
        if (!Number.isFinite(resistance) || resistance <= 0) {
            errors.push(`edges[${index}].resistancePaPerFlowN must be positive`);
        }
        if (!Number.isFinite(flow)) {
            errors.push(`edges[${index}].initialFlow must be finite`);
        }
        edgeMap.set(edgeId, { edgeId, resistancePaPerFlowN: resistance, flow });
    }
    const normalizedLoops = (Array.isArray(loops) ? loops : []).map((loop, loopIndex) => {
        const loopEdges = Array.isArray(loop.edges) ? loop.edges : [];
        if (loopEdges.length < 2) {
            errors.push(`loops[${loopIndex}].edges must contain at least two edge references`);
        }
        return {
            loopId: loop.loopId || `loop-${loopIndex + 1}`,
            edges: loopEdges.map((ref, refIndex) => {
                const edgeId = typeof ref === "string" ? ref : ref.edgeId;
                const orientation = typeof ref === "string" ? 1 : Number(ref.orientation ?? 1);
                if (!edgeMap.has(edgeId)) {
                    errors.push(`loops[${loopIndex}].edges[${refIndex}] references unknown edge ${edgeId}`);
                }
                return {
                    edgeId,
                    orientation: orientation < 0 ? -1 : 1,
                };
            }),
        };
    });
    if (edgeMap.size === 0) errors.push("edges must contain at least one edge");
    if (normalizedLoops.length === 0) errors.push("loops must contain at least one loop");
    if (errors.length > 0) {
        return { success: false, errors, warnings: [], canCommit: false };
    }

    const max = Math.max(1, Number.parseInt(String(maxIterations), 10) || 50);
    const tolerance = Math.max(0, Number(tolerancePa) || 0.01);
    const iterations = [];
    let converged = false;
    for (let iteration = 1; iteration <= max; iteration++) {
        const loopCorrections = [];
        let maxResidualPa = 0;
        for (const loop of normalizedLoops) {
            const state = networkLoopState(loop, edgeMap, n);
            maxResidualPa = Math.max(maxResidualPa, Math.abs(state.residualPa));
            if (Math.abs(state.residualPa) <= tolerance) {
                loopCorrections.push({ loopId: loop.loopId, residualPa: state.residualPa, correction: 0 });
                continue;
            }
            if (state.derivativeSum <= 0) {
                return {
                    success: false,
                    errors: [`Hardy-Cross derivative sum is zero for ${loop.loopId}`],
                    warnings: [],
                    canCommit: false,
                };
            }
            const correction = -state.residualPa / state.derivativeSum;
            for (const ref of loop.edges) {
                edgeMap.get(ref.edgeId).flow += ref.orientation * correction;
            }
            loopCorrections.push({ loopId: loop.loopId, residualPa: state.residualPa, correction });
        }
        iterations.push({ iteration, maxResidualPa, loopCorrections });
        const residuals = normalizedLoops.map((loop) => Math.abs(networkLoopState(loop, edgeMap, n).residualPa));
        if (Math.max(...residuals) <= tolerance) {
            converged = true;
            break;
        }
    }
    const finalLoopResiduals = normalizedLoops.map((loop) => ({
        loopId: loop.loopId,
        residualPa: networkLoopState(loop, edgeMap, n).residualPa,
    }));
    const maxResidualPa = Math.max(...finalLoopResiduals.map((loop) => Math.abs(loop.residualPa)));
    return {
        success: true,
        method: "Sequential Hardy-Cross coupled loop hydraulic balancing",
        assumptions: [
            "Loops are solved sequentially; shared-edge interactions are updated each iteration.",
            "All loop edges use signed loop orientation and a common flow exponent.",
            "Resistance coefficients must be supplied by prior pipe/fitting/equipment calculations.",
        ],
        input: {
            exponent: n,
            tolerancePa: tolerance,
            maxIterations: max,
            loopCount: normalizedLoops.length,
            edgeCount: edgeMap.size,
        },
        output: {
            converged: converged || maxResidualPa <= tolerance,
            iterationCount: iterations.length,
            maxResidualPa,
            finalLoopResiduals,
            finalEdges: [...edgeMap.values()].map((edge) => ({
                edgeId: edge.edgeId,
                flow: edge.flow,
                resistancePaPerFlowN: edge.resistancePaPerFlowN,
                headLossPa: signedHeadLoss(edge.flow, edge.resistancePaPerFlowN, n),
            })),
            iterations,
        },
        canCommit: false,
        riskLevel: "high",
    };
}

function networkLoopState(loop, edgeMap, exponent) {
    let residualPa = 0;
    let derivativeSum = 0;
    for (const ref of loop.edges) {
        const edge = edgeMap.get(ref.edgeId);
        const orientedFlow = ref.orientation * edge.flow;
        residualPa += signedHeadLoss(orientedFlow, edge.resistancePaPerFlowN, exponent);
        derivativeSum += exponent * edge.resistancePaPerFlowN * Math.pow(Math.abs(orientedFlow), exponent - 1);
    }
    return { residualPa, derivativeSum };
}

function loopState(edges, exponent) {
    let residualPa = 0;
    let derivativeSum = 0;
    for (const edge of edges) {
        residualPa += signedHeadLoss(edge.flow, edge.resistancePaPerFlowN, exponent);
        derivativeSum += exponent * edge.resistancePaPerFlowN * Math.pow(Math.abs(edge.flow), exponent - 1);
    }
    return { residualPa, derivativeSum };
}

function signedHeadLoss(flow, resistance, exponent) {
    const q = Number(flow);
    if (!Number.isFinite(q) || q === 0) return 0;
    return Math.sign(q) * Number(resistance) * Math.pow(Math.abs(q), exponent);
}

function isFinitePositive(value) {
    return value !== null && value !== undefined && Number.isFinite(Number(value)) && Number(value) > 0;
}
