import { missingStandardsForDiscipline } from "../../office-standards/defaults.js";
import { validateGravitySlope } from "./calculations.js";

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
            "vent continuity scaffold",
        ],
        calculationExamples: {
            slopeValidation: validateGravitySlope({
                startElevationM: 10.0,
                endElevationM: 9.95,
                lengthM: 5.0,
                minSlopePercent: officeStandards.sanitaryStorm?.sanitarySlopeRules?.[0]?.minSlopePercent,
            }),
        },
        canCommit: false,
    };
}
