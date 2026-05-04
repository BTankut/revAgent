export function calculateSlopePercent({ startElevationM, endElevationM, lengthM } = {}) {
    const length = Number(lengthM);
    if (!Number.isFinite(length) || length <= 0) {
        return {
            success: false,
            error: "lengthM must be greater than zero",
            canCommit: false,
        };
    }
    const fallM = Number(startElevationM) - Number(endElevationM);
    return {
        success: true,
        fallM,
        slopePercent: (fallM / length) * 100.0,
    };
}

export function validateGravitySlope({ startElevationM, endElevationM, lengthM, minSlopePercent = null } = {}) {
    if (minSlopePercent === null || minSlopePercent === undefined || !Number.isFinite(Number(minSlopePercent)) || Number(minSlopePercent) <= 0) {
        return {
            success: false,
            requiresOfficeStandard: true,
            missingStandards: ["sanitaryStorm.sanitarySlopeRules"],
            canCommit: false,
        };
    }
    const slope = calculateSlopePercent({ startElevationM, endElevationM, lengthM });
    if (!slope.success) return slope;
    const reverseSlope = slope.slopePercent < 0;
    const belowMinimum = slope.slopePercent >= 0 && slope.slopePercent < Number(minSlopePercent);
    const issues = [];
    if (reverseSlope) issues.push("reverse_slope");
    if (belowMinimum) issues.push("below_minimum_slope");
    return {
        success: issues.length === 0,
        method: "Gravity pipe slope validation",
        input: {
            startElevationM: Number(startElevationM),
            endElevationM: Number(endElevationM),
            lengthM: Number(lengthM),
            minSlopePercent: Number(minSlopePercent),
        },
        output: {
            fallM: slope.fallM,
            slopePercent: slope.slopePercent,
            reverseSlope,
            belowMinimum,
        },
        issues,
        canCommit: false,
        riskLevel: "medium",
    };
}
