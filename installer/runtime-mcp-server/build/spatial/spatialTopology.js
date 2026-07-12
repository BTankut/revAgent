import { clampInteger, cleanText, compareText, firstDefined } from "./spatialCanonical.js";
const PASS_THROUGH_BUILT_IN_CATEGORIES = new Set([
    "ost_ductcurves",
    "ost_flexductcurves",
    "ost_ductfitting",
    "ost_ductaccessory",
    "ost_pipecurves",
    "ost_flexpipecurves",
    "ost_pipefitting",
    "ost_pipeaccessory",
]);
function normalizedConnectorField(node, paths) {
    return cleanText(firstDefined(node.payload, paths))?.toLowerCase() ?? null;
}
function supportsOwnerTraversal(store, snapshotId, ownerNodeId) {
    const owner = store.getStoredNode(snapshotId, ownerNodeId);
    if (!owner)
        return false;
    if (PASS_THROUGH_BUILT_IN_CATEGORIES.has(owner.builtInCategory?.toLowerCase() ?? ""))
        return true;
    const ownership = store.queryStoredEdges({
        snapshotId,
        sourceNodeIds: [ownerNodeId],
        relationTypes: ["owns_connector"],
        limit: 2_000,
    });
    if (ownership.hasMore)
        return false;
    const connectorIds = ownership.edges.map((edge) => edge.targetNodeId);
    if (connectorIds.length <= 1)
        return true;
    const connectors = store.getStoredNodesByIds(snapshotId, connectorIds);
    if (connectors.length !== connectorIds.length)
        return false;
    const systemKeys = new Set(connectors.map((connector) => connector.systemKey).filter((value) => Boolean(value)));
    if (systemKeys.size !== 1 || connectors.some((connector) => !connector.systemKey))
        return false;
    const domains = new Set(connectors.map((connector) => normalizedConnectorField(connector, [["domain"]]))
        .filter((value) => value !== null));
    if (domains.size !== 1 || connectors.some((connector) => normalizedConnectorField(connector, [["domain"]]) === null))
        return false;
    const classifications = new Set(connectors.map((connector) => normalizedConnectorField(connector, [
        ["spatialProperties", "systemClassification"],
    ])).filter((value) => value !== null));
    return classifications.size <= 1;
}
function opposite(edge, nodeId) {
    if (edge.sourceNodeId === nodeId)
        return edge.targetNodeId;
    if (edge.targetNodeId === nodeId && (edge.bidirectional || edge.relationType === "owns_connector")) {
        return edge.sourceNodeId;
    }
    return null;
}
export function traceSpatialConnectivity(store, snapshotId, input) {
    const startNodeId = cleanText(input.startNodeId) ?? "";
    const targetNodeId = cleanText(input.targetNodeId);
    const maxDepth = clampInteger(input.maxDepth, 20, 0, 100);
    const maxNodes = clampInteger(input.maxNodes, 500, 1, 5_000);
    const queue = [{ nodeId: startNodeId, depth: 0 }];
    const visited = new Set();
    const discoveredEdges = new Map();
    const parent = new Map();
    let maxDepthReached = 0;
    let truncated = false;
    const unsupportedOwnerNodeIds = new Set();
    const ownerTraversalSupport = new Map();
    while (queue.length > 0) {
        const current = queue.shift();
        if (visited.has(current.nodeId))
            continue;
        if (visited.size >= maxNodes) {
            truncated = true;
            break;
        }
        visited.add(current.nodeId);
        maxDepthReached = Math.max(maxDepthReached, current.depth);
        if (targetNodeId && current.nodeId === targetNodeId)
            break;
        const page = store.queryStoredEdges({
            snapshotId,
            incidentNodeIds: [current.nodeId],
            relationTypes: ["connected_to", "owns_connector"],
            limit: 2_000,
        });
        if (page.hasMore)
            truncated = true;
        const neighbors = page.edges
            .map((edge) => ({ edge, neighbor: opposite(edge, current.nodeId) }))
            .filter((item) => item.neighbor !== null)
            .filter(({ edge }) => {
            if (edge.relationType !== "owns_connector")
                return true;
            const ownerNodeId = edge.sourceNodeId;
            if (current.nodeId === ownerNodeId && ownerNodeId === startNodeId)
                return true;
            if (current.nodeId !== ownerNodeId && ownerNodeId === targetNodeId)
                return true;
            let supported = ownerTraversalSupport.get(ownerNodeId);
            if (supported === undefined) {
                supported = supportsOwnerTraversal(store, snapshotId, ownerNodeId);
                ownerTraversalSupport.set(ownerNodeId, supported);
            }
            if (!supported)
                unsupportedOwnerNodeIds.add(ownerNodeId);
            return supported;
        })
            .sort((left, right) => compareText(left.neighbor, right.neighbor) || compareText(left.edge.edgeId, right.edge.edgeId));
        for (const { edge, neighbor } of neighbors) {
            discoveredEdges.set(edge.edgeId, edge);
            if (current.depth >= maxDepth) {
                if (!visited.has(neighbor))
                    truncated = true;
                continue;
            }
            if (!visited.has(neighbor) && !parent.has(neighbor)) {
                parent.set(neighbor, { nodeId: current.nodeId, edgeId: edge.edgeId });
                queue.push({ nodeId: neighbor, depth: current.depth + 1 });
            }
        }
    }
    const reachedTarget = targetNodeId ? visited.has(targetNodeId) : null;
    if (unsupportedOwnerNodeIds.size > 0 && reachedTarget !== true)
        truncated = true;
    const pathNodeIds = [];
    const pathEdgeIds = [];
    if (targetNodeId && reachedTarget) {
        let cursor = targetNodeId;
        pathNodeIds.push(cursor);
        while (cursor !== startNodeId) {
            const previous = parent.get(cursor);
            if (!previous)
                break;
            pathEdgeIds.push(previous.edgeId);
            cursor = previous.nodeId;
            pathNodeIds.push(cursor);
        }
        pathNodeIds.reverse();
        pathEdgeIds.reverse();
    }
    const visitedNodeIds = [...visited].sort(compareText);
    return {
        startNodeId,
        targetNodeId,
        reachedTarget: targetNodeId && !reachedTarget && truncated ? null : reachedTarget,
        visitedNodeIds,
        nodes: store.getStoredNodesByIds(snapshotId, visitedNodeIds),
        edges: [...discoveredEdges.values()].sort((left, right) => compareText(left.edgeId, right.edgeId)),
        pathNodeIds,
        pathEdgeIds,
        maxDepthReached,
        complete: !truncated,
        truncated,
        unsupportedOwnerNodeIds: [...unsupportedOwnerNodeIds].sort(compareText),
        basis: "stored_connector_topology",
        precisionClass: "measured",
        verdictCapability: "context_only",
    };
}
