import { buildEquipmentScheduleProposal, selectFanCandidate, selectPumpCandidate } from "./calculations.js";

export function analyzeEquipmentSelection() {
    const fanSelection = selectFanCandidate({
        requiredFlowM3h: 5000,
        requiredPressurePa: 450,
        candidates: [
            { id: "fan-a", familyName: "Supply Fan", typeName: "SF-4800-500", flowM3h: 4800, pressurePa: 500 },
            { id: "fan-b", familyName: "Supply Fan", typeName: "SF-5200-500", flowM3h: 5200, pressurePa: 500 },
        ],
    });
    const pumpSelection = selectPumpCandidate({
        requiredFlowLs: 5,
        requiredHeadKPa: 80,
        candidates: [
            { id: "pump-a", familyName: "Inline Pump", typeName: "P-5.5-75", flowLs: 5.5, headKPa: 75 },
            { id: "pump-b", familyName: "Inline Pump", typeName: "P-5.5-85", flowLs: 5.5, headKPa: 85 },
        ],
    });
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
            "equipment schedule/report update proposal without replacement",
        ],
        calculationExamples: {
            fanSelection,
            pumpSelection,
            scheduleProposal: buildEquipmentScheduleProposal({
                equipmentKind: "fan",
                requirement: { requiredFlowM3h: 5000, requiredPressurePa: 450 },
                selection: fanSelection,
                targetEId: "supply-fan-001",
            }),
        },
        canCommit: false,
    };
}
