import { missingStandardsForDiscipline } from "../../office-standards/defaults.js";
import { calculateStormRunoffRational, checkVentContinuity, sizeGravityPipeByFixtureUnits, sizeStormPipeByFlow, traceGravityDrainageToStack, validateGravitySlope } from "./calculations.js";

export function analyzeSanitaryStorm({ officeStandards = {} } = {}) {
    const missingStandards = missingStandardsForDiscipline("sanitary", officeStandards);
    return {
        discipline: "sanitary",
        engine: "sanitary-storm-foundation",
        status: "foundation",
        requiresOfficeStandard: missingStandards.length > 0,
        missingStandards,
        assumptions: [
            "Gravity pipe sizing and slope decisions are reported as issues/proposals until slope and sizing standards are configured.",
        ],
        checksAvailable: [
            "gravity slope validation",
            "reverse slope issue check",
            "fixture-unit gravity pipe sizing proposal",
            "storm runoff and pipe sizing proposal",
            "branch-to-stack reachability check",
            "vent continuity check",
        ],
        calculationExamples: {
            slopeValidation: validateGravitySlope({
                startElevationM: 10.0,
                endElevationM: 9.95,
                lengthM: 5.0,
                minSlopePercent: officeStandards.sanitaryStorm?.sanitarySlopeRules?.[0]?.minSlopePercent,
            }),
            pipeSizing: sizeGravityPipeByFixtureUnits({
                fixtureUnits: 12,
                sizingTable: officeStandards.sanitaryStorm?.pipeSizingTable,
            }),
            stormRunoff: calculateStormRunoffRational({
                catchmentAreaM2: 250,
                rainfallIntensityMmH: officeStandards.sanitaryStorm?.rainfallIntensityMmH,
                runoffCoefficient: officeStandards.sanitaryStorm?.runoffCoefficient,
            }),
            stormPipeSizing: sizeStormPipeByFlow({
                runoffFlowLs: calculateStormRunoffRational({
                    catchmentAreaM2: 250,
                    rainfallIntensityMmH: officeStandards.sanitaryStorm?.rainfallIntensityMmH,
                    runoffCoefficient: officeStandards.sanitaryStorm?.runoffCoefficient,
                }).output?.runoffFlowLs,
                sizingTable: officeStandards.sanitaryStorm?.stormPipeSizingTable,
            }),
            stackReachability: traceGravityDrainageToStack({
                fixtureNodeIds: ["wc-1"],
                stackNodeIds: ["stack-a"],
                edges: [
                    { from: "wc-1", to: "branch-a" },
                    { from: "branch-a", to: "stack-a" },
                ],
            }),
            ventContinuity: checkVentContinuity({
                fixtureNodeIds: ["wc-1"],
                ventNodeIds: ["vent-a"],
                edges: [
                    { from: "wc-1", to: "branch-a" },
                    { from: "branch-a", to: "vent-a" },
                ],
            }),
        },
        canCommit: false,
    };
}
