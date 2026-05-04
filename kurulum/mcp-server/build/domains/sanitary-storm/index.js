import { missingStandardsForDiscipline } from "../../office-standards/defaults.js";

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
            "slope validation scaffold",
            "reverse slope issue scaffold",
            "vent continuity scaffold",
        ],
        canCommit: false,
    };
}
