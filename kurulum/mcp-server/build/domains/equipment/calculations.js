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
