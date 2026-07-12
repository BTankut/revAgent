import type {
    SpatialAabb,
    SpatialStoredEdge,
    SpatialStoredNode,
    SpatialStoredOmission,
} from "./spatialStore.js";

export type SpatialLivenessValue = "current" | "stale" | "unknown";
export type SpatialVerdictCapability = "context_only" | "screening_only";
export type SpatialPrecisionClass = "candidate" | "measured";

export interface SpatialTrustEvidence {
    liveness: SpatialLivenessValue;
    evaluatedAt?: string | null;
    warnings?: readonly string[];
}

export interface SpatialNodeFilters {
    nodeIds?: readonly string[];
    nodeKinds?: readonly string[];
    categories?: readonly string[];
    builtInCategories?: readonly string[];
    categoryRoles?: readonly string[];
    levelNames?: readonly string[];
    levelUniqueIds?: readonly string[];
    systemKeys?: readonly string[];
    ownerNodeIds?: readonly string[];
    aabb?: SpatialAabb;
    elevationBandMm?: {
        minZ: number;
        maxZ: number;
    };
    withinSpaceNodeIds?: readonly string[];
}

export interface SpatialRetrieveInput {
    snapshotId: string;
    mode: "retrieve";
    requireCurrent?: boolean;
    trust?: SpatialTrustEvidence;
    filters?: SpatialNodeFilters;
    includeEdges?: boolean;
    relationTypes?: readonly string[];
    limit?: number;
    edgeLimit?: number;
    cursor?: string;
}

export type SpatialOperationInput =
    | { name: "relation_between"; sourceNodeId: string; targetNodeId: string }
    | {
        name: "nearest_elements";
        anchorNodeId: string;
        maxDistanceMm: number;
        limit?: number;
        filters?: SpatialNodeFilters;
    }
    | {
        name: "elements_within";
        anchorNodeId: string;
        distanceMm: number;
        limit?: number;
        filters?: SpatialNodeFilters;
    }
    | { name: "clearance_between"; sourceNodeId: string; targetNodeId: string }
    | {
        name: "trace_connectivity";
        startNodeId: string;
        targetNodeId?: string;
        maxDepth?: number;
        maxNodes?: number;
    }
    | {
        name: "locate_in_space";
        nodeId: string;
        spaceNodeIds?: readonly string[];
        maxSpaces?: number;
    }
    | {
        name: "above_below";
        sourceNodeId: string;
        targetNodeId: string;
        toleranceMm?: number;
    };

export interface SpatialOperationQueryInput {
    snapshotId: string;
    mode: "operation";
    requireCurrent?: boolean;
    trust?: SpatialTrustEvidence;
    operation: SpatialOperationInput;
}

export type SpatialQueryInput = SpatialRetrieveInput | SpatialOperationQueryInput;

export interface SpatialCapabilityCoverage {
    schemaVersion: string;
    adapter: "native_v03" | "legacy_v02";
    geometry: boolean;
    properties: boolean;
    topology: boolean;
    analyticClearance: boolean;
    containment: boolean;
    limitations: string[];
}

export interface SpatialGuardedResult {
    success: true;
    guarded: true;
    state: "guarded";
    action: string;
    reason: string;
    message: string;
    partial: boolean;
    coverageStatus?: string | null;
    truncated: false;
    scanStoppedReason: string;
    scanPolicy: Record<string, unknown>;
    suggestedNextScopes: string[];
    nextCursor: null;
    warnings: string[];
    notices: string[];
    elapsedMs: number;
    queryId?: string;
    reportId?: string;
    summaryId?: string;
    counts?: Record<string, number>;
}

export interface SpatialComputedRelation {
    sourceNodeId: string;
    targetNodeId: string;
    relation: string;
    separationMm: number;
    intersects: boolean;
    penetrationDepthMm?: number | null;
    direction?: readonly [number, number, number] | null;
    verticalRelation?: "above" | "below" | "overlapping" | "coincident";
    basis: string;
    precisionClass: SpatialPrecisionClass;
    verdictCapability: SpatialVerdictCapability;
    changeType?: "added" | "removed" | "changed";
    before?: {
        separationMm: number;
        intersects: boolean;
        basis: string;
        precisionClass: SpatialPrecisionClass;
    } | null;
}

export interface SpatialQueryCompletedResult {
    success: true;
    guarded: false;
    state: "completed";
    action: "query_spatial_context";
    queryId: string;
    snapshotId: string;
    revisionFingerprint: string;
    scopeFingerprint: string;
    liveness: SpatialLivenessValue;
    mode: "retrieve" | "operation";
    operation?: SpatialOperationInput["name"];
    inputs?: Record<string, unknown>;
    nodes: SpatialStoredNode[];
    edges: SpatialStoredEdge[];
    computed?: unknown;
    capabilityCoverage: SpatialCapabilityCoverage;
    basis?: string;
    precisionClass?: SpatialPrecisionClass;
    verdictCapability: SpatialVerdictCapability;
    partial: boolean;
    truncated: boolean;
    nextCursor: string | null;
    scanStoppedReason: string;
    scanPolicy: Record<string, unknown>;
    suggestedNextScopes: string[];
    counts: Record<string, number>;
    warnings: string[];
    notices: string[];
    elapsedMs: number;
}

export type SpatialQueryResult = SpatialQueryCompletedResult | SpatialGuardedResult;

export interface SpatialDiffInput {
    baseSnapshotId: string;
    headSnapshotId: string;
    allowLegacyV02?: boolean;
    maxChanges?: number;
    proximityRadiusMm?: number;
    maxProximityPairs?: number;
}

export interface SpatialNodeChange {
    nodeId: string;
    nodeKind: string;
    documentKey: string;
    beforeFingerprint?: string | null;
    afterFingerprint?: string | null;
    changedFields?: string[];
    before?: Record<string, unknown>;
    after?: Record<string, unknown>;
}

export interface SpatialSourceChange {
    sourceKey: string;
    changeType: string;
    before?: unknown;
    after?: unknown;
}

export interface SpatialSnapshotDiffCompletedResult {
    success: true;
    guarded: false;
    state: "completed";
    action: "compare_spatial_snapshots";
    reportId: string;
    baseSnapshotId: string;
    headSnapshotId: string;
    scopeFingerprint: string;
    baseRevisionFingerprint: string;
    headRevisionFingerprint: string;
    added: SpatialStoredNode[];
    removed: SpatialStoredNode[];
    sourceAvailabilityChanges: SpatialSourceChange[];
    transformChanges: SpatialSourceChange[];
    moved: SpatialNodeChange[];
    geometryChanges: SpatialNodeChange[];
    geometryIndeterminate: SpatialNodeChange[];
    propertyChanges: SpatialNodeChange[];
    connectorChanges: SpatialNodeChange[];
    connectivityChanges: SpatialNodeChange[];
    proximityChanges: SpatialComputedRelation[];
    capabilityCoverage: {
        full: boolean;
        base: SpatialCapabilityCoverage;
        head: SpatialCapabilityCoverage;
        geometryChanges: {
            classification: "complete" | "capability_limited";
            baseAabbOnlyNodeCount: number;
            headAabbOnlyNodeCount: number;
            indeterminateChangeCount: number;
        };
    };
    partial: boolean;
    truncated: boolean;
    scanStoppedReason: string;
    scanPolicy: Record<string, unknown>;
    suggestedNextScopes: string[];
    nextCursor: null;
    counts: Record<string, number>;
    warnings: string[];
    notices: string[];
    elapsedMs: number;
}

export type SpatialSnapshotDiffResult = SpatialSnapshotDiffCompletedResult | SpatialGuardedResult;

export interface SpatialSummaryInput {
    snapshotId: string;
    requireCurrent?: boolean;
    trust?: SpatialTrustEvidence;
    filters?: SpatialNodeFilters;
    maxNodes?: number;
    maxLevels?: number;
    includeSystems?: boolean;
}

export interface SpatialLevelSummary {
    levelKey: string;
    groupingKey: string;
    groupingBasis: "document_link_placement_level";
    documentKey: string;
    linkInstanceUniqueId: string | null;
    levelName: string | null;
    levelUniqueId: string | null;
    nodeCount: number;
    nodesByKind: Record<string, number>;
    nodesByCategory: Record<string, number>;
    nodesByRole: Record<string, number>;
    nodesBySystem?: Record<string, number>;
    bounds: SpatialAabb | null;
    evidenceNodeIds: string[];
}

export interface SpatialSummaryCompletedResult {
    success: true;
    guarded: false;
    state: "completed";
    action: "summarize_spatial_state";
    summaryId: string;
    snapshotId: string;
    revisionFingerprint: string;
    scopeFingerprint: string;
    liveness: SpatialLivenessValue;
    advisory: true;
    quotableAsVerification: false;
    verdictCapability: "context_only";
    levels: SpatialLevelSummary[];
    capabilityCoverage: SpatialCapabilityCoverage;
    partial: boolean;
    truncated: boolean;
    scanStoppedReason: string;
    scanPolicy: Record<string, unknown>;
    suggestedNextScopes: string[];
    nextCursor: null;
    counts: Record<string, number>;
    warnings: string[];
    notices: string[];
    elapsedMs: number;
}

export type SpatialSummaryResult = SpatialSummaryCompletedResult | SpatialGuardedResult;

export interface SpatialStoreEvidenceBundle {
    nodes: SpatialStoredNode[];
    edges: SpatialStoredEdge[];
    omissions: SpatialStoredOmission[];
}
