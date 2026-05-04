export function checkSprinklerCoverage({
    roomWidthM,
    roomLengthM,
    sprinklers = [],
    maxSpacingM = null,
    maxCoverageM2 = null,
    maxWallDistanceM = null,
} = {}) {
    const missingStandards = [];
    if (!isPositive(maxSpacingM)) missingStandards.push("fire.sprinklerSpacingRules.maxSpacingM");
    if (!isPositive(maxCoverageM2)) missingStandards.push("fire.sprinklerSpacingRules.maxCoverageM2");
    if (missingStandards.length > 0) {
        return {
            success: false,
            requiresOfficeStandard: true,
            missingStandards,
            canCommit: false,
        };
    }
    const width = Number(roomWidthM);
    const length = Number(roomLengthM);
    const wallLimit = isPositive(maxWallDistanceM) ? Number(maxWallDistanceM) : Number(maxSpacingM) / 2.0;
    const issues = [];
    const roomAreaM2 = width * length;
    const coveragePerSprinklerM2 = sprinklers.length > 0 ? roomAreaM2 / sprinklers.length : Infinity;
    if (coveragePerSprinklerM2 > Number(maxCoverageM2)) {
        issues.push({
            issue: "coverage_area_exceeds_limit",
            coveragePerSprinklerM2,
            maxCoverageM2: Number(maxCoverageM2),
        });
    }
    for (let i = 0; i < sprinklers.length; i++) {
        const s = sprinklers[i];
        const wallDistance = Math.min(Number(s.x), Number(s.y), width - Number(s.x), length - Number(s.y));
        if (wallDistance > wallLimit) {
            issues.push({
                issue: "wall_distance_exceeds_limit",
                sprinklerIndex: i,
                wallDistanceM: wallDistance,
                maxWallDistanceM: wallLimit,
            });
        }
        for (let j = i + 1; j < sprinklers.length; j++) {
            const other = sprinklers[j];
            const distance = Math.hypot(Number(s.x) - Number(other.x), Number(s.y) - Number(other.y));
            if (distance > Number(maxSpacingM)) {
                issues.push({
                    issue: "sprinkler_spacing_exceeds_limit",
                    sprinklerIndexes: [i, j],
                    distanceM: distance,
                    maxSpacingM: Number(maxSpacingM),
                });
            }
        }
    }
    return {
        success: issues.length === 0,
        method: "Rectangular room sprinkler spacing/coverage screening",
        assumptions: [
            "Obstructions, ceiling features, hazard classification, and code-specific hydraulic criteria are not evaluated.",
            "Result is a coverage screening proposal, not final fire protection design.",
        ],
        output: {
            roomAreaM2,
            sprinklerCount: sprinklers.length,
            coveragePerSprinklerM2,
            wallLimitM: wallLimit,
        },
        issues,
        canCommit: false,
        riskLevel: "critical",
    };
}

function isPositive(value) {
    return value !== null && value !== undefined && Number.isFinite(Number(value)) && Number(value) > 0;
}
