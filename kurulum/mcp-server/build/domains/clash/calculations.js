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

export function classifyMepClashPriority({
    classification = "hard_clash",
    elementA = {},
    elementB = {},
    pipeDiameterM,
    pipeOrientation,
    mainPipeDiameterM = 0.05,
    smallDropDiameterM = 0.04,
} = {}) {
    if (classification === "no_clash") {
        return {
            success: true,
            coordinationClass: "clear",
            priority: "none",
            action: "no_action",
            canCommit: false,
        };
    }
    const pipe = selectPipeElement(elementA, elementB, pipeDiameterM, pipeOrientation);
    const diameterM = Number(pipe.diameterM || 0);
    const orientation = pipe.orientation || "unknown";
    const systemType = String(pipe.systemType || "");
    const isHard = classification === "hard_clash";
    const isHorizontal = orientation === "horizontal";
    const isVertical = orientation === "vertical";
    const isMainPipe = diameterM >= Number(mainPipeDiameterM);
    const isSmallDrop = diameterM > 0 && diameterM <= Number(smallDropDiameterM);

    if (isHard && isHorizontal) {
        return {
            success: true,
            coordinationClass: isMainPipe ? "main_distribution_blocker" : "branch_distribution_blocker",
            priority: isMainPipe ? "high" : "medium",
            action: "reroute_or_layer_adjustment_required",
            reason: "Horizontal distribution geometry intersects another service envelope.",
            pipeSystemType: systemType,
            pipeDiameterM: diameterM,
            pipeOrientation: orientation,
            canCommit: false,
        };
    }
    if (isHard && isVertical && isSmallDrop) {
        return {
            success: true,
            coordinationClass: "local_drop_or_equipment_connection_detail",
            priority: "detail",
            action: "offset_drop_or_connection_detail_required",
            reason: "Small vertical drop/connection intersects a service envelope; main horizontal coordination can still be clear.",
            pipeSystemType: systemType,
            pipeDiameterM: diameterM,
            pipeOrientation: orientation,
            canCommit: false,
        };
    }
    if (isHard && isVertical) {
        return {
            success: true,
            coordinationClass: "vertical_connection_blocker",
            priority: "medium",
            action: "connection_offset_required",
            reason: "Vertical connection intersects another service envelope.",
            pipeSystemType: systemType,
            pipeDiameterM: diameterM,
            pipeOrientation: orientation,
            canCommit: false,
        };
    }
    return {
        success: true,
        coordinationClass: "clearance_review",
        priority: classification === "clearance_clash" ? "low" : "review",
        action: "clearance_review_required",
        reason: "Non-hard clash or unknown orientation requires clearance review.",
        pipeSystemType: systemType,
        pipeDiameterM: diameterM,
        pipeOrientation: orientation,
        canCommit: false,
    };
}

export function summarizeMepClashPriorities(clashes = [], options = {}) {
    const rows = Array.isArray(clashes) ? clashes : [];
    const summary = {
        total: rows.length,
        hardClashes: 0,
        mainDistributionBlockers: 0,
        branchDistributionBlockers: 0,
        verticalConnectionBlockers: 0,
        localDropOrConnectionDetails: 0,
        clearanceReviews: 0,
        clear: 0,
        horizontalHardClashes: 0,
        verticalHardClashes: 0,
        largePipeHardClashes: 0,
        majorDistributionClear: true,
        canCommit: false,
    };
    const classified = rows.map((row) => {
        const result = classifyMepClashPriority({ ...row, ...options });
        if (row.classification === "hard_clash") summary.hardClashes++;
        if (result.pipeOrientation === "horizontal" && row.classification === "hard_clash") summary.horizontalHardClashes++;
        if (result.pipeOrientation === "vertical" && row.classification === "hard_clash") summary.verticalHardClashes++;
        if (Number(result.pipeDiameterM || 0) >= Number(options.mainPipeDiameterM ?? 0.05) && row.classification === "hard_clash") {
            summary.largePipeHardClashes++;
        }
        if (result.coordinationClass === "main_distribution_blocker") summary.mainDistributionBlockers++;
        else if (result.coordinationClass === "branch_distribution_blocker") summary.branchDistributionBlockers++;
        else if (result.coordinationClass === "vertical_connection_blocker") summary.verticalConnectionBlockers++;
        else if (result.coordinationClass === "local_drop_or_equipment_connection_detail") summary.localDropOrConnectionDetails++;
        else if (result.coordinationClass === "clearance_review") summary.clearanceReviews++;
        else if (result.coordinationClass === "clear") summary.clear++;
        return { ...row, coordination: result };
    });
    summary.majorDistributionClear = summary.mainDistributionBlockers === 0 &&
        summary.branchDistributionBlockers === 0 &&
        summary.horizontalHardClashes === 0 &&
        summary.largePipeHardClashes === 0;
    return {
        success: true,
        summary,
        classified,
        assumptions: [
            "Horizontal hard clashes are treated as distribution coordination blockers.",
            "Small vertical pipe/drop clashes are separated from main distribution blockers so they can be detailed with offsets or connection fittings.",
        ],
        canCommit: false,
    };
}

export function evaluateConnectedDropDoglegCandidate({
    sourceElementId,
    targetDuctId,
    currentHitIds = [],
    candidateHitIds = [],
    endpointInsideHitIds = [],
    sourceConnectorCount = 0,
    sourceOpenConnectorCount = 0,
    connectedOwnerIds = [],
    connectedOwnerCategories = [],
    requiredReduction = 1,
} = {}) {
    const currentHits = normalizeIdSet(currentHitIds);
    const candidateHits = normalizeIdSet(candidateHitIds);
    const endpointInsideHits = normalizeIdSet(endpointInsideHitIds);
    const newHitIds = setDifference(candidateHits, currentHits);
    const removedHitIds = setDifference(currentHits, candidateHits);
    const targetCleared = targetDuctId == null || !candidateHits.has(String(targetDuctId));
    const createsNewHits = newHitIds.length > 0;
    const reduction = currentHits.size - candidateHits.size;
    const connectedConnectorCount = Math.max(0, Number(sourceConnectorCount || 0) - Number(sourceOpenConnectorCount || 0));
    const hasConnectedEndpoint = connectedConnectorCount > 0 ||
        normalizeIdSet(connectedOwnerIds).size > 0 ||
        (Array.isArray(connectedOwnerCategories) && connectedOwnerCategories.length > 0);
    const hasEndpointInside = endpointInsideHits.size > 0;
    const geometryFeasible = currentHits.size > 0 &&
        candidateHits.size < currentHits.size &&
        reduction >= Number(requiredReduction || 1) &&
        targetCleared &&
        !createsNewHits;

    let safetyClass = "blocked";
    let action = "do_not_commit";
    const blockers = [];
    const preconditions = [];

    if (currentHits.size === 0) blockers.push("currentHitIds is empty");
    if (!targetCleared) blockers.push("candidate route still hits target duct");
    if (createsNewHits) blockers.push(`candidate route creates new clash ids: ${newHitIds.join(",")}`);
    if (reduction < Number(requiredReduction || 1)) blockers.push("candidate route does not meet required clash reduction");

    if (geometryFeasible && hasConnectedEndpoint) {
        safetyClass = "connected_drop_write_plan_required";
        action = "preview_connected_reroute_before_commit";
        preconditions.push("preserve the external connected fitting/connector");
        preconditions.push("commit one source pipe at a time");
        preconditions.push("verify source deletion/replacement, fitting count, and post-commit clash reduction");
        if (hasEndpointInside) {
            preconditions.push("remaining endpoint-inside-duct-depth clashes must be accepted or resolved by moving the connection point/adjacent branch");
        }
    }
    else if (geometryFeasible) {
        safetyClass = hasEndpointInside ? "open_drop_partial_detail_candidate" : "open_drop_auto_reroute_candidate";
        action = hasEndpointInside ? "reroute_only_after_detail_rule" : "safe_open_connector_reroute_candidate";
        if (hasEndpointInside) {
            preconditions.push("dogleg clears the target duct but endpoint-inside clashes remain");
        }
    }
    else if (hasEndpointInside) {
        safetyClass = "connection_or_equipment_move_required";
        action = "move_connection_point_or_adjacent_branch";
    }

    return {
        success: true,
        sourceElementId,
        targetDuctId,
        currentHitIds: [...currentHits],
        candidateHitIds: [...candidateHits],
        endpointInsideHitIds: [...endpointInsideHits],
        newHitIds,
        removedHitIds,
        reduction,
        geometryFeasible,
        hasConnectedEndpoint,
        connectedConnectorCount,
        hasEndpointInside,
        safetyClass,
        action,
        blockers,
        preconditions,
        canCommit: false,
        riskLevel: hasConnectedEndpoint ? "critical" : geometryFeasible ? "high" : "medium",
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

export function solveOrthogonalReroute({
    routePoints = [],
    obstacleBoxes = [],
    clearanceM = 0.1,
    candidateOffsetAxes = ["y", "z"],
} = {}) {
    if (!Array.isArray(routePoints) || routePoints.length < 2) {
        return {
            success: false,
            errors: ["routePoints must contain at least two points"],
            canCommit: false,
        };
    }
    const obstacles = Array.isArray(obstacleBoxes) ? obstacleBoxes.filter((box) => box?.min && box?.max) : [];
    if (obstacles.length === 0) {
        const start = point(routePoints[0]);
        const end = point(routePoints[routePoints.length - 1]);
        return {
            success: true,
            rerouteRequired: false,
            selectedCandidate: {
                previewPoints: [start, end],
                addedLengthM: 0,
                valid: true,
            },
            candidates: [],
            canCommit: false,
        };
    }
    const start = point(routePoints[0]);
    const end = point(routePoints[routePoints.length - 1]);
    const axis = dominantAxis(start, end);
    if (axis !== "x") {
        return {
            success: false,
            errors: ["foundation reroute solver currently supports x-directed routes"],
            canCommit: false,
        };
    }
    const expandedBoxes = obstacles.map((box) => expandBox(box, Number(clearanceM)));
    const blockingBoxes = expandedBoxes.filter((box) => xSegmentIntersectsBox(start, end, box));
    if (blockingBoxes.length === 0) {
        return {
            success: true,
            rerouteRequired: false,
            expandedObstacleBoxes: expandedBoxes,
            selectedCandidate: {
                previewPoints: [start, end],
                originalLengthM: polylineLength([start, end]),
                rerouteLengthM: polylineLength([start, end]),
                addedLengthM: 0,
                valid: true,
            },
            candidates: [],
            canCommit: false,
        };
    }

    const candidates = [];
    const axes = [...new Set(candidateOffsetAxes.filter((candidate) => candidate === "y" || candidate === "z"))];
    for (const offsetAxis of axes.length > 0 ? axes : ["y"]) {
        for (const side of ["min", "max"]) {
            candidates.push(buildRerouteCandidate({ start, end, blockingBoxes, expandedBoxes, offsetAxis, side, clearanceM }));
        }
    }
    candidates.sort((a, b) => {
        if (a.valid !== b.valid) return a.valid ? -1 : 1;
        if (a.addedLengthM !== b.addedLengthM) return a.addedLengthM - b.addedLengthM;
        return a.violationCount - b.violationCount;
    });
    const selectedCandidate = candidates.find((candidate) => candidate.valid) || candidates[0] || null;
    return {
        success: Boolean(selectedCandidate),
        rerouteRequired: true,
        method: "Candidate orthogonal reroute solver with clearance validation",
        expandedObstacleBoxes: expandedBoxes,
        selectedCandidate,
        candidates,
        assumptions: [
            "Solver generates orthogonal y/z bypass candidates for one x-directed route segment.",
            "Candidate validity checks expanded obstacle boxes including clearance; fittings, bend radius, slope, support, and system reconnection are still proposal-stage checks.",
            "No automatic commit is allowed; selected geometry must become an explicit preview/commit write-plan and be verified after model changes.",
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

function normalizeIdSet(values = []) {
    const set = new Set();
    const list = Array.isArray(values) ? values : [values];
    for (const value of list) {
        if (value === null || value === undefined || value === "") continue;
        set.add(String(value));
    }
    return set;
}

function setDifference(a, b) {
    const rows = [];
    for (const value of a) {
        if (!b.has(value)) rows.push(value);
    }
    return rows;
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

function buildRerouteCandidate({ start, end, blockingBoxes, expandedBoxes, offsetAxis, side, clearanceM }) {
    const margin = Math.max(0.001, Number(clearanceM || 0) * 0.05);
    const bypassValue = side === "min"
        ? Math.min(...blockingBoxes.map((box) => box.min[offsetAxis])) - margin
        : Math.max(...blockingBoxes.map((box) => box.max[offsetAxis])) + margin;
    const entryX = Math.min(...blockingBoxes.map((box) => box.min.x)) - margin;
    const exitX = Math.max(...blockingBoxes.map((box) => box.max.x)) + margin;
    const previewPoints = [
        start,
        { x: entryX, y: start.y, z: start.z },
        { x: entryX, y: offsetAxis === "y" ? bypassValue : start.y, z: offsetAxis === "z" ? bypassValue : start.z },
        { x: exitX, y: offsetAxis === "y" ? bypassValue : end.y, z: offsetAxis === "z" ? bypassValue : end.z },
        { x: exitX, y: end.y, z: end.z },
        end,
    ];
    const violations = clearanceViolations(previewPoints, expandedBoxes);
    const originalLengthM = polylineLength([start, end]);
    const rerouteLengthM = polylineLength(previewPoints);
    return {
        offsetAxis,
        side,
        bypassValue,
        previewPoints,
        originalLengthM,
        rerouteLengthM,
        addedLengthM: rerouteLengthM - originalLengthM,
        violationCount: violations.length,
        violations,
        valid: violations.length === 0,
    };
}

function clearanceViolations(points, boxes) {
    const violations = [];
    for (let index = 1; index < points.length; index++) {
        const a = points[index - 1];
        const b = points[index];
        if (samePoint(a, b)) continue;
        for (const [boxIndex, box] of boxes.entries()) {
            if (axisAlignedSegmentIntersectsBox(a, b, box)) {
                violations.push({ segmentIndex: index - 1, obstacleIndex: boxIndex });
            }
        }
    }
    return violations;
}

function axisAlignedSegmentIntersectsBox(a, b, box) {
    const dx = Math.abs(b.x - a.x);
    const dy = Math.abs(b.y - a.y);
    const dz = Math.abs(b.z - a.z);
    if (dy === 0 && dz === 0) {
        return rangesOverlap(a.x, b.x, box.min.x, box.max.x) && within(a.y, box.min.y, box.max.y) && within(a.z, box.min.z, box.max.z);
    }
    if (dx === 0 && dz === 0) {
        return rangesOverlap(a.y, b.y, box.min.y, box.max.y) && within(a.x, box.min.x, box.max.x) && within(a.z, box.min.z, box.max.z);
    }
    if (dx === 0 && dy === 0) {
        return rangesOverlap(a.z, b.z, box.min.z, box.max.z) && within(a.x, box.min.x, box.max.x) && within(a.y, box.min.y, box.max.y);
    }
    return false;
}

function rangesOverlap(a, b, min, max) {
    const lower = Math.min(Number(a), Number(b));
    const upper = Math.max(Number(a), Number(b));
    return upper >= Number(min) && lower <= Number(max);
}

function within(value, min, max) {
    return Number(value) >= Number(min) && Number(value) <= Number(max);
}

function samePoint(a, b) {
    return a.x === b.x && a.y === b.y && a.z === b.z;
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

function selectPipeElement(elementA, elementB, pipeDiameterM, pipeOrientation) {
    const aIsPipe = isPipeLike(elementA);
    const bIsPipe = isPipeLike(elementB);
    const selected = aIsPipe ? elementA : (bIsPipe ? elementB : {});
    return {
        systemType: selected.systemType || selected.systemName || "",
        diameterM: Number(pipeDiameterM ?? selected.diameterM ?? selected.diameter ?? 0),
        orientation: pipeOrientation || selected.orientation || "",
    };
}

function isPipeLike(element) {
    const category = String(element?.category || "").toLowerCase();
    const kind = String(element?.kind || element?.domain || "").toLowerCase();
    return category.includes("pipe") || kind.includes("pipe") || element?.diameterM !== undefined || element?.diameter !== undefined;
}
