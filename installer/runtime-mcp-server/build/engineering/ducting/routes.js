import { asRecord, boolByFields, makeIssue, normalizeText, numberByFields, pointDistanceMm, pointFromValue, round, stringByFields, validationStatus, valueByFields, } from "./helpers.js";
function pointsFromRoute(route) {
    const direct = valueByFields(route, ["pointsMm", "points_mm", "points"]);
    if (Array.isArray(direct)) {
        const points = direct.map(pointFromValue).filter((point) => !!point);
        if (points.length >= 2)
            return points;
    }
    const segments = valueByFields(route, ["segmentsMm", "segments_mm", "segments"]);
    if (Array.isArray(segments)) {
        const points = [];
        for (const rawSegment of segments) {
            const segment = asRecord(rawSegment);
            const start = pointFromValue(segment.startMm ?? segment.start_mm ?? segment.start ?? (Array.isArray(rawSegment) ? rawSegment[0] : undefined));
            const end = pointFromValue(segment.endMm ?? segment.end_mm ?? segment.end ?? (Array.isArray(rawSegment) ? rawSegment[1] : undefined));
            if (start && points.length === 0)
                points.push(start);
            if (end)
                points.push(end);
        }
        if (points.length >= 2)
            return points;
    }
    return [];
}
function lengthFromPoints(points) {
    let total = 0;
    for (let index = 1; index < points.length; index++) {
        total += pointDistanceMm(points[index - 1], points[index]);
    }
    return total;
}
function elbowCount(points) {
    let count = 0;
    for (let index = 2; index < points.length; index++) {
        const a = points[index - 2];
        const b = points[index - 1];
        const c = points[index];
        const left = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
        const right = { x: c.x - b.x, y: c.y - b.y, z: c.z - b.z };
        const leftLength = Math.sqrt(left.x * left.x + left.y * left.y + left.z * left.z);
        const rightLength = Math.sqrt(right.x * right.x + right.y * right.y + right.z * right.z);
        if (leftLength <= 0 || rightLength <= 0)
            continue;
        const dot = (left.x * right.x + left.y * right.y + left.z * right.z) / (leftLength * rightLength);
        if (dot < 0.98)
            count++;
    }
    return count;
}
function arrayCount(value) {
    return Array.isArray(value) ? value.length : 0;
}
export function validateRoutePreview(routeCandidates = [], rules = {}) {
    const issues = [];
    const options = routeCandidates.map((raw, index) => {
        const route = asRecord(raw);
        const routeIssues = [];
        const points = pointsFromRoute(route);
        const explicitLength = numberByFields(route, ["lengthMm", "length_mm"]);
        const lengthMm = explicitLength ?? lengthFromPoints(points);
        const elbows = numberByFields(route, ["elbowCount", "elbow_count"]) ?? elbowCount(points);
        const obstacleCount = arrayCount(route.obstacleIntersections ?? route.obstacle_intersections);
        const clearanceCount = arrayCount(route.clearanceViolations ?? route.clearance_violations);
        const blocked = boolByFields(route, ["blocked"]) === true || ["blocked", "fail", "error"].includes(normalizeText(valueByFields(route, ["status", "clearanceStatus", "clearance_status"])));
        if (points.length < 2 && explicitLength === undefined) {
            routeIssues.push(makeIssue("route_geometry_missing", "error", "Route candidate has no measurable geometry.", { routeId: stringByFields(route, ["id"]) ?? `route-${index + 1}` }));
        }
        if (lengthMm <= 0) {
            routeIssues.push(makeIssue("route_length_invalid", "error", "Route candidate length is not positive.", { routeId: stringByFields(route, ["id"]) ?? `route-${index + 1}` }));
        }
        if (blocked || obstacleCount > 0 || clearanceCount > 0) {
            routeIssues.push(makeIssue("route_clearance_conflict", "error", "Route candidate has obstacle or clearance conflicts.", {
                routeId: stringByFields(route, ["id"]) ?? `route-${index + 1}`,
                obstacleCount,
                clearanceCount,
            }));
        }
        const score = lengthMm / 1000
            + elbows * (rules.routeElbowPenalty ?? 4)
            + (obstacleCount + clearanceCount) * (rules.routeConflictPenalty ?? 100);
        const status = validationStatus(routeIssues);
        issues.push(...routeIssues);
        return {
            id: stringByFields(route, ["id"]) ?? `route-${index + 1}`,
            status,
            reviewed: boolByFields(route, ["reviewed", "approved"]) === true,
            lengthMm: round(lengthMm),
            elbowCount: elbows,
            obstacleCount,
            clearanceViolationCount: clearanceCount,
            score: round(score),
            issues: routeIssues,
        };
    }).sort((left, right) => Number(left.score) - Number(right.score));
    if (routeCandidates.length === 0) {
        issues.push(makeIssue("route_preview_missing", "warning", "No route preview candidates were provided."));
    }
    return {
        status: routeCandidates.length === 0 ? "not_run" : validationStatus(issues),
        issues,
        summary: {
            routeCandidateCount: routeCandidates.length,
            validRouteCount: options.filter((option) => option.status === "pass" || option.status === "warn").length,
            bestRouteId: options.find((option) => option.status === "pass" || option.status === "warn")?.id,
        },
        options,
    };
}
function graphArray(graph, field) {
    const value = graph[field];
    return Array.isArray(value) ? value.map(asRecord) : [];
}
function nodeId(node) {
    const id = stringByFields(node, ["id", "nodeId", "node_id", "elementId", "element_id", "uniqueId", "unique_id"]);
    return id ? String(id) : undefined;
}
function edgeEnds(edge) {
    const source = stringByFields(edge, ["source", "sourceId", "source_id", "from", "fromId", "from_id", "a"]);
    const target = stringByFields(edge, ["target", "targetId", "target_id", "to", "toId", "to_id", "b"]);
    return [source, target];
}
function summaryNumber(graph, fields) {
    const summary = asRecord(graph.summary);
    return numberByFields(summary, fields) ?? numberByFields(graph, fields);
}
export function validateConnectedDuctNetwork(graphInput, expectedNodeIds = [], rules = {}) {
    const issues = [];
    if (!graphInput || Object.keys(graphInput).length === 0) {
        issues.push(makeIssue("network_graph_missing", "warning", "Connector graph was not provided; connected duct network validation is prepared but not run."));
        return { status: "not_run", issues, summary: { nodeCount: 0, edgeCount: 0 } };
    }
    const graph = asRecord(graphInput);
    const nodes = graphArray(graph, "nodes");
    const edges = graphArray(graph, "edges");
    if (nodes.length === 0) {
        issues.push(makeIssue("network_graph_empty", "error", "Connector graph has no nodes."));
    }
    const nodeIds = nodes.map(nodeId).filter((id) => !!id);
    const nodeSet = new Set(nodeIds);
    const expectedSet = new Set(expectedNodeIds.filter(Boolean));
    for (const expected of expectedSet) {
        if (!nodeSet.has(expected)) {
            issues.push(makeIssue("network_expected_node_missing", "error", "Expected node is missing from the connector graph.", { nodeId: expected }));
        }
    }
    const adjacency = new Map();
    for (const id of nodeIds)
        adjacency.set(id, new Set());
    for (const edge of edges) {
        const [source, target] = edgeEnds(edge);
        if (!source || !target)
            continue;
        if (!adjacency.has(source))
            adjacency.set(source, new Set());
        if (!adjacency.has(target))
            adjacency.set(target, new Set());
        adjacency.get(source).add(target);
        adjacency.get(target).add(source);
    }
    const visited = new Set();
    const components = [];
    for (const start of adjacency.keys()) {
        if (visited.has(start))
            continue;
        const component = [];
        const queue = [start];
        visited.add(start);
        while (queue.length > 0) {
            const current = queue.shift();
            component.push(current);
            for (const next of adjacency.get(current) ?? []) {
                if (!visited.has(next)) {
                    visited.add(next);
                    queue.push(next);
                }
            }
        }
        components.push(component);
    }
    if (components.length > 1) {
        issues.push(makeIssue("duct_graph_disconnected", "error", "Connector graph contains disconnected duct network islands.", {
            componentCount: components.length,
            componentSizes: components.map((component) => component.length),
        }));
    }
    const openEndCount = summaryNumber(graph, ["openEndCount", "open_end_count", "openConnectorCount", "open_connector_count"])
        ?? graphArray(graph, "openEnds").length
        ?? 0;
    if (openEndCount > 0 && rules.allowOpenEnds !== true) {
        issues.push(makeIssue("duct_graph_open_ends", "error", "Connector graph reports open ends.", { openEndCount }));
    }
    const ambiguityCount = summaryNumber(graph, ["directionAmbiguityCount", "direction_ambiguity_count"])
        ?? graphArray(graph, "directionAmbiguities").length
        ?? 0;
    if (ambiguityCount > 0 && rules.allowDirectionAmbiguity !== true) {
        issues.push(makeIssue("duct_graph_direction_ambiguity", "warning", "Connector graph reports direction ambiguity.", { directionAmbiguityCount: ambiguityCount }));
    }
    return {
        status: validationStatus(issues),
        issues,
        summary: {
            nodeCount: nodes.length,
            edgeCount: edges.length,
            componentCount: components.length,
            openEndCount,
            directionAmbiguityCount: ambiguityCount,
        },
    };
}
function nativeSegments(input) {
    if (!input)
        return [];
    if (Array.isArray(input))
        return input.map(asRecord);
    const record = asRecord(input);
    if (Array.isArray(record.segments))
        return record.segments.map(asRecord);
    if (Array.isArray(record.segmentResults))
        return record.segmentResults.map(asRecord);
    return [record];
}
export function validateNativeSizing(input, rules = {}) {
    const issues = [];
    const segments = nativeSegments(input);
    if (segments.length === 0) {
        issues.push(makeIssue("native_sizing_not_run", "warning", "Revit native duct sizing validation was not provided; run or attach a native sizing report before commit."));
        return { status: "not_run", issues, summary: { segmentCount: 0 } };
    }
    const flowTolerancePercent = Math.max(0, rules.flowTolerancePercent ?? 5);
    const sizeToleranceMm = Math.max(0, rules.sizeToleranceMm ?? 5);
    const maxVelocityMps = rules.maxVelocityMps ?? 6;
    for (const segment of segments) {
        const id = stringByFields(segment, ["id", "segmentId", "segment_id", "elementId", "element_id"]) ?? "unknown";
        const status = normalizeText(valueByFields(segment, ["status"]));
        if (["fail", "error", "blocked"].includes(status)) {
            issues.push(makeIssue("native_sizing_segment_failed", "error", "Native sizing report marked a duct segment as failed.", { segmentId: id }));
        }
        const designFlow = numberByFields(segment, ["designFlowLps", "design_flow_lps", "targetFlowLps", "target_flow_lps"]);
        const nativeFlow = numberByFields(segment, ["nativeFlowLps", "native_flow_lps", "revitFlowLps", "revit_flow_lps"]);
        if (designFlow !== undefined && nativeFlow !== undefined && designFlow > 0) {
            const diffPercent = Math.abs(nativeFlow - designFlow) / designFlow * 100;
            if (diffPercent > flowTolerancePercent) {
                issues.push(makeIssue("native_sizing_flow_mismatch", "error", "Native duct flow differs from design flow beyond tolerance.", {
                    segmentId: id,
                    designFlowLps: round(designFlow),
                    nativeFlowLps: round(nativeFlow),
                    diffPercent: round(diffPercent),
                    tolerancePercent: flowTolerancePercent,
                }));
            }
        }
        const widthDiff = dimensionDiff(segment, "width");
        const heightDiff = dimensionDiff(segment, "height");
        const diameterDiff = dimensionDiff(segment, "diameter");
        for (const [dimension, diff] of [["width", widthDiff], ["height", heightDiff], ["diameter", diameterDiff]]) {
            if (diff !== undefined && diff > sizeToleranceMm) {
                issues.push(makeIssue("native_sizing_size_mismatch", "error", "Native duct size differs from design size beyond tolerance.", {
                    segmentId: id,
                    dimension,
                    diffMm: round(diff),
                    toleranceMm: sizeToleranceMm,
                }));
            }
        }
        const velocity = numberByFields(segment, ["nativeVelocityMps", "native_velocity_mps", "velocityMps", "velocity_mps"]);
        if (velocity !== undefined && velocity > maxVelocityMps) {
            issues.push(makeIssue("native_sizing_velocity_exceeds_rule", "error", "Native duct velocity exceeds the project rule.", {
                segmentId: id,
                velocityMps: round(velocity),
                maxVelocityMps,
            }));
        }
    }
    return {
        status: validationStatus(issues),
        issues,
        summary: {
            segmentCount: segments.length,
            flowTolerancePercent,
            sizeToleranceMm,
            maxVelocityMps,
        },
    };
}
function dimensionDiff(segment, dimension) {
    const design = numberByFields(segment, [`design${capitalize(dimension)}Mm`, `design_${dimension}_mm`, `target${capitalize(dimension)}Mm`, `target_${dimension}_mm`]);
    const native = numberByFields(segment, [`native${capitalize(dimension)}Mm`, `native_${dimension}_mm`, `revit${capitalize(dimension)}Mm`, `revit_${dimension}_mm`]);
    if (design === undefined || native === undefined)
        return undefined;
    return Math.abs(native - design);
}
function capitalize(value) {
    return value.charAt(0).toUpperCase() + value.slice(1);
}
