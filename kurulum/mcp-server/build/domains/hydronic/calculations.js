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

function isFinitePositive(value) {
    return value !== null && value !== undefined && Number.isFinite(Number(value)) && Number(value) > 0;
}
