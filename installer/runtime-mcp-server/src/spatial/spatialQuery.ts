import type { SpatialAabb, SpatialStore, SpatialStoredNode } from "./spatialStore.js";
import type {
    SpatialCapabilityCoverage,
    SpatialGuardedResult,
    SpatialNodeFilters,
    SpatialOperationInput,
    SpatialQueryCompletedResult,
    SpatialQueryInput,
    SpatialQueryResult,
} from "./spatialTypes.js";
import {
    aboveBelowRelation,
    inflateAabb,
    locateNodeInSpace,
    mergeAabbs,
    relationBetweenNodes,
    spatialGeometry,
} from "./spatialGeometry.js";
import { traceSpatialConnectivity } from "./spatialTopology.js";
import {
    buildSpatialQueryFingerprint,
    decodeSpatialQueryCursor,
    encodeSpatialQueryCursor,
    SpatialQueryCursorError,
} from "./spatialQueryCursor.js";
import { canonicalJson, clampInteger, cleanText, compareText, createEvidenceId, finiteNumber } from "./spatialCanonical.js";

const QUERY_ACTION = "query_spatial_context";
const MAX_INTERNAL_CANDIDATES = 10_000;
const MAX_QUERY_RESPONSE_BYTES = 8 * 1024 * 1024;

export function spatialCapabilityCoverage(schemaVersion: string): SpatialCapabilityCoverage | null {
    if (schemaVersion === "0.3") {
        return {
            schemaVersion,
            adapter: "native_v03",
            geometry: true,
            properties: true,
            topology: true,
            analyticClearance: true,
            containment: true,
            limitations: [
                "analytic_clearance_is_limited_to_explicitly_supported_straight_round_swept_profiles",
                "aabb_only_shape_change_not_classified_without_rotation_invariant_primitive",
                "relation_outputs_are_context_or_screening_only_never_live_verdict",
            ],
        };
    }
    if (schemaVersion === "0.2") {
        return {
            schemaVersion,
            adapter: "legacy_v02",
            geometry: true,
            properties: false,
            topology: false,
            analyticClearance: false,
            containment: true,
            limitations: [
                "legacy_v02_has_no_system_property_or_topology_contract",
                "legacy_v02_has_no_supported_profile_clearance_contract",
                "legacy_v02_indexed_metadata_filters_require_explicit_node_ids",
                "relation_outputs_are_context_or_screening_only_never_live_verdict",
            ],
        };
    }
    return null;
}

function guarded(
    reason: string,
    message: string,
    warnings: readonly string[] = [],
    scanPolicy: Record<string, unknown> = {},
    snapshotCoverage?: { partial: boolean; coverageStatus: string | null },
): SpatialGuardedResult {
    return {
        success: true,
        guarded: true,
        state: "guarded",
        action: QUERY_ACTION,
        reason,
        message,
        partial: snapshotCoverage?.partial ?? false,
        ...(snapshotCoverage === undefined ? {} : {
            coverageStatus: snapshotCoverage.coverageStatus,
        }),
        truncated: false,
        scanStoppedReason: reason === "needs_scope" ? "needs_scope" : reason === "max_bytes" ? "max_bytes" : "read_failed",
        scanPolicy,
        suggestedNextScopes: reason === "needs_scope" ? ["snapshotId", "nodeIds"] : [],
        nextCursor: null,
        warnings: [...new Set(warnings)],
        notices: [],
        elapsedMs: 0,
        queryId: createEvidenceId("spatial-query"),
        counts: { nodeCount: 0, edgeCount: 0, computedCount: 0 },
    };
}

function queryWarnings(input: SpatialQueryInput, capability: SpatialCapabilityCoverage): string[] {
    return [...new Set([
        ...(input.trust?.warnings ?? []),
        ...capability.limitations,
        ...(input.trust?.liveness && input.trust.liveness !== "current"
            ? [`snapshot_liveness_${input.trust.liveness}`]
            : []),
    ])];
}

function requiresIndexedV03Filters(filters: SpatialNodeFilters | undefined): boolean {
    return Boolean(filters && [
        filters.categories,
        filters.builtInCategories,
        filters.categoryRoles,
        filters.levelNames,
        filters.levelUniqueIds,
        filters.systemKeys,
        filters.ownerNodeIds,
    ].some((values) => Array.isArray(values) && values.length > 0));
}

function hasRetrieveScope(filters: SpatialNodeFilters | undefined): boolean {
    if (!filters) return false;
    return Boolean(filters.aabb || filters.elevationBandMm
        || Object.entries(filters).some(([key, value]) => key !== "aabb"
            && key !== "elevationBandMm"
            && Array.isArray(value)
            && value.some((item) => cleanText(item) !== null)));
}

function toStoreQuery(snapshotId: string, filters: SpatialNodeFilters | undefined, limit: number, afterNodeId?: string | null) {
    return {
        snapshotId,
        nodeIds: filters?.nodeIds,
        nodeKinds: filters?.nodeKinds,
        categories: filters?.categories,
        builtInCategories: filters?.builtInCategories,
        categoryRoles: filters?.categoryRoles,
        levelNames: filters?.levelNames,
        levelUniqueIds: filters?.levelUniqueIds,
        systemKeys: filters?.systemKeys,
        ownerNodeIds: filters?.ownerNodeIds,
        aabb: filters?.aabb,
        elevationBandMm: filters?.elevationBandMm,
        limit,
        afterNodeId,
    };
}

interface SpatialRetrieveNodePage {
    nodes: SpatialStoredNode[];
    hasMore: boolean;
    pageEndNodeId: string | null;
    scannedNodeCount: number;
    unsupportedNodeId: string | null;
}

interface PreparedRetrieveFilters {
    storeFilters: SpatialNodeFilters;
    spaces: SpatialStoredNode[];
    empty: boolean;
}

function intersectAabbs(left: SpatialAabb, right: SpatialAabb): SpatialAabb | null {
    const minMm: [number, number, number] = [
        Math.max(left.minMm[0], right.minMm[0]),
        Math.max(left.minMm[1], right.minMm[1]),
        Math.max(left.minMm[2], right.minMm[2]),
    ];
    const maxMm: [number, number, number] = [
        Math.min(left.maxMm[0], right.maxMm[0]),
        Math.min(left.maxMm[1], right.maxMm[1]),
        Math.min(left.maxMm[2], right.maxMm[2]),
    ];
    return minMm.every((value, index) => value <= maxMm[index]) ? { minMm, maxMm } : null;
}

function prepareRetrieveFilters(
    store: SpatialStore,
    snapshotId: string,
    filters: SpatialNodeFilters | undefined,
): PreparedRetrieveFilters | SpatialGuardedResult {
    const elevationBand = filters?.elevationBandMm;
    if (elevationBand) {
        const minZ = finiteNumber(elevationBand.minZ);
        const maxZ = finiteNumber(elevationBand.maxZ);
        if (minZ === null || maxZ === null || minZ > maxZ) {
            return guarded("invalid_filter", "elevationBandMm requires finite minZ <= maxZ.");
        }
    }
    const withinSpaceNodeIds = [...new Set((filters?.withinSpaceNodeIds ?? [])
        .map(cleanText)
        .filter((value): value is string => value !== null))].sort(compareText);
    if (withinSpaceNodeIds.length > 100) {
        return guarded("needs_scope", "withinSpaceNodeIds is bounded to at most 100 explicit space nodes.");
    }
    const storeFilters: SpatialNodeFilters = { ...(filters ?? {}) };
    delete storeFilters.withinSpaceNodeIds;
    if (withinSpaceNodeIds.length === 0) return { storeFilters, spaces: [], empty: false };
    const spaces = store.getStoredNodesByIds(snapshotId, withinSpaceNodeIds);
    if (spaces.length !== withinSpaceNodeIds.length) {
        return guarded("node_not_found", "Every withinSpaceNodeIds entry must identify a committed node in the selected snapshot.");
    }
    let union: SpatialAabb | null = null;
    for (const space of spaces) {
        const geometry = spatialGeometry(space);
        if (!space.aabb || geometry.boundaryLoops.length === 0) {
            return guarded(
                "unsupported_geometry",
                "withinSpaceNodeIds requires stored boundary loops and vertical extents for every selected space.",
            );
        }
        union = mergeAabbs(union, space.aabb);
    }
    if (!union) return { storeFilters, spaces, empty: true };
    if (storeFilters.aabb) {
        const intersection = intersectAabbs(storeFilters.aabb, union);
        if (!intersection) return { storeFilters, spaces, empty: true };
        storeFilters.aabb = intersection;
    } else {
        storeFilters.aabb = union;
    }
    return { storeFilters, spaces, empty: false };
}

function queryRetrieveNodePage(
    store: SpatialStore,
    snapshotId: string,
    prepared: PreparedRetrieveFilters,
    limit: number,
    afterNodeId: string | null,
): SpatialRetrieveNodePage {
    if (prepared.empty) {
        return { nodes: [], hasMore: false, pageEndNodeId: afterNodeId, scannedNodeCount: 0, unsupportedNodeId: null };
    }
    if (prepared.spaces.length === 0) {
        const page = store.queryStoredNodes(toStoreQuery(snapshotId, prepared.storeFilters, limit, afterNodeId));
        return {
            nodes: page.nodes,
            hasMore: page.hasMore,
            pageEndNodeId: page.nodes.at(-1)?.nodeId ?? afterNodeId,
            scannedNodeCount: page.nodes.length,
            unsupportedNodeId: null,
        };
    }
    const selected: SpatialStoredNode[] = [];
    const maximumScannedNodes = Math.min(MAX_INTERNAL_CANDIDATES, Math.max(1_000, limit * 20));
    let scanAfterNodeId = afterNodeId;
    let scannedNodeCount = 0;
    let hasMore = false;
    while (selected.length < limit && scannedNodeCount < maximumScannedNodes) {
        const page = store.queryStoredNodes(toStoreQuery(
            snapshotId,
            prepared.storeFilters,
            Math.min(1_000, maximumScannedNodes - scannedNodeCount),
            scanAfterNodeId,
        ));
        for (let index = 0; index < page.nodes.length; index += 1) {
            const node = page.nodes[index];
            scannedNodeCount += 1;
            scanAfterNodeId = node.nodeId;
            if (prepared.spaces.some((space) => space.nodeId === node.nodeId)) continue;
            const containments = prepared.spaces.map((space) => locateNodeInSpace(node, space));
            if (containments.some((containment) => containment.status === "inside" || containment.status === "boundary")) selected.push(node);
            else if (containments.some((containment) => containment.status === "unsupported")) {
                return {
                    nodes: [],
                    hasMore: false,
                    pageEndNodeId: scanAfterNodeId,
                    scannedNodeCount,
                    unsupportedNodeId: node.nodeId,
                };
            }
            if (selected.length >= limit) {
                hasMore = index + 1 < page.nodes.length || page.hasMore;
                break;
            }
        }
        if (selected.length >= limit) break;
        if (!page.hasMore) {
            hasMore = false;
            break;
        }
        if (!page.nextNodeId || page.nextNodeId === scanAfterNodeId && page.nodes.length === 0) {
            hasMore = true;
            break;
        }
        if (page.nodes.length > 0) scanAfterNodeId = page.nodes.at(-1)!.nodeId;
        hasMore = true;
    }
    if (scannedNodeCount >= maximumScannedNodes) hasMore = true;
    return {
        nodes: selected,
        hasMore,
        pageEndNodeId: scanAfterNodeId,
        scannedNodeCount,
        unsupportedNodeId: null,
    };
}

function collectStoredNodes(
    store: SpatialStore,
    snapshotId: string,
    filters: SpatialNodeFilters | undefined,
    maximum: number,
): { nodes: SpatialStoredNode[]; truncated: boolean } {
    const nodes: SpatialStoredNode[] = [];
    let afterNodeId: string | null = null;
    let truncated = false;
    while (nodes.length < maximum) {
        const page = store.queryStoredNodes(toStoreQuery(
            snapshotId,
            filters,
            Math.min(1_000, maximum - nodes.length),
            afterNodeId,
        ));
        nodes.push(...page.nodes);
        if (!page.hasMore) break;
        if (!page.nextNodeId || page.nextNodeId === afterNodeId) {
            truncated = true;
            break;
        }
        afterNodeId = page.nextNodeId;
        if (nodes.length >= maximum) truncated = true;
    }
    return { nodes, truncated };
}

function collectPreparedStoredNodes(
    store: SpatialStore,
    snapshotId: string,
    prepared: PreparedRetrieveFilters,
    maximum: number,
): { nodes: SpatialStoredNode[]; truncated: boolean; guarded?: SpatialGuardedResult } {
    const nodes: SpatialStoredNode[] = [];
    let afterNodeId: string | null = null;
    let truncated = false;
    while (nodes.length < maximum) {
        const page = queryRetrieveNodePage(
            store,
            snapshotId,
            prepared,
            Math.min(1_000, maximum - nodes.length),
            afterNodeId,
        );
        if (page.unsupportedNodeId) {
            return {
                nodes: [],
                truncated: false,
                guarded: guarded(
                    "unsupported_geometry",
                    "within-space filtering encountered an AABB-only candidate that cannot be classified as inside or outside.",
                    [`unsupported_node_id:${page.unsupportedNodeId}`],
                ),
            };
        }
        nodes.push(...page.nodes);
        if (!page.hasMore) break;
        if (!page.pageEndNodeId || page.pageEndNodeId === afterNodeId) {
            truncated = true;
            break;
        }
        afterNodeId = page.pageEndNodeId;
        if (nodes.length >= maximum) truncated = true;
    }
    return { nodes, truncated };
}

function completeSnapshot(record: NonNullable<ReturnType<SpatialStore["getSnapshotRecord"]>>): boolean {
    return record.complete && !record.partial && record.coverageStatus === "complete";
}

function operationNodePair(
    store: SpatialStore,
    snapshotId: string,
    sourceNodeId: string,
    targetNodeId: string,
): [SpatialStoredNode, SpatialStoredNode] | null {
    const ids = [cleanText(sourceNodeId), cleanText(targetNodeId)];
    if (ids.some((value) => !value)) return null;
    const nodes = store.getStoredNodesByIds(snapshotId, ids as string[]);
    const byId = new Map(nodes.map((node) => [node.nodeId, node]));
    const source = byId.get(ids[0]!);
    const target = byId.get(ids[1]!);
    return source && target ? [source, target] : null;
}

function operationRequirements(
    operation: SpatialOperationInput,
    capability: SpatialCapabilityCoverage,
    snapshotComplete: boolean,
): SpatialGuardedResult | null {
    if (["nearest_elements", "elements_within", "locate_in_space", "trace_connectivity"].includes(operation.name)
        && !snapshotComplete) {
        return guarded(
            "incomplete_snapshot",
            `${operation.name} requires a complete snapshot because missing nodes could change the deterministic result.`,
        );
    }
    if (operation.name === "trace_connectivity" && !capability.topology) {
        return guarded(
            "unsupported_snapshot_capability",
            "trace_connectivity requires a v0.3 snapshot with explicit connector peer topology.",
            capability.limitations,
        );
    }
    if (operation.name === "clearance_between" && !capability.analyticClearance) {
        return guarded(
            "unsupported_snapshot_capability",
            "clearance_between requires a v0.3 snapshot with explicit supported profile dimensions.",
            capability.limitations,
        );
    }
    return null;
}

function operationResultBase(
    snapshot: NonNullable<ReturnType<SpatialStore["getSnapshotRecord"]>>,
    input: SpatialQueryInput,
    capability: SpatialCapabilityCoverage,
    startedAt: number,
): Omit<SpatialQueryCompletedResult, "nodes" | "edges" | "computed" | "partial" | "truncated" | "nextCursor"> {
    return {
        success: true,
        guarded: false,
        state: "completed",
        action: QUERY_ACTION,
        queryId: createEvidenceId("spatial-query"),
        snapshotId: snapshot.snapshotId,
        revisionFingerprint: snapshot.revisionFingerprint,
        scopeFingerprint: snapshot.scopeFingerprint,
        liveness: input.trust?.liveness ?? "unknown",
        mode: input.mode,
        capabilityCoverage: capability,
        verdictCapability: "context_only",
        scanStoppedReason: "completed",
        scanPolicy: {},
        suggestedNextScopes: [],
        counts: {},
        warnings: queryWarnings(input, capability),
        notices: [],
        elapsedMs: Date.now() - startedAt,
    };
}

function runPairOperation(
    store: SpatialStore,
    snapshotId: string,
    operation: Extract<SpatialOperationInput, { name: "relation_between" | "clearance_between" | "above_below" }>,
) {
    const pair = operationNodePair(store, snapshotId, operation.sourceNodeId, operation.targetNodeId);
    if (!pair) return null;
    const computed = operation.name === "above_below"
        ? aboveBelowRelation(pair[0], pair[1], operation.toleranceMm)
        : relationBetweenNodes(pair[0], pair[1]);
    return computed ? { nodes: pair, computed } : null;
}

function runNeighborOperation(
    store: SpatialStore,
    snapshotId: string,
    operation: Extract<SpatialOperationInput, { name: "nearest_elements" | "elements_within" }>,
) {
    const anchor = store.getStoredNode(snapshotId, operation.anchorNodeId);
    const distanceMm = finiteNumber(operation.name === "nearest_elements"
        ? operation.maxDistanceMm
        : operation.distanceMm);
    if (!anchor || !anchor.aabb || distanceMm === null || distanceMm < 0) return null;
    const maximum = clampInteger(operation.limit, 20, 1, 500);
    const radiusAabb = inflateAabb(anchor.aabb, distanceMm);
    const effectiveAabb = operation.filters?.aabb
        ? intersectAabbs(operation.filters.aabb, radiusAabb)
        : radiusAabb;
    if (!effectiveAabb) {
        return {
            nodes: [anchor],
            computed: [],
            truncated: false,
            candidateCount: 0,
        };
    }
    const filters: SpatialNodeFilters = {
        ...(operation.filters ?? {}),
        aabb: effectiveAabb,
    };
    const prepared = prepareRetrieveFilters(store, snapshotId, filters);
    if ("guarded" in prepared) return { guarded: prepared };
    const candidates = collectPreparedStoredNodes(store, snapshotId, prepared, MAX_INTERNAL_CANDIDATES);
    if (candidates.guarded) return { guarded: candidates.guarded };
    const computed = candidates.nodes
        .filter((node) => node.nodeId !== anchor.nodeId)
        .map((node) => ({ node, relation: relationBetweenNodes(anchor, node) }))
        .filter((row): row is { node: SpatialStoredNode; relation: NonNullable<ReturnType<typeof relationBetweenNodes>> } => row.relation !== null)
        .filter((row) => row.relation.separationMm <= distanceMm)
        .sort((left, right) => left.relation.separationMm - right.relation.separationMm
            || compareText(left.node.nodeId, right.node.nodeId));
    const selected = computed.slice(0, maximum);
    return {
        nodes: [anchor, ...selected.map((row) => row.node)],
        computed: selected.map((row) => row.relation),
        truncated: candidates.truncated || computed.length > maximum,
        candidateCount: candidates.nodes.length,
    };
}

function runLocateOperation(
    store: SpatialStore,
    snapshotId: string,
    operation: Extract<SpatialOperationInput, { name: "locate_in_space" }>,
    capability: SpatialCapabilityCoverage,
) {
    const node = store.getStoredNode(snapshotId, operation.nodeId);
    if (!node || !node.aabb) return null;
    const explicitSpaceIds = (operation.spaceNodeIds ?? []).map(cleanText).filter((value): value is string => value !== null);
    if (capability.adapter === "legacy_v02" && explicitSpaceIds.length === 0) {
        return { guarded: guarded(
            "needs_scope",
            "Legacy v0.2 containment requires explicit spaceNodeIds because indexed spatial-role projections were introduced in v0.3.",
            capability.limitations,
        ) };
    }
    const maximum = clampInteger(operation.maxSpaces, 100, 1, 1_000);
    const spaces = explicitSpaceIds.length > 0
        ? { nodes: store.getStoredNodesByIds(snapshotId, explicitSpaceIds), truncated: false }
        : collectStoredNodes(store, snapshotId, {
            categoryRoles: ["spatial"],
            aabb: node.aabb,
        }, maximum + 1);
    if (explicitSpaceIds.length > 0 && spaces.nodes.length !== explicitSpaceIds.length) {
        return { guarded: guarded("node_not_found", "Every explicit spaceNodeIds entry must identify a committed node.") };
    }
    const evaluated = spaces.nodes
        .filter((space) => space.nodeId !== node.nodeId)
        .map((space) => ({ space, containment: locateNodeInSpace(node, space) }))
        .sort((left, right) => compareText(left.space.nodeId, right.space.nodeId));
    const computed = evaluated.filter((row) => row.containment.status !== "outside");
    if (computed.length > 0 && computed.every((row) => row.containment.status === "unsupported")) {
        return { guarded: guarded(
            "unsupported_geometry",
            "locate_in_space requires stored point, centerline, or boundary evidence plus a readable space boundary; AABB-only containment is not supported.",
        ) };
    }
    return {
        nodes: [node, ...computed.slice(0, maximum).map((row) => row.space)],
        computed: computed.slice(0, maximum).map((row) => row.containment),
        truncated: spaces.truncated || computed.length > maximum,
        basis: computed.some((row) => row.containment.status === "unsupported")
            ? "mixed_boundary_and_unsupported_geometry"
            : "stored_boundary_loops_and_vertical_extent",
        precisionClass: computed.some((row) => row.containment.precisionClass === "candidate")
            ? "candidate" as const
            : "measured" as const,
        unsupportedCount: computed.filter((row) => row.containment.status === "unsupported").length,
    };
}

function querySpatialContextCore(store: SpatialStore, input: SpatialQueryInput): SpatialQueryResult {
    const startedAt = Date.now();
    const snapshotId = cleanText(input.snapshotId);
    if (!snapshotId) return guarded("needs_scope", "query_spatial_context requires an explicit snapshotId.");
    const snapshot = store.getSnapshotRecord(snapshotId);
    if (!snapshot) return guarded("snapshot_not_found", `Spatial snapshot ${snapshotId} was not found in the local store.`);
    const capability = spatialCapabilityCoverage(snapshot.schemaVersion);
    if (!capability) {
        return guarded(
            "unsupported_snapshot_schema",
            `Spatial snapshot schema ${snapshot.schemaVersion} is not supported by the Phase 1b runtime adapter.`,
        );
    }
    if (!completeSnapshot(snapshot)) {
        return guarded(
            "incomplete_snapshot",
            "Deterministic spatial queries require a complete, non-partial snapshot with coverageStatus=complete.",
            [
                `snapshot_complete:${snapshot.complete}`,
                `snapshot_partial:${snapshot.partial}`,
                `snapshot_coverage_status:${snapshot.coverageStatus}`,
                ...queryWarnings(input, capability),
            ],
            {},
            {
                partial: snapshot.partial,
                coverageStatus: snapshot.coverageStatus,
            },
        );
    }
    if (input.requireCurrent && input.trust?.liveness !== "current") {
        return guarded(
            "snapshot_not_current",
            "The requested current-state query requires a live liveness probe returning current.",
            queryWarnings(input, capability),
        );
    }

    if (input.mode === "retrieve") {
        if (!hasRetrieveScope(input.filters)) {
            return guarded(
                "needs_scope",
                "retrieve mode requires an explicit node, category, role, level, system, AABB, elevation-band, or within-space filter; whole-snapshot dumps are not supported.",
            );
        }
        if (capability.adapter === "legacy_v02" && requiresIndexedV03Filters(input.filters)
            && (!input.filters?.nodeIds || input.filters.nodeIds.length === 0)) {
            return guarded(
                "unsupported_snapshot_capability",
                "Legacy v0.2 metadata filters require explicit nodeIds; v0.3 adds indexed property projections.",
                capability.limitations,
            );
        }
        const limit = clampInteger(input.limit, 100, 1, 1_000);
        const edgeLimit = clampInteger(input.edgeLimit, 500, 1, 2_000);
        const prepared = prepareRetrieveFilters(store, snapshotId, input.filters);
        if ("guarded" in prepared) return prepared;
        const queryFingerprint = buildSpatialQueryFingerprint({
            mode: input.mode,
            filters: input.filters ?? {},
            includeEdges: input.includeEdges === true,
            relationTypes: input.relationTypes ?? [],
            limit,
            edgeLimit,
        });
        let nodePageStartAfterNodeId: string | null = null;
        let expectedNodePageEndId: string | null = null;
        let afterEdgeId: string | null = null;
        try {
            if (input.cursor) {
                const cursor = decodeSpatialQueryCursor(input.cursor, {
                    snapshotId,
                    revisionFingerprint: snapshot.revisionFingerprint,
                    queryFingerprint,
                });
                nodePageStartAfterNodeId = cursor.lastNodeId;
                expectedNodePageEndId = cursor.nodePageEndId;
                afterEdgeId = cursor.lastEdgeId;
            }
        } catch (error) {
            if (error instanceof SpatialQueryCursorError) {
                return guarded(error.reason, error.message);
            }
            throw error;
        }
        const page = queryRetrieveNodePage(store, snapshotId, prepared, limit, nodePageStartAfterNodeId);
        if (page.unsupportedNodeId) {
            return guarded(
                "unsupported_geometry",
                "within-space retrieval encountered an AABB candidate without point, centerline, or boundary evidence; the node was not silently classified outside.",
                [`unsupported_node_id:${page.unsupportedNodeId}`],
            );
        }
        const edgeContinuation = expectedNodePageEndId !== null;
        if (edgeContinuation && page.pageEndNodeId !== expectedNodePageEndId) {
            return guarded(
                "invalid_cursor",
                "The immutable snapshot did not reproduce the node page bound to this edge continuation cursor.",
            );
        }
        const edgePage = input.includeEdges && page.nodes.length > 0
            ? store.queryStoredEdges({
                snapshotId,
                sourceNodeIds: page.nodes.map((node) => node.nodeId),
                relationTypes: input.relationTypes,
                afterEdgeId,
                limit: edgeLimit,
            })
            : { edges: [], hasMore: false, nextEdgeId: null };
        let nextCursor: string | null = null;
        if (edgePage.hasMore) {
            if (!edgePage.nextEdgeId || !page.pageEndNodeId) {
                return guarded("store_integrity_error", "Bounded edge pagination did not produce a valid continuation position.");
            }
            nextCursor = encodeSpatialQueryCursor({
                snapshotId,
                revisionFingerprint: snapshot.revisionFingerprint,
                queryFingerprint,
                lastNodeId: nodePageStartAfterNodeId,
                nodePageEndId: page.pageEndNodeId,
                lastEdgeId: edgePage.nextEdgeId,
            });
        } else if (page.hasMore && page.pageEndNodeId) {
            nextCursor = encodeSpatialQueryCursor({
                snapshotId,
                revisionFingerprint: snapshot.revisionFingerprint,
                queryFingerprint,
                lastNodeId: page.pageEndNodeId,
                nodePageEndId: null,
                lastEdgeId: null,
            });
        }
        const returnedNodes = edgeContinuation ? [] : page.nodes;
        const truncated = nextCursor !== null;
        return {
            ...operationResultBase(snapshot, input, capability, startedAt),
            nodes: returnedNodes,
            edges: edgePage.edges,
            partial: truncated,
            truncated,
            nextCursor,
            scanStoppedReason: truncated ? "max_items" : "completed",
            scanPolicy: {
                maxNodes: limit,
                maxEdges: edgeLimit,
                maxWithinSpaceCandidates: input.filters?.withinSpaceNodeIds?.length
                    ? Math.min(MAX_INTERNAL_CANDIDATES, Math.max(1_000, limit * 20))
                    : null,
                edgeOwnership: "source_node_page",
            },
            suggestedNextScopes: nextCursor ? ["cursor"] : [],
            counts: {
                nodeCount: returnedNodes.length,
                edgeCount: edgePage.edges.length,
                computedCount: 0,
                scannedNodeCount: page.scannedNodeCount,
            },
            notices: input.includeEdges ? ["Edges are emitted once on the page containing their stored source node."] : [],
            elapsedMs: Date.now() - startedAt,
        };
    }

    const requirements = operationRequirements(input.operation, capability, true);
    if (requirements) return requirements;
    const base = operationResultBase(snapshot, input, capability, startedAt);
    const operation = input.operation;
    if (["relation_between", "clearance_between", "above_below"].includes(operation.name)) {
        const pair = runPairOperation(store, snapshotId, operation as Extract<SpatialOperationInput, {
            name: "relation_between" | "clearance_between" | "above_below";
        }>);
        if (!pair) return guarded("node_not_found_or_geometry_unsupported", "Both explicit nodes and supported stored geometry are required.");
        const pairComputed = operation.name === "clearance_between"
            && pair.computed.precisionClass === "candidate"
            ? {
                ...pair.computed,
                relation: "clearance_screening",
                verdictCapability: "screening_only" as const,
            }
            : pair.computed;
        return {
            ...base,
            operation: operation.name,
            inputs: { ...operation },
            nodes: pair.nodes,
            edges: [],
            computed: pairComputed,
            basis: pairComputed.basis,
            precisionClass: pairComputed.precisionClass,
            verdictCapability: pairComputed.verdictCapability,
            partial: false,
            truncated: false,
            nextCursor: null,
            scanPolicy: { exactNodeCount: 2 },
            counts: { nodeCount: 2, edgeCount: 0, computedCount: 1 },
            elapsedMs: Date.now() - startedAt,
        };
    }
    if (operation.name === "nearest_elements" || operation.name === "elements_within") {
        if (capability.adapter === "legacy_v02" && requiresIndexedV03Filters(operation.filters)) {
            return guarded("unsupported_snapshot_capability", "Legacy v0.2 nearest/within metadata filters are not indexed.", capability.limitations);
        }
        const result = runNeighborOperation(store, snapshotId, operation);
        if (!result) return guarded("node_not_found_or_geometry_unsupported", "The anchor node, a bounded distance, and stored AABB geometry are required.");
        if (result.guarded) return result.guarded;
        return {
            ...base,
            operation: operation.name,
            inputs: { ...operation },
            nodes: result.nodes,
            edges: [],
            computed: result.computed,
            basis: "rtree_candidates_then_stored_geometry",
            precisionClass: result.computed.length > 0
                && result.computed.every((relation) => relation.precisionClass === "measured")
                ? "measured"
                : "candidate",
            verdictCapability: result.computed.length > 0
                && result.computed.every((relation) => relation.verdictCapability === "context_only")
                ? "context_only"
                : "screening_only",
            partial: result.truncated,
            truncated: result.truncated,
            nextCursor: null,
            scanStoppedReason: result.truncated ? "max_items" : "completed",
            scanPolicy: {
                maxCandidates: MAX_INTERNAL_CANDIDATES,
                maxResults: clampInteger(operation.limit, 20, 1, 500),
                distanceMm: operation.name === "nearest_elements" ? operation.maxDistanceMm : operation.distanceMm,
            },
            suggestedNextScopes: result.truncated ? ["filters", "maxDistanceMm"] : [],
            counts: {
                nodeCount: result.nodes.length,
                edgeCount: 0,
                computedCount: result.computed.length,
                candidateCount: result.candidateCount,
            },
            notices: [`candidate_count:${result.candidateCount}`],
            elapsedMs: Date.now() - startedAt,
        };
    }
    if (operation.name === "trace_connectivity") {
        if (!store.getStoredNode(snapshotId, operation.startNodeId)) {
            return guarded("node_not_found", "trace_connectivity requires an existing explicit startNodeId.");
        }
        if (operation.targetNodeId && !store.getStoredNode(snapshotId, operation.targetNodeId)) {
            return guarded("node_not_found", "trace_connectivity requires targetNodeId to identify an existing node when supplied.");
        }
        const topology = store.getSnapshotTopologyCapability(snapshotId);
        if (!topology || !topology.readComplete || !topology.targetMembershipValidated
            || topology.ambiguousConnectorCount > 0 || topology.unresolvedPeerReferenceCount > 0) {
            return guarded(
                "incomplete_topology_coverage",
                "trace_connectivity requires complete connector reads and committed-snapshot validation for every peer reference.",
                [
                    `topology_read_complete:${topology?.readComplete === true}`,
                    `topology_target_membership_validated:${topology?.targetMembershipValidated === true}`,
                    `topology_ambiguous_connector_count:${topology?.ambiguousConnectorCount ?? -1}`,
                    `topology_unresolved_peer_reference_count:${topology?.unresolvedPeerReferenceCount ?? -1}`,
                ],
            );
        }
        const result = traceSpatialConnectivity(store, snapshotId, operation);
        if (result.unsupportedOwnerNodeIds.length > 0 && result.reachedTarget !== true) {
            return guarded(
                "internal_topology_unsupported",
                "The trace reached a multi-port owner whose internal connector routing cannot be proven from same-system/domain evidence or an explicit pass-through category.",
                result.unsupportedOwnerNodeIds.map((ownerNodeId) => `unsupported_owner_node_id:${ownerNodeId}`),
            );
        }
        return {
            ...base,
            operation: operation.name,
            inputs: { ...operation },
            nodes: result.nodes,
            edges: result.edges,
            computed: result,
            basis: result.basis,
            precisionClass: result.precisionClass,
            partial: result.truncated,
            truncated: result.truncated,
            nextCursor: null,
            scanStoppedReason: result.truncated ? "max_items" : "completed",
            scanPolicy: {
                maxDepth: clampInteger(operation.maxDepth, 20, 0, 100),
                maxNodes: clampInteger(operation.maxNodes, 500, 1, 5_000),
            },
            suggestedNextScopes: result.truncated ? ["targetNodeId", "maxDepth", "maxNodes"] : [],
            counts: {
                nodeCount: result.nodes.length,
                edgeCount: result.edges.length,
                computedCount: result.pathNodeIds.length,
            },
            elapsedMs: Date.now() - startedAt,
        };
    }
    if (operation.name === "locate_in_space") {
        const result = runLocateOperation(store, snapshotId, operation, capability);
        if (!result) return guarded("node_not_found_or_geometry_unsupported", "locate_in_space requires an existing node with stored geometry.");
        if ("guarded" in result && result.guarded) return result.guarded;
        return {
            ...base,
            operation: operation.name,
            inputs: { ...operation },
            nodes: result.nodes,
            edges: [],
            computed: result.computed,
            basis: result.basis,
            precisionClass: result.precisionClass,
            partial: result.truncated,
            truncated: result.truncated,
            nextCursor: null,
            scanStoppedReason: result.truncated ? "max_items" : "completed",
            scanPolicy: { maxSpaces: clampInteger(operation.maxSpaces, 100, 1, 1_000) },
            suggestedNextScopes: result.truncated ? ["spaceNodeIds"] : [],
            counts: {
                nodeCount: result.nodes.length,
                edgeCount: 0,
                computedCount: result.computed.length,
            },
            notices: result.unsupportedCount > 0
                ? [`unsupported_containment_count:${result.unsupportedCount}`]
                : [],
            elapsedMs: Date.now() - startedAt,
        };
    }
    return guarded("unsupported_operation", "The requested deterministic spatial operation is not supported.");
}

export function querySpatialContext(store: SpatialStore, input: SpatialQueryInput): SpatialQueryResult {
    const result = querySpatialContextCore(store, input);
    if (!result.guarded && Buffer.byteLength(canonicalJson(result), "utf8") > MAX_QUERY_RESPONSE_BYTES) {
        return guarded(
            "max_bytes",
            "The bounded spatial query result exceeded the runtime response budget; narrow filters or lower item/depth limits.",
            [],
            { maxResponseBytes: MAX_QUERY_RESPONSE_BYTES },
        );
    }
    return result;
}
