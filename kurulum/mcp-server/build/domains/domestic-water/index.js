import { missingStandardsForDiscipline } from "../../office-standards/defaults.js";
import { buildDomesticWaterPipeResizeProposal, calculateDomesticWaterPressureLoss, calculateFixtureDemand, checkRecirculationContinuity, convertFixtureUnitsToDemand, sizeDomesticWaterPipe } from "./calculations.js";

export function analyzeDomesticWater({ officeStandards = {}, pipeSizingRequests = [] } = {}) {
    const missingStandards = missingStandardsForDiscipline("domestic_water", officeStandards);
    const pipeSizingProposal = buildDomesticWaterPipeResizeProposal({
        pipeSizingRequests,
        maxVelocityMps: officeStandards.domesticWater?.pipeVelocityLimitMps,
        maxPressureLossPaPerM: officeStandards.domesticWater?.pipeFrictionLimitPaPerM,
        diametersMm: officeStandards.domesticWater?.pipeDiametersMm,
        demandCurve: officeStandards.domesticWater?.fixtureUnitDemandCurve,
    });
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
            "fixture-unit demand curve interpolation",
            "domestic water pressure loss basis",
            "domestic water pipe sizing proposal",
            "resize_pipe write-plan proposal from domestic water sizing requests",
            "recirculation continuity issue check",
        ],
        calculationExamples: {
            fixtureDemand: calculateFixtureDemand(),
            demandConversion: convertFixtureUnitsToDemand({
                fixtureUnits: 16,
                demandCurve: officeStandards.domesticWater?.fixtureUnitDemandCurve,
            }),
            pressureLoss: calculateDomesticWaterPressureLoss({
                flowLs: 0.5,
                diameterMm: 25,
                lengthM: 10,
                staticLiftM: 0,
            }),
            pipeSizing: sizeDomesticWaterPipe({
                flowLs: 0.5,
                maxVelocityMps: officeStandards.domesticWater?.pipeVelocityLimitMps,
                maxPressureLossPaPerM: officeStandards.domesticWater?.pipeFrictionLimitPaPerM,
                diametersMm: officeStandards.domesticWater?.pipeDiametersMm,
            }),
            recirculationContinuity: checkRecirculationContinuity({
                nodes: [{ id: "heater" }, { id: "riser-1" }],
                edges: [{ from: "heater", to: "riser-1" }],
                requiredLoopNodeIds: ["heater", "riser-1"],
            }),
        },
        ...(Array.isArray(pipeSizingRequests) && pipeSizingRequests.length > 0 ? { pipeSizingProposal } : {}),
        canCommit: false,
    };
}
