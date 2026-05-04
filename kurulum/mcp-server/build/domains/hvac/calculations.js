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

function invalidResult(message) {
    return {
        success: false,
        error: message,
        canCommit: false,
    };
}

function isFinitePositive(value) {
    return value !== null && value !== undefined && Number.isFinite(Number(value)) && Number(value) > 0;
}
