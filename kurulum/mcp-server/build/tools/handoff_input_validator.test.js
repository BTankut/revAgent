import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildAnalyzeHandoffValidation } from "./analysis_handoff_validation.js";
import { validateOfficeStandardsHandoff, validateProjectCriticalDataHandoff } from "./handoff_input_validator.js";

const toolsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = findRepoRoot(toolsDir);

const officeTemplate = readJson(join(repoRoot, "docs", "revit-mep-office-standards-input-template.json"));
const criticalTemplate = readJson(join(repoRoot, "docs", "revit-mep-project-critical-data-template.json"));
const liveSample = readJson(join(repoRoot, "docs", "revit-mep-project-critical-data-live-sample.json"));
const analyzeSource = readFileSync(join(toolsDir, "analyze_mep_system.js"), "utf8");

const filledOfficeStandards = {
    hvac: {
        ductEqualFrictionTargetPaPerM: 1.0,
        ductVelocityLimitsMps: { main: 6.0, branch: 4.5, terminal: 2.5 },
    },
    hydronic: {
        pipeVelocityLimitsMps: { main: 1.5, branch: 1.0 },
        pipeFrictionLimitPaPerM: 200,
    },
    domesticWater: {
        sizingMethod: "office_fixture_unit_curve",
        pressureLossMethod: "darcy_weisbach",
        fixtureUnitStandard: "office_approved",
        fixtureUnitDemandCurve: [
            { fixtureUnits: 0, flowLs: 0.01 },
            { fixtureUnits: 10, flowLs: 0.3 },
            { fixtureUnits: 20, flowLs: 0.45 },
        ],
        pipeVelocityLimitMps: 2.0,
        pipeFrictionLimitPaPerM: 500,
    },
    sanitaryStorm: {
        sanitarySlopeRules: [{ diameterMm: 75, minSlopePercent: 2.0 }],
        pipeSizingTable: [{ diameterMm: 75, maxFixtureUnits: 20 }],
        rainfallIntensityMmH: 100,
        runoffCoefficient: 0.8,
        stormPipeSizingTable: [{ diameterMm: 100, maxFlowLs: 4.0 }],
        stackNodeIds: ["stack-a"],
        ventNodeIds: ["vent-a"],
    },
    fire: {
        sprinklerSpacingRules: [{ hazardClass: "light", maxSpacingM: 4.6 }],
        fireCabinetFlowLpm: 100,
        fireCabinetPressureBar: 4,
        fireCabinetMaxHoseReachM: 30,
        simultaneousFireCabinetCount: 2,
        hydraulicStandard: "office_approved",
        pipeVelocityLimitMps: 3.0,
        pipeFrictionLimitPaPerM: 400,
    },
};

const emptyOfficeValidation = validateOfficeStandardsHandoff(officeTemplate);
assert.equal(emptyOfficeValidation.valid, false);
assert.equal(emptyOfficeValidation.completeForProductionReview, false);
assert.equal(emptyOfficeValidation.missingStandardCount, 28);
assert(emptyOfficeValidation.errors.includes("hvac.ductEqualFrictionTargetPaPerM is required before production review."));
assert.equal(emptyOfficeValidation.canCommit, false);

const filledOfficeValidation = validateOfficeStandardsHandoff({
    officeStandards: filledOfficeStandards,
});
assert.equal(filledOfficeValidation.valid, true);
assert.equal(filledOfficeValidation.completeForProductionReview, true);
assert.equal(filledOfficeValidation.missingStandardCount, 0);
assert.deepEqual(filledOfficeValidation.errors, []);
assert.equal(filledOfficeValidation.canCommit, false);

const criticalTemplateValidation = validateProjectCriticalDataHandoff(criticalTemplate);
assert.equal(criticalTemplateValidation.valid, true);
assert.equal(criticalTemplateValidation.completeForProductionReview, false);
assert(criticalTemplateValidation.blockers.includes("No project-critical target, demand, flow, or local-loss data has been supplied."));
assert.equal(criticalTemplateValidation.canCommit, false);

const badCriticalValidation = validateProjectCriticalDataHandoff({
    discipline: "hvac",
    includeRevitRead: true,
    localLossElementIds: [392203],
    criticalPathLocalLossComplete: true,
    hvacDuctSizingTargetElementIds: [392199],
    hvacDesignFlowsByElementId: { "392199": 360 },
});
assert.equal(badCriticalValidation.valid, false);
assert(badCriticalValidation.errors.includes("directArguments.criticalPathLocalLossPressurePa is required when criticalPathLocalLossComplete is true."));

const liveSampleValidation = validateProjectCriticalDataHandoff(liveSample);
assert.equal(liveSampleValidation.valid, true);
assert.equal(liveSampleValidation.completeForProductionReview, false);
assert.equal(liveSampleValidation.sampleOnly, true);
assert(liveSampleValidation.blockers.includes("Sample-only project data is not production-final input."));
assert(liveSampleValidation.blockers.some((blocker) => blocker.includes("hydronicDesignFlowsByElementId.513756")));
assert.equal(liveSampleValidation.canCommit, false);

const integratedValidation = buildAnalyzeHandoffValidation({
    discipline: "hvac",
    includeRevitRead: false,
    officeStandards: filledOfficeStandards,
    localLossElementIds: [392203],
    criticalPathLocalLossComplete: true,
    hvacDuctSizingTargetElementIds: [392199],
    hvacDesignFlowsByElementId: { "392199": 360 },
});
assert.equal(integratedValidation.officeStandards.valid, true);
assert.equal(integratedValidation.projectCriticalData.valid, false);
assert(integratedValidation.projectCriticalData.errors.includes("directArguments.criticalPathLocalLossPressurePa is required when criticalPathLocalLossComplete is true."));
assert.equal(integratedValidation.completeForProductionReview, false);
assert.equal(integratedValidation.canCommit, false);

const completeIntegratedValidation = buildAnalyzeHandoffValidation({
    discipline: "domestic_water",
    includeRevitRead: false,
    officeStandards: filledOfficeStandards,
    domesticWaterPipeSizingRequests: [
        { elementId: 601, systemName: "Domestic Cold Water", lengthM: 12, currentDiameterMm: 15, fixtureUnits: 16 },
    ],
});
assert.equal(completeIntegratedValidation.officeStandards.valid, true);
assert.equal(completeIntegratedValidation.projectCriticalData.valid, true);
assert.equal(completeIntegratedValidation.projectCriticalData.completeForProductionReview, true);
assert.equal(completeIntegratedValidation.completeForProductionReview, true);
assert.equal(completeIntegratedValidation.canCommit, false);
assert(analyzeSource.includes("buildAnalyzeHandoffValidation(args)"));
assert(analyzeSource.includes("handoffValidation"));

console.log("handoff input validator tests passed");

function readJson(path) {
    return JSON.parse(readFileSync(path, "utf8"));
}


function findRepoRoot(startDir) {
    let current = startDir;
    while (current && current !== dirname(current)) {
        if (existsSync(join(current, "docs", "revit-mep-design-platform-full-goal.md"))) {
            return current;
        }
        current = dirname(current);
    }
    throw new Error("Unable to find repo root containing docs/revit-mep-design-platform-full-goal.md");
}
