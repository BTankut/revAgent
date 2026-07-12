import type { SpatialStore, SpatialStoredEdge, SpatialStoredNode } from "./spatialStore.js";
import { clampInteger, cleanText, compareText, firstDefined } from "./spatialCanonical.js";

export interface SpatialConnectivityTraceInput {
    startNodeId: string;
    targetNodeId?: string;
    maxDepth?: number;
    maxNodes?: number;
}

export interface SpatialConnectivityTraceResult {
    startNodeId: string;
    targetNodeId: string | null;
    reachedTarget: boolean | null;
    visitedNodeIds: string[];
    nodes: SpatialStoredNode[];
    edges: SpatialStoredEdge[];
    pathNodeIds: string[];
    pathEdgeIds: string[];
    maxDepthReached: number;
    complete: boolean;
    truncated: boolean;
    unsupportedOwnerNodeIds: string[];
    basis: "stored_connector_topology";
    precisionClass: "measured";
    verdictCapability: "context_only";
}

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

function normalizedConnectorField(node: SpatialStoredNode, paths: readonly (readonly string[])[]): string | null {
    return cleanText(firstDefined(node.payload, paths))?.toLowerCase() ?? null;
}

function supportsOwnerTraversal(
    store: SpatialStore,
    snapshotId: string,
    ownerNodeId: string,
): boolean {
    const owner = store.getStoredNode(snapshotId, ownerNodeId);
    if (!owner) return false;
    if (PASS_THROUGH_BUILT_IN_CATEGORIES.has(owner.builtInCategory?.toLowerCase() ?? "")) return true;
    const ownership = store.queryStoredEdges({
        snapshotId,
        sourceNodeIds: [ownerNodeId],
        relationTypes: ["owns_connector"],
        limit: 2_000,
    });
    if (ownership.hasMore) return false;
    const connectorIds = ownership.edges.map((edge) => edge.targetNodeId);
    if (connectorIds.length <= 1) return true;
    const connectors = store.getStoredNodesByIds(snapshotId, connectorIds);
    if (connectors.length !== connectorIds.length) return false;
    const systemKeys = new Set(connectors.map((connector) => connector.systemKey).filter((value): value is string => Boolean(value)));
    if (systemKeys.size !== 1 || connectors.some((connector) => !connector.systemKey)) return false;
    const domains = new Set(connectors.map((connector) => normalizedConnectorField(connector, [["domain"]]))
        .filter((value): value is string => value !== null));
    if (domains.size !== 1 || connectors.some((connector) => normalizedConnectorField(connector, [["domain"]]) === null)) return false;
    const classifications = new Set(connectors.map((connector) => normalizedConnectorField(connector, [
        ["spatialProperties", "systemClassification"],
    ])).filter((value): value is string => value !== null));
    return classifications.size <= 1;
}

function opposite(edge: SpatialStoredEdge, nodeId: string): string | null {
    if (edge.sourceNodeId === nodeId) return edge.targetNodeId;
    if (edge.targetNodeId === nodeId && (edge.bidirectional || edge.relationType === "owns_connector")) {
        return edge.sourceNodeId;
    }
    return null;
}

export function traceSpatialConnectivity(
    store: SpatialStore,
    snapshotId: string,
    input: SpatialConnectivityTraceInput,
): SpatialConnectivityTraceResult {
    const startNodeId = cleanText(input.startNodeId) ?? "";
    const targetNodeId = cleanText(input.targetNodeId);
    const maxDepth = clampInteger(input.maxDepth, 20, 0, 100);
    const maxNodes = clampInteger(input.maxNodes, 500, 1, 5_000);
    const queue: Array<{ nodeId: string; depth: number }> = [{ nodeId: startNodeId, depth: 0 }];
    const visited = new Set<string>();
    const discoveredEdges = new Map<string, SpatialStoredEdge>();
    const parent = new Map<string, { nodeId: string; edgeId: string }>();
    let maxDepthReached = 0;
    let truncated = false;
    const unsupportedOwnerNodeIds = new Set<string>();
    const ownerTraversalSupport = new Map<string, boolean>();

    while (queue.length > 0) {
        const current = queue.shift()!;
        if (visited.has(current.nodeId)) continue;
        if (visited.size >= maxNodes) {
            truncated = true;
            break;
        }
        visited.add(current.nodeId);
        maxDepthReached = Math.max(maxDepthReached, current.depth);
        if (targetNodeId && current.nodeId === targetNodeId) break;
        const page = store.queryStoredEdges({
            snapshotId,
            incidentNodeIds: [current.nodeId],
            relationTypes: ["connected_to", "owns_connector"],
            limit: 2_000,
        });
        if (page.hasMore) truncated = true;
        const neighbors = page.edges
            .map((edge) => ({ edge, neighbor: opposite(edge, current.nodeId) }))
            .filter((item): item is { edge: SpatialStoredEdge; neighbor: string } => item.neighbor !== null)
            .filter(({ edge }) => {
                if (edge.relationType !== "owns_connector") return true;
                const ownerNodeId = edge.sourceNodeId;
                if (current.nodeId === ownerNodeId && ownerNodeId === startNodeId) return true;
                if (current.nodeId !== ownerNodeId && ownerNodeId === targetNodeId) return true;
                let supported = ownerTraversalSupport.get(ownerNodeId);
                if (supported === undefined) {
                    supported = supportsOwnerTraversal(store, snapshotId, ownerNodeId);
                    ownerTraversalSupport.set(ownerNodeId, supported);
                }
                if (!supported) unsupportedOwnerNodeIds.add(ownerNodeId);
                return supported;
            })
            .sort((left, right) => compareText(left.neighbor, right.neighbor) || compareText(left.edge.edgeId, right.edge.edgeId));
        for (const { edge, neighbor } of neighbors) {
            discoveredEdges.set(edge.edgeId, edge);
            if (current.depth >= maxDepth) {
                if (!visited.has(neighbor)) truncated = true;
                continue;
            }
            if (!visited.has(neighbor) && !parent.has(neighbor)) {
                parent.set(neighbor, { nodeId: current.nodeId, edgeId: edge.edgeId });
                queue.push({ nodeId: neighbor, depth: current.depth + 1 });
            }
        }
    }

    const reachedTarget = targetNodeId ? visited.has(targetNodeId) : null;
    if (unsupportedOwnerNodeIds.size > 0 && reachedTarget !== true) truncated = true;
    const pathNodeIds: string[] = [];
    const pathEdgeIds: string[] = [];
    if (targetNodeId && reachedTarget) {
        let cursor = targetNodeId;
        pathNodeIds.push(cursor);
        while (cursor !== startNodeId) {
            const previous = parent.get(cursor);
            if (!previous) break;
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
