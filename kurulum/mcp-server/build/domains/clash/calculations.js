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

export function proposeOrthogonalReroute({ routePoints = [], obstacleBox, clearanceM = 0.1, offsetAxis = "y" } = {}) {
    if (!Array.isArray(routePoints) || routePoints.length < 2) {
        return {
            success: false,
            errors: ["routePoints must contain at least two points"],
            canCommit: false,
        };
    }
    if (!obstacleBox || !obstacleBox.min || !obstacleBox.max) {
        return {
            success: false,
            errors: ["obstacleBox with min/max is required"],
            canCommit: false,
        };
    }
    const start = point(routePoints[0]);
    const end = point(routePoints[routePoints.length - 1]);
    const expanded = expandBox(obstacleBox, Number(clearanceM));
    const axis = dominantAxis(start, end);
    if (axis !== "x" || (offsetAxis !== "y" && offsetAxis !== "z")) {
        return {
            success: false,
            errors: ["foundation reroute currently supports x-directed routes with y or z offset"],
            canCommit: false,
        };
    }
    if (!xSegmentIntersectsBox(start, end, expanded)) {
        return {
            success: true,
            rerouteRequired: false,
            previewPoints: [start, end],
            addedLengthM: 0,
            riskLevel: "low",
            canCommit: false,
        };
    }
    const bypassValue = chooseBypassValue(start[offsetAxis], expanded.min[offsetAxis], expanded.max[offsetAxis]);
    const z = start.z;
    const entryX = Math.min(Math.max(Math.min(start.x, end.x), expanded.min.x), expanded.max.x);
    const exitX = Math.max(Math.min(Math.max(start.x, end.x), expanded.max.x), expanded.min.x);
    const previewPoints = [
        start,
        { x: entryX, y: start.y, z },
        { x: entryX, y: offsetAxis === "y" ? bypassValue : start.y, z: offsetAxis === "z" ? bypassValue : z },
        { x: exitX, y: offsetAxis === "y" ? bypassValue : end.y, z: offsetAxis === "z" ? bypassValue : z },
        { x: exitX, y: end.y, z: end.z },
        end,
    ];
    return {
        success: true,
        rerouteRequired: true,
        obstacleExpandedByClearanceM: expanded,
        offsetAxis,
        previewPoints,
        originalLengthM: polylineLength([start, end]),
        rerouteLengthM: polylineLength(previewPoints),
        addedLengthM: polylineLength(previewPoints) - polylineLength([start, end]),
        assumptions: [
            "Foundation preview only; fittings, bend radius, slope, system connectivity, and new clashes must be verified before commit.",
            "The current deterministic preview handles a single x-directed segment and one rectangular obstacle envelope.",
        ],
        riskLevel: "high",
        canCommit: false,
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

function point(value) {
    return {
        x: Number(value?.x ?? 0),
        y: Number(value?.y ?? 0),
        z: Number(value?.z ?? 0),
    };
}

function expandBox(box, clearance) {
    const c = Number.isFinite(clearance) && clearance > 0 ? clearance : 0;
    return {
        min: {
            x: Number(box.min.x) - c,
            y: Number(box.min.y) - c,
            z: Number(box.min.z) - c,
        },
        max: {
            x: Number(box.max.x) + c,
            y: Number(box.max.y) + c,
            z: Number(box.max.z) + c,
        },
    };
}

function dominantAxis(start, end) {
    const dx = Math.abs(end.x - start.x);
    const dy = Math.abs(end.y - start.y);
    const dz = Math.abs(end.z - start.z);
    if (dx >= dy && dx >= dz) return "x";
    if (dy >= dx && dy >= dz) return "y";
    return "z";
}

function xSegmentIntersectsBox(start, end, box) {
    const xMin = Math.min(start.x, end.x);
    const xMax = Math.max(start.x, end.x);
    return xMax >= box.min.x &&
        xMin <= box.max.x &&
        start.y >= box.min.y &&
        start.y <= box.max.y &&
        start.z >= box.min.z &&
        start.z <= box.max.z;
}

function chooseBypassValue(current, min, max) {
    const center = (Number(min) + Number(max)) / 2;
    return Number(current) <= center ? Number(min) : Number(max);
}

function polylineLength(points) {
    let total = 0;
    for (let i = 1; i < points.length; i++) {
        const a = points[i - 1];
        const b = points[i];
        total += Math.sqrt(
            Math.pow(b.x - a.x, 2) +
            Math.pow(b.y - a.y, 2) +
            Math.pow(b.z - a.z, 2),
        );
    }
    return total;
}
