import { missingStandardsForDiscipline } from "../../office-standards/defaults.js";
import { calculateFixtureDemand, checkRecirculationContinuity } from "./calculations.js";

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
            "configured fixture-unit summation",
            "recirculation continuity issue check",
        ],
        calculationExamples: {
            fixtureDemand: calculateFixtureDemand(),
            recirculationContinuity: checkRecirculationContinuity({
                nodes: [{ id: "heater" }, { id: "riser-1" }],
                edges: [{ from: "heater", to: "riser-1" }],
                requiredLoopNodeIds: ["heater", "riser-1"],
            }),
        },
        canCommit: false,
    };
}
