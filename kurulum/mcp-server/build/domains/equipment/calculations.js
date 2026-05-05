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

export function buildFamilyPlacementProposal({
    discipline = "general",
    placementKind = "equipment",
    requests = [],
    defaultLevelId,
} = {}) {
    const normalizedRequests = Array.isArray(requests) ? requests : [];
    const rows = [];
    const writePlanSteps = [];
    const errors = [];
    normalizedRequests.forEach((request, index) => {
        const normalized = normalizePlacementRequest({
            request,
            index,
            discipline,
            placementKind,
            defaultLevelId,
        });
        rows.push(normalized.row);
        if (normalized.errors.length > 0) {
            errors.push(...normalized.errors);
            return;
        }
        writePlanSteps.push(normalized.step);
    });
    return {
        success: errors.length === 0 && writePlanSteps.length > 0,
        method: "Domain placement proposal mapped to native place_family_instance write-plan steps",
        discipline,
        placementKind,
        rows,
        writePlanSteps,
        errors,
        assumptions: [
            "Placement requests are proposal-only and use the generic native place_family_instance operation.",
            "Family/type availability, hosting, orientation, connector tie-in, and system assignment must be confirmed by preview/readback before commit.",
            "Air terminals, dampers, valves, pumps, and fire cabinets usually need domain-specific connection steps after placement.",
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

function normalizePlacementRequest({ request = {}, index, discipline, placementKind, defaultLevelId }) {
    const kind = normalizeKind(request.placementKind || request.kind || placementKind);
    const eId = request.eId || `${kind}-${String(index + 1).padStart(3, "0")}`;
    const args = {
        point: request.point,
        unit: request.unit || "m",
    };
    if (request.familySymbolId !== undefined) args.familySymbolId = Number(request.familySymbolId);
    if (request.familyName) args.familyName = String(request.familyName);
    if (request.typeName) args.typeName = String(request.typeName);
    const levelId = request.levelId ?? defaultLevelId;
    if (levelId !== undefined && levelId !== null && String(levelId).trim() !== "") args.levelId = Number(levelId);
    if (request.rotationDegrees !== undefined) args.rotationDegrees = Number(request.rotationDegrees);
    if (request.hostElementId !== undefined) args.hostElementId = Number(request.hostElementId);
    const errors = [];
    if (!args.point || typeof args.point !== "object") {
        errors.push(`placementRequests[${index}].point is required`);
    }
    if (!Number.isFinite(Number(args.familySymbolId)) && !(args.familyName && args.typeName)) {
        errors.push(`placementRequests[${index}].familySymbolId or familyName/typeName is required`);
    }
    const row = {
        rowType: "family_placement_proposal",
        discipline,
        placementKind: kind,
        eId,
        familySymbolId: Number.isFinite(Number(args.familySymbolId)) ? Number(args.familySymbolId) : "",
        familyName: args.familyName || "",
        typeName: args.typeName || "",
        levelId: Number.isFinite(Number(args.levelId)) ? Number(args.levelId) : "",
        point: args.point || null,
        status: errors.length === 0 ? "proposal_ready_for_preview" : "proposal_invalid",
        canCommit: false,
        errors,
    };
    return {
        errors,
        row,
        step: {
            stepId: `${kind}-placement-${String(index + 1).padStart(3, "0")}`,
            eId,
            operation: "place_family_instance",
            dependsOn: [],
            targets: {},
            arguments: args,
            preconditions: [
                `${kind} family/type must be loaded and suitable for the active Revit 2022 model.`,
                "Preview must confirm insertion point, level, host/orientation, and no unintended model mutation.",
                "Connector/system assignment is not implied by this placement proposal.",
            ],
            riskLevel: "medium",
        },
    };
}

function normalizeKind(value) {
    return String(value || "equipment")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "") || "equipment";
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
