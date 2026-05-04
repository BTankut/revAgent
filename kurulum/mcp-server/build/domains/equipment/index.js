import { selectFanCandidate, selectPumpCandidate } from "./calculations.js";

export function analyzeEquipmentSelection() {
    return {
        discipline: "general",
        engine: "equipment-selection-foundation",
        status: "foundation",
        assumptions: [
            "Fan and pump selection is proposal-only; no silent equipment replacement is allowed.",
        ],
        checksAvailable: [
            "fan candidate screening from airflow and critical path pressure",
            "pump candidate screening from flow and head",
            "family/type candidate comparison scaffold",
        ],
        calculationExamples: {
            fanSelection: selectFanCandidate({
                requiredFlowM3h: 5000,
                requiredPressurePa: 450,
                candidates: [
                    { id: "fan-a", flowM3h: 4800, pressurePa: 500 },
                    { id: "fan-b", flowM3h: 5200, pressurePa: 500 },
                ],
            }),
            pumpSelection: selectPumpCandidate({
                requiredFlowLs: 5,
                requiredHeadKPa: 80,
                candidates: [
                    { id: "pump-a", flowLs: 5.5, headKPa: 75 },
                    { id: "pump-b", flowLs: 5.5, headKPa: 85 },
                ],
            }),
        },
        canCommit: false,
    };
}
