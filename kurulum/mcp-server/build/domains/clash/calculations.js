export function classifyAabbClash({ boxA, boxB, clearanceM = 0 } = {}) {
    const overlap = {
        x: axisOverlap(boxA.min.x, boxA.max.x, boxB.min.x, boxB.max.x),
        y: axisOverlap(boxA.min.y, boxA.max.y, boxB.min.y, boxB.max.y),
        z: axisOverlap(boxA.min.z, boxA.max.z, boxB.min.z, boxB.max.z),
    };
    const hardClash = overlap.x > 0 && overlap.y > 0 && overlap.z > 0;
    if (hardClash) {
        return {
            success: true,
            classification: "hard_clash",
            overlapM: overlap,
            canCommit: false,
            riskLevel: "high",
        };
    }
    const gap = minimumAxisGap(boxA, boxB);
    const clearanceClash = gap < Number(clearanceM);
    return {
        success: true,
        classification: clearanceClash ? "clearance_clash" : "no_clash",
        minimumGapM: gap,
        requiredClearanceM: Number(clearanceM),
        canCommit: false,
        riskLevel: clearanceClash ? "medium" : "low",
    };
}

function axisOverlap(aMin, aMax, bMin, bMax) {
    return Math.min(Number(aMax), Number(bMax)) - Math.max(Number(aMin), Number(bMin));
}

function axisGap(aMin, aMax, bMin, bMax) {
    if (Number(aMax) < Number(bMin)) return Number(bMin) - Number(aMax);
    if (Number(bMax) < Number(aMin)) return Number(aMin) - Number(bMax);
    return 0;
}

function minimumAxisGap(boxA, boxB) {
    return Math.min(
        axisGap(boxA.min.x, boxA.max.x, boxB.min.x, boxB.max.x),
        axisGap(boxA.min.y, boxA.max.y, boxB.min.y, boxB.max.y),
        axisGap(boxA.min.z, boxA.max.z, boxB.min.z, boxB.max.z),
    );
}
