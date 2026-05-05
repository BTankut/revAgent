import { validateOfficeStandardsHandoff, validateProjectCriticalDataHandoff } from "./handoff_input_validator.js";

const PROJECT_CRITICAL_ARGUMENT_KEYS = [
    "discipline",
    "includeRevitRead",
    "localLossOnly",
    "localLossFromNetworkPath",
    "localLossElementIds",
    "criticalPathLocalLossPressurePa",
    "criticalPathLocalLossComplete",
    "hvacDuctSizingTargetElementIds",
    "hvacDesignFlowsByElementId",
    "hvacDefaultDesignFlowM3h",
    "hydronicPipeSizingTargetElementIds",
    "hydronicDesignFlowsByElementId",
    "hydronicDefaultDesignFlowLs",
    "domesticWaterPipeSizingRequests",
    "sanitaryStormPipeSizingRequests",
    "firePipeSizingRequests",
];

export function buildAnalyzeHandoffValidation(args = {}) {
    const officeStandards = validateOfficeStandardsHandoff({
        officeStandards: args.officeStandards || {},
    });
    const projectCriticalData = validateProjectCriticalDataHandoff(projectCriticalArguments(args));
    return {
        success: true,
        officeStandards,
        projectCriticalData,
        completeForProductionReview: officeStandards.completeForProductionReview === true &&
            projectCriticalData.completeForProductionReview === true,
        assumptions: [
            "This validates handoff input shape and completeness before production review.",
            "It does not approve engineering values, preview a write-plan, or permit commit.",
        ],
        canCommit: false,
    };
}

function projectCriticalArguments(args = {}) {
    const payload = {};
    for (const key of PROJECT_CRITICAL_ARGUMENT_KEYS) {
        if (key in args) {
            payload[key] = args[key];
        }
    }
    return payload;
}
