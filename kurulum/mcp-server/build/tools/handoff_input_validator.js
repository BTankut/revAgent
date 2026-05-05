import { mergeOfficeStandards, missingStandardsForDiscipline } from "../office-standards/defaults.js";

const STANDARD_DISCIPLINES = ["hvac", "hydronic", "domestic_water", "sanitary", "fire"];
const OPTIONAL_SCALAR_ARGS = [
    "criticalPathLocalLossPressurePa",
    "hvacDefaultDesignFlowM3h",
    "hydronicDefaultDesignFlowLs",
];
const ARRAY_ARGS = [
    "localLossElementIds",
    "hvacDuctSizingTargetElementIds",
    "hydronicPipeSizingTargetElementIds",
    "domesticWaterPipeSizingRequests",
    "sanitaryStormPipeSizingRequests",
    "firePipeSizingRequests",
];
const MAP_ARGS = [
    "hvacDesignFlowsByElementId",
    "hydronicDesignFlowsByElementId",
];

export function validateOfficeStandardsHandoff(payload = {}) {
    const errors = [];
    const warnings = [];
    const officeStandards = normalizeOfficeStandardsPayload(payload);
    if (!isPlainObject(officeStandards)) {
        return {
            success: true,
            valid: false,
            completeForProductionReview: false,
            missingStandardCount: 0,
            missingStandards: [],
            errors: ["officeStandards payload must be an object or a wrapper containing officeStandards."],
            warnings,
            canCommit: false,
        };
    }

    const standards = mergeOfficeStandards(officeStandards);
    const missingStandards = uniqueSorted(STANDARD_DISCIPLINES.flatMap((discipline) => missingStandardsForDiscipline(discipline, standards)));
    validateOfficeStandardShapes(standards, errors);

    const missingErrors = missingStandards.map((path) => `${path} is required before production review.`);
    const allErrors = [...missingErrors, ...errors];
    const valid = allErrors.length === 0;
    return {
        success: true,
        valid,
        completeForProductionReview: valid,
        missingStandardCount: missingStandards.length,
        missingStandards,
        errors: allErrors,
        warnings,
        canCommit: false,
    };
}

export function validateProjectCriticalDataHandoff(payload = {}) {
    const errors = [];
    const blockers = [];
    const warnings = [];
    const normalized = normalizeProjectCriticalPayload(payload, warnings, errors);
    if (normalized.scenarios.length === 0) {
        errors.push("Project-critical data payload must contain analyzeMepSystemArguments, direct analyze_mep_system arguments, or sample suggested arguments.");
    }

    let hasAnyProductionInput = false;
    for (const scenario of normalized.scenarios) {
        if (!isPlainObject(scenario.args)) {
            errors.push(`${scenario.label} must be an object.`);
            continue;
        }
        validateAnalyzeArgumentsShape(scenario.label, scenario.args, errors, blockers, warnings);
        hasAnyProductionInput = hasAnyProductionInput || hasProductionInput(scenario.args);
    }

    if (!hasAnyProductionInput) {
        blockers.push("No project-critical target, demand, flow, or local-loss data has been supplied.");
    }
    if (normalized.sampleOnly) {
        blockers.push("Sample-only project data is not production-final input.");
        warnings.push("sampleOnly payloads are accepted for shape review, but they cannot clear production readiness.");
    }

    const valid = errors.length === 0;
    return {
        success: true,
        valid,
        completeForProductionReview: valid && blockers.length === 0,
        scenarioCount: normalized.scenarios.length,
        sampleOnly: normalized.sampleOnly,
        errors: uniqueStable(errors),
        blockers: uniqueStable(blockers),
        warnings: uniqueStable(warnings),
        canCommit: false,
    };
}

function normalizeOfficeStandardsPayload(payload) {
    if (isPlainObject(payload) && isPlainObject(payload.officeStandards)) {
        return payload.officeStandards;
    }
    return payload;
}

function normalizeProjectCriticalPayload(payload, warnings, errors) {
    const scenarios = [];
    if (!isPlainObject(payload)) {
        return { scenarios, sampleOnly: false };
    }
    if (isPlainObject(payload.analyzeMepSystemArguments)) {
        scenarios.push({
            label: "analyzeMepSystemArguments",
            args: mergeOptionalScalarArguments(payload.analyzeMepSystemArguments, payload.optionalScalarArguments, warnings, errors),
        });
    }
    else if (payload.sampleOnly === true) {
        appendSampleScenario(scenarios, "hvacExample.suggestedAnalyzeMepSystemArguments", payload.hvacExample?.suggestedAnalyzeMepSystemArguments);
        appendSampleScenario(scenarios, "hydronicExample.suggestedAnalyzeMepSystemArgumentsAfterFlowReview", payload.hydronicExample?.suggestedAnalyzeMepSystemArgumentsAfterFlowReview);
    }
    else {
        scenarios.push({ label: "directArguments", args: payload });
    }
    return { scenarios, sampleOnly: payload.sampleOnly === true };
}

function mergeOptionalScalarArguments(args, optionalScalars, warnings, errors) {
    const merged = { ...args };
    if (!isPlainObject(optionalScalars)) return merged;
    for (const key of OPTIONAL_SCALAR_ARGS) {
        if (!(key in optionalScalars) || optionalScalars[key] == null) continue;
        if (!isPositiveNumber(optionalScalars[key])) {
            errors.push(`optionalScalarArguments.${key} must be a positive number before copying into analyzeMepSystemArguments.`);
            continue;
        }
        if (key in merged) {
            warnings.push(`analyzeMepSystemArguments.${key} already exists; optionalScalarArguments.${key} was not merged.`);
            continue;
        }
        merged[key] = optionalScalars[key];
    }
    return merged;
}

function appendSampleScenario(scenarios, label, args) {
    if (isPlainObject(args)) {
        scenarios.push({ label, args });
    }
}

function validateOfficeStandardShapes(standards, errors) {
    validatePositivePath(standards, "hvac.ductEqualFrictionTargetPaPerM", errors);
    validatePositivePath(standards, "hvac.ductVelocityLimitsMps.main", errors);
    validatePositivePath(standards, "hvac.ductVelocityLimitsMps.branch", errors);
    validatePositivePath(standards, "hvac.ductVelocityLimitsMps.terminal", errors);
    validatePositivePath(standards, "hydronic.pipeFrictionLimitPaPerM", errors);
    validatePositivePath(standards, "hydronic.pipeVelocityLimitsMps.main", errors);
    validatePositivePath(standards, "hydronic.pipeVelocityLimitsMps.branch", errors);
    validateRequiredStringPath(standards, "domesticWater.sizingMethod", errors);
    validateRequiredStringPath(standards, "domesticWater.pressureLossMethod", errors);
    validateRequiredStringPath(standards, "domesticWater.fixtureUnitStandard", errors);
    validateFixtureUnitDemandCurve(standards.domesticWater?.fixtureUnitDemandCurve, errors);
    validatePositivePath(standards, "domesticWater.pipeVelocityLimitMps", errors);
    validatePositivePath(standards, "domesticWater.pipeFrictionLimitPaPerM", errors);
    validateSanitarySlopeRules(standards.sanitaryStorm?.sanitarySlopeRules, errors);
    validatePipeSizingTable(standards.sanitaryStorm?.pipeSizingTable, "sanitaryStorm.pipeSizingTable", ["maxFixtureUnits", "fixtureUnits", "dfu"], errors);
    validatePositivePath(standards, "sanitaryStorm.rainfallIntensityMmH", errors);
    validateRunoffCoefficient(standards.sanitaryStorm?.runoffCoefficient, errors);
    validatePipeSizingTable(standards.sanitaryStorm?.stormPipeSizingTable, "sanitaryStorm.stormPipeSizingTable", ["maxFlowLs", "flowLs", "runoffFlowLs"], errors);
    validateNonEmptyIdArray(standards.sanitaryStorm?.stackNodeIds, "sanitaryStorm.stackNodeIds", errors);
    validateNonEmptyIdArray(standards.sanitaryStorm?.ventNodeIds, "sanitaryStorm.ventNodeIds", errors);
    validateRequiredStringPath(standards, "fire.hydraulicStandard", errors);
    validateSprinklerSpacingRules(standards.fire?.sprinklerSpacingRules, errors);
    validatePositivePath(standards, "fire.fireCabinetFlowLpm", errors);
    validatePositivePath(standards, "fire.fireCabinetPressureBar", errors);
    validatePositivePath(standards, "fire.fireCabinetMaxHoseReachM", errors);
    validatePositiveIntegerPath(standards, "fire.simultaneousFireCabinetCount", errors);
    validatePositivePath(standards, "fire.pipeVelocityLimitMps", errors);
    validatePositivePath(standards, "fire.pipeFrictionLimitPaPerM", errors);
}

function validateAnalyzeArgumentsShape(label, args, errors, blockers, warnings) {
    for (const key of ARRAY_ARGS) {
        if (key in args && !Array.isArray(args[key])) {
            errors.push(`${label}.${key} must be an array.`);
        }
    }
    for (const key of MAP_ARGS) {
        if (key in args && !isPlainObject(args[key])) {
            errors.push(`${label}.${key} must be an object keyed by ElementId.`);
        }
    }
    for (const key of OPTIONAL_SCALAR_ARGS) {
        if (key in args && !isPositiveNumber(args[key])) {
            errors.push(`${label}.${key} must be a positive number when supplied directly to analyze_mep_system.`);
        }
    }

    validateElementIdArray(args.localLossElementIds, `${label}.localLossElementIds`, errors);
    validateElementIdArray(args.hvacDuctSizingTargetElementIds, `${label}.hvacDuctSizingTargetElementIds`, errors);
    validateElementIdArray(args.hydronicPipeSizingTargetElementIds, `${label}.hydronicPipeSizingTargetElementIds`, errors);
    validateDesignFlowMap(args.hvacDesignFlowsByElementId, `${label}.hvacDesignFlowsByElementId`, "m3/h", errors, blockers);
    validateDesignFlowMap(args.hydronicDesignFlowsByElementId, `${label}.hydronicDesignFlowsByElementId`, "L/s", errors, blockers);

    if (args.criticalPathLocalLossComplete === true) {
        if (!isPositiveNumber(args.criticalPathLocalLossPressurePa)) {
            errors.push(`${label}.criticalPathLocalLossPressurePa is required when criticalPathLocalLossComplete is true.`);
        }
        if (!Array.isArray(args.localLossElementIds) || args.localLossElementIds.length === 0) {
            errors.push(`${label}.localLossElementIds must identify the reviewed local-loss elements when criticalPathLocalLossComplete is true.`);
        }
    }
    else if (isPositiveNumber(args.criticalPathLocalLossPressurePa)) {
        warnings.push(`${label}.criticalPathLocalLossPressurePa is supplied while criticalPathLocalLossComplete is not true.`);
    }

    validateSizingTargets({
        label,
        targetKey: "hvacDuctSizingTargetElementIds",
        flowMapKey: "hvacDesignFlowsByElementId",
        defaultFlowKey: "hvacDefaultDesignFlowM3h",
        args,
        blockers,
        discipline: "HVAC",
    });
    validateSizingTargets({
        label,
        targetKey: "hydronicPipeSizingTargetElementIds",
        flowMapKey: "hydronicDesignFlowsByElementId",
        defaultFlowKey: "hydronicDefaultDesignFlowLs",
        args,
        blockers,
        discipline: "hydronic",
    });
    validateDomesticWaterRequests(label, args.domesticWaterPipeSizingRequests, blockers);
    validateSanitaryStormRequests(label, args.sanitaryStormPipeSizingRequests, blockers);
    validateFireRequests(label, args.firePipeSizingRequests, blockers);
}

function validateSizingTargets({ label, targetKey, flowMapKey, defaultFlowKey, args, blockers, discipline }) {
    const targets = Array.isArray(args[targetKey]) ? args[targetKey] : [];
    if (targets.length === 0) return;
    for (const targetId of targets) {
        const mapValue = isPlainObject(args[flowMapKey]) ? args[flowMapKey][String(targetId)] : undefined;
        if (!isPositiveNumber(mapValue) && !isPositiveNumber(args[defaultFlowKey])) {
            blockers.push(`${label}.${flowMapKey} needs confirmed ${discipline} design flow for target element ${targetId}, or ${defaultFlowKey} must be supplied.`);
        }
    }
    if (args.criticalPathLocalLossComplete !== true) {
        blockers.push(`${label}.${targetKey} requires complete critical-path/circuit local-loss data before production-final sizing.`);
    }
}

function validateDomesticWaterRequests(label, requests, blockers) {
    if (!Array.isArray(requests)) return;
    requests.forEach((request, index) => {
        const prefix = `${label}.domesticWaterPipeSizingRequests[${index}]`;
        validateRequestIdentity(prefix, request, blockers);
        validatePositiveRequestField(prefix, request, "lengthM", blockers);
        validatePositiveRequestField(prefix, request, "currentDiameterMm", blockers);
        if (!isPositiveNumber(request?.flowLs) && !isPositiveNumber(request?.fixtureUnits)) {
            blockers.push(`${prefix} needs confirmed flowLs or fixtureUnits.`);
        }
    });
}

function validateSanitaryStormRequests(label, requests, blockers) {
    if (!Array.isArray(requests)) return;
    requests.forEach((request, index) => {
        const prefix = `${label}.sanitaryStormPipeSizingRequests[${index}]`;
        validateRequestIdentity(prefix, request, blockers);
        validatePositiveRequestField(prefix, request, "lengthM", blockers);
        validatePositiveRequestField(prefix, request, "currentDiameterMm", blockers);
        const drainageType = String(request?.drainageType || "").toLowerCase();
        const isStorm = drainageType.includes("storm") || isPositiveNumber(request?.runoffFlowLs) || isPositiveNumber(request?.catchmentAreaM2);
        if (isStorm) {
            if (!isPositiveNumber(request?.runoffFlowLs) && !isPositiveNumber(request?.catchmentAreaM2)) {
                blockers.push(`${prefix} needs runoffFlowLs or catchmentAreaM2 for storm sizing.`);
            }
        }
        else if (!isPositiveNumber(request?.fixtureUnits)) {
            blockers.push(`${prefix} needs fixtureUnits for sanitary sizing.`);
        }
    });
}

function validateFireRequests(label, requests, blockers) {
    if (!Array.isArray(requests)) return;
    requests.forEach((request, index) => {
        const prefix = `${label}.firePipeSizingRequests[${index}]`;
        validateRequestIdentity(prefix, request, blockers);
        validatePositiveRequestField(prefix, request, "lengthM", blockers);
        validatePositiveRequestField(prefix, request, "currentDiameterMm", blockers);
        if (!isPositiveNumber(request?.flowLpm) &&
            !isPositiveNumber(request?.flowLs) &&
            !isPositiveNumber(request?.cabinetCount) &&
            !isPositiveNumber(request?.sprinklerDemandLpm)) {
            blockers.push(`${prefix} needs fire demand via flowLpm, flowLs, cabinetCount, or sprinklerDemandLpm.`);
        }
    });
}

function validateRequestIdentity(prefix, request, blockers) {
    if (!isPlainObject(request)) {
        blockers.push(`${prefix} must be an object.`);
        return;
    }
    if (!isPositiveInteger(request.elementId) && !nonEmptyString(request.eId)) {
        blockers.push(`${prefix} needs elementId or eId.`);
    }
}

function validatePositiveRequestField(prefix, request, field, blockers) {
    if (!isPositiveNumber(request?.[field])) {
        blockers.push(`${prefix}.${field} must be a positive number.`);
    }
}

function hasProductionInput(args) {
    if (arrayHasItems(args.localLossElementIds)) return true;
    if (arrayHasItems(args.hvacDuctSizingTargetElementIds)) return true;
    if (arrayHasItems(args.hydronicPipeSizingTargetElementIds)) return true;
    if (arrayHasItems(args.domesticWaterPipeSizingRequests)) return true;
    if (arrayHasItems(args.sanitaryStormPipeSizingRequests)) return true;
    if (arrayHasItems(args.firePipeSizingRequests)) return true;
    if (isPlainObject(args.hvacDesignFlowsByElementId) && Object.keys(args.hvacDesignFlowsByElementId).length > 0) return true;
    if (isPlainObject(args.hydronicDesignFlowsByElementId) && Object.keys(args.hydronicDesignFlowsByElementId).length > 0) return true;
    return false;
}

function validatePositivePath(target, path, errors) {
    const value = valueAt(target, path);
    if (value == null) return;
    if (!isPositiveNumber(value)) {
        errors.push(`${path} must be a positive number.`);
    }
}

function validatePositiveIntegerPath(target, path, errors) {
    const value = valueAt(target, path);
    if (value == null) return;
    if (!isPositiveInteger(value)) {
        errors.push(`${path} must be a positive integer.`);
    }
}

function validateRequiredStringPath(target, path, errors) {
    const value = valueAt(target, path);
    if (value == null) return;
    if (!nonEmptyString(value)) {
        errors.push(`${path} must be a non-empty string.`);
    }
}

function validateFixtureUnitDemandCurve(curve, errors) {
    if (curve == null || (Array.isArray(curve) && curve.length === 0)) return;
    if (!Array.isArray(curve)) {
        errors.push("domesticWater.fixtureUnitDemandCurve must be an array.");
        return;
    }
    let previousFixtureUnits = -Infinity;
    curve.forEach((row, index) => {
        const prefix = `domesticWater.fixtureUnitDemandCurve[${index}]`;
        if (!isPlainObject(row)) {
            errors.push(`${prefix} must be an object.`);
            return;
        }
        if (!isNonNegativeNumber(row.fixtureUnits)) {
            errors.push(`${prefix}.fixtureUnits must be a non-negative number.`);
        }
        if (!isPositiveNumber(row.flowLs)) {
            errors.push(`${prefix}.flowLs must be a positive number.`);
        }
        if (isNonNegativeNumber(row.fixtureUnits)) {
            if (row.fixtureUnits <= previousFixtureUnits) {
                errors.push(`${prefix}.fixtureUnits must be greater than the previous curve row.`);
            }
            previousFixtureUnits = row.fixtureUnits;
        }
    });
}

function validateSanitarySlopeRules(rules, errors) {
    if (rules == null || (Array.isArray(rules) && rules.length === 0)) return;
    if (!Array.isArray(rules)) {
        errors.push("sanitaryStorm.sanitarySlopeRules must be an array.");
        return;
    }
    rules.forEach((row, index) => {
        const prefix = `sanitaryStorm.sanitarySlopeRules[${index}]`;
        if (!isPlainObject(row)) {
            errors.push(`${prefix} must be an object.`);
            return;
        }
        if (!isPositiveNumber(row.diameterMm)) {
            errors.push(`${prefix}.diameterMm must be a positive number.`);
        }
        if (!isPositiveNumber(row.minSlopePercent ?? row.slopePercent)) {
            errors.push(`${prefix}.minSlopePercent must be a positive number.`);
        }
    });
}

function validatePipeSizingTable(table, path, capacityFields, errors) {
    if (table == null || (Array.isArray(table) && table.length === 0)) return;
    if (!Array.isArray(table)) {
        errors.push(`${path} must be an array.`);
        return;
    }
    table.forEach((row, index) => {
        const prefix = `${path}[${index}]`;
        if (!isPlainObject(row)) {
            errors.push(`${prefix} must be an object.`);
            return;
        }
        if (!isPositiveNumber(row.diameterMm)) {
            errors.push(`${prefix}.diameterMm must be a positive number.`);
        }
        if (!capacityFields.some((field) => isPositiveNumber(row[field]))) {
            errors.push(`${prefix} must include one positive capacity field: ${capacityFields.join(", ")}.`);
        }
    });
}

function validateRunoffCoefficient(value, errors) {
    if (value == null) return;
    if (!isPositiveNumber(value) || value > 1) {
        errors.push("sanitaryStorm.runoffCoefficient must be a positive number not greater than 1.");
    }
}

function validateNonEmptyIdArray(values, path, errors) {
    if (values == null || (Array.isArray(values) && values.length === 0)) return;
    if (!Array.isArray(values)) {
        errors.push(`${path} must be an array.`);
        return;
    }
    values.forEach((value, index) => {
        if (!isPositiveInteger(value) && !nonEmptyString(value)) {
            errors.push(`${path}[${index}] must be a non-empty node id.`);
        }
    });
}

function validateSprinklerSpacingRules(rules, errors) {
    if (rules == null || (Array.isArray(rules) && rules.length === 0)) return;
    if (!Array.isArray(rules)) {
        errors.push("fire.sprinklerSpacingRules must be an array.");
        return;
    }
    rules.forEach((row, index) => {
        const prefix = `fire.sprinklerSpacingRules[${index}]`;
        if (!isPlainObject(row)) {
            errors.push(`${prefix} must be an object.`);
            return;
        }
        if (!nonEmptyString(row.hazardClass ?? row.hazard ?? row.occupancy)) {
            errors.push(`${prefix} must include hazardClass, hazard, or occupancy.`);
        }
        if (!isPositiveNumber(row.maxSpacingM) &&
            !isPositiveNumber(row.spacingM) &&
            !isPositiveNumber(row.coverageM2) &&
            !isPositiveNumber(row.maxAreaM2)) {
            errors.push(`${prefix} must include maxSpacingM, spacingM, coverageM2, or maxAreaM2 as a positive number.`);
        }
    });
}

function validateElementIdArray(values, path, errors) {
    if (values == null) return;
    if (!Array.isArray(values)) return;
    values.forEach((value, index) => {
        if (!isPositiveInteger(value)) {
            errors.push(`${path}[${index}] must be a positive integer ElementId.`);
        }
    });
}

function validateDesignFlowMap(map, path, unit, errors, blockers) {
    if (map == null || !isPlainObject(map)) return;
    for (const [key, value] of Object.entries(map)) {
        if (!/^\d+$/.test(String(key)) || Number(key) <= 0) {
            errors.push(`${path}.${key} must be keyed by positive integer ElementId.`);
        }
        if (value == null) {
            blockers.push(`${path}.${key} must be filled with confirmed design flow in ${unit}.`);
        }
        else if (!isPositiveNumber(value)) {
            errors.push(`${path}.${key} must be a positive design flow in ${unit}.`);
        }
    }
}

function valueAt(target, path) {
    let cursor = target;
    for (const part of path.split(".")) {
        if (!cursor || typeof cursor !== "object" || !(part in cursor)) return undefined;
        cursor = cursor[part];
    }
    return cursor;
}

function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isPositiveNumber(value) {
    return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isNonNegativeNumber(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isPositiveInteger(value) {
    return Number.isInteger(value) && value > 0;
}

function nonEmptyString(value) {
    return typeof value === "string" && value.trim().length > 0;
}

function arrayHasItems(value) {
    return Array.isArray(value) && value.length > 0;
}

function uniqueSorted(values) {
    return uniqueStable(values).sort();
}

function uniqueStable(values) {
    const seen = new Set();
    const result = [];
    for (const value of values) {
        if (value === null || value === undefined) continue;
        const text = String(value);
        if (seen.has(text)) continue;
        seen.add(text);
        result.push(text);
    }
    return result;
}
