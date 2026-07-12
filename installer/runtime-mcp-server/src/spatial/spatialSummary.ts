import type { SpatialAabb, SpatialStore, SpatialStoredNode } from "./spatialStore.js";
import type {
    SpatialGuardedResult,
    SpatialLevelSummary,
    SpatialSummaryInput,
    SpatialSummaryResult,
} from "./spatialTypes.js";
import { spatialCapabilityCoverage } from "./spatialQuery.js";
import { canonicalJson, clampInteger, cleanText, compareText, createEvidenceId } from "./spatialCanonical.js";
import { mergeAabbs } from "./spatialGeometry.js";

const SUMMARY_ACTION = "summarize_spatial_state";
const MAX_SUMMARY_RESPONSE_BYTES = 4 * 1024 * 1024;

function guarded(reason: string, message: string, warnings: readonly string[] = []): SpatialGuardedResult {
    return {
        success: true,
        guarded: true,
        state: "guarded",
        action: SUMMARY_ACTION,
        reason,
        message,
        partial: false,
        truncated: false,
        scanStoppedReason: reason === "needs_scope" ? "needs_scope" : reason === "max_bytes" ? "max_bytes" : "read_failed",
        scanPolicy: {},
        suggestedNextScopes: reason === "needs_scope" ? ["snapshotId", "nodeIds"] : [],
        nextCursor: null,
        warnings: [...new Set(warnings)],
        notices: [],
        elapsedMs: 0,
        summaryId: createEvidenceId("spatial-summary"),
        counts: { nodeCount: 0, levelCount: 0 },
    };
}

function increment(target: Map<string, number>, key: string | null): void {
    const normalized = key ?? "<unknown>";
    target.set(normalized, (target.get(normalized) ?? 0) + 1);
}

function orderedCounts(values: Map<string, number>): Record<string, number> {
    return Object.fromEntries([...values.entries()].sort(([left], [right]) => compareText(left, right)));
}

interface MutableLevelSummary {
    levelKey: string;
    groupingKey: string;
    documentKey: string;
    linkInstanceUniqueId: string | null;
    levelName: string | null;
    levelUniqueId: string | null;
    nodes: SpatialStoredNode[];
    nodesByKind: Map<string, number>;
    nodesByCategory: Map<string, number>;
    nodesByRole: Map<string, number>;
    nodesBySystem: Map<string, number>;
    bounds: SpatialAabb | null;
}

function legacyIndexedFilterRequested(input: SpatialSummaryInput): boolean {
    const filters = input.filters;
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

function summarizeSpatialStateCore(store: SpatialStore, input: SpatialSummaryInput): SpatialSummaryResult {
    const startedAt = Date.now();
    const snapshotId = cleanText(input.snapshotId);
    if (!snapshotId) return guarded("needs_scope", "summarize_spatial_state requires an explicit snapshotId.");
    const snapshot = store.getSnapshotRecord(snapshotId);
    if (!snapshot) return guarded("snapshot_not_found", `Spatial snapshot ${snapshotId} was not found in the local store.`);
    const capability = spatialCapabilityCoverage(snapshot.schemaVersion);
    if (!capability) {
        return guarded("unsupported_snapshot_schema", `Spatial snapshot schema ${snapshot.schemaVersion} is not supported.`);
    }
    const warnings = [...new Set([
        ...(input.trust?.warnings ?? []),
        ...capability.limitations,
        "spatial_state_summary_is_advisory_only",
    ])];
    if (!snapshot.complete || snapshot.partial || snapshot.coverageStatus !== "complete") {
        return guarded(
            "incomplete_snapshot",
            "Spatial state summaries require a complete, non-partial snapshot with coverageStatus=complete.",
            [
                `snapshot_complete:${snapshot.complete}`,
                `snapshot_partial:${snapshot.partial}`,
                `snapshot_coverage_status:${snapshot.coverageStatus}`,
                ...warnings,
            ],
        );
    }
    if (input.requireCurrent && input.trust?.liveness !== "current") {
        return guarded(
            "snapshot_not_current",
            "The requested current-state summary requires a live liveness probe returning current.",
            warnings,
        );
    }
    if (capability.adapter === "legacy_v02" && legacyIndexedFilterRequested(input)
        && (!input.filters?.nodeIds || input.filters.nodeIds.length === 0)) {
        return guarded(
            "unsupported_snapshot_capability",
            "Legacy v0.2 summary metadata filters require explicit nodeIds.",
            warnings,
        );
    }

    const maximumNodes = clampInteger(input.maxNodes, 10_000, 1, 50_000);
    const maximumLevels = clampInteger(input.maxLevels, 50, 1, 100);
    const nodes: SpatialStoredNode[] = [];
    let afterNodeId: string | null = null;
    let truncated = false;
    while (nodes.length < maximumNodes) {
        const page = store.queryStoredNodes({
            snapshotId,
            nodeIds: input.filters?.nodeIds,
            nodeKinds: input.filters?.nodeKinds,
            categories: input.filters?.categories,
            builtInCategories: input.filters?.builtInCategories,
            categoryRoles: input.filters?.categoryRoles,
            levelNames: input.filters?.levelNames,
            levelUniqueIds: input.filters?.levelUniqueIds,
            systemKeys: input.filters?.systemKeys,
            ownerNodeIds: input.filters?.ownerNodeIds,
            aabb: input.filters?.aabb,
            afterNodeId,
            limit: Math.min(1_000, maximumNodes - nodes.length),
        });
        nodes.push(...page.nodes);
        if (!page.hasMore) break;
        if (!page.nextNodeId || page.nextNodeId === afterNodeId || nodes.length >= maximumNodes) {
            truncated = true;
            break;
        }
        afterNodeId = page.nextNodeId;
    }

    const levels = new Map<string, MutableLevelSummary>();
    for (const node of nodes) {
        const levelIdentity = node.levelUniqueId ?? (node.levelName ? `name:${node.levelName}` : "<unscoped>");
        const groupingKey = [node.documentKey, node.linkInstanceUniqueId ?? "<host>", levelIdentity].join("\u001f");
        let level = levels.get(groupingKey);
        if (!level) {
            level = {
                levelKey: levelIdentity,
                groupingKey,
                documentKey: node.documentKey,
                linkInstanceUniqueId: node.linkInstanceUniqueId,
                levelName: node.levelName,
                levelUniqueId: node.levelUniqueId,
                nodes: [],
                nodesByKind: new Map(),
                nodesByCategory: new Map(),
                nodesByRole: new Map(),
                nodesBySystem: new Map(),
                bounds: null,
            };
            levels.set(groupingKey, level);
        }
        level.nodes.push(node);
        increment(level.nodesByKind, node.nodeKind);
        increment(level.nodesByCategory, node.category ?? node.builtInCategory);
        increment(level.nodesByRole, node.categoryRole);
        if (input.includeSystems !== false) increment(level.nodesBySystem, node.systemKey);
        level.bounds = mergeAabbs(level.bounds, node.aabb);
    }

    const orderedLevels = [...levels.values()].sort((left, right) => compareText(left.groupingKey, right.groupingKey));
    if (orderedLevels.length > maximumLevels) truncated = true;
    const resultLevels: SpatialLevelSummary[] = orderedLevels.slice(0, maximumLevels).map((level) => ({
        levelKey: level.levelKey,
        groupingKey: level.groupingKey,
        groupingBasis: "document_link_placement_level",
        documentKey: level.documentKey,
        linkInstanceUniqueId: level.linkInstanceUniqueId,
        levelName: level.levelName,
        levelUniqueId: level.levelUniqueId,
        nodeCount: level.nodes.length,
        nodesByKind: orderedCounts(level.nodesByKind),
        nodesByCategory: orderedCounts(level.nodesByCategory),
        nodesByRole: orderedCounts(level.nodesByRole),
        ...(input.includeSystems === false ? {} : { nodesBySystem: orderedCounts(level.nodesBySystem) }),
        bounds: level.bounds,
        evidenceNodeIds: level.nodes.map((node) => node.nodeId).sort(compareText).slice(0, 20),
    }));
    return {
        success: true,
        guarded: false,
        state: "completed",
        action: SUMMARY_ACTION,
        summaryId: createEvidenceId("spatial-summary"),
        snapshotId,
        revisionFingerprint: snapshot.revisionFingerprint,
        scopeFingerprint: snapshot.scopeFingerprint,
        liveness: input.trust?.liveness ?? "unknown",
        advisory: true,
        quotableAsVerification: false,
        verdictCapability: "context_only",
        levels: resultLevels,
        capabilityCoverage: capability,
        partial: truncated,
        truncated,
        scanStoppedReason: truncated ? "max_items" : "completed",
        scanPolicy: { maxNodes: maximumNodes, maxLevels: maximumLevels },
        suggestedNextScopes: truncated ? ["filters", "maxNodes", "maxLevels"] : [],
        nextCursor: null,
        counts: {
            nodeCount: nodes.length,
            levelCount: resultLevels.length,
            omittedLevelCount: Math.max(0, orderedLevels.length - resultLevels.length),
        },
        warnings,
        notices: ["Use deterministic query operations for spatial claims; this summary is never verification evidence."],
        elapsedMs: Date.now() - startedAt,
    };
}

export function summarizeSpatialState(store: SpatialStore, input: SpatialSummaryInput): SpatialSummaryResult {
    const result = summarizeSpatialStateCore(store, input);
    if (!result.guarded && Buffer.byteLength(canonicalJson(result), "utf8") > MAX_SUMMARY_RESPONSE_BYTES) {
        return guarded(
            "max_bytes",
            "The advisory summary exceeded the runtime response budget; narrow filters or lower maxLevels.",
            [`max_response_bytes:${MAX_SUMMARY_RESPONSE_BYTES}`],
        );
    }
    return result;
}
