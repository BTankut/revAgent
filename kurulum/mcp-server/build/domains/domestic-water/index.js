import { missingStandardsForDiscipline } from "../../office-standards/defaults.js";

export function analyzeDomesticWater({ officeStandards = {} } = {}) {
    const missingStandards = missingStandardsForDiscipline("domestic_water", officeStandards);
    return {
        discipline: "domestic_water",
        engine: "domestic-water-foundation",
        status: "foundation",
        requiresOfficeStandard: missingStandards.length > 0,
        missingStandards,
        assumptions: [
            "Cold/hot/recirculation classification, fixture units, and pressure loss require office sizing assumptions before final design output.",
        ],
        checksAvailable: [
            "network classification scaffold",
            "fixture demand basis scaffold",
            "recirculation continuity issue scaffold",
        ],
        canCommit: false,
    };
}
