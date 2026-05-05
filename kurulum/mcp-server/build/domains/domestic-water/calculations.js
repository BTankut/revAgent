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
