export function selectFanCandidate({ requiredFlowM3h, requiredPressurePa, candidates = [] } = {}) {
    return selectCandidate({
        requiredPrimary: Number(requiredFlowM3h),
        requiredSecondary: Number(requiredPressurePa),
        candidates,
        primaryKey: "flowM3h",
        secondaryKey: "pressurePa",
        equipmentKind: "fan",
    });
}

export function selectPumpCandidate({ requiredFlowLs, requiredHeadKPa, candidates = [] } = {}) {
    return selectCandidate({
        requiredPrimary: Number(requiredFlowLs),
        requiredSecondary: Number(requiredHeadKPa),
        candidates,
        primaryKey: "flowLs",
        secondaryKey: "headKPa",
        equipmentKind: "pump",
    });
}

export function buildEquipmentScheduleProposal({
    equipmentKind = "equipment",
    requirement = {},
    selection,
    targetElementId,
    targetEId,
    parameterName = "Comments",
} = {}) {
    const selected = selection?.selected || null;
    const scheduleRows = [];
    if (selected) {
        scheduleRows.push({
            rowType: "equipment_selection",
            equipmentKind,
            selectedId: selected.id || "",
            selectedFamily: selected.familyName || "",
            selectedType: selected.typeName || selected.id || "",
            requiredFlow: requirement.requiredFlowM3h ?? requirement.requiredFlowLs ?? "",
            requiredPressureOrHead: requirement.requiredPressurePa ?? requirement.requiredHeadKPa ?? "",
            primaryMargin: selected.primaryMargin,
            secondaryMargin: selected.secondaryMargin,
            viableCount: selection.viableCount || 0,
            status: "proposal",
            canCommit: false,
        });
    }
    const writePlanSteps = [];
    const hasTarget = Number.isFinite(Number(targetElementId)) || (typeof targetEId === "string" && targetEId.trim().length > 0);
    if (selected && hasTarget) {
        writePlanSteps.push({
            stepId: "equipment-schedule-note-001",
            operation: "set_parameter",
            dependsOn: [],
            targets: Number.isFinite(Number(targetElementId))
                ? { elementId: Number(targetElementId) }
                : { eId: targetEId },
            arguments: {
                parameterName,
                value: equipmentScheduleNote({ equipmentKind, requirement, selected }),
            },
            preconditions: [
                "User must approve schedule/note update.",
                "No family/type replacement is performed by this proposal.",
            ],
            riskLevel: "low",
        });
    }
    return {
        success: Boolean(selected),
        method: "Equipment schedule update proposal from selected candidate",
        scheduleRows,
        writePlanSteps,
        assumptions: [
            "Proposal updates schedule/report metadata only; it does not replace equipment.",
            "Candidate dimensional, acoustic, electrical, efficiency, and manufacturer constraints must be checked before procurement or model replacement.",
        ],
        canCommit: false,
        riskLevel: "medium",
    };
}

function selectCandidate({ requiredPrimary, requiredSecondary, candidates, primaryKey, secondaryKey, equipmentKind }) {
    const viable = [];
    for (const candidate of candidates) {
        const primary = Number(candidate[primaryKey]);
        const secondary = Number(candidate[secondaryKey]);
        if (primary >= requiredPrimary && secondary >= requiredSecondary) {
            viable.push({
                ...candidate,
                primaryMargin: primary - requiredPrimary,
                secondaryMargin: secondary - requiredSecondary,
                score: (primary - requiredPrimary) / Math.max(requiredPrimary, 1) +
                    (secondary - requiredSecondary) / Math.max(requiredSecondary, 1),
            });
        }
    }
    viable.sort((a, b) => a.score - b.score);
    return {
        success: viable.length > 0,
        method: `Smallest viable ${equipmentKind} candidate by normalized flow/head-pressure margin`,
        selected: viable[0] || null,
        viableCount: viable.length,
        assumptions: [
            "Selection is a proposal only; no silent equipment replacement is allowed.",
            "Efficiency, noise, electrical data, dimensions, and manufacturer constraints are not evaluated.",
        ],
        canCommit: false,
        riskLevel: "critical",
    };
}

function equipmentScheduleNote({ equipmentKind, requirement, selected }) {
    const requiredFlow = requirement.requiredFlowM3h !== undefined
        ? `${requirement.requiredFlowM3h} m3/h`
        : requirement.requiredFlowLs !== undefined
            ? `${requirement.requiredFlowLs} L/s`
            : "N/A";
    const requiredPressure = requirement.requiredPressurePa !== undefined
        ? `${requirement.requiredPressurePa} Pa`
        : requirement.requiredHeadKPa !== undefined
            ? `${requirement.requiredHeadKPa} kPa`
            : "N/A";
    return [
        `Equipment selection proposal: ${equipmentKind}`,
        `selected=${selected.typeName || selected.id || ""}`,
        `requiredFlow=${requiredFlow}`,
        `requiredPressureOrHead=${requiredPressure}`,
    ].join("; ");
}
