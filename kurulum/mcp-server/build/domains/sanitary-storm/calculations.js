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
