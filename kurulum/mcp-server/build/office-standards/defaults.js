export const defaultOfficeStandards = {
    schemaVersion: "1.0",
    locale: "tr-TR",
    units: {
        length: "mm",
        ductFlow: "m3/h",
        pipeFlow: "L/s",
        pressure: "Pa",
        friction: "Pa/m",
    },
    hvac: {
        ductEqualFrictionTargetPaPerM: null,
        ductVelocityLimitsMps: {
            main: null,
            branch: null,
            terminal: null,
        },
    },
    hydronic: {
        pipeVelocityLimitsMps: {
            main: null,
            branch: null,
        },
        pipeFrictionLimitPaPerM: null,
    },
    domesticWater: {
        sizingMethod: null,
        pressureLossMethod: null,
        fixtureUnitStandard: null,
        fixtureUnitDemandCurve: null,
        pipeVelocityLimitMps: null,
        pipeFrictionLimitPaPerM: null,
        pipeDiametersMm: [15, 20, 25, 32, 40, 50, 65, 80, 100],
    },
    sanitaryStorm: {
        sanitarySlopeRules: [],
        pipeSizingTable: [],
        rainfallIntensityMmH: null,
        runoffCoefficient: null,
        stormPipeSizingTable: [],
        stackNodeIds: [],
        ventNodeIds: [],
        stormSizingMethod: null,
    },
    fire: {
        sprinklerSpacingRules: [],
        fireCabinetFlowLpm: null,
        fireCabinetPressureBar: null,
        fireCabinetMaxHoseReachM: null,
        simultaneousFireCabinetCount: null,
        hydraulicStandard: null,
        pipeVelocityLimitMps: null,
        pipeFrictionLimitPaPerM: null,
        pipeDiametersMm: [25, 32, 40, 50, 65, 80, 100, 125, 150, 200],
    },
    reporting: {
        csvDelimiter: ";",
        keepIdentityColumnsAsText: true,
    },
    naming: {
        markParameter: "Mark",
        visibleTraceParameter: "Comments",
    },
    allowedParameterNames: [
        "Comments",
        "Mark",
        "System Name",
        "System Type",
        "System Classification",
    ],
    enforceAllowedParameterNames: false,
    exactSchemaMappings: {},
};

export function mergeOfficeStandards(overrides = {}) {
    return deepMerge(defaultOfficeStandards, overrides || {});
}

export function missingStandardsForDiscipline(discipline, standards = defaultOfficeStandards) {
    const missing = [];
    if (discipline === "hvac" || discipline === "clash" || discipline === "general") {
        if (standards.hvac?.ductEqualFrictionTargetPaPerM == null) {
            missing.push("hvac.ductEqualFrictionTargetPaPerM");
        }
        if (standards.hvac?.ductVelocityLimitsMps?.main == null) {
            missing.push("hvac.ductVelocityLimitsMps.main");
        }
        if (standards.hvac?.ductVelocityLimitsMps?.branch == null) {
            missing.push("hvac.ductVelocityLimitsMps.branch");
        }
        if (standards.hvac?.ductVelocityLimitsMps?.terminal == null) {
            missing.push("hvac.ductVelocityLimitsMps.terminal");
        }
    }
    if (discipline === "hydronic" || discipline === "general") {
        if (standards.hydronic?.pipeFrictionLimitPaPerM == null) {
            missing.push("hydronic.pipeFrictionLimitPaPerM");
        }
        if (standards.hydronic?.pipeVelocityLimitsMps?.main == null) {
            missing.push("hydronic.pipeVelocityLimitsMps.main");
        }
        if (standards.hydronic?.pipeVelocityLimitsMps?.branch == null) {
            missing.push("hydronic.pipeVelocityLimitsMps.branch");
        }
    }
    if (discipline === "domestic_water" || discipline === "general") {
        if (!standards.domesticWater?.sizingMethod) {
            missing.push("domesticWater.sizingMethod");
        }
        if (!standards.domesticWater?.pressureLossMethod) {
            missing.push("domesticWater.pressureLossMethod");
        }
        if (!standards.domesticWater?.fixtureUnitStandard) {
            missing.push("domesticWater.fixtureUnitStandard");
        }
        if (!Array.isArray(standards.domesticWater?.fixtureUnitDemandCurve) || standards.domesticWater.fixtureUnitDemandCurve.length < 2) {
            missing.push("domesticWater.fixtureUnitDemandCurve");
        }
        if (standards.domesticWater?.pipeVelocityLimitMps == null) {
            missing.push("domesticWater.pipeVelocityLimitMps");
        }
        if (standards.domesticWater?.pipeFrictionLimitPaPerM == null) {
            missing.push("domesticWater.pipeFrictionLimitPaPerM");
        }
    }
    if (discipline === "sanitary" || discipline === "general") {
        if (!Array.isArray(standards.sanitaryStorm?.sanitarySlopeRules) || standards.sanitaryStorm.sanitarySlopeRules.length === 0) {
            missing.push("sanitaryStorm.sanitarySlopeRules");
        }
        if (!Array.isArray(standards.sanitaryStorm?.pipeSizingTable) || standards.sanitaryStorm.pipeSizingTable.length === 0) {
            missing.push("sanitaryStorm.pipeSizingTable");
        }
        if (standards.sanitaryStorm?.rainfallIntensityMmH == null) {
            missing.push("sanitaryStorm.rainfallIntensityMmH");
        }
        if (standards.sanitaryStorm?.runoffCoefficient == null) {
            missing.push("sanitaryStorm.runoffCoefficient");
        }
        if (!Array.isArray(standards.sanitaryStorm?.stormPipeSizingTable) || standards.sanitaryStorm.stormPipeSizingTable.length === 0) {
            missing.push("sanitaryStorm.stormPipeSizingTable");
        }
        if (!Array.isArray(standards.sanitaryStorm?.stackNodeIds) || standards.sanitaryStorm.stackNodeIds.length === 0) {
            missing.push("sanitaryStorm.stackNodeIds");
        }
        if (!Array.isArray(standards.sanitaryStorm?.ventNodeIds) || standards.sanitaryStorm.ventNodeIds.length === 0) {
            missing.push("sanitaryStorm.ventNodeIds");
        }
    }
    if (discipline === "fire" || discipline === "sprinkler" || discipline === "general") {
        if (!standards.fire?.hydraulicStandard) {
            missing.push("fire.hydraulicStandard");
        }
        if (!Array.isArray(standards.fire?.sprinklerSpacingRules) || standards.fire.sprinklerSpacingRules.length === 0) {
            missing.push("fire.sprinklerSpacingRules");
        }
        if (standards.fire?.fireCabinetFlowLpm == null) {
            missing.push("fire.fireCabinetFlowLpm");
        }
        if (standards.fire?.fireCabinetPressureBar == null) {
            missing.push("fire.fireCabinetPressureBar");
        }
        if (standards.fire?.fireCabinetMaxHoseReachM == null) {
            missing.push("fire.fireCabinetMaxHoseReachM");
        }
        if (standards.fire?.simultaneousFireCabinetCount == null) {
            missing.push("fire.simultaneousFireCabinetCount");
        }
        if (standards.fire?.pipeVelocityLimitMps == null) {
            missing.push("fire.pipeVelocityLimitMps");
        }
        if (standards.fire?.pipeFrictionLimitPaPerM == null) {
            missing.push("fire.pipeFrictionLimitPaPerM");
        }
    }
    return missing;
}

function deepMerge(base, overrides) {
    if (Array.isArray(base)) {
        return Array.isArray(overrides) ? overrides.slice() : base.slice();
    }
    if (!base || typeof base !== "object") {
        return overrides === undefined ? base : overrides;
    }
    const merged = { ...base };
    for (const [key, value] of Object.entries(overrides || {})) {
        if (value && typeof value === "object" && !Array.isArray(value) && base[key] && typeof base[key] === "object" && !Array.isArray(base[key])) {
            merged[key] = deepMerge(base[key], value);
        }
        else {
            merged[key] = value;
        }
    }
    return merged;
}
