export function analyzeEquipmentSelection() {
    return {
        discipline: "general",
        engine: "equipment-selection-foundation",
        status: "foundation",
        assumptions: [
            "Fan and pump selection is proposal-only; no silent equipment replacement is allowed.",
        ],
        checksAvailable: [
            "fan selection basis from airflow and critical path pressure",
            "pump selection basis from flow and head",
            "family/type candidate comparison scaffold",
        ],
        canCommit: false,
    };
}
