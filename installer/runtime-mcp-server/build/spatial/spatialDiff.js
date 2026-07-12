import { derivedPlacementFingerprint, derivedPropertyFingerprint, derivedShapeFingerprint, derivedTopologyFingerprint, inflateAabb, relationBetweenNodes, spatialGeometry, } from "./spatialGeometry.js";
import { spatialCapabilityCoverage } from "./spatialQuery.js";
import { spatialSourceKey } from "./spatialLiveness.js";
import { canonicalJson, clampInteger, cleanText, compareText, createEvidenceId, finiteNumber, firstDefined, isJsonObject, } from "./spatialCanonical.js";
const DIFF_ACTION = "compare_spatial_snapshots";
const MAX_DIFF_RESPONSE_BYTES = 8 * 1024 * 1024;
function guarded(reason, message, warnings = []) {
    return {
        success: true,
        guarded: true,
        state: "guarded",
        action: DIFF_ACTION,
        reason,
        message,
        partial: false,
        truncated: false,
        scanStoppedReason: reason === "needs_scope" ? "needs_scope" : reason === "max_bytes" ? "max_bytes" : "read_failed",
        scanPolicy: {},
        suggestedNextScopes: reason === "needs_scope" ? ["baseSnapshotId", "headSnapshotId"] : [],
        nextCursor: null,
        warnings: [...new Set(warnings)],
        notices: [],
        elapsedMs: 0,
        reportId: createEvidenceId("spatial-diff"),
        counts: { totalChangeCount: 0 },
    };
}
function completeSnapshot(record) {
    return record.complete && !record.partial && record.coverageStatus === "complete";
}
function capturePolicyValue(snapshot, key) {
    return cleanText(firstDefined(snapshot.captureMetadata, [[key]]))
        ?? cleanText(firstDefined(snapshot.scope, [[key]]));
}
function hasIncomparableSourceSessions(baseSources, headSources) {
    const base = sourceMap(baseSources);
    const head = sourceMap(headSources);
    const isSessionOnly = (source) => {
        const resolution = isJsonObject(source.documentKeyResolution) ? source.documentKeyResolution : null;
        return resolution?.crossSessionComparable === false;
    };
    for (const [sourceKey, before] of [...base.entries()].sort(([left], [right]) => compareText(left, right))) {
        const after = head.get(sourceKey);
        if (isSessionOnly(before) && (!after || before.documentSessionId !== after.documentSessionId))
            return true;
        if (after && isSessionOnly(after) && before.documentSessionId !== after.documentSessionId)
            return true;
    }
    for (const [sourceKey, after] of [...head.entries()].sort(([left], [right]) => compareText(left, right))) {
        if (isSessionOnly(after) && !base.has(sourceKey))
            return true;
    }
    return false;
}
function fingerprintVersions(nodes) {
    return [...new Set(nodes.map((node) => cleanText(firstDefined(node.payload, [["fingerprints", "version"]])))
            .filter((value) => value !== null))].sort(compareText);
}
function collectAllNodes(store, snapshotId, maximum) {
    const nodes = [];
    let afterNodeId = null;
    while (nodes.length < maximum) {
        const page = store.queryStoredNodes({
            snapshotId,
            afterNodeId,
            limit: Math.min(1_000, maximum - nodes.length),
        });
        nodes.push(...page.nodes);
        if (!page.hasMore)
            return { nodes, truncated: false };
        if (!page.nextNodeId || page.nextNodeId === afterNodeId)
            return { nodes, truncated: true };
        afterNodeId = page.nextNodeId;
    }
    return { nodes, truncated: true };
}
function sourceMap(sources) {
    return new Map(sources.map((source) => [spatialSourceKey(source), source]));
}
function compareSources(baseSources, headSources) {
    const base = sourceMap(baseSources);
    const head = sourceMap(headSources);
    const availability = [];
    const transforms = [];
    for (const sourceKey of [...new Set([...base.keys(), ...head.keys()])].sort(compareText)) {
        const before = base.get(sourceKey);
        const after = head.get(sourceKey);
        if (!before) {
            availability.push({ sourceKey, changeType: "source_added_or_loaded", after });
            continue;
        }
        if (!after) {
            availability.push({ sourceKey, changeType: "source_removed_or_unloaded", before });
            continue;
        }
        if (before.loadedVersion !== after.loadedVersion) {
            availability.push({
                sourceKey,
                changeType: "source_reloaded_or_content_version_changed",
                before: { loadedVersion: before.loadedVersion },
                after: { loadedVersion: after.loadedVersion },
            });
        }
        if (canonicalJson(before.sourceToHostTransform) !== canonicalJson(after.sourceToHostTransform)) {
            transforms.push({
                sourceKey,
                changeType: "source_to_host_transform_changed",
                before: before.sourceToHostTransform,
                after: after.sourceToHostTransform,
            });
        }
    }
    return { availability, transforms };
}
function propertyFields(node) {
    return {
        category: node.category,
        builtInCategory: node.builtInCategory,
        categoryRole: node.categoryRole,
        levelUniqueId: node.levelUniqueId,
        levelName: node.levelName,
        systemKey: node.systemKey,
        name: firstDefined(node.payload, [["name"]]),
        familyName: firstDefined(node.payload, [["familyName"]]),
        typeName: firstDefined(node.payload, [["typeName"]]),
        spatialProperties: firstDefined(node.payload, [["spatialProperties"]]),
    };
}
function changedFieldNames(before, after) {
    return [...new Set([...Object.keys(before), ...Object.keys(after)])]
        .filter((key) => canonicalJson(before[key]) !== canonicalJson(after[key]))
        .sort(compareText);
}
function nodeChange(before, after, beforeFingerprint, afterFingerprint, changedFields) {
    return {
        nodeId: before.nodeId,
        nodeKind: before.nodeKind,
        documentKey: before.documentKey,
        beforeFingerprint,
        afterFingerprint,
        ...(changedFields ? { changedFields } : {}),
    };
}
function hasAabbOnlyShapeEvidence(node) {
    const geometry = spatialGeometry(node);
    return node.nodeKind === "revit_element"
        && geometry.aabb !== null
        && geometry.centerline.length < 2
        && geometry.boundaryLoops.length === 0;
}
function relationPairKey(firstNodeId, secondNodeId) {
    return firstNodeId < secondNodeId
        ? `${firstNodeId}\u001f${secondNodeId}`
        : `${secondNodeId}\u001f${firstNodeId}`;
}
function collectAffectedProximity(store, snapshotId, affectedNodeIds, radiusMm, maximumPairs, maximumCandidates) {
    const relations = new Map();
    let truncated = false;
    let candidateCount = 0;
    for (const nodeId of [...new Set(affectedNodeIds)].sort(compareText)) {
        const node = store.getStoredNode(snapshotId, nodeId);
        if (!node?.aabb)
            continue;
        let afterNodeId = null;
        while (candidateCount < maximumCandidates) {
            const page = store.queryStoredNodes({
                snapshotId,
                aabb: inflateAabb(node.aabb, radiusMm),
                afterNodeId,
                limit: Math.min(1_000, maximumCandidates - candidateCount),
            });
            candidateCount += page.nodes.length;
            for (const candidate of page.nodes) {
                if (candidate.nodeId === node.nodeId)
                    continue;
                const key = relationPairKey(node.nodeId, candidate.nodeId);
                if (relations.has(key))
                    continue;
                if (relations.size >= maximumPairs) {
                    truncated = true;
                    return { relations, truncated, candidateCount };
                }
                const relation = relationBetweenNodes(node, candidate);
                if (relation && relation.separationMm <= radiusMm)
                    relations.set(key, relation);
            }
            if (!page.hasMore)
                break;
            if (!page.nextNodeId || page.nextNodeId === afterNodeId) {
                truncated = true;
                return { relations, truncated, candidateCount };
            }
            afterNodeId = page.nextNodeId;
        }
        if (candidateCount >= maximumCandidates) {
            truncated = true;
            break;
        }
    }
    return { relations, truncated, candidateCount };
}
function compareProximity(base, head, maximumOutputChanges) {
    const changes = [];
    let truncated = base.truncated || head.truncated;
    let observedChangeCount = 0;
    for (const key of [...new Set([...base.relations.keys(), ...head.relations.keys()])].sort(compareText)) {
        const before = base.relations.get(key);
        const after = head.relations.get(key);
        if (before && after && canonicalJson({
            separationMm: before.separationMm,
            intersects: before.intersects,
            basis: before.basis,
            precisionClass: before.precisionClass,
        }) === canonicalJson({
            separationMm: after.separationMm,
            intersects: after.intersects,
            basis: after.basis,
            precisionClass: after.precisionClass,
        }))
            continue;
        observedChangeCount += 1;
        if (changes.length >= maximumOutputChanges) {
            truncated = true;
            continue;
        }
        const current = after ?? before;
        changes.push({
            ...current,
            relation: after ? (before ? "proximity_changed" : "proximity_added") : "proximity_removed",
            changeType: after ? (before ? "changed" : "added") : "removed",
            before: before ? {
                separationMm: before.separationMm,
                intersects: before.intersects,
                basis: before.basis,
                precisionClass: before.precisionClass,
            } : null,
        });
    }
    return { changes, truncated, observedChangeCount };
}
function compareSpatialSnapshotsCore(store, input) {
    const startedAt = Date.now();
    const baseSnapshotId = cleanText(input.baseSnapshotId);
    const headSnapshotId = cleanText(input.headSnapshotId);
    if (!baseSnapshotId || !headSnapshotId) {
        return guarded("needs_scope", "compare_spatial_snapshots requires explicit baseSnapshotId and headSnapshotId.");
    }
    const baseSnapshot = store.getSnapshotRecord(baseSnapshotId);
    const headSnapshot = store.getSnapshotRecord(headSnapshotId);
    if (!baseSnapshot || !headSnapshot) {
        return guarded("snapshot_not_found", "One or both explicit spatial snapshots were not found in the local store.");
    }
    if (!completeSnapshot(baseSnapshot) || !completeSnapshot(headSnapshot)) {
        return guarded("incomplete_snapshot", "Snapshot diff requires two complete, non-partial snapshots.");
    }
    if (baseSnapshot.scopeFingerprint !== headSnapshot.scopeFingerprint) {
        return guarded("incomparable_scopes", "Snapshot diff requires equal scopeFingerprint values.");
    }
    for (const policyKey of ["coordinateFrame", "lengthUnit", "captureConsistency"]) {
        const basePolicy = capturePolicyValue(baseSnapshot, policyKey);
        const headPolicy = capturePolicyValue(headSnapshot, policyKey);
        if (basePolicy && headPolicy && basePolicy !== headPolicy) {
            return guarded("incomparable_scopes", `Snapshot diff requires a common ${policyKey} policy.`, [`base_${policyKey}:${basePolicy}`, `head_${policyKey}:${headPolicy}`]);
        }
    }
    if (hasIncomparableSourceSessions(baseSnapshot.sourceRevisions, headSnapshot.sourceRevisions)) {
        return guarded("incomparable_scopes", "Session-only document identities cannot be diffed across different documentSessionId values.");
    }
    const baseCapability = spatialCapabilityCoverage(baseSnapshot.schemaVersion);
    const headCapability = spatialCapabilityCoverage(headSnapshot.schemaVersion);
    if (!baseCapability || !headCapability) {
        return guarded("unsupported_snapshot_schema", "One or both snapshot schema versions have no Phase 1b compatibility adapter.");
    }
    if (baseCapability.adapter !== headCapability.adapter) {
        return guarded("snapshot_capability_mismatch", "Mixed v0.2/v0.3 diffs are unsupported because native v0.3 and legacy-derived fingerprints do not share a comparable algorithm basis.", [...baseCapability.limitations, ...headCapability.limitations]);
    }
    const legacy = baseCapability.adapter === "legacy_v02" || headCapability.adapter === "legacy_v02";
    if (legacy && input.allowLegacyV02 !== true) {
        return guarded("unsupported_snapshot_capability", "A full Phase 1b diff requires v0.3 snapshots. Set allowLegacyV02 only for an explicitly capability-limited historical diff.", [...baseCapability.limitations, ...headCapability.limitations]);
    }
    if (!legacy) {
        const baseTopology = store.getSnapshotTopologyCapability(baseSnapshotId);
        const headTopology = store.getSnapshotTopologyCapability(headSnapshotId);
        const topologyComplete = (value) => Boolean(value
            && value.readComplete
            && value.targetMembershipValidated
            && value.ambiguousConnectorCount === 0
            && value.unresolvedPeerReferenceCount === 0);
        if (!topologyComplete(baseTopology) || !topologyComplete(headTopology)) {
            return guarded("incomplete_topology_coverage", "A full v0.3 diff requires complete connector reads and committed-snapshot membership validation in both snapshots.", [
                `base_topology_complete:${topologyComplete(baseTopology)}`,
                `head_topology_complete:${topologyComplete(headTopology)}`,
            ]);
        }
    }
    const maximumChanges = clampInteger(input.maxChanges, 20_000, 1, 50_000);
    const maximumNodes = Math.max(50_000, maximumChanges * 2);
    const baseNodes = collectAllNodes(store, baseSnapshotId, maximumNodes);
    const headNodes = collectAllNodes(store, headSnapshotId, maximumNodes);
    if (baseNodes.truncated || headNodes.truncated) {
        return guarded("max_items", "The bounded snapshot diff could not load every node; no incomplete diff was presented as complete.", [`max_nodes:${maximumNodes}`]);
    }
    if (!legacy) {
        const baseFingerprintVersions = fingerprintVersions(baseNodes.nodes);
        const headFingerprintVersions = fingerprintVersions(headNodes.nodes);
        const baseVersionInvalid = baseNodes.nodes.length > 0 && baseFingerprintVersions.length !== 1;
        const headVersionInvalid = headNodes.nodes.length > 0 && headFingerprintVersions.length !== 1;
        const commonVersionMismatch = baseFingerprintVersions.length === 1
            && headFingerprintVersions.length === 1
            && baseFingerprintVersions[0] !== headFingerprintVersions[0];
        if (baseVersionInvalid || headVersionInvalid || commonVersionMismatch) {
            return guarded("snapshot_capability_mismatch", "A precise v0.3 diff requires one common fingerprints.version across every node in both snapshots.", [
                `base_fingerprint_versions:${baseFingerprintVersions.join(",") || "missing"}`,
                `head_fingerprint_versions:${headFingerprintVersions.join(",") || "missing"}`,
            ]);
        }
    }
    const baseById = new Map(baseNodes.nodes.map((node) => [node.nodeId, node]));
    const headById = new Map(headNodes.nodes.map((node) => [node.nodeId, node]));
    const added = [];
    const removed = [];
    const moved = [];
    const geometryChanges = [];
    const geometryIndeterminate = [];
    const propertyChanges = [];
    const connectorChanges = [];
    const connectivityChanges = [];
    const sourceAvailabilityChanges = [];
    const transformChanges = [];
    let truncated = false;
    let returnedChangeCount = 0;
    const observedCounts = {
        added: 0,
        removed: 0,
        sourceAvailability: 0,
        transform: 0,
        moved: 0,
        geometry: 0,
        geometryIndeterminate: 0,
        property: 0,
        connector: 0,
        connectivity: 0,
        proximity: 0,
    };
    function offerChange(bucket, value, observedKey) {
        observedCounts[observedKey] = (observedCounts[observedKey] ?? 0) + 1;
        if (returnedChangeCount >= maximumChanges) {
            truncated = true;
            return;
        }
        bucket.push(value);
        returnedChangeCount += 1;
    }
    const affectedBaseIds = new Set();
    const affectedHeadIds = new Set();
    for (const nodeId of [...new Set([...baseById.keys(), ...headById.keys()])].sort(compareText)) {
        const before = baseById.get(nodeId);
        const after = headById.get(nodeId);
        if (!before) {
            affectedHeadIds.add(nodeId);
            offerChange(added, after, "added");
            continue;
        }
        if (!after) {
            affectedBaseIds.add(nodeId);
            offerChange(removed, before, "removed");
            continue;
        }
        const beforePlacement = derivedPlacementFingerprint(before);
        const afterPlacement = derivedPlacementFingerprint(after);
        const beforeShape = derivedShapeFingerprint(before);
        const afterShape = derivedShapeFingerprint(after);
        const beforeProperty = derivedPropertyFingerprint(before);
        const afterProperty = derivedPropertyFingerprint(after);
        const beforeTopology = derivedTopologyFingerprint(before);
        const afterTopology = derivedTopologyFingerprint(after);
        const movedChanged = beforePlacement !== afterPlacement;
        const shapeChanged = beforeShape !== afterShape;
        const aabbOnlyEvidence = hasAabbOnlyShapeEvidence(before) || hasAabbOnlyShapeEvidence(after);
        const geometryEvidenceChanged = canonicalJson(before.aabb) !== canonicalJson(after.aabb)
            || before.geometryFingerprint !== after.geometryFingerprint;
        const propertyChanged = !legacy && beforeProperty !== afterProperty;
        const topologyChanged = !legacy && beforeTopology !== afterTopology;
        if (movedChanged) {
            affectedBaseIds.add(nodeId);
            affectedHeadIds.add(nodeId);
            offerChange(moved, nodeChange(before, after, beforePlacement, afterPlacement), "moved");
        }
        if (shapeChanged) {
            affectedBaseIds.add(nodeId);
            affectedHeadIds.add(nodeId);
            offerChange(geometryChanges, nodeChange(before, after, beforeShape, afterShape), "geometry");
        }
        if (!legacy && !shapeChanged && aabbOnlyEvidence && geometryEvidenceChanged) {
            affectedBaseIds.add(nodeId);
            affectedHeadIds.add(nodeId);
            offerChange(geometryIndeterminate, nodeChange(before, after, before.geometryFingerprint, after.geometryFingerprint, ["aabb_or_geometry_fingerprint"]), "geometryIndeterminate");
        }
        if (propertyChanged) {
            const beforeFields = propertyFields(before);
            const afterFields = propertyFields(after);
            offerChange(propertyChanges, nodeChange(before, after, beforeProperty, afterProperty, changedFieldNames(beforeFields, afterFields)), "property");
        }
        if (!legacy && before.nodeKind === "connector" && (movedChanged || shapeChanged || propertyChanged)) {
            offerChange(connectorChanges, nodeChange(before, after, before.geometryFingerprint, after.geometryFingerprint), "connector");
        }
        if (topologyChanged) {
            offerChange(connectivityChanges, nodeChange(before, after, beforeTopology, afterTopology), "connectivity");
        }
    }
    const sourceChanges = compareSources(baseSnapshot.sourceRevisions, headSnapshot.sourceRevisions);
    for (const change of sourceChanges.availability) {
        offerChange(sourceAvailabilityChanges, change, "sourceAvailability");
    }
    for (const change of sourceChanges.transforms) {
        offerChange(transformChanges, change, "transform");
    }
    const requestedProximityRadiusMm = finiteNumber(input.proximityRadiusMm);
    const proximityRadiusMm = Math.max(0, Math.min(10_000, requestedProximityRadiusMm ?? 1_000));
    const maximumProximityPairs = clampInteger(input.maxProximityPairs, 10_000, 1, 100_000);
    const maximumProximityCandidates = Math.min(200_000, Math.max(10_000, maximumProximityPairs * 4));
    const proximity = compareProximity(collectAffectedProximity(store, baseSnapshotId, [...affectedBaseIds], proximityRadiusMm, maximumProximityPairs, maximumProximityCandidates), collectAffectedProximity(store, headSnapshotId, [...affectedHeadIds], proximityRadiusMm, maximumProximityPairs, maximumProximityCandidates), Math.max(0, maximumChanges - returnedChangeCount));
    returnedChangeCount += proximity.changes.length;
    observedCounts.proximity = proximity.observedChangeCount;
    truncated = truncated || proximity.truncated;
    const baseAabbOnlyNodeCount = baseNodes.nodes.filter(hasAabbOnlyShapeEvidence).length;
    const headAabbOnlyNodeCount = headNodes.nodes.filter(hasAabbOnlyShapeEvidence).length;
    const aabbOnlyGeometryCapabilityGap = baseAabbOnlyNodeCount > 0 || headAabbOnlyNodeCount > 0;
    const fullCapability = !legacy
        && baseCapability.properties && headCapability.properties
        && baseCapability.topology && headCapability.topology
        && !aabbOnlyGeometryCapabilityGap;
    const observedChangeCount = Object.values(observedCounts).reduce((total, count) => total + count, 0);
    return {
        success: true,
        guarded: false,
        state: "completed",
        action: DIFF_ACTION,
        reportId: createEvidenceId("spatial-diff"),
        baseSnapshotId,
        headSnapshotId,
        scopeFingerprint: baseSnapshot.scopeFingerprint,
        baseRevisionFingerprint: baseSnapshot.revisionFingerprint,
        headRevisionFingerprint: headSnapshot.revisionFingerprint,
        added,
        removed,
        sourceAvailabilityChanges,
        transformChanges,
        moved,
        geometryChanges,
        geometryIndeterminate,
        propertyChanges,
        connectorChanges,
        connectivityChanges,
        proximityChanges: proximity.changes,
        capabilityCoverage: {
            full: fullCapability,
            base: baseCapability,
            head: headCapability,
            geometryChanges: {
                classification: aabbOnlyGeometryCapabilityGap ? "capability_limited" : "complete",
                baseAabbOnlyNodeCount,
                headAabbOnlyNodeCount,
                indeterminateChangeCount: geometryIndeterminate.length,
            },
        },
        partial: truncated,
        truncated,
        scanStoppedReason: truncated ? "max_items" : "completed",
        scanPolicy: {
            maxChanges: maximumChanges,
            proximityRadiusMm,
            maxProximityPairs: maximumProximityPairs,
            maxProximityCandidates: maximumProximityCandidates,
        },
        suggestedNextScopes: truncated ? ["maxChanges", "proximityRadiusMm", "maxProximityPairs"] : [],
        nextCursor: null,
        counts: {
            baseNodeCount: baseNodes.nodes.length,
            headNodeCount: headNodes.nodes.length,
            addedCount: added.length,
            removedCount: removed.length,
            sourceAvailabilityChangeCount: sourceAvailabilityChanges.length,
            transformChangeCount: transformChanges.length,
            movedCount: moved.length,
            geometryChangeCount: geometryChanges.length,
            geometryIndeterminateCount: geometryIndeterminate.length,
            propertyChangeCount: propertyChanges.length,
            connectorChangeCount: connectorChanges.length,
            connectivityChangeCount: connectivityChanges.length,
            proximityChangeCount: proximity.changes.length,
            totalChangeCount: observedChangeCount,
            observedChangeCount,
            returnedChangeCount,
            observedChangeCountIsLowerBound: proximity.truncated ? 1 : 0,
            observedAddedCount: observedCounts.added,
            observedRemovedCount: observedCounts.removed,
            observedSourceAvailabilityChangeCount: observedCounts.sourceAvailability,
            observedTransformChangeCount: observedCounts.transform,
            observedMovedCount: observedCounts.moved,
            observedGeometryChangeCount: observedCounts.geometry,
            observedGeometryIndeterminateCount: observedCounts.geometryIndeterminate,
            observedPropertyChangeCount: observedCounts.property,
            observedConnectorChangeCount: observedCounts.connector,
            observedConnectivityChangeCount: observedCounts.connectivity,
            observedProximityChangeCount: observedCounts.proximity,
        },
        warnings: [...new Set([
                ...baseCapability.limitations,
                ...headCapability.limitations,
                ...(legacy ? ["legacy_v02_diff_is_capability_limited"] : []),
                ...(aabbOnlyGeometryCapabilityGap ? ["aabb_only_geometry_change_classification_is_capability_limited"] : []),
                ...(truncated ? ["diff_output_truncated_no_complete_claim_allowed"] : []),
            ])],
        notices: ["Snapshot diff is historical evidence bound to both explicit revision fingerprints."],
        elapsedMs: Date.now() - startedAt,
    };
}
export function compareSpatialSnapshots(store, input) {
    const result = compareSpatialSnapshotsCore(store, input);
    if (!result.guarded && Buffer.byteLength(canonicalJson(result), "utf8") > MAX_DIFF_RESPONSE_BYTES) {
        return guarded("max_bytes", "The bounded diff result exceeded the runtime response budget; lower maxChanges or narrow the snapshot scope.", [`max_response_bytes:${MAX_DIFF_RESPONSE_BYTES}`]);
    }
    return result;
}
