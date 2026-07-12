import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { registerTools } from "../build/tools/register.js";
import { resolveAutoTargetVisualStyle } from "../build/tools/export_revit_coordination_image.js";
import {
  compactMcpStatusPayload,
  formatJsonContent,
  normalizeRevitExecutionResponse,
  truncateText,
} from "../build/utils/revitToolHelpers.js";
import { compactDeleteReviewViewResult } from "../build/tools/delete_review_view.js";
import { stripViewCleanupFields } from "../build/tools/view_operation_result.js";
import {
  recordTelemetryEvent,
  extractProductionContext,
  isSpatialExtractionTelemetry,
  resolveTelemetryTargets,
  sanitizeTelemetryPathSegment,
  summarizeSpatialExtractionTelemetryParams,
  summarizeSpatialExtractionTelemetryResponse,
  summarizeTelemetryParams,
  summarizeTelemetryResponse,
  flushTelemetryWritesForTests,
} from "../build/utils/telemetry.js";
import {
  buildFindElementsSearchPolicy,
} from "../build/utils/searchPolicy.js";
import {
  buildSpatialCaptureParams,
  resolveSpatialCapturePolicy,
} from "../build/tools/capture_spatial_snapshot.js";
import {
  buildInspectLevelsParams,
  normalizeInspectLevelsResult,
} from "../build/tools/inspect_levels.js";
import {
  normalizeSpatialPage,
} from "../build/spatial/spatialPage.js";
import { captureSpatialSnapshotAtomic } from "../build/spatial/spatialCapture.js";
import { SpatialStore } from "../build/spatial/spatialStore.js";

const tools = new Map();
const server = {
  tool(name, description, schema, handler) {
    if (typeof description === "object") {
      handler = schema;
      schema = description;
      description = "";
    }
    tools.set(name, { description, schema, handler });
  },
};

await registerTools(server);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const runtimeRoot = path.resolve(__dirname, "..");
const srcToolsDir = path.join(runtimeRoot, "src", "tools");
const registerSource = fs.readFileSync(path.join(srcToolsDir, "register.ts"), "utf8");
const registeredToolModules = new Set(
  [...registerSource.matchAll(/from\s+["']\.\/([^"']+)\.js["']/g)]
    .map((match) => match[1])
    .sort(),
);
const sourceToolModules = fs
  .readdirSync(srcToolsDir)
  .filter((fileName) =>
    fileName.endsWith(".ts") &&
    fileName !== "register.ts" &&
    !fileName.endsWith(".guard-test.ts")
  )
  .map((fileName) => fileName.replace(/\.ts$/, ""))
  .sort();
const unregisteredServerToolModules = sourceToolModules.filter((moduleName) => {
  const source = fs.readFileSync(path.join(srcToolsDir, `${moduleName}.ts`), "utf8");
  return /server\.tool\s*\(/.test(source) && !registeredToolModules.has(moduleName);
});
assert.deepEqual(
  unregisteredServerToolModules,
  [],
  "Every source module that defines server.tool(...) must be imported by src/tools/register.ts.",
);

const expectedTools = [
  "list_revit_instances",
  "get_revit_mcp_status",
  "send_code_to_revit",
  "send_code_to_revit_safe",
  "get_revit_session_context",
  "get_active_view_context",
  "list_open_views",
  "activate_view",
  "close_view",
  "clear_selection",
  "delete_review_view",
  "get_ui_state",
  "find_elements",
  "open_existing_plan_for_element_level",
  "focus_elements",
  "section_box_elements",
  "create_3d_view_for_elements",
  "export_revit_view_image",
  "export_revit_coordination_image",
  "show_element_in_plan_and_3d",
  "smart_focus_elements",
  "inspect_elements",
  "inspect_levels",
  "inspect_sheet_text",
  "inspect_schedules",
  "reconcile_schedule_excel",
  "count_annotations",
  "inspect_parameter_schema",
  "set_element_parameter",
  "set_schedule_cells",
  "set_schedule_cells_by_text",
  "capture_spatial_snapshot",
  "query_spatial_context",
  "compare_spatial_snapshots",
  "summarize_spatial_state",
];

assert.deepEqual([...tools.keys()], expectedTools);

const statusTool = tools.get("get_revit_mcp_status");
assert.match(statusTool.description, /runtimeActivity/);
assert.equal("includeRuntimeActivity" in statusTool.schema, true);
assert.equal("runtimeActivityLimit" in statusTool.schema, true);
assert.equal("runtimeActivityMode" in statusTool.schema, true);

const inspectLevelsTool = tools.get("inspect_levels");
assert.match(inspectLevelsTool.description, /LEVEL_INSPECTION_READ_ONLY/);
assert.match(inspectLevelsTool.description, /partial\/max_items/);
assert.match(inspectLevelsTool.description, /partial\/read_failed/);
for (const field of [
  "sourceScope",
  "linkInstanceIds",
  "linkInstanceUniqueIds",
  "nameQuery",
  "nameMatchMode",
  "maxResults",
  "timeoutMs",
]) {
  assert.equal(field in inspectLevelsTool.schema, true, `inspect_levels is missing ${field}.`);
}
const inspectLevelsParams = buildInspectLevelsParams({
  sourceScope: "linkedOnly",
  linkInstanceIds: [9, "9", 3, -1, "bad"],
  linkInstanceUniqueIds: ["link-b", "link-a", "link-b", ""],
  nameQuery: "  2FL  ",
  nameMatchMode: "exact",
  maxResults: 2,
  timeoutMs: 70000,
});
assert.equal(inspectLevelsParams.sourceScope, "linkedOnly");
assert.deepEqual(inspectLevelsParams.linkInstanceIds, [3, 9]);
assert.deepEqual(inspectLevelsParams.linkInstanceUniqueIds, ["link-a", "link-b"]);
assert.equal(inspectLevelsParams.nameQuery, "2FL");
assert.equal(inspectLevelsParams.nameMatchMode, "exact");
assert.equal(inspectLevelsParams.maxResults, 2);
assert.equal(inspectLevelsParams.timeoutMs, 60000);
assert.equal(buildInspectLevelsParams({ sourceScope: "invalid", nameMatchMode: "invalid" }).sourceScope, "hostAndLinked");
assert.equal(buildInspectLevelsParams({ sourceScope: "invalid", nameMatchMode: "invalid" }).nameMatchMode, "contains");
const normalizedInspectLevels = normalizeInspectLevelsResult({
  Success: true,
  Guarded: false,
  State: "completed",
  Action: "inspect_levels",
  SourceScope: "linkedOnly",
  NameQuery: "2FL",
  NameMatchMode: "exact",
  EffectiveSourceCount: 1,
  SelectedLinkCount: 1,
  LoadedSelectedLinkCount: 1,
  UnavailableSourceCount: 0,
  ScannedLevelCount: 3,
  MatchedLevelCount: 3,
  ReturnedCount: 2,
  Partial: true,
  ScanStoppedReason: "max_items",
  LastReadItemId: 202,
  Levels: [
    {
      SourceKind: "link",
      DocumentKey: "standalone:linked-doc",
      DocumentSessionId: "session-linked-doc",
      LevelId: 201,
      LevelUniqueId: "level-201",
      Name: "2FL",
      SourceProjectElevationMm: 4900,
      SourceProjectElevationFrame: "linked_document_internal_mm",
      HostElevationMm: 5000,
      HostElevationFrame: "host_internal_mm",
      HostElevationTransformBasis: "revit_link_instance_get_transform_source_origin_project_elevation_point",
      LinkInstanceId: 91,
      LinkInstanceUniqueId: "link-a",
      LinkedSourceLevelSelector: {
        LinkInstanceUniqueId: "link-a",
        LevelId: 201,
        LevelUniqueId: "level-201",
        LevelName: "2FL",
      },
    },
    {
      SourceKind: "link",
      DocumentKey: "standalone:linked-doc",
      DocumentSessionId: "session-linked-doc",
      LevelId: 202,
      LevelUniqueId: "level-202",
      Name: "2FL",
      SourceProjectElevationMm: 5100,
      SourceProjectElevationFrame: "linked_document_internal_mm",
      HostElevationMm: 5200,
      HostElevationFrame: "host_internal_mm",
      HostElevationTransformBasis: "revit_link_instance_get_transform_source_origin_project_elevation_point",
      LinkInstanceId: 91,
      LinkInstanceUniqueId: "link-a",
      LinkedSourceLevelSelector: {
        LinkInstanceUniqueId: "link-a",
        LevelId: 202,
        LevelUniqueId: "level-202",
        LevelName: "2FL",
      },
    },
  ],
}, inspectLevelsParams, 12);
assert.equal(normalizedInspectLevels.action, "inspect_levels");
assert.equal(normalizedInspectLevels.partial, true);
assert.equal(normalizedInspectLevels.scanStoppedReason, "max_items");
assert.equal(normalizedInspectLevels.levels.length, 2);
assert.equal(normalizedInspectLevels.levels[0].sourceKind, "link");
assert.equal(normalizedInspectLevels.levels[0].documentKey, "standalone:linked-doc");
assert.equal(normalizedInspectLevels.levels[0].hostElevationMm, 5000);
assert.equal(normalizedInspectLevels.levels[0].sourceProjectElevationMm, 4900);
assert.deepEqual(normalizedInspectLevels.levels[0].linkedSourceLevelSelector, {
  linkInstanceUniqueId: "link-a",
  levelId: 201,
  levelUniqueId: "level-201",
  levelName: "2FL",
});
assert.equal(normalizedInspectLevels.evidenceRows.length, 2);
assert.equal(normalizedInspectLevels.summary.matchedLevelCount, 3);
assert.equal(normalizedInspectLevels.summary.unavailableSourceCount, 0);
assert.equal(normalizedInspectLevels.lastReadItemId, 202);
assert.equal("Levels" in normalizedInspectLevels, false);
const unavailableInspectLevels = normalizeInspectLevelsResult({
  Success: true,
  Guarded: false,
  State: "completed",
  Action: "inspect_levels",
  SourceScope: "linkedOnly",
  UnavailableSourceCount: 1,
  Levels: [],
  Warnings: ["Selected link is unloaded."],
}, { sourceScope: "linkedOnly" }, 4);
assert.equal(unavailableInspectLevels.success, true);
assert.equal(unavailableInspectLevels.state, "completed");
assert.equal(unavailableInspectLevels.partial, true);
assert.equal(unavailableInspectLevels.scanStoppedReason, "read_failed");
assert.equal(unavailableInspectLevels.summary.unavailableSourceCount, 1);

const captureSpatialTool = tools.get("capture_spatial_snapshot");
assert.match(captureSpatialTool.description, /SPATIAL_CAPTURE_READ_ONLY/);
assert.match(captureSpatialTool.description, /stages every page/);
assert.match(captureSpatialTool.description, /atomic commit/);
assert.match(captureSpatialTool.description, /mixed revisions never commit/);
for (const field of [
  "levelIds",
  "levelNames",
  "sourceScope",
  "linkedSourceLevels",
  "linkedSourceLevelNames",
  "pageTargetBytes",
  "maxElements",
  "maxElapsedMs",
  "maxCaptureElapsedMs",
]) {
  assert.equal(field in captureSpatialTool.schema, true, `capture_spatial_snapshot is missing ${field}.`);
}
const querySpatialTool = tools.get("query_spatial_context");
assert.match(querySpatialTool.description, /SPATIAL_QUERY_READ_ONLY/);
assert.match(querySpatialTool.description, /never a live clash or clearance verdict/i);
for (const field of ["snapshotId", "mode", "filters", "operation", "cursor"]) {
  assert.equal(field in querySpatialTool.schema, true, `query_spatial_context is missing ${field}.`);
}
const compareSpatialTool = tools.get("compare_spatial_snapshots");
assert.match(compareSpatialTool.description, /SPATIAL_DIFF_READ_ONLY/);
for (const field of ["baseSnapshotId", "headSnapshotId", "allowLegacyV02", "maxChanges"]) {
  assert.equal(field in compareSpatialTool.schema, true, `compare_spatial_snapshots is missing ${field}.`);
}
const summarizeSpatialTool = tools.get("summarize_spatial_state");
assert.match(summarizeSpatialTool.description, /SPATIAL_SUMMARY_ADVISORY_READ_ONLY/);
assert.match(summarizeSpatialTool.description, /quotableAsVerification=false/);
for (const field of ["snapshotId", "filters", "maxNodes", "maxLevels"]) {
  assert.equal(field in summarizeSpatialTool.schema, true, `summarize_spatial_state is missing ${field}.`);
}
const spatialPolicy = resolveSpatialCapturePolicy({});
assert.equal(spatialPolicy.pageTargetBytes, 4 * 1024 * 1024);
assert.equal(spatialPolicy.maxElements, 5000);
assert.equal(spatialPolicy.maxElapsedMs, 1800);
assert.equal(spatialPolicy.maxCaptureElapsedMs, 45000);
const spatialParams = buildSpatialCaptureParams({
  levelIds: [9, "9", 3],
  levelNames: ["Level 2", "Level 2"],
  linkedSourceLevels: [
    { linkInstanceUniqueId: "link-b", levelUniqueId: "level-2", levelName: "2FL" },
    { linkInstanceUniqueId: "link-a", levelId: "22", levelName: "2FL" },
    { linkInstanceUniqueId: "link-a", levelId: 22, levelName: "2FL" },
  ],
  linkedSourceLevelNames: ["2FL", "2FL"],
});
assert.deepEqual(spatialParams.levelIds, [3, 9]);
assert.deepEqual(spatialParams.levelNames, ["Level 2"]);
assert.deepEqual(spatialParams.linkedSourceLevels, [
  { linkInstanceUniqueId: "link-a", levelId: 22, levelUniqueId: null, levelName: "2FL" },
  { linkInstanceUniqueId: "link-b", levelId: null, levelUniqueId: "level-2", levelName: "2FL" },
]);
assert.deepEqual(spatialParams.linkedSourceLevelNames, ["2FL"]);
assert.equal("cursor" in spatialParams, false, "Phase 1a runtime orchestration must own native continuation cursors.");
assert.equal(spatialParams.suppressTaskStatusWindow, true, "Paged spatial capture must not block continuation on a per-page Revit status window.");
const canonicalJson = (value) => {
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error("Spatial canonical JSON rejects non-finite numbers.");
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
};
const canonicalSha256 = (value) => `sha256:${crypto.createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
const semanticCanonicalJson = (value) => {
  if (value === null) return "null";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Semantic spatial JSON cannot contain a non-finite number.");
    const normalized = Object.is(value, -0) ? 0 : value;
    const bytes = new ArrayBuffer(8);
    const view = new DataView(bytes);
    view.setFloat64(0, normalized, false);
    return JSON.stringify(`n:${view.getBigUint64(0, false).toString(16).padStart(16, "0")}`);
  }
  if (typeof value === "string") return JSON.stringify(`s:${value}`);
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(semanticCanonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${semanticCanonicalJson(value[key])}`).join(",")}}`;
};
const semanticCanonicalSha256 = (value) => `sha256:${crypto.createHash("sha256").update(semanticCanonicalJson(value), "utf8").digest("hex")}`;
assert.equal(canonicalJson({ integralDouble: 1.0, negativeZero: -0.0, oneMicro: 0.000001, tiny: 1e-7, large: 1e20, huge: 1e21 }), "{\"huge\":1e+21,\"integralDouble\":1,\"large\":100000000000000000000,\"negativeZero\":0,\"oneMicro\":0.000001,\"tiny\":1e-7}");
assert.throws(() => canonicalJson(Number.NaN), /non-finite/);
assert.throws(() => canonicalJson(Number.NEGATIVE_INFINITY), /non-finite/);
const spatialFixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "spatial", "double-placed-link.golden.json"), "utf8"));
const fixturePage = spatialFixture.pages[0];
const fixtureSnapshot = spatialFixture.snapshot;
const nativeNodes = fixturePage.rows.map((row) => ({
  nodeId: row.node.nodeId,
  nodeKind: row.node.nodeKind,
  nodeRef: row.node,
  elementRef: row.node.elementRef,
  sourceRefs: row.node.sourceRefs,
  category: row.category,
  builtInCategory: "OST_Rooms",
  categoryRole: "spatial",
  name: row.elementName,
  familyName: "",
  typeName: "Room",
  levelRef: { sourceLevelId: 2001, sourceLevelName: "Level 02" },
  geometry: {
    coordinateFrame: "host_internal_mm",
    lengthUnit: "mm",
    aabb: {
      min: row.hostPointMm.map((value) => value - 10),
      max: row.hostPointMm.map((value) => value + 10),
    },
    centerline: null,
    pointLocation: { point: row.hostPointMm, rotationRadians: 0 },
    boundaryLoops: [],
    basis: "revit_element_aabb",
    precisionClass: "aabb_only",
    verdictCapability: "context_only",
    geometryFingerprint: canonicalSha256(row.hostPointMm),
  },
}));
const nativeRows = fixturePage.rows.map((row, index) => ({ orderKey: row.orderKey, node: nativeNodes[index] }));
const pagePayloadBytes = Buffer.byteLength(semanticCanonicalJson(nativeRows), "utf8");
const nativePageHash = semanticCanonicalSha256({
  captureId: spatialFixture.captureId,
  pageOrdinal: 0,
  priorPageHash: null,
  rows: nativeRows,
});
const nativeSpatialPage = {
  resultContractVersion: 2,
  success: true,
  guarded: false,
  state: "completed",
  action: "extract_spatial_snapshot",
  reason: null,
  message: "A bounded Phase 0 spatial extraction page was produced with explicit continuation/partial state.",
  error: null,
  schemaVersion: "0.1",
  coordinateFrame: "host_internal_mm",
  lengthUnit: "mm",
  extractorVersion: "phase0-spike/0.1.0",
  captureId: spatialFixture.captureId,
  snapshotId: spatialFixture.captureId,
  capturedAt: fixtureSnapshot.capturedAt,
  scope: {
    ...fixtureSnapshot.scope,
    sourceDocumentPolicy: "host_and_loaded_links",
    phaseSelectionPolicy: "collector_unfiltered_phase0",
    designOptionsInEffect: ["collector_default_phase0"],
    worksetVisibilityPolicy: "collector_unfiltered_phase0",
    effectiveVerticalBands: [{
      levelId: 2001,
      levelUniqueId: fixtureSnapshot.scope.requestedLevelUniqueIds[0],
      levelName: "Level 02",
      elevationMm: 0,
      minHostZMm: -1000,
      maxHostZMm: 6000,
    }],
  },
  effectiveSourcePolicy: {
    requestedSourceScope: "hostAndLinked",
    sourceDocumentPolicy: "host_and_loaded_links",
    includeHostMep: true,
    includeRoomsSpaces: true,
    includeLinkedObstructions: true,
    selectedLinkCount: 3,
    loadedSelectedLinkCount: 3,
    effectiveSourceCount: fixtureSnapshot.sourceRevisions.length,
    effectiveCategories: ["OST_DuctCurves", "OST_Rooms", "OST_StructuralColumns"],
    effectiveSources: fixtureSnapshot.sourceRevisions.map((revision) => ({
      documentKey: revision.documentKey,
      sourceKind: revision.linkInstanceUniqueId ? "link" : "host",
      linkPlacementKey: revision.linkInstanceUniqueId ?? "host",
      categories: revision.linkInstanceUniqueId
        ? [revision.documentKey.includes("structure") ? "OST_StructuralColumns" : "OST_Rooms"]
        : ["OST_DuctCurves"],
    })),
    hasEffectiveExtractionPolicy: true,
  },
  scopeFingerprint: fixtureSnapshot.scopeFingerprint,
  revisionFingerprint: fixtureSnapshot.revisionFingerprint,
  sourceRevisions: fixtureSnapshot.sourceRevisions.map((revision) => ({
    ...revision,
    changeSequence: 0,
    changeSequenceState: "unknown_phase0_sentinel",
  })),
  counts: fixtureSnapshot.counts,
  liveness: "unknown",
  atomic: false,
  revisionBasisCaveat: "Phase 0 is non-atomic and cannot make current-state claims.",
  nodes: nativeNodes,
  omissions: [],
  coverage: {
    sourceCount: fixtureSnapshot.sourceRevisions.length,
    effectiveScope: true,
    selectionComplete: true,
    selectedLinkCount: 3,
    loadedLinkCount: 3,
    unloadedLinkCount: 0,
    scannedElementCount: fixtureSnapshot.counts.totalNodes,
    filteredOutOfScopeCount: 0,
    sourceAvailabilityOmissionCount: 0,
    totalOrderedRowCount: fixtureSnapshot.counts.totalNodes,
    pageNodeCount: nativeNodes.length,
    pageOmissionCount: 0,
    eligibleByCategory: { Rooms: 2, Ducts: 1, "Structural Columns": 1 },
    extractedByCategory: { Rooms: 2, Ducts: 1, "Structural Columns": 1 },
    omittedByClassification: {},
    sourceOmittedByClassification: {},
    classifiedOmissionCount: 0,
    allEligibleOmissionsClassified: true,
    extractionCoverageRatio: 1,
    phase0TargetAtLeast0_995: true,
    complete: false,
  },
  transformValidation: {
    transformCount: fixtureSnapshot.sourceRevisions.length,
    validatedCount: fixtureSnapshot.sourceRevisions.length,
    failedCount: 0,
    maxRoundTripErrorMm: 0,
    allWithin0_5mm: true,
  },
  page: {
    ordinal: 0,
    targetBytes: 4 * 1024 * 1024,
    payloadBytes: pagePayloadBytes,
    recordCount: nativeNodes.length,
    rowCount: nativeRows.length,
    nodeCount: nativeNodes.length,
    omissionCount: 0,
    hasMore: true,
    pageSha256: nativePageHash,
    pageHash: nativePageHash,
    priorPageSha256: null,
    priorPageHash: null,
    firstSortPosition: canonicalJson(nativeRows[0].orderKey),
    lastSortPosition: canonicalJson(nativeRows.at(-1).orderKey),
    nextCursor: fixturePage.nextCursor,
    rows: nativeRows,
  },
  pageCount: fixtureSnapshot.pageCount,
  payloadBytes: fixtureSnapshot.payloadBytes,
  nextCursor: fixturePage.nextCursor,
  partial: true,
  coverageStatus: "complete",
  scanStoppedReason: "max_bytes",
  scanPolicy: {
    levelScopeRequired: true,
    maxElements: 5000,
    maxElapsedMs: 4500,
    pageTargetBytes: 4 * 1024 * 1024,
    pagePayloadBasis: "canonical_ieee754_rows_utf8_v1",
    hardPageCap: true,
    maxGeometryPointsPerElement: 8192,
    maxBoundarySegmentsPerElement: 2048,
    ordering: ["documentKey", "linkPlacement", "nodeKind", "stableSourceIdentity"],
    selectionAndFilteringBeforeMaxElements: true,
    coordinateFrame: "host_internal_mm",
    cursorVersion: "0.1",
    cursorIntegrity: "hmac_sha256_process_session",
    cursorInvalidAfterRestart: true,
    readOnly: true,
    transactionOpened: false,
  },
  suggestedNextScopes: ["cursor"],
  elapsedMs: 50,
  lastReadDocumentKey: nativeRows.at(-1).orderKey.documentKey,
  lastReadLinkInstanceUniqueId: nativeRows.at(-1).orderKey.linkPlacementKey,
  lastReadNodeKind: nativeRows.at(-1).orderKey.nodeKind,
  lastReadItemId: nativeNodes.at(-1).elementRef.elementId,
  warnings: [],
  notices: ["Phase 0 non-atomic extraction."],
};
const normalizedSpatialPage = normalizeSpatialPage(nativeSpatialPage);
assert.equal(normalizedSpatialPage.valid, true, normalizedSpatialPage.errors.join("; "));
assert.equal(normalizedSpatialPage.payload.pageHash, nativePageHash);
assert.equal(normalizedSpatialPage.payload.snapshot.snapshotId, spatialFixture.captureId);
assert.equal(normalizedSpatialPage.payload.payloadBytes, fixtureSnapshot.payloadBytes, "Logical capture payloadBytes must be preserved.");
assert.equal(normalizedSpatialPage.payload.pagePayloadBytes, pagePayloadBytes);
assert.equal(normalizedSpatialPage.payload.coverageStatus, "complete");
assert.equal(normalizedSpatialPage.payload.snapshot.coverageStatus, "complete");
assert.deepEqual(normalizedSpatialPage.payload.page.rows, nativeRows, "Exact native hash rows must remain visible without aggregation.");
assert.deepEqual(
  Object.keys(normalizedSpatialPage.payload.snapshot).sort(),
  [
    "capturedAt",
    "coordinateFrame",
    "counts",
    "coverageStatus",
    "extractorVersion",
    "lengthUnit",
    "pageCount",
    "partial",
    "payloadBytes",
    "revisionFingerprint",
    "scanStoppedReason",
    "schemaVersion",
    "scope",
    "scopeFingerprint",
    "snapshotId",
    "sourceRevisions",
    "suggestedNextScopes",
  ].sort(),
  "Normalized pages must expose an exact SpatialSnapshot v0.1 contract view.",
);

const phase1aNativeSpatialPage = structuredClone(nativeSpatialPage);
phase1aNativeSpatialPage.schemaVersion = "0.2";
phase1aNativeSpatialPage.extractorVersion = "phase1a-native/0.2";
phase1aNativeSpatialPage.liveness = "staging";
phase1aNativeSpatialPage.atomic = false;
phase1aNativeSpatialPage.captureConsistency = "document_change_sequence_bound";
phase1aNativeSpatialPage.continuationKind = null;
phase1aNativeSpatialPage.sourceBindingFingerprint = `sha256:${"9".repeat(64)}`;
phase1aNativeSpatialPage.preparation = null;
phase1aNativeSpatialPage.revisionBasisCaveat = "Native pages are sequence-bound staging inputs; only the runtime store commit is atomic.";
phase1aNativeSpatialPage.sourceRevisions = phase1aNativeSpatialPage.sourceRevisions.map((revision, index) => ({
  ...revision,
  changeSequence: index + 7,
  changeSequenceState: "tracked",
  oldestRetainedSequence: Math.max(0, index + 6),
  trackerSessionId: "tracker-session-1",
  journalEntryCount: index + 7,
  journalCapacity: 512,
  journalTruncated: false,
}));
phase1aNativeSpatialPage.counts.connectorOmissionsByReason = {};
phase1aNativeSpatialPage.coverage.connectorOmittedByClassification = {};
phase1aNativeSpatialPage.coverage.unmaterializedOmissionCount = 0;
phase1aNativeSpatialPage.coverage.unmaterializedOmissionsByClassification = {};
phase1aNativeSpatialPage.scanPolicy.maxElapsedMs = 1800;
phase1aNativeSpatialPage.scanPolicy.cursorVersion = "0.2";
phase1aNativeSpatialPage.scanPolicy.sequenceBound = true;
phase1aNativeSpatialPage.scanPolicy.maxUiOccupancyMs = 5000;
const normalizedPhase1aPage = normalizeSpatialPage(phase1aNativeSpatialPage);
assert.equal(normalizedPhase1aPage.valid, true, normalizedPhase1aPage.errors.join("; "));
assert.equal(normalizedPhase1aPage.payload.schemaVersion, "0.2");
assert.equal(normalizedPhase1aPage.payload.liveness, "staging");
assert.equal(normalizedPhase1aPage.payload.contractValidation.version, "spatial-extraction-page.v0.2");

const strictAtomicPage = structuredClone(phase1aNativeSpatialPage);
strictAtomicPage.schemaVersion = "0.3";
strictAtomicPage.extractorVersion = "phase1b-native/0.3";
const strictAtomicNodesById = new Map(strictAtomicPage.nodes.map((node) => [node.nodeId, node]));
for (const node of strictAtomicPage.nodes) {
  node.spatialProperties = { systemKey: null, systemName: null, systemClassification: null };
  node.profile = { shape: "unknown", diameterMm: null, widthMm: null, heightMm: null, insulationThicknessMm: null };
  node.fingerprints = {
    version: "phase1b-spatial-fingerprint/1.0",
    placement: canonicalSha256({ nodeId: node.nodeId, kind: "placement" }),
    shape: canonicalSha256({ nodeId: node.nodeId, kind: "shape" }),
    property: canonicalSha256({ nodeId: node.nodeId, kind: "property" }),
    topology: canonicalSha256({ nodeId: node.nodeId, kind: "topology" }),
  };
}
for (const row of strictAtomicPage.page.rows) {
  row.node = strictAtomicNodesById.get(row.node.nodeId);
}
strictAtomicPage.page.hasMore = false;
strictAtomicPage.page.nextCursor = null;
strictAtomicPage.nextCursor = null;
strictAtomicPage.pageCount = 1;
strictAtomicPage.payloadBytes = strictAtomicPage.page.payloadBytes;
strictAtomicPage.partial = false;
strictAtomicPage.coverage.complete = true;
strictAtomicPage.coverage.totalOrderedRowCount = strictAtomicPage.nodes.length;
strictAtomicPage.counts = {
  ...strictAtomicPage.counts,
  totalNodes: strictAtomicPage.nodes.length,
  nodesByKind: { revit_element: strictAtomicPage.nodes.length, connector: 0, derived: 0 },
  expectedSupportedNodes: strictAtomicPage.nodes.length,
  extractedSupportedNodes: strictAtomicPage.nodes.length,
};
strictAtomicPage.page.payloadBytes = Buffer.byteLength(semanticCanonicalJson(strictAtomicPage.page.rows), "utf8");
strictAtomicPage.page.pageSha256 = semanticCanonicalSha256({
  captureId: strictAtomicPage.captureId,
  pageOrdinal: 0,
  priorPageHash: null,
  rows: strictAtomicPage.page.rows,
});
strictAtomicPage.page.pageHash = strictAtomicPage.page.pageSha256;
strictAtomicPage.payloadBytes = strictAtomicPage.page.payloadBytes;
strictAtomicPage.scanStoppedReason = "completed";
strictAtomicPage.suggestedNextScopes = [];
const strictAtomicValidation = normalizeSpatialPage(strictAtomicPage);
assert.equal(strictAtomicValidation.valid, true, strictAtomicValidation.errors.join("; "));
const strictAtomicRoot = fs.mkdtempSync(path.join(os.tmpdir(), "revagent-spatial-strict-atomic-"));
const strictAtomicStore = new SpatialStore({
  databasePath: path.join(strictAtomicRoot, "spatial.db"),
  retentionPolicy: false,
});
try {
  const strictAtomicResult = await captureSpatialSnapshotAtomic({
    nativeParams: {},
    scanPolicy: { pageTargetBytes: 4 * 1024 * 1024, maxElements: 5000, maxElapsedMs: 1800 },
  }, {
    store: strictAtomicStore,
    sendPage: async () => strictAtomicPage,
  });
  assert.equal(strictAtomicResult.committed, true, strictAtomicResult.error);
  assert.equal(strictAtomicResult.liveness, "unknown");
  assert.equal(strictAtomicStore.getSnapshot(strictAtomicResult.snapshotId).nodeCount, strictAtomicPage.nodes.length);
} finally {
  strictAtomicStore.close();
  fs.rmSync(strictAtomicRoot, { recursive: true, force: true });
}

const legacySpatialCoveragePage = structuredClone(nativeSpatialPage);
delete legacySpatialCoveragePage.coverageStatus;
legacySpatialCoveragePage.counts.omittedSupportedNodes = 1;
legacySpatialCoveragePage.counts.expectedSupportedNodes += 1;
legacySpatialCoveragePage.page.hasMore = false;
legacySpatialCoveragePage.page.nextCursor = null;
legacySpatialCoveragePage.nextCursor = null;
legacySpatialCoveragePage.suggestedNextScopes = [];
legacySpatialCoveragePage.scanStoppedReason = "read_failed";
const legacySpatialCoverageResult = normalizeSpatialPage(legacySpatialCoveragePage);
assert.equal(legacySpatialCoverageResult.valid, true, legacySpatialCoverageResult.errors.join("; "));
assert.equal(legacySpatialCoverageResult.payload.coverageStatus, "incomplete_omissions");

const legacySpatialBudgetPage = structuredClone(nativeSpatialPage);
delete legacySpatialBudgetPage.coverageStatus;
legacySpatialBudgetPage.scanStoppedReason = "max_items";
const legacySpatialBudgetResult = normalizeSpatialPage(legacySpatialBudgetPage);
assert.equal(legacySpatialBudgetResult.valid, true, legacySpatialBudgetResult.errors.join("; "));
assert.equal(legacySpatialBudgetResult.payload.coverageStatus, "incomplete_budget");

const conflictingSpatialCoveragePage = structuredClone(nativeSpatialPage);
conflictingSpatialCoveragePage.coverageStatus = "incomplete_omissions";
const conflictingSpatialCoverageResult = normalizeSpatialPage(conflictingSpatialCoveragePage);
assert.equal(conflictingSpatialCoverageResult.valid, false);
assert.match(conflictingSpatialCoverageResult.errors.join("; "), /coverageStatus conflicts/);

const invalidPaginatedOmissionPage = structuredClone(nativeSpatialPage);
delete invalidPaginatedOmissionPage.coverageStatus;
invalidPaginatedOmissionPage.counts.omittedSupportedNodes = 1;
invalidPaginatedOmissionPage.counts.expectedSupportedNodes += 1;
invalidPaginatedOmissionPage.scanStoppedReason = "read_failed";
const invalidPaginatedOmissionResult = normalizeSpatialPage(invalidPaginatedOmissionPage);
assert.equal(invalidPaginatedOmissionResult.valid, false);
assert.match(invalidPaginatedOmissionResult.errors.join("; "), /scanStoppedReason conflicts/);

const invalidCompletedPartialPage = structuredClone(nativeSpatialPage);
invalidCompletedPartialPage.page.hasMore = false;
invalidCompletedPartialPage.page.nextCursor = null;
invalidCompletedPartialPage.nextCursor = null;
invalidCompletedPartialPage.partial = true;
invalidCompletedPartialPage.scanStoppedReason = "completed";
invalidCompletedPartialPage.suggestedNextScopes = [];
const invalidCompletedPartialResult = normalizeSpatialPage(invalidCompletedPartialPage);
assert.equal(invalidCompletedPartialResult.valid, false);
assert.match(invalidCompletedPartialResult.errors.join("; "), /partial conflicts/);

const invalidSpatialRevisionPage = structuredClone(nativeSpatialPage);
invalidSpatialRevisionPage.sourceRevisions = [];
const invalidSpatialRevisionResult = normalizeSpatialPage(invalidSpatialRevisionPage);
assert.equal(invalidSpatialRevisionResult.valid, false);
assert.match(invalidSpatialRevisionResult.errors.join("; "), /sourceRevisions/);

const invalidSpatialHashPage = structuredClone(nativeSpatialPage);
invalidSpatialHashPage.page.pageHash = `sha256:${"f".repeat(64)}`;
invalidSpatialHashPage.page.pageSha256 = invalidSpatialHashPage.page.pageHash;
const invalidSpatialHashResult = normalizeSpatialPage(invalidSpatialHashPage);
assert.equal(invalidSpatialHashResult.valid, false);
assert.match(invalidSpatialHashResult.errors.join("; "), /canonical extraction-row envelope hash/);

const invalidSpatialCountPage = structuredClone(nativeSpatialPage);
invalidSpatialCountPage.page.omissionCount = 1;
const invalidSpatialCountResult = normalizeSpatialPage(invalidSpatialCountPage);
assert.equal(invalidSpatialCountResult.valid, false);
assert.match(invalidSpatialCountResult.errors.join("; "), /omissionCount/);

const create3dDescription = tools.get("create_3d_view_for_elements").description;
const showPlan3dDescription = tools.get("show_element_in_plan_and_3d").description;
const coordinationDescription = tools.get("export_revit_coordination_image").description;
const clearSelectionDescription = tools.get("clear_selection").description;
const deleteReviewViewDescription = tools.get("delete_review_view").description;
assert.match(create3dDescription, /LIVE_VIEW_NAVIGATION_PRIMITIVE/);
assert.match(showPlan3dDescription, /LIVE_VIEW_WORKFLOW_WRAPPER/);
assert.match(coordinationDescription, /VISUAL_ARTIFACT_EXPORT_ONLY/);
assert.match(coordinationDescription, /Do not use this as the primary tool for live view navigation/);
assert.match(coordinationDescription, /Use qa_high_contrast explicitly/);
assert.match(clearSelectionDescription, /LIVE_UI_SELECTION_CLEANUP/);
assert.match(clearSelectionDescription, /does not modify model elements/);
assert.match(deleteReviewViewDescription, /REVIEW_VIEW_CLEANUP_GUARDED/);
assert.match(deleteReviewViewDescription, /mode="commit"/);
assert.equal("confirmDelete" in tools.get("delete_review_view").schema, true);
assert.equal("responseMode" in tools.get("delete_review_view").schema, true);
const setParameterDescription = tools.get("set_element_parameter").description;
assert.match(setParameterDescription, /PRODUCTION_PARAMETER_WRITE/);
assert.match(setParameterDescription, /Never writes by visible display name alone/);
assert.match(setParameterDescription, /clearVisibleValue/);
assert.match(setParameterDescription, /Defaults to dryRun/);
assert.equal("operation" in tools.get("set_element_parameter").schema, true);
const findElementsDescription = tools.get("find_elements").description;
assert.match(findElementsDescription, /MEP-aware progressive discovery/);
assert.match(findElementsDescription, /fan coil\/FCU -> Mechanical Equipment/);
assert.match(findElementsDescription, /allowExpensiveSearch/);
assert.match(findElementsDescription, /responseMode=compact/);
const findElementsSchema = tools.get("find_elements").schema;
assert.equal("responseMode" in findElementsSchema, true);
assert.equal("maxResultRows" in findElementsSchema, true);
const inspectSchedulesDescription = tools.get("inspect_schedules").description;
assert.match(inspectSchedulesDescription, /SCHEDULE_INSPECTION_READ_ONLY/);
assert.match(inspectSchedulesDescription, /large models/);
assert.match(inspectSchedulesDescription, /allowExpensiveSearch=true/);
assert.match(inspectSchedulesDescription, /generic send_code_to_revit/);
assert.match(inspectSchedulesDescription, /responseMode=compact/);
const inspectSchedulesSchema = tools.get("inspect_schedules").schema;
assert.equal("maxElapsedMs" in inspectSchedulesSchema, true);
assert.equal("maxCells" in inspectSchedulesSchema, true);
assert.equal("maxResponseBytes" in inspectSchedulesSchema, true);
assert.equal("startRow" in inspectSchedulesSchema, true);
assert.equal("startColumn" in inspectSchedulesSchema, true);
assert.equal("responseMode" in inspectSchedulesSchema, true);
assert.equal("maxResultRows" in inspectSchedulesSchema, true);
assert.equal("maxEvidenceRows" in inspectSchedulesSchema, true);
const reconcileScheduleExcelDescription = tools.get("reconcile_schedule_excel").description;
assert.match(reconcileScheduleExcelDescription, /SCHEDULE_EXCEL_RECONCILIATION_REVIEW_ONLY/);
assert.match(reconcileScheduleExcelDescription, /Review-first\/write-free/);
assert.match(reconcileScheduleExcelDescription, /Default responseMode=compact returns summary, reviewTable, evidenceRows/);
assert.match(reconcileScheduleExcelDescription, /responseMode=full\/debug for reviewRows/);
assert.match(reconcileScheduleExcelDescription, /Does not write Revit or workbook data/);
assert.match(reconcileScheduleExcelDescription, /columnMapping\.identity/);
const reconcileScheduleExcelSchema = tools.get("reconcile_schedule_excel").schema;
assert.equal("excel" in reconcileScheduleExcelSchema, true);
assert.equal("schedule" in reconcileScheduleExcelSchema, true);
assert.equal("config" in reconcileScheduleExcelSchema, true);
assert.equal("responseMode" in reconcileScheduleExcelSchema, true);
assert.equal("maxReviewRows" in reconcileScheduleExcelSchema, true);
assert.equal("maxCandidateRows" in reconcileScheduleExcelSchema, true);
const inspectSheetTextDescription = tools.get("inspect_sheet_text").description;
assert.match(inspectSheetTextDescription, /SHEET_TEXT_INSPECTION_READ_ONLY/);
assert.match(inspectSheetTextDescription, /DrawingSheet/);
assert.match(inspectSheetTextDescription, /viewport annotation/);
assert.match(inspectSheetTextDescription, /sheet text lookup/);
assert.match(inspectSheetTextDescription, /titleblock\/revision evidence/);
assert.match(inspectSheetTextDescription, /placed schedule cells/);
assert.match(inspectSheetTextDescription, /allowExpensiveSearch=true/);
assert.match(inspectSheetTextDescription, /generic send_code_to_revit/);
const inspectSheetTextSchema = tools.get("inspect_sheet_text").schema;
assert.equal("includeViewportTextNotes" in inspectSheetTextSchema, true);
assert.equal("includeViewportTags" in inspectSheetTextSchema, true);
assert.equal("viewNameQuery" in inspectSheetTextSchema, true);
assert.equal("maxTags" in inspectSheetTextSchema, true);
assert.equal("maxViewports" in inspectSheetTextSchema, true);
assert.equal("maxElapsedMs" in inspectSheetTextSchema, true);
assert.equal("maxResponseBytes" in inspectSheetTextSchema, true);
const countAnnotationsDescription = tools.get("count_annotations").description;
assert.match(countAnnotationsDescription, /ANNOTATION_COUNT_READ_ONLY/);
assert.match(countAnnotationsDescription, /sheetQuery\/sheetIds/);
assert.match(countAnnotationsDescription, /viewport text notes/);
assert.match(countAnnotationsDescription, /placed schedule cells/);
assert.match(countAnnotationsDescription, /uniqueTaggedElement/);
assert.match(countAnnotationsDescription, /allowExpensiveSearch=true/);
const countAnnotationsSchema = tools.get("count_annotations").schema;
assert.equal("profiles" in countAnnotationsSchema, true);
assert.equal("countMode" in countAnnotationsSchema, true);
assert.equal("groupBy" in countAnnotationsSchema, true);
assert.equal("regexTimeoutMs" in countAnnotationsSchema, true);
assert.equal("maxScheduleCellsScanned" in countAnnotationsSchema, true);
assert.equal("maxResponseBytes" in countAnnotationsSchema, true);
const setScheduleCellsDescription = tools.get("set_schedule_cells").description;
assert.match(setScheduleCellsDescription, /PRODUCTION_SCHEDULE_CELL_WRITE/);
assert.match(setScheduleCellsDescription, /scheduleId/);
assert.match(setScheduleCellsDescription, /Defaults to dryRun/);
const setScheduleCellsByTextDescription = tools.get("set_schedule_cells_by_text").description;
assert.match(setScheduleCellsByTextDescription, /PRODUCTION_SCHEDULE_CELL_WRITE_BY_TEXT/);
assert.match(setScheduleCellsByTextDescription, /row text/);
assert.match(setScheduleCellsByTextDescription, /generic send_code_to_revit/);
const setScheduleCellsByTextSchema = tools.get("set_schedule_cells_by_text").schema;
assert.equal("responseMode" in setScheduleCellsByTextSchema, true);
assert.equal("maxResultRows" in setScheduleCellsByTextSchema, true);

const autoStyleExpectations = {
  raw_evidence: "raw",
  coordination_overlay: "outline_only",
  system_focus: "technical_report",
  clash_clearance: "technical_report",
};
for (const [intent, expectedStyle] of Object.entries(autoStyleExpectations)) {
  const resolvedStyle = resolveAutoTargetVisualStyle(intent);
  assert.equal(resolvedStyle, expectedStyle);
  assert.notEqual(resolvedStyle, "qa_high_contrast");
}

const chooseExpectedToolForIntent = (utterance) => {
  const text = utterance.toLocaleLowerCase("tr-TR");
  if (/(png|jpeg|jpg|export|çıktı|görsel|rapor|evidence)/.test(text)) {
    return "export_revit_coordination_image";
  }
  if (/(plan).*(3d)|(3d).*(plan)/.test(text)) {
    return "show_element_in_plan_and_3d";
  }
  if (/(3d|yakından|zoom|seç|göster|ekranda|aç)/.test(text)) {
    return "create_3d_view_for_elements";
  }
  return null;
};
assert.equal(
  chooseExpectedToolForIntent("seçili elemanı yeni 3D'de açıp zoomla"),
  "create_3d_view_for_elements",
);
assert.notEqual(
  chooseExpectedToolForIntent("seçili elemanı yeni 3D'de açıp zoomla"),
  "export_revit_coordination_image",
);
assert.equal(
  chooseExpectedToolForIntent("bu eleman için rapora PNG görsel çıktı al"),
  "export_revit_coordination_image",
);

const inferredFindPolicy = buildFindElementsSearchPolicy({ query: "MTL fan coil" });
assert.equal(inferredFindPolicy.guarded, false);
assert.equal(inferredFindPolicy.effectiveQuery, "MTL");
assert.deepEqual(inferredFindPolicy.effectiveCategoryNames, ["Mechanical Equipment"]);
assert.equal(inferredFindPolicy.searchBudget, "fast");
assert.equal(inferredFindPolicy.maxElapsedMs < inferredFindPolicy.timeoutMs, true);
assert.equal(inferredFindPolicy.riskPolicy.riskLevel, "low");
assert.equal(inferredFindPolicy.riskPolicy.requiresUserControl, false);
assert.deepEqual(inferredFindPolicy.riskPolicy.recommendedFirstScope, ["categoryNames=Mechanical Equipment"]);

const turkishTermPolicy = buildFindElementsSearchPolicy({ query: "YY01 sihhi tesisat armatür" });
assert.equal(turkishTermPolicy.guarded, false);
assert.equal(turkishTermPolicy.effectiveQuery, "YY01");
assert.deepEqual(turkishTermPolicy.effectiveCategoryNames, ["Plumbing Fixtures"]);

const turkishFoldedTermPolicy = buildFindElementsSearchPolicy({ query: "YY01 sıhhi tesisat armatür" });
assert.equal(turkishFoldedTermPolicy.guarded, false);
assert.equal(turkishFoldedTermPolicy.effectiveQuery, "YY01");
assert.deepEqual(turkishFoldedTermPolicy.effectiveCategoryNames, ["Plumbing Fixtures"]);

const compactFcuPolicy = buildFindElementsSearchPolicy({ query: "FCU01" });
assert.equal(compactFcuPolicy.guarded, false);
assert.equal(compactFcuPolicy.effectiveQuery, "FCU01");
assert.deepEqual(compactFcuPolicy.effectiveCategoryNames, ["Mechanical Equipment"]);

const compactPumpPolicy = buildFindElementsSearchPolicy({ query: "PUMP1" });
assert.equal(compactPumpPolicy.guarded, false);
assert.equal(compactPumpPolicy.effectiveQuery, "PUMP1");
assert.deepEqual(compactPumpPolicy.effectiveCategoryNames, ["Mechanical Equipment"]);

const standalonePumpPolicy = buildFindElementsSearchPolicy({ query: "pump" });
assert.equal(standalonePumpPolicy.guarded, false);
assert.equal(standalonePumpPolicy.effectiveQuery, "pump");
assert.deepEqual(standalonePumpPolicy.effectiveCategoryNames, ["Mechanical Equipment"]);

const standaloneAhuPolicy = buildFindElementsSearchPolicy({ query: "AHU" });
assert.equal(standaloneAhuPolicy.guarded, false);
assert.equal(standaloneAhuPolicy.effectiveQuery, "AHU");
assert.deepEqual(standaloneAhuPolicy.effectiveCategoryNames, ["Mechanical Equipment"]);

const explicitDuctCategoryPolicy = buildFindElementsSearchPolicy({ query: "duct", categoryNames: ["Ducts"] });
assert.equal(explicitDuctCategoryPolicy.guarded, false);
assert.equal(explicitDuctCategoryPolicy.effectiveQuery, "duct");
assert.deepEqual(explicitDuctCategoryPolicy.effectiveCategoryNames, ["Ducts"]);
assert.equal(explicitDuctCategoryPolicy.warnings.includes("explicit_category_scope_preserved_no_inferred_expansion"), true);

const valvePolicy = buildFindElementsSearchPolicy({ query: "vana" });
assert.equal(valvePolicy.guarded, false);
assert.equal(valvePolicy.effectiveQuery, "vana");
assert.deepEqual(valvePolicy.effectiveCategoryNames, ["Pipe Accessories", "Pipe Fittings"]);
assert.equal(valvePolicy.inferredScope.concepts[0].preserveQueryWhenFullyStripped, true);

const linkedUniqueIdPolicy = buildFindElementsSearchPolicy({
  uniqueIds: ["linked-element-uid"],
  linkScope: "linkedOnly",
});
assert.equal(linkedUniqueIdPolicy.guarded, false);
assert.equal(linkedUniqueIdPolicy.riskPolicy.requiresUserControl, false);
assert.equal(linkedUniqueIdPolicy.linkScope, "linkedOnly");

const linkedElementIdPolicy = buildFindElementsSearchPolicy({
  elementIds: [123],
  linkScope: "linkedOnly",
});
assert.equal(linkedElementIdPolicy.guarded, true);
assert.equal(linkedElementIdPolicy.reason, "needs_scope");

const broadFindPolicy = buildFindElementsSearchPolicy({ query: "MTL" });
assert.equal(broadFindPolicy.guarded, true);
assert.equal(broadFindPolicy.reason, "needs_scope");
assert.equal(broadFindPolicy.riskPolicy.riskLevel, "medium");
assert.equal(broadFindPolicy.riskPolicy.requiresUserControl, true);

const broadVerifiedPolicy = buildFindElementsSearchPolicy({
  query: "MTL fan coil",
  includePlanCandidates: true,
  planCandidateMode: "verified",
  modelSignals: { linkCount: 50, worksetCount: 45 },
});
assert.equal(broadVerifiedPolicy.guarded, true);
assert.equal(broadVerifiedPolicy.reason, "needs_scope");
assert.equal(broadVerifiedPolicy.riskPolicy.requiresUserControl, true);
assert.equal(broadVerifiedPolicy.riskPolicy.reasons.includes("verified_visibility_expensive"), true);
assert.equal(broadVerifiedPolicy.warnings.includes("verified_visibility_requires_exact_targets_or_approval"), true);

const exactVerifiedPolicy = buildFindElementsSearchPolicy({
  elementIds: [123],
  includePlanCandidates: true,
  planCandidateMode: "verified",
});
assert.equal(exactVerifiedPolicy.guarded, false);
assert.equal(exactVerifiedPolicy.riskPolicy.requiresUserControl, false);

const inertVerifiedModePolicy = buildFindElementsSearchPolicy({
  query: "MTL fan coil",
  planCandidateMode: "verified",
});
assert.equal(inertVerifiedModePolicy.riskPolicy.reasons.includes("verified_visibility_expensive"), false);
assert.equal(inertVerifiedModePolicy.warnings.includes("verified_visibility_requires_exact_targets_or_approval"), false);

const largeSignalPolicy = buildFindElementsSearchPolicy({
  query: "equipment tag",
  modelSignals: { linkCount: 50, worksetCount: 45 },
});
assert.equal(largeSignalPolicy.guarded, true);
assert.equal(largeSignalPolicy.riskPolicy.riskLevel, "high");
assert.equal(largeSignalPolicy.riskPolicy.reasons.includes("high_link_count"), true);
assert.equal(largeSignalPolicy.riskPolicy.reasons.includes("high_workset_count"), true);

const approvedLinkedPolicy = buildFindElementsSearchPolicy({
  query: "MTL",
  linkScope: "hostAndLinked",
  allowExpensiveSearch: true,
});
assert.equal(approvedLinkedPolicy.guarded, false);
assert.equal(approvedLinkedPolicy.riskPolicy.reasons.includes("operator_approved_expensive_search"), true);

const normalized = normalizeRevitExecutionResponse({
  result: JSON.stringify({ success: true, count: 2 }),
});
assert.equal(normalized.result.success, true);
assert.equal(normalized.result.count, 2);

const compactStatus = compactMcpStatusPayload({
  activeTask: null,
  recentTasks: [
    {
      id: "status-wrapper",
      method: "send_code_to_revit",
      wrapperAction: "set_schedule_cells_by_text",
      logicalToolName: "set_schedule_cells_by_text",
      taskName: "Wrapper status task",
      state: "completed",
    },
  ],
});
assert.equal(compactStatus.recentTasks[0].method, "set_schedule_cells_by_text");
assert.equal(compactStatus.recentTasks[0].toolName, "set_schedule_cells_by_text");
assert.equal(compactStatus.recentTasks[0].commandName, "send_code_to_revit");

const compactDelete = compactDeleteReviewViewResult({
  success: true,
  state: "completed",
  action: "delete_review_view",
  message: "Review view deleted.",
  mode: "commit",
  dryRun: false,
  changed: true,
  deleted: true,
  deletedElementCount: 10,
  confirmDelete: true,
  targetIsReviewView: true,
  reviewSignals: ["revagent_review_view_name"],
  targetView: { id: 123, name: "revAgent_QA_DELETE_TEST_386031", viewType: "ThreeD" },
}, {});
assert.equal(compactDelete.responseMode, "compact");
assert.equal("deleted" in compactDelete, false);
assert.equal("confirmDelete" in compactDelete, false);
assert.equal("targetIsReviewView" in compactDelete, false);
assert.equal(compactDelete.cleanup.deleted, true);
assert.equal(compactDelete.cleanup.confirmed, true);
assert.equal(compactDelete.cleanup.targetIsReviewView, true);

const compactDeleteConfirmFallback = compactDeleteReviewViewResult({ success: true }, { confirmDelete: true });
assert.equal(compactDeleteConfirmFallback.cleanup.confirmed, true);

const fullDelete = compactDeleteReviewViewResult({ success: true, deleted: true, confirmDelete: true }, { responseMode: "full" });
assert.equal(fullDelete.responseMode, "full");
assert.equal(fullDelete.deleted, true);
assert.equal(fullDelete.confirmDelete, true);

const navigationResult = stripViewCleanupFields({
  success: true,
  action: "activate_view",
  changed: true,
  closed: false,
  dryRun: false,
  deleted: false,
  confirmDelete: false,
  targetIsReviewView: false,
  reviewSignals: [],
  deletedElementCount: 0,
}, { stripCloseOnlyFields: true });
assert.equal(navigationResult.changed, true);
for (const key of ["closed", "dryRun", "deleted", "confirmDelete", "targetIsReviewView", "reviewSignals", "deletedElementCount"]) {
  assert.equal(key in navigationResult, false);
}

const closeViewResult = stripViewCleanupFields({
  success: true,
  action: "close_view",
  changed: true,
  closed: true,
  dryRun: false,
  deleted: false,
  confirmDelete: false,
  targetIsReviewView: false,
  reviewSignals: [],
  deletedElementCount: 0,
});
assert.equal(closeViewResult.changed, true);
assert.equal(closeViewResult.closed, true);
for (const key of ["dryRun", "deleted", "confirmDelete", "targetIsReviewView", "reviewSignals", "deletedElementCount"]) {
  assert.equal(key in closeViewResult, false);
}

const content = formatJsonContent({ success: true });
assert.equal(content.content[0].type, "text");
assert.match(content.content[0].text, /"success": true/);
assert.doesNotMatch(content.content[0].text, /"Success":/);

const successAliasContent = formatJsonContent({
  Success: true,
  nested: { success: false },
});
const successAliasPayload = JSON.parse(successAliasContent.content[0].text);
assert.equal(successAliasPayload.success, true);
assert.equal("Success" in successAliasPayload, false);
assert.equal(successAliasPayload.nested.success, false);
assert.equal("Success" in successAliasPayload.nested, false);

const contractAliasContent = formatJsonContent({
  Success: false,
  Guarded: true,
  State: "guarded",
  Action: "find_elements",
  Message: "No matching elements found.",
  Error: "guarded by safety",
  ResultContractVersion: 2,
});
const contractAliasPayload = JSON.parse(contractAliasContent.content[0].text);
assert.equal(contractAliasPayload.success, false);
assert.equal(contractAliasPayload.guarded, true);
assert.equal(contractAliasPayload.state, "guarded");
assert.equal(contractAliasPayload.action, "find_elements");
assert.equal(contractAliasPayload.message, "No matching elements found.");
assert.equal(contractAliasPayload.error, "guarded by safety");
assert.equal(contractAliasPayload.resultContractVersion, 2);
assert.equal("Success" in contractAliasPayload, false);
assert.equal("Guarded" in contractAliasPayload, false);
assert.equal("Action" in contractAliasPayload, false);
assert.equal("ResultContractVersion" in contractAliasPayload, false);

const trimmed = truncateText("abcdef", 3);
assert.equal(trimmed.truncated, true);
assert.match(trimmed.text, /truncated 3 chars/);

assert.equal(sanitizeTelemetryPathSegment("HAFIZE"), "HAFIZE");
assert.equal(sanitizeTelemetryPathSegment("MARINA"), "MARINA");
assert.equal(sanitizeTelemetryPathSegment("office machine/name"), "office_machine_name");

const telemetryParamSummary = summarizeTelemetryParams({
  code: "using (var t = new Transaction(document, \"x\")) { t.Start(); t.Commit(); }",
  elementIds: [1, 2, 3],
  transactionMode: "none",
  query: "sensitive search text",
  searchBudget: "fast",
  linkScope: "hostOnly",
});
assert.equal(telemetryParamSummary.code.lineCount, 1);
assert.equal(telemetryParamSummary.code.hasManualTransaction, true);
assert.match(telemetryParamSummary.code.preview, /Transaction/);
assert.equal(telemetryParamSummary.elementIds.count, 3);
assert.equal(telemetryParamSummary.transactionMode, "none");
assert.equal(typeof telemetryParamSummary.query.hash, "string");
assert.equal(telemetryParamSummary.query.text, "sensitive search text");
assert.equal(telemetryParamSummary.searchBudget, "fast");
assert.equal(telemetryParamSummary.linkScope, "hostOnly");

const scheduleWriteParamSummary = summarizeTelemetryParams({
  code: "TableSectionData sectionData = schedule.GetTableData().GetSectionData(SectionType.Body); sectionData.SetCellText(1, 2, \"R914X023\");",
});
assert.equal(scheduleWriteParamSummary.code.writePatterns.includes("Schedule.SetCellText"), true);

const telemetryResponseSummary = summarizeTelemetryResponse({
  result: {
    success: false,
    state: "guarded",
    error: "C:\\Projects\\Secret\\model.rvt blocked by safety",
  },
});
assert.equal(telemetryResponseSummary.success, false);
assert.equal(telemetryResponseSummary.guarded, true);
assert.match(telemetryResponseSummary.errorMessage, /Secret/);

const wrapperFailureSummary = summarizeTelemetryResponse({
  success: false,
  result: null,
  errorMessage: "Execution failed inside Revit wrapper",
});
assert.equal(wrapperFailureSummary.success, false);
assert.equal(wrapperFailureSummary.errorMessage, "Execution failed inside Revit wrapper");

const safeRejectionSummary = summarizeTelemetryResponse({
  success: false,
  error: "Rejected write-looking code for intent 'writePreview'.",
});
assert.equal(safeRejectionSummary.guarded, true);
assert.equal(safeRejectionSummary.guardSource, "runtime");

const spatialSecret = "Level 09 Room 901 element-7788 cursor-secret";
const spatialTelemetryParams = summarizeSpatialExtractionTelemetryParams({
  levelNames: [spatialSecret],
  levelIds: [7788],
  linkInstanceUniqueIds: ["link-secret"],
  linkedSourceLevels: [{ linkInstanceUniqueId: "linked-level-placement-secret", levelUniqueId: "linked-level-secret" }],
  linkedSourceLevelNames: ["linked-level-name-secret"],
  cursor: spatialSecret,
  sourceScope: "hostAndLinked",
  pageTargetBytes: 262144,
  maxElements: 5000,
  maxElapsedMs: 4500,
});
assert.equal(spatialTelemetryParams.levelNameCount, 1);
assert.equal(spatialTelemetryParams.levelIdCount, 1);
assert.equal(spatialTelemetryParams.linkInstanceSelectorCount, 1);
assert.equal(spatialTelemetryParams.linkedSourceLevelSelectorCount, 2);
assert.equal(spatialTelemetryParams.cursorPresent, true);
assert.doesNotMatch(JSON.stringify(spatialTelemetryParams), /Level 09|Room 901|7788|cursor-secret|link-secret|linked-level/);
const inspectLevelsTelemetryParams = summarizeSpatialExtractionTelemetryParams({
  sourceScope: "linkedOnly",
  linkInstanceUniqueIds: ["inspect-levels-link-secret"],
  nameQuery: "inspect-levels-name-secret",
  maxResults: 25,
}, "inspect_levels");
assert.equal(inspectLevelsTelemetryParams.linkInstanceSelectorCount, 1);
assert.equal(inspectLevelsTelemetryParams.nameQueryPresent, true);
assert.equal(inspectLevelsTelemetryParams.maxResults, 25);
assert.equal(Object.hasOwn(inspectLevelsTelemetryParams, "includeHostMep"), false);
assert.equal(Object.hasOwn(inspectLevelsTelemetryParams, "includeRoomsSpaces"), false);
assert.equal(Object.hasOwn(inspectLevelsTelemetryParams, "includeLinkedObstructions"), false);
assert.doesNotMatch(JSON.stringify(inspectLevelsTelemetryParams), /inspect-levels/);
const spatialTelemetryResponse = summarizeSpatialExtractionTelemetryResponse({
  success: true,
  guarded: false,
  state: "completed",
  action: "capture_spatial_snapshot",
  nodes: [{ nodeId: spatialSecret, roomName: spatialSecret }],
  omissions: [{ classification: spatialSecret }],
  sourceRevisions: [{ documentKey: spatialSecret }],
  page: {
    ordinal: 0,
    recordCount: 1,
    omissionCount: 1,
    payloadBytes: 900,
    hasMore: true,
    nextCursor: spatialSecret,
  },
  scanStoppedReason: "max_bytes",
  coverageStatus: "incomplete_omissions",
});
assert.equal(spatialTelemetryResponse.recordCount, 1);
assert.equal(spatialTelemetryResponse.omissionCount, 1);
assert.equal(spatialTelemetryResponse.sourceRevisionCount, 1);
assert.equal(spatialTelemetryResponse.nextCursorPresent, true);
assert.equal(spatialTelemetryResponse.coverageStatus, "incomplete_omissions");
assert.doesNotMatch(JSON.stringify(spatialTelemetryResponse), /Level 09|Room 901|7788|cursor-secret/);
const spatialWorkTelemetryResponse = summarizeSpatialExtractionTelemetryResponse({
  success: true,
  guarded: false,
  state: "in_progress",
  action: "extract_spatial_snapshot",
  continuationKind: "work",
  nextCursor: "spatial-work-cursor-v0.2.cursor-secret",
  sourceBindingFingerprint: spatialSecret,
  scope: { requestedLevelNames: [spatialSecret] },
  preparation: {
    phase: "filter",
    stepOrdinal: 3,
    processed: 120,
    total: 400,
    nextCursor: "spatial-work-cursor-v0.2.cursor-secret",
  },
});
assert.equal(spatialWorkTelemetryResponse.state, "in_progress");
assert.equal(spatialWorkTelemetryResponse.continuationKind, "work");
assert.equal(spatialWorkTelemetryResponse.preparationPhase, "filter");
assert.equal(spatialWorkTelemetryResponse.preparationStepOrdinal, 3);
assert.equal(spatialWorkTelemetryResponse.preparationProcessed, 120);
assert.equal(spatialWorkTelemetryResponse.preparationTotal, 400);
assert.equal(spatialWorkTelemetryResponse.workCursorPresent, true);
assert.doesNotMatch(JSON.stringify(spatialWorkTelemetryResponse), /cursor-secret|Level 09|Room 901|7788/);
assert.equal(isSpatialExtractionTelemetry({ toolName: "capture_spatial_snapshot" }), true);
assert.equal(isSpatialExtractionTelemetry({ toolName: "inspect_levels" }), true);
assert.equal(isSpatialExtractionTelemetry({ toolName: "query_spatial_context" }), true);
assert.equal(isSpatialExtractionTelemetry({ toolName: "compare_spatial_snapshots" }), true);
assert.equal(isSpatialExtractionTelemetry({ toolName: "summarize_spatial_state" }), true);
const spatialQueryTelemetryParams = summarizeSpatialExtractionTelemetryParams({
  snapshotId: spatialSecret,
  mode: "operation",
  operationName: "nearest_elements",
  nodeIds: [spatialSecret],
  categories: [spatialSecret],
  cursor: spatialSecret,
  maxItems: 25,
}, "query_spatial_context");
assert.equal(spatialQueryTelemetryParams.snapshotSelectorCount, 1);
assert.equal(spatialQueryTelemetryParams.selectorCount, 2);
assert.equal(spatialQueryTelemetryParams.mode, "operation");
assert.equal(spatialQueryTelemetryParams.operationName, "nearest_elements");
assert.equal(spatialQueryTelemetryParams.maxItems, 25);
assert.equal(Object.hasOwn(spatialQueryTelemetryParams, "includeHostMep"), false);
assert.doesNotMatch(JSON.stringify(spatialQueryTelemetryParams), /Level 09|Room 901|7788|cursor-secret/);
assert.equal(extractProductionContext({
  sourceEventType: "mcp.tool",
  toolName: "capture_spatial_snapshot",
  params: { levelNames: [spatialSecret], cursor: spatialSecret },
  response: { nodes: [{ nodeId: spatialSecret }] },
}), null);
assert.equal(extractProductionContext({
  sourceEventType: "mcp.tool",
  toolName: "inspect_levels",
  params: { nameQuery: "inspect-levels-name-secret" },
  response: { levels: [{ name: "inspect-levels-name-secret", levelId: 99 }] },
}), null);

const productionContext = extractProductionContext({
  sourceEventType: "revit.command",
  commandName: "find_elements",
  logicalToolName: "find_elements",
  executionKind: "bridgeCommand",
  taskName: "Find ducts on Level 02 Room 204",
  taskId: "run-204",
  durationMs: 42,
  params: {
    taskName: "Find ducts on Level 02 Room 204",
    query: "supply duct room 204",
    categoryNames: ["Ducts"],
    searchBudget: "fast",
    linkScope: "hostOnly",
    elementIds: [101, 102],
  },
  response: {
    success: true,
    Action: "find_elements",
    DocumentTitle: "Office Tower",
    DocumentPath: "C:\\Projects\\Office Tower\\MEP.rvt",
    ActiveView: { Id: 7, Name: "Level 02 - Mechanical", ViewType: "FloorPlan" },
    LevelName: "Level 02",
    SelectionIds: [101],
    InferredScope: { categoryNames: ["Ducts"], residualQuery: "supply room 204" },
    EffectiveScope: { categoryNames: ["Ducts"], linkScope: "hostOnly" },
    RiskPolicy: { riskLevel: "low", recommendedFirstScope: ["categoryNames=Ducts"], requiresUserControl: false },
    ScanPolicy: { searchBudget: "fast", maxElapsedMs: 4500, planCandidateMode: "none" },
    ScannedElementCount: 18,
    Partial: false,
    Elements: [
      { Id: 101, Name: "Supply Duct", Category: "Ducts", LevelName: "Level 02", RoomNumber: "204" },
    ],
  },
});
assert.equal(productionContext.eventType, "production.context");
assert.equal(productionContext.runId, "run-204");
assert.equal(productionContext.operation.taskName, "Find ducts on Level 02 Room 204");
assert.equal(productionContext.project.documentTitle, "Office Tower");
assert.match(productionContext.project.documentPath, /Office Tower/);
assert.equal(productionContext.view.active.name, "Level 02 - Mechanical");
assert.equal(productionContext.location.levelName, "Level 02");
assert.deepEqual(productionContext.elements.targetElementIds, [101, 102]);
assert.deepEqual(productionContext.elements.selectionIds, [101]);
assert.equal(productionContext.elements.disciplineHint, "mechanical_hvac");
assert.equal(productionContext.elements.samples[0].roomNumber, "204");
assert.equal(productionContext.search.searchBudget, "fast");
assert.equal(productionContext.search.linkScope, "hostOnly");
assert.equal(productionContext.search.riskLevel, "low");
assert.equal(productionContext.search.requiresUserControl, false);
assert.equal(productionContext.search.scannedElementCount, 18);
assert.equal(productionContext.search.partial, false);
assert.equal(productionContext.search.effectiveScope.categoryNames[0], "Ducts");

const scheduleContext = extractProductionContext({
  sourceEventType: "mcp.tool",
  toolName: "inspect_schedules",
  taskName: "M701 sheet schedule scan Level 02",
  taskId: "run-schedule",
  durationMs: 88,
  params: {
    sheetQuery: "M701",
    nameQuery: "Mechanical Schedules",
    cellQuery: "R914",
  },
  response: {
    content: [{
      type: "text",
      text: JSON.stringify({
        success: true,
        action: "inspect_schedules",
        ActiveView: { Id: 17, Name: "Level 02 HVAC", ViewType: "DrawingSheet" },
        schedules: [{ id: 501, name: "Mechanical Schedules" }],
      }),
    }],
  },
});
assert.equal(scheduleContext.elements.disciplineHint, "mechanical_hvac");
assert.equal(scheduleContext.location.levelName, "Level 02");
assert.equal(scheduleContext.operation.query, "Mechanical Schedules");

const telemetryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "revagent-telemetry-"));
process.env.REVAGENT_TELEMETRY_ROOT = telemetryRoot;
process.env.REVAGENT_TELEMETRY_LOCAL_ONLY = "1";
await recordTelemetryEvent({
  eventType: "runtime.test",
  timestampUtc: "2026-05-27T00:00:00.000Z",
});
const telemetryTargets = resolveTelemetryTargets({
  timestampUtc: "2026-05-27T00:00:00.000Z",
  machineName: "HAFIZE",
  sessionId: "session",
});
assert.equal(telemetryTargets.length, 1);
assert.match(telemetryTargets[0].path, /2026-05-27\.ndjson$/);
const telemetryFile = path.join(telemetryRoot, "events", "2026-05-27.ndjson");
assert.equal(fs.existsSync(telemetryFile), true);
const telemetryLine = fs.readFileSync(telemetryFile, "utf8").trim();
assert.equal(JSON.parse(telemetryLine).eventType, "runtime.test");
delete process.env.REVAGENT_TELEMETRY_LOCAL_ONLY;
process.env.REVAGENT_REPORTS_ROOT = path.join(telemetryRoot, "reports");
const remoteTargets = resolveTelemetryTargets({
  timestampUtc: "2026-05-27T00:00:00.000Z",
  machineName: "hafize",
  sessionId: "session",
});
assert.equal(remoteTargets.some((target) => target.kind === "remote" && target.path.includes(`${path.sep}HAFIZE${path.sep}`)), true);

const orderedIndexes = Array.from({ length: 20 }, (_, index) => index);
await Promise.all(orderedIndexes.map((index) => recordTelemetryEvent({
  eventType: "ordered.test",
  timestampUtc: "2026-05-28T00:00:00.000Z",
  order: index,
})));
const orderedLocalFile = path.join(telemetryRoot, "events", "2026-05-28.ndjson");
const orderedLocalLines = fs.readFileSync(orderedLocalFile, "utf8")
  .trim()
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => JSON.parse(line))
  .filter((line) => line.eventType === "ordered.test");
assert.deepEqual(orderedLocalLines.map((line) => line.order), orderedIndexes);
assert.deepEqual(
  orderedLocalLines.map((line) => line.sequence),
  [...orderedLocalLines].sort((a, b) => a.sequence - b.sequence).map((line) => line.sequence),
);
const orderedRemoteDayRoot = path.join(telemetryRoot, "reports", "events", "2026", "05", "28");
const orderedRemoteFiles = fs.readdirSync(orderedRemoteDayRoot)
  .flatMap((machineName) => fs.readdirSync(path.join(orderedRemoteDayRoot, machineName))
    .filter((fileName) => fileName.endsWith(".ndjson"))
    .map((fileName) => path.join(orderedRemoteDayRoot, machineName, fileName)));
assert.equal(orderedRemoteFiles.length > 0, true);
const orderedRemoteLines = orderedRemoteFiles.flatMap((fileName) =>
  fs.readFileSync(fileName, "utf8").trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
).filter((line) => line.eventType === "ordered.test");
assert.deepEqual(orderedRemoteLines.map((line) => line.order), orderedIndexes);

const safeTool = tools.get("send_code_to_revit_safe");
const rejection = await safeTool.handler({
  code: "document.Delete(new ElementId(1));",
  intent: "writeCommit",
  taskName: "Write preview for Level 02 Room 204",
});
const rejectionPayload = JSON.parse(rejection.content[0].text);
assert.equal(rejectionPayload.success, false);
assert.equal(rejectionPayload.guarded, true);
assert.match(rejectionPayload.error, /does not support writeCommit/);
await flushTelemetryWritesForTests();
const telemetryFiles = fs.readdirSync(path.join(telemetryRoot, "events"))
  .filter((fileName) => fileName.endsWith(".ndjson"))
  .map((fileName) => path.join(telemetryRoot, "events", fileName));
const telemetryLines = telemetryFiles.flatMap((fileName) =>
  fs.readFileSync(fileName, "utf8").trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
);
const toolTelemetry = telemetryLines.find((line) => line.eventType === "mcp.tool" && line.toolName === "send_code_to_revit_safe");
assert.equal(toolTelemetry.result.success, false);
assert.equal(toolTelemetry.result.guarded, true);
assert.equal(toolTelemetry.taskName, "Write preview for Level 02 Room 204");
assert.equal(toolTelemetry.params.code.writePatternCount > 0, true);
const productionTelemetry = telemetryLines.find((line) => line.eventType === "production.context" && line.related?.toolName === "send_code_to_revit_safe");
assert.equal(productionTelemetry.operation.taskName, "Write preview for Level 02 Room 204");
assert.equal(productionTelemetry.operation.guarded, true);
const rawSendCodeTool = tools.get("send_code_to_revit");
const typeDeclarationGuard = await rawSendCodeTool.handler({
  code: "public class BadHelper {}\nreturn new { success = true };",
  taskName: "Unsupported snippet helper type",
});
assert.match(typeDeclarationGuard.content[0].text, /Code execution guarded/);
assert.match(typeDeclarationGuard.content[0].text, /type declarations/);
const coordinationTool = tools.get("export_revit_coordination_image");
const invalidCoordinationIds = await coordinationTool.handler({
  elementIds: ["not-a-revit-element-id"],
  outputDir: os.tmpdir(),
  taskName: "Invalid coordination element ids",
});
const invalidCoordinationPayload = JSON.parse(invalidCoordinationIds.content[0].text);
assert.equal(invalidCoordinationPayload.success, false);
assert.equal(invalidCoordinationPayload.guarded, true);
assert.equal(invalidCoordinationPayload.reason, "invalid_element_ids");
assert.equal(invalidCoordinationPayload.revitWriteAction, "none");
delete process.env.REVAGENT_TELEMETRY_ROOT;
delete process.env.REVAGENT_REPORTS_ROOT;

console.error("runtime MCP smoke passed");
