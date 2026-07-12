import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  captureSpatialSnapshotAtomic,
  probeStoredSpatialSnapshotLiveness,
  validateSpatialLivenessProbe,
} from "../build/spatial/spatialCapture.js";
import { SpatialStore } from "../build/spatial/spatialStore.js";

const sha = (character) => `sha256:${character.repeat(64)}`;
function semanticCanonicalJson(value) {
  if (value === null) return "null";
  if (typeof value === "number") {
    const bytes = new ArrayBuffer(8);
    const view = new DataView(bytes);
    view.setFloat64(0, Object.is(value, -0) ? 0 : value, false);
    return JSON.stringify(`n:${view.getBigUint64(0, false).toString(16).padStart(16, "0")}`);
  }
  if (typeof value === "string") return JSON.stringify(`s:${value}`);
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(semanticCanonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort()
    .map((key) => `${JSON.stringify(key)}:${semanticCanonicalJson(value[key])}`).join(",")}}`;
}
const semanticHash = (value) => `sha256:${crypto.createHash("sha256")
  .update(semanticCanonicalJson(value), "utf8").digest("hex")}`;
const sourceRevisions = [{
  documentKey: "host:test",
  documentSessionId: "document-session-1",
  trackerSessionId: "tracker-session-1",
  loadedVersion: "version-1",
  changeSequence: 7,
  changeSequenceState: "tracked",
  oldestRetainedSequence: 0,
  journalEntryCount: 7,
  journalCapacity: 512,
  journalTruncated: false,
  sourceToHostTransform: { matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
  documentKeyResolution: { resolverVersion: "phase1a-document-key/1.0", basis: "saved_standalone", crossSessionComparable: true },
}];
const captureScope = {
  hostDocumentKey: "host:test",
  requestedLevelUniqueIds: ["level-1"],
  categories: ["OST_DuctCurves"],
  linkInclusionPolicy: "host_only",
  sourceDocumentPolicy: "host_only",
  effectiveVerticalBands: [{
    levelId: 1,
    levelUniqueId: "level-1",
    levelName: "Level 1",
    elevationMm: 0,
    minHostZMm: -1000,
    maxHostZMm: 5000,
  }],
  activePhase: "Existing",
  phaseSelectionPolicy: "collector_unfiltered_phase0",
  designOptionsInEffect: [],
  worksetVisibilityPolicy: "collector_unfiltered_phase0",
  categoryRuleSetSelection: ["phase1a-default"],
  coordinateFrame: "host_internal_mm",
};
const effectiveSourcePolicy = {
  requestedSourceScope: "hostOnly",
  sourceDocumentPolicy: "host_only",
  includeHostMep: true,
  includeRoomsSpaces: false,
  includeLinkedObstructions: false,
  selectedLinkCount: 0,
  loadedSelectedLinkCount: 0,
  effectiveSourceCount: 1,
  effectiveCategories: ["OST_DuctCurves"],
  effectiveSources: [{
    documentKey: "host:test",
    sourceKind: "host",
    linkPlacementKey: "host",
    categories: ["OST_DuctCurves"],
  }],
  hasEffectiveExtractionPolicy: true,
};
const nativeScanPolicy = {
  levelScopeRequired: true,
  maxElements: 5000,
  maxElapsedMs: 1800,
  pageTargetBytes: 4 * 1024 * 1024,
  pagePayloadBasis: "canonical_ieee754_rows_utf8_v1",
  hardPageCap: true,
  maxGeometryPointsPerElement: 8192,
  maxBoundarySegmentsPerElement: 2048,
  ordering: ["documentKey", "linkPlacement", "nodeKind", "stableSourceIdentity"],
  selectionAndFilteringBeforeMaxElements: true,
  coordinateFrame: "host_internal_mm",
  cursorVersion: "0.2",
  cursorIntegrity: "hmac_sha256_process_session",
  cursorInvalidAfterRestart: true,
  sequenceBound: true,
  maxUiOccupancyMs: 5000,
  readOnly: true,
  transactionOpened: false,
};

function node(nodeId, x) {
  return {
    nodeId,
    nodeKind: "revit_element",
    elementRef: {
      documentKey: "host:test",
      documentSessionId: "document-session-1",
      elementUniqueId: `element-${nodeId}`,
      elementId: x + 1,
      sourceKind: "host",
    },
    sourceRefs: [{ documentKey: "host:test", documentSessionId: "document-session-1" }],
    geometry: {
      aabb: { min: [x, x, x], max: [x + 10, x + 10, x + 10] },
    },
  };
}

function connectorNode(nodeId, ownerNodeId, x) {
  return {
    nodeId,
    nodeKind: "connector",
    elementRef: {
      documentKey: "host:test",
      documentSessionId: "document-session-1",
      elementUniqueId: `element-${ownerNodeId}`,
      elementId: x + 1,
      sourceKind: "host",
    },
    sourceRefs: [{ documentKey: "host:test", documentSessionId: "document-session-1" }],
    ownerNodeId,
    connectorKey: "connector:0",
    geometry: {
      aabb: { min: [x, x, x], max: [x + 1, x + 1, x + 1] },
    },
  };
}

function connectorOmission(ownerNodeId) {
  return {
    classification: "connector_location_unavailable",
    detail: "Connector origin could not be read.",
    eligible: true,
    nodeKind: "connector",
    ownerNodeId,
    connectorKey: null,
    elementRef: {
      documentKey: "host:test",
      documentSessionId: "document-session-1",
      elementUniqueId: `element-${ownerNodeId}`,
      elementId: 77,
      sourceKind: "host",
    },
  };
}

function strictV03Page() {
  const strictSourceRef = {
    documentKey: "host:test",
    documentSessionId: "document-session-1",
  };
  const elementRef = {
    ...strictSourceRef,
    elementUniqueId: "strict-element-1",
    elementId: 1,
    sourceKind: "host",
  };
  const strictNode = {
    nodeId: "node:strict-v03",
    nodeKind: "revit_element",
    nodeRef: {
      nodeId: "node:strict-v03",
      nodeKind: "revit_element",
      elementRef,
      sourceRefs: [strictSourceRef],
    },
    elementRef,
    sourceRefs: [strictSourceRef],
    category: "Ducts",
    builtInCategory: "OST_DuctCurves",
    categoryRole: "host_mep",
    name: "Strict Duct",
    familyName: "Strict Duct",
    typeName: "100x100",
    levelRef: {
      sourceLevelId: 1,
      sourceLevelName: "Level 1",
      sourceLevelUniqueId: "level-1",
    },
    spatialProperties: {
      systemKey: "Supply Air",
      systemName: "Supply Air",
      systemClassification: "Supply Air",
    },
    profile: {
      shape: "rectangular",
      diameterMm: null,
      widthMm: 100,
      heightMm: 100,
      insulationThicknessMm: 0,
    },
    fingerprints: {
      version: "phase1b-spatial-fingerprint/1.0",
      placement: sha("1"),
      shape: sha("2"),
      property: sha("3"),
      topology: sha("4"),
    },
    geometry: {
      coordinateFrame: "host_internal_mm",
      lengthUnit: "mm",
      aabb: { min: [0, 0, 0], max: [100, 100, 100] },
      centerline: null,
      pointLocation: null,
      boundaryLoops: [],
      basis: "revit_element_aabb",
      precisionClass: "aabb_only",
      verdictCapability: "context_only",
      geometryFingerprint: sha("5"),
    },
  };
  const sortPosition = {
    documentKey: "host:test",
    linkPlacementKey: "host",
    nodeKind: "revit_element",
    stableSourceIdentity: "strict-element-1",
  };
  const strictCoverage = {
    sourceCount: 1,
    effectiveScope: true,
    selectionComplete: true,
    selectedLinkCount: 0,
    loadedLinkCount: 0,
    unloadedLinkCount: 0,
    scannedElementCount: 1,
    filteredOutOfScopeCount: 0,
    sourceAvailabilityOmissionCount: 0,
    totalOrderedRowCount: 1,
    pageNodeCount: 1,
    pageOmissionCount: 0,
    eligibleByCategory: { OST_DuctCurves: 1 },
    extractedByCategory: { OST_DuctCurves: 1 },
    omittedByClassification: {},
    connectorOmittedByClassification: {},
    unmaterializedOmissionCount: 0,
    unmaterializedOmissionsByClassification: {},
    sourceOmittedByClassification: {},
    classifiedOmissionCount: 0,
    allEligibleOmissionsClassified: true,
    extractionCoverageRatio: 1,
    phase0TargetAtLeast0_995: true,
    complete: true,
  };
  const pageRows = [{ orderKey: sortPosition, node: strictNode }];
  const pagePayloadBytes = Buffer.byteLength(semanticCanonicalJson(pageRows), "utf8");
  const pageHash = semanticHash({
    captureId: "capture-strict-v03",
    pageOrdinal: 0,
    priorPageHash: null,
    rows: pageRows,
  });
  return {
    resultContractVersion: 2,
    success: true,
    guarded: false,
    state: "completed",
    action: "extract_spatial_snapshot",
    reason: null,
    message: "Spatial extraction page completed.",
    error: null,
    schemaVersion: "0.3",
    extractorVersion: "phase1b-native/0.3",
    coordinateFrame: "host_internal_mm",
    lengthUnit: "mm",
    captureId: "capture-strict-v03",
    snapshotId: "capture-strict-v03",
    capturedAt: "2026-07-11T20:00:00.000Z",
    atomic: false,
    liveness: "staging",
    captureConsistency: "document_change_sequence_bound",
    continuationKind: null,
    sourceBindingFingerprint: sha("6"),
    preparation: null,
    revisionBasisCaveat: "Document change sequences bind this prepared capture.",
    scope: captureScope,
    effectiveSourcePolicy,
    sourceRevisions: [{
      ...sourceRevisions[0],
      sourceToHostTransform: {
        representation: "affine_4x4_row_major",
        fromFrame: "source_internal",
        toFrame: "host_internal_mm",
        lengthUnit: "mm",
        matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      },
    }],
    scopeFingerprint: sha("7"),
    revisionFingerprint: sha("8"),
    nodes: [strictNode],
    omissions: [],
    counts: {
      totalNodes: 1,
      nodesByKind: { revit_element: 1, connector: 0, derived: 0 },
      expectedSupportedNodes: 1,
      extractedSupportedNodes: 1,
      omittedSupportedNodes: 0,
      omissionsByReason: {},
      connectorOmissionsByReason: {},
    },
    coverage: strictCoverage,
    transformValidation: {
      transformCount: 1,
      validatedCount: 1,
      failedCount: 0,
      maxRoundTripErrorMm: 0,
      allWithin0_5mm: true,
    },
    page: {
      ordinal: 0,
      targetBytes: 4 * 1024 * 1024,
      payloadBytes: pagePayloadBytes,
      rows: pageRows,
      rowCount: 1,
      recordCount: 1,
      nodeCount: 1,
      omissionCount: 0,
      hasMore: false,
      pageSha256: pageHash,
      pageHash,
      priorPageSha256: null,
      priorPageHash: null,
      firstSortPosition: "host:test|host|revit_element|strict-element-1",
      lastSortPosition: "host:test|host|revit_element|strict-element-1",
      nextCursor: null,
    },
    pageCount: 1,
    payloadBytes: pagePayloadBytes,
    nextCursor: null,
    partial: false,
    coverageStatus: "complete",
    scanStoppedReason: "completed",
    scanPolicy: nativeScanPolicy,
    suggestedNextScopes: [],
    elapsedMs: 10,
    lastReadDocumentKey: "host:test",
    lastReadLinkInstanceUniqueId: null,
    lastReadNodeKind: "revit_element",
    lastReadItemId: 1,
    warnings: [],
    notices: [],
  };
}

function page({
  captureId,
  ordinal,
  priorPageHash,
  pageHash,
  hasMore,
  nodes,
  omissions = [],
  revisionFingerprint = sha("b"),
  sourceBindingFingerprint = sha("8"),
  revisions = sourceRevisions,
  totalNodes = 2,
  nodesByKind = { revit_element: totalNodes, connector: 0, derived: 0 },
  omittedSupportedNodes = 0,
  omissionsByReason = {},
  connectorOmissionsByReason = {},
  unmaterializedOmissionCount = 0,
  unmaterializedOmissionsByClassification = {},
  pageCount = 2,
  totalPayloadBytes = 20,
  partial = hasMore,
  coverageStatus = "complete",
  scanStoppedReason = hasMore ? "max_bytes" : "completed",
  coverageMarker = hasMore ? "first-page" : "terminal-page",
  elapsedMs = 900 + ordinal * 200,
}) {
  return {
    success: true,
    guarded: false,
    state: "completed",
    action: "extract_spatial_snapshot",
    schemaVersion: "0.3",
    extractorVersion: "phase1b-native/0.3",
    coordinateFrame: "host_internal_mm",
    lengthUnit: "mm",
    captureId,
    snapshotId: captureId,
    capturedAt: "2026-07-11T20:00:00.000Z",
    atomic: false,
    liveness: "staging",
    captureConsistency: "document_change_sequence_bound",
    continuationKind: null,
    revisionBasisCaveat: "Document change sequences bind this prepared capture.",
    scope: captureScope,
    sourceRevisions: revisions,
    scopeFingerprint: sha("a"),
    sourceBindingFingerprint,
    revisionFingerprint,
    counts: {
      totalNodes,
      nodesByKind,
      expectedSupportedNodes: totalNodes + omittedSupportedNodes,
      extractedSupportedNodes: totalNodes,
      omittedSupportedNodes,
      omissionsByReason,
      connectorOmissionsByReason,
    },
    effectiveSourcePolicy,
    coverage: {
      complete: !hasMore && !partial,
      totalOrderedRowCount: totalNodes + omissions.length,
      sourceAvailabilityOmissionCount: 0,
      pageNodeCount: nodes.length,
      pageOmissionCount: omissions.length,
      omittedByClassification: omissionsByReason,
      connectorOmittedByClassification: connectorOmissionsByReason,
      unmaterializedOmissionCount,
      unmaterializedOmissionsByClassification,
      sourceOmittedByClassification: {},
      classifiedOmissionCount: omittedSupportedNodes,
      allEligibleOmissionsClassified: true,
      marker: coverageMarker,
    },
    transformValidation: { allWithin0_5mm: true },
    preparation: null,
    nodes,
    omissions,
    page: {
      ordinal,
      payloadBytes: 10,
      hasMore,
      pageSha256: pageHash,
      priorPageSha256: priorPageHash,
      nextCursor: hasMore ? `cursor-${ordinal + 1}` : null,
    },
    pageCount,
    payloadBytes: totalPayloadBytes,
    nextCursor: hasMore ? `cursor-${ordinal + 1}` : null,
    partial,
    coverageStatus,
    scanStoppedReason,
    scanPolicy: nativeScanPolicy,
    suggestedNextScopes: hasMore ? ["cursor"] : [],
    elapsedMs,
    warnings: [],
    notices: [],
  };
}

function workContinuation({
  captureId,
  stepOrdinal,
  phase = "discover",
  processed = stepOrdinal,
  total = 4,
  nextCursor = `spatial-work-cursor-v0.2.${stepOrdinal}`,
  sourceBindingFingerprint = sha("8"),
  elapsedMs = 600,
}) {
  return {
    resultContractVersion: 2,
    success: true,
    guarded: false,
    state: "in_progress",
    action: "extract_spatial_snapshot",
    reason: null,
    message: "Spatial capture preparation remains in progress.",
    error: null,
    schemaVersion: "0.3",
    extractorVersion: "phase1b-native/0.3",
    coordinateFrame: "host_internal_mm",
    lengthUnit: "mm",
    captureId,
    snapshotId: captureId,
    capturedAt: "2026-07-11T20:00:00.000Z",
    atomic: false,
    liveness: "staging",
    captureConsistency: "document_change_sequence_bound",
    continuationKind: "work",
    sourceBindingFingerprint,
    preparation: {
      phase,
      stepOrdinal,
      processed,
      total,
      hasMore: true,
      cursorVersion: "0.2-work",
      nextCursor,
      uiOccupancyTargetMs: 1800,
    },
    revisionBasisCaveat: "Document change sequences bind this prepared capture.",
    scope: captureScope,
    effectiveSourcePolicy,
    sourceRevisions: null,
    scopeFingerprint: sha("a"),
    revisionFingerprint: null,
    nodes: null,
    omissions: null,
    counts: null,
    coverage: null,
    transformValidation: null,
    page: null,
    pageCount: 0,
    payloadBytes: 0,
    nextCursor,
    partial: false,
    coverageStatus: null,
    scanStoppedReason: null,
    scanPolicy: nativeScanPolicy,
    suggestedNextScopes: [],
    elapsedMs,
    lastReadDocumentKey: null,
    lastReadLinkInstanceUniqueId: null,
    lastReadNodeKind: null,
    lastReadItemId: null,
    warnings: [],
    notices: [],
  };
}

function liveProbe(liveness = "current") {
  const currentCount = liveness === "current" ? 1 : 0;
  const staleCount = liveness === "stale" ? 1 : 0;
  const unknownCount = liveness === "unknown" ? 1 : 0;
  return {
    success: true,
    guarded: false,
    state: "completed",
    trackerSessionId: "tracker-session-1",
    trackerSubscribed: true,
    expectedSourceRevisionCount: 1,
    resolvedSourceCount: 1,
    currentSourceCount: currentCount,
    staleSourceCount: staleCount,
    unknownSourceCount: unknownCount,
    externalLinkUpdateAvailableCount: 0,
    liveness,
    sourceStates: [{
      inputOrdinal: 0,
      documentKey: "host:test",
      linkInstanceUniqueId: null,
      sourceResolved: true,
      liveness,
      reason: liveness === "current" ? "sequence_matches" : `${liveness}_test`,
      externalLinkUpdateAvailable: false,
    }],
  };
}

const passthroughNormalizer = (payload) => ({ payload, valid: true, errors: [] });
const policy = { pageTargetBytes: 4 * 1024 * 1024, maxElements: 5000, maxElapsedMs: 1800 };

const linkedSourceRevision = {
  ...sourceRevisions[0],
  documentKey: "link:test",
  documentSessionId: "link-document-session-1",
  loadedVersion: "link-version-1",
  changeSequence: 11,
  linkInstanceUniqueId: "link-instance-1",
};

const multiSourceProbePayload = {
  success: true,
  guarded: false,
  state: "completed",
  livenessProbeBasis: "sequence_bound_process_cache",
  livenessCacheHit: true,
  livenessGeneration: 42,
  trackerSessionId: "tracker-session-1",
  trackerSubscribed: true,
  expectedSourceRevisionCount: 2,
  resolvedSourceCount: 2,
  currentSourceCount: 2,
  staleSourceCount: 0,
  unknownSourceCount: 0,
  externalLinkUpdateAvailableCount: 0,
  liveness: "current",
  sourceStates: [
    {
      inputOrdinal: 1,
      documentKey: "link:test",
      linkInstanceUniqueId: "link-instance-1",
      sourceResolved: true,
      liveness: "current",
      reason: "sequence_matches",
      externalLinkUpdateAvailable: false,
    },
    {
      inputOrdinal: 0,
      documentKey: "host:test",
      linkInstanceUniqueId: null,
      sourceResolved: true,
      liveness: "current",
      reason: "sequence_matches",
      externalLinkUpdateAvailable: false,
    },
  ],
};
const multiSourceProbe = validateSpatialLivenessProbe(
  multiSourceProbePayload,
  [sourceRevisions[0], linkedSourceRevision],
);
assert.equal(multiSourceProbe.liveness, "current", "inputOrdinal must bind reordered multi-source rows to their original request slots");
const lyingCacheDiagnosticProbe = validateSpatialLivenessProbe({
  ...multiSourceProbePayload,
  trackerSessionId: "tracker-session-mismatch",
  livenessCacheHit: true,
}, [sourceRevisions[0], linkedSourceRevision]);
assert.equal(lyingCacheDiagnosticProbe.liveness, "unknown",
  "Cache provenance is diagnostic only and must not promote a mismatched tracker/source contract to current.");
assert.deepEqual(lyingCacheDiagnosticProbe.unknownReasons, ["live_liveness_probe_failed"]);
const externalUpdateProbePayload = {
  success: true,
  guarded: false,
  state: "completed",
  trackerSessionId: "tracker-session-1",
  trackerSubscribed: true,
  expectedSourceRevisionCount: 2,
  resolvedSourceCount: 2,
  currentSourceCount: 2,
  staleSourceCount: 0,
  unknownSourceCount: 0,
  externalLinkUpdateAvailableCount: 1,
  liveness: "current",
  warnings: ["model-specific text must not pass through"],
  sourceStates: [
    {
      inputOrdinal: 0,
      documentKey: "host:test",
      linkInstanceUniqueId: null,
      sourceResolved: true,
      liveness: "current",
      reason: "sequence_matches",
      externalLinkUpdateAvailable: false,
    },
    {
      inputOrdinal: 1,
      documentKey: "link:test",
      linkInstanceUniqueId: "link-instance-1",
      sourceResolved: true,
      liveness: "current",
      reason: "sequence_matches",
      externalLinkUpdateAvailable: true,
    },
  ],
};
const externalUpdateProbe = validateSpatialLivenessProbe(
  externalUpdateProbePayload,
  [sourceRevisions[0], linkedSourceRevision],
);
assert.equal(externalUpdateProbe.liveness, "current", "external availability does not invalidate loaded-geometry liveness");
assert.deepEqual(externalUpdateProbe.warnings, [
  "external_link_update_available: Newer linked-model source data is available; currently loaded Revit geometry remains authoritative until reload.",
]);
const mismatchedExternalCountProbe = validateSpatialLivenessProbe({
  ...externalUpdateProbePayload,
  externalLinkUpdateAvailableCount: 0,
}, [sourceRevisions[0], linkedSourceRevision]);
assert.equal(mismatchedExternalCountProbe.liveness, "unknown");
assert.deepEqual(mismatchedExternalCountProbe.unknownReasons, ["live_liveness_probe_external_observation_mismatch"]);
const duplicateOrdinalProbe = validateSpatialLivenessProbe({
  success: true,
  guarded: false,
  state: "completed",
  trackerSessionId: "tracker-session-1",
  trackerSubscribed: true,
  expectedSourceRevisionCount: 2,
  resolvedSourceCount: 2,
  currentSourceCount: 2,
  staleSourceCount: 0,
  unknownSourceCount: 0,
  externalLinkUpdateAvailableCount: 0,
  liveness: "current",
  sourceStates: [
    { inputOrdinal: 0, documentKey: "host:test", linkInstanceUniqueId: null, sourceResolved: true, liveness: "current", externalLinkUpdateAvailable: false },
    { inputOrdinal: 0, documentKey: "link:test", linkInstanceUniqueId: "link-instance-1", sourceResolved: true, liveness: "current", externalLinkUpdateAvailable: false },
  ],
}, [sourceRevisions[0], linkedSourceRevision]);
assert.equal(duplicateOrdinalProbe.liveness, "unknown");
assert.deepEqual(duplicateOrdinalProbe.unknownReasons, ["live_liveness_probe_incomplete"]);

function withStore(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revagent-phase1a-capture-"));
  const store = new SpatialStore({ databasePath: path.join(root, "spatial.db") });
  return Promise.resolve()
    .then(() => run(store))
    .finally(() => {
      store.close();
      fs.rmSync(root, { recursive: true, force: true });
    });
}

await withStore(async (store) => {
  let normalizeCalls = 0;
  let beginCalls = 0;
  const originalBeginCapture = store.beginCapture.bind(store);
  store.beginCapture = (...args) => {
    beginCalls += 1;
    return originalBeginCapture(...args);
  };
  const legacyPage = {
    ...page({
      captureId: "capture-v02-native-guard",
      ordinal: 0,
      priorPageHash: null,
      pageHash: sha("9"),
      hasMore: false,
      nodes: [node("legacy-v02-node", 0)],
      totalNodes: 1,
      nodesByKind: { revit_element: 1, connector: 0, derived: 0 },
      pageCount: 1,
      totalPayloadBytes: 10,
    }),
    schemaVersion: "0.2",
    extractorVersion: "phase1a-truth-foundation/0.2.0",
  };
  const result = await captureSpatialSnapshotAtomic({ nativeParams: {}, scanPolicy: policy }, {
    store,
    normalizePage: (payload, elapsedMs) => {
      normalizeCalls += 1;
      return passthroughNormalizer(payload, elapsedMs);
    },
    sendPage: async () => legacyPage,
  });
  assert.equal(result.success, true);
  assert.equal(result.guarded, true);
  assert.equal(result.reason, "phase1b_native_contract_required");
  assert.equal(result.requiredSchemaVersion, "0.3");
  assert.equal(result.receivedSchemaVersion, "0.2");
  assert.equal(result.committed, false);
  assert.equal(normalizeCalls, 1, "A valid old page must be identified after strict page normalization.");
  assert.equal(beginCalls, 0, "A v0.2 native page must be guarded before durable staging begins.");
  assert.equal(store.listSnapshots().length, 0);
});

await withStore(async (store) => {
  const strictPage = strictV03Page();
  const result = await captureSpatialSnapshotAtomic({ nativeParams: {}, scanPolicy: policy }, {
    store,
    sendPage: async () => strictPage,
    probeLiveness: async () => liveProbe("current"),
  });
  assert.equal(result.committed, true, JSON.stringify(result));
  assert.equal(result.snapshot.schemaVersion, "0.3");
  assert.equal(store.getStoredNode("capture-strict-v03", "node:strict-v03").category, "Ducts");
});

await withStore(async (store) => {
  const terminalPage = page({
    captureId: "capture-external-link-warning",
    ordinal: 0,
    priorPageHash: null,
    pageHash: sha("3"),
    hasMore: false,
    nodes: [node("external-warning-node", 0)],
    revisions: [sourceRevisions[0], linkedSourceRevision],
    totalNodes: 1,
    nodesByKind: { revit_element: 1, connector: 0, derived: 0 },
    pageCount: 1,
    totalPayloadBytes: 10,
  });
  const result = await captureSpatialSnapshotAtomic({ nativeParams: {}, scanPolicy: policy }, {
    store,
    normalizePage: passthroughNormalizer,
    sendPage: async () => terminalPage,
    probeLiveness: async (sources) => {
      assert.equal(sources.length, 2);
      return externalUpdateProbePayload;
    },
  });
  assert.equal(result.committed, true, result.error);
  assert.equal(result.liveness, "current");
  assert.deepEqual(result.warnings, externalUpdateProbe.warnings);
  assert.doesNotMatch(JSON.stringify(result.warnings), /model-specific/);
});

await withStore(async (store) => {
  const captureId = "capture-with-work";
  const responses = [
    workContinuation({ captureId, stepOrdinal: 1, phase: "discover", processed: 1, total: 4, elapsedMs: 500 }),
    workContinuation({ captureId, stepOrdinal: 2, phase: "filter", processed: 2, total: 2, elapsedMs: 700 }),
    page({ captureId, ordinal: 0, priorPageHash: null, pageHash: sha("6"), hasMore: true, nodes: [node("work-node-1", 0)] }),
    page({ captureId, ordinal: 1, priorPageHash: sha("6"), pageHash: sha("7"), hasMore: false, nodes: [node("work-node-2", 20)] }),
  ];
  const seenCursors = [];
  let normalizeCalls = 0;
  let beginCalls = 0;
  let stageCalls = 0;
  const originalBeginCapture = store.beginCapture.bind(store);
  const originalStagePage = store.stagePage.bind(store);
  store.beginCapture = (...args) => {
    beginCalls += 1;
    return originalBeginCapture(...args);
  };
  store.stagePage = (...args) => {
    stageCalls += 1;
    return originalStagePage(...args);
  };

  const result = await captureSpatialSnapshotAtomic({ nativeParams: {}, scanPolicy: policy }, {
    store,
    normalizePage: (payload, elapsedMs) => {
      normalizeCalls += 1;
      return passthroughNormalizer(payload, elapsedMs);
    },
    sendPage: async (params) => {
      seenCursors.push(params.cursor ?? null);
      if (seenCursors.length <= 2) {
        assert.equal(beginCalls, 0, "work continuations must not begin durable staging");
        assert.equal(stageCalls, 0, "work continuations must not stage a data page");
      }
      return responses.shift();
    },
    probeLiveness: async () => liveProbe("current"),
  });

  assert.equal(result.committed, true, JSON.stringify(result));
  assert.equal(normalizeCalls, 2, "only data pages may enter the spatial page normalizer");
  assert.equal(beginCalls, 1);
  assert.equal(stageCalls, 2);
  assert.deepEqual(seenCursors, [
    null,
    "spatial-work-cursor-v0.2.1",
    "spatial-work-cursor-v0.2.2",
    "cursor-1",
  ]);
  assert.equal(result.pagePerformance.roundTrip.count, 2, "work calls are not data pages");
  assert.equal(result.preparationPerformance.continuationCount, 2);
  assert.deepEqual(result.preparationPerformance.phases, ["discover", "filter"]);
  assert.equal(result.preparationPerformance.nativeUiOccupancy.p95Ms, 700);
  assert.equal(result.snapshot.sourceBindingFingerprint, sha("8"));
});

await withStore(async (store) => {
  const captureId = "capture-connector-reconciliation";
  const omission = connectorOmission("owner-1");
  const terminalPage = page({
    captureId,
    ordinal: 0,
    priorPageHash: null,
    pageHash: sha("5"),
    hasMore: false,
    nodes: [connectorNode("connector-node-1", "owner-1", 10)],
    omissions: [omission],
    totalNodes: 1,
    nodesByKind: { revit_element: 0, connector: 1, derived: 0 },
    omittedSupportedNodes: 1,
    omissionsByReason: {},
    connectorOmissionsByReason: { connector_location_unavailable: 1 },
    pageCount: 1,
    totalPayloadBytes: 10,
    partial: true,
    coverageStatus: "incomplete_omissions",
    scanStoppedReason: "read_failed",
  });
  const result = await captureSpatialSnapshotAtomic({ nativeParams: {}, scanPolicy: policy }, {
    store,
    normalizePage: passthroughNormalizer,
    sendPage: async () => terminalPage,
    probeLiveness: async () => liveProbe("current"),
  });

  assert.equal(result.committed, true, result.error);
  assert.equal(result.counts.persistedNodes, 1);
  assert.equal(result.counts.persistedOmissions, 1);
  const record = store.getSnapshotRecord(captureId);
  assert.equal(record.nodeCount, 1);
  assert.equal(record.omissionCount, 1);
  assert.equal(record.declaredCounts.nodesByKind.connector, 1);
  assert.equal(record.declaredCounts.connectorOmissionsByReason.connector_location_unavailable, 1);
  assert.equal(record.derivedCounts.nodesByKind.connector, 1);
  assert.equal(record.derivedCounts.omissionsByReason.connector_location_unavailable, 1);
});

await withStore(async (store) => {
  const captureId = "capture-max-items-aggregate-omissions";
  const terminalPage = page({
    captureId,
    ordinal: 0,
    priorPageHash: null,
    pageHash: sha("4"),
    hasMore: false,
    nodes: [node("bounded-node-1", 0)],
    totalNodes: 1,
    nodesByKind: { revit_element: 1, connector: 0, derived: 0 },
    omittedSupportedNodes: 3,
    omissionsByReason: { max_items: 3 },
    unmaterializedOmissionCount: 3,
    unmaterializedOmissionsByClassification: { max_items: 3 },
    pageCount: 1,
    totalPayloadBytes: 10,
    partial: true,
    coverageStatus: "incomplete_budget",
    scanStoppedReason: "max_items",
  });
  const result = await captureSpatialSnapshotAtomic({ nativeParams: {}, scanPolicy: policy }, {
    store,
    normalizePage: passthroughNormalizer,
    sendPage: async () => terminalPage,
    probeLiveness: async () => liveProbe("current"),
  });

  assert.equal(result.committed, true, result.error);
  assert.equal(result.partial, true);
  assert.equal(result.scanStoppedReason, "max_items");
  assert.equal(result.counts.omittedSupportedNodes, 3, "public counts retain aggregate unmaterialized omissions");
  assert.equal(result.counts.persistedOmissions, 0, "persisted omissions count only materialized omission rows");
  assert.equal(result.coverage.unmaterializedOmissionCount, 3, "aggregate coverage evidence must remain public");
  assert.deepEqual(result.coverage.unmaterializedOmissionsByClassification, { max_items: 3 });
  assert.equal(result.transformValidation.allWithin0_5mm, true);
  const record = store.getSnapshotRecord(captureId);
  assert.equal(record.omissionCount, 0);
  assert.equal(record.declaredCounts.omittedSupportedNodes, 3);
  assert.equal(record.coverage.unmaterializedOmissionCount, 3);
  assert.equal(record.derivedCounts.omittedSupportedNodes, 0);
});

await withStore(async (store) => {
  let normalizeCalls = 0;
  let beginCalls = 0;
  const originalBeginCapture = store.beginCapture.bind(store);
  store.beginCapture = (...args) => {
    beginCalls += 1;
    return originalBeginCapture(...args);
  };
  const malformed = {
    ...workContinuation({ captureId: "capture-malformed-work", stepOrdinal: 1 }),
    unexpectedModelData: "must-not-pass",
  };
  const result = await captureSpatialSnapshotAtomic({ nativeParams: {}, scanPolicy: policy }, {
    store,
    normalizePage: (payload, elapsedMs) => {
      normalizeCalls += 1;
      return passthroughNormalizer(payload, elapsedMs);
    },
    sendPage: async () => malformed,
  });
  assert.equal(result.success, false);
  assert.equal(result.reason, "invalid_spatial_work_contract");
  assert.equal(normalizeCalls, 0, "malformed progress must fail before the data-page normalizer");
  assert.equal(beginCalls, 0, "malformed progress must fail before store staging");
});

await withStore(async (store) => {
  const captureId = "capture-binding-change";
  const responses = [
    workContinuation({ captureId, stepOrdinal: 1 }),
    page({
      captureId,
      ordinal: 0,
      priorPageHash: null,
      pageHash: sha("0"),
      hasMore: false,
      nodes: [node("binding-node", 0)],
      sourceBindingFingerprint: sha("9"),
    }),
  ];
  const result = await captureSpatialSnapshotAtomic({ nativeParams: {}, scanPolicy: policy }, {
    store,
    normalizePage: passthroughNormalizer,
    sendPage: async () => responses.shift(),
  });
  assert.equal(result.success, false);
  assert.equal(result.reason, "invalid_spatial_work_contract");
  assert.equal(store.listSnapshots().length, 0);
});

await withStore(async (store) => {
  const result = await captureSpatialSnapshotAtomic({ nativeParams: {}, scanPolicy: policy }, {
    store,
    normalizePage: passthroughNormalizer,
    sendPage: async () => workContinuation({ captureId: "capture-step-replay", stepOrdinal: 2 }),
  });
  assert.equal(result.success, false);
  assert.equal(result.reason, "invalid_spatial_work_contract");
  assert.match(result.error, /monotonicity/i);
});

await withStore(async (store) => {
  const pages = [
    page({ captureId: "capture-success", ordinal: 0, priorPageHash: null, pageHash: sha("c"), hasMore: true, nodes: [node("node-1", 0)] }),
    page({ captureId: "capture-success", ordinal: 1, priorPageHash: sha("c"), pageHash: sha("d"), hasMore: false, nodes: [node("node-2", 20)] }),
  ];
  let calls = 0;
  const result = await captureSpatialSnapshotAtomic({ nativeParams: {}, scanPolicy: policy }, {
    store,
    normalizePage: passthroughNormalizer,
    sendPage: async () => {
      if (calls === 1) {
        assert.equal(store.listSnapshots().length, 0, "staging must remain invisible before the terminal page commits");
      }
      return pages[calls++];
    },
    probeLiveness: async () => liveProbe("current"),
  });

  assert.equal(result.success, true);
  assert.equal(result.committed, true);
  assert.equal(result.atomic, true);
  assert.equal(result.liveness, "current");
  assert.equal(result.snapshot.schemaVersion, "0.3");
  assert.equal(result.snapshot.pageCount, 2);
  assert.equal(store.listSnapshots().length, 1);
  assert.equal(store.getSnapshot("capture-success").nodeCount, 2);
  assert.equal(store.getSnapshotRecord("capture-success").coverage.marker, "terminal-page");
  assert.equal(store.countRTreeEntries("capture-success"), 2);
  assert.equal(store.queryIntersectingAabbs({ minMm: [5, 5, 5], maxMm: [6, 6, 6] }, "capture-success").length, 1);
  assert.deepEqual(result.pagePerformance.nativeUiOccupancy, {
    count: 2,
    p95Ms: 1100,
    maxMs: 1100,
    totalMs: 2000,
    p95Within2000Ms: true,
    maxWithin5000Ms: true,
  });
  assert.equal(result.pagePerformance.roundTrip.count, 2);
  assert.equal((await probeStoredSpatialSnapshotLiveness(
    store,
    "capture-success",
    async () => liveProbe("stale"),
  )).liveness, "stale");
  assert.equal((await probeStoredSpatialSnapshotLiveness(
    store,
    "capture-success",
    async () => ({ ...liveProbe("current"), sourceStates: [] }),
  )).liveness, "unknown");
});

await withStore(async (store) => {
  const pages = [
    page({ captureId: "capture-no-probe", ordinal: 0, priorPageHash: null, pageHash: sha("2"), hasMore: true, nodes: [node("no-probe-1", 0)], elapsedMs: 2100 }),
    page({ captureId: "capture-no-probe", ordinal: 1, priorPageHash: sha("2"), pageHash: sha("3"), hasMore: false, nodes: [node("no-probe-2", 20)], elapsedMs: 5100 }),
  ];
  const result = await captureSpatialSnapshotAtomic({ nativeParams: {}, scanPolicy: policy }, {
    store,
    normalizePage: passthroughNormalizer,
    sendPage: async () => pages.shift(),
  });
  assert.equal(result.committed, true);
  assert.equal(result.liveness, "unknown", "a stored snapshot without a fresh probe must never be current");
  assert.deepEqual(result.snapshot.livenessBinding.unknownReasons, ["live_liveness_probe_not_configured"]);
  assert.equal(result.pagePerformance.nativeUiOccupancy.p95Within2000Ms, false);
  assert.equal(result.pagePerformance.nativeUiOccupancy.maxWithin5000Ms, false);
});

await withStore(async (store) => {
  const retryPages = [
    page({ captureId: "capture-after-expiry", ordinal: 0, priorPageHash: null, pageHash: sha("4"), hasMore: true, nodes: [node("after-expiry-1", 0)] }),
    page({ captureId: "capture-after-expiry", ordinal: 1, priorPageHash: sha("4"), pageHash: sha("5"), hasMore: false, nodes: [node("after-expiry-2", 20)] }),
  ];
  let firstCall = true;
  const result = await captureSpatialSnapshotAtomic({ nativeParams: {}, scanPolicy: policy }, {
    store,
    normalizePage: passthroughNormalizer,
    sendPage: async () => {
      if (firstCall) {
        firstCall = false;
        return {
          success: true,
          guarded: true,
          state: "guarded",
          reason: "expired_capture_session",
        };
      }
      return retryPages.shift();
    },
    probeLiveness: async () => liveProbe("current"),
  });
  assert.equal(result.committed, true);
  assert.equal(result.attempts, 2, "canonical native expiry must restart one bounded capture attempt");
});

await withStore(async (store) => {
  let attempt = 0;
  let pageInAttempt = 0;
  const result = await captureSpatialSnapshotAtomic({ nativeParams: {}, scanPolicy: policy }, {
    store,
    normalizePage: passthroughNormalizer,
    sendPage: async () => {
      if (pageInAttempt++ === 0) {
        return page({
          captureId: `capture-interrupted-${attempt}`,
          ordinal: 0,
          priorPageHash: null,
          pageHash: sha("e"),
          hasMore: true,
          nodes: [node(`interrupted-node-${attempt}`, attempt * 50)],
        });
      }
      pageInAttempt = 0;
      attempt += 1;
      return {
        success: true,
        guarded: true,
        state: "guarded",
        action: "capture_spatial_snapshot",
        reason: "capture_interrupted_by_change",
        warnings: [],
      };
    },
  });

  assert.equal(result.guarded, true);
  assert.equal(result.reason, "capture_interrupted_by_change");
  assert.equal(result.attempts, 3);
  assert.equal(store.listSnapshots().length, 0, "interrupted attempts must never expose a mixed-revision snapshot");
  assert.equal(store.purge({ all: true }).purgedStagingCaptureCount, 0, "interrupted staging must be discarded immediately");
});

await withStore(async (store) => {
  const pages = [
    page({ captureId: "capture-mixed", ordinal: 0, priorPageHash: null, pageHash: sha("f"), hasMore: true, nodes: [node("mixed-1", 0)] }),
    page({ captureId: "capture-mixed", ordinal: 1, priorPageHash: sha("f"), pageHash: sha("1"), hasMore: false, nodes: [node("mixed-2", 30)], revisionFingerprint: sha("9") }),
  ];
  const result = await captureSpatialSnapshotAtomic({ nativeParams: {}, scanPolicy: policy }, {
    store,
    normalizePage: passthroughNormalizer,
    sendPage: async () => pages.shift(),
  });
  assert.equal(result.success, false);
  assert.equal(result.reason, "invalid_spatial_page_contract");
  assert.equal(store.listSnapshots().length, 0);
});

{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revagent-retention-disabled-"));
  const store = new SpatialStore({
    databasePath: path.join(root, "spatial.db"),
    retentionPolicy: false,
  });
  try {
    store.applyRetention = () => {
      throw new Error("disabled configured retention must not call explicit default retention");
    };
    const terminalPage = page({
      captureId: "capture-retention-disabled",
      ordinal: 0,
      priorPageHash: null,
      pageHash: sha("a"),
      hasMore: false,
      nodes: [node("retention-disabled-node", 0)],
      totalNodes: 1,
      nodesByKind: { revit_element: 1, connector: 0, derived: 0 },
      pageCount: 1,
      totalPayloadBytes: 10,
    });
    const result = await captureSpatialSnapshotAtomic({ nativeParams: {}, scanPolicy: policy }, {
      store,
      normalizePage: passthroughNormalizer,
      sendPage: async () => terminalPage,
    });
    assert.equal(result.committed, true, result.error);
    assert.ok(store.getSnapshot("capture-retention-disabled"));
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revagent-retention-custom-"));
  const capturedAtMs = Date.parse("2026-07-11T20:00:00.000Z");
  const store = new SpatialStore({
    databasePath: path.join(root, "spatial.db"),
    now: () => capturedAtMs + 100 * 24 * 60 * 60 * 1000,
    retentionPolicy: { retentionDays: 365, minCompleteSnapshots: 0 },
  });
  try {
    for (const [index, captureId] of ["capture-retention-custom-old", "capture-retention-custom-new"].entries()) {
      const terminalPage = page({
        captureId,
        ordinal: 0,
        priorPageHash: null,
        pageHash: index === 0 ? sha("b") : sha("c"),
        hasMore: false,
        nodes: [node(`retention-custom-node-${index}`, index * 10)],
        totalNodes: 1,
        nodesByKind: { revit_element: 1, connector: 0, derived: 0 },
        pageCount: 1,
        totalPayloadBytes: 10,
      });
      const result = await captureSpatialSnapshotAtomic({ nativeParams: {}, scanPolicy: policy }, {
        store,
        normalizePage: passthroughNormalizer,
        sendPage: async () => terminalPage,
      });
      assert.equal(result.committed, true, result.error);
    }
    assert.ok(
      store.getSnapshot("capture-retention-custom-old"),
      "post-capture retention must preserve the configured 365-day policy instead of reverting to 30 days",
    );
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revagent-retention-zero-"));
  const store = new SpatialStore({
    databasePath: path.join(root, "spatial.db"),
    retentionPolicy: { retentionDays: 0, minCompleteSnapshots: 0 },
  });
  try {
    const terminalPage = page({
      captureId: "capture-retention-zero",
      ordinal: 0,
      priorPageHash: null,
      pageHash: sha("d"),
      hasMore: false,
      nodes: [node("retention-zero-node", 0)],
      totalNodes: 1,
      nodesByKind: { revit_element: 1, connector: 0, derived: 0 },
      pageCount: 1,
      totalPayloadBytes: 10,
    });
    const result = await captureSpatialSnapshotAtomic({ nativeParams: {}, scanPolicy: policy }, {
      store,
      normalizePage: passthroughNormalizer,
      sendPage: async () => terminalPage,
    });
    assert.equal(result.committed, true, result.error);
    assert.ok(
      store.getSnapshot("capture-retention-zero"),
      "0/0 retention must run before capture and never erase the snapshot just returned as committed",
    );
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

console.log("spatial Phase 1a atomic capture tests: ok");
