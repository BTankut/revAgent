import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const runtimeRoot = path.resolve(__dirname, "..");
const repoRoot = process.env.REVIT_MCP_REPO_ROOT
  ? path.resolve(process.env.REVIT_MCP_REPO_ROOT)
  : path.resolve(runtimeRoot, "..", "..");
const schemaRoot = path.join(runtimeRoot, "schemas", "spatial", "v0.2");
const schemaNames = [
  "element-ref",
  "node-ref",
  "source-revision",
  "cursor-envelope",
  "spatial-snapshot",
  "extraction-page",
  "work-cursor-envelope",
  "work-continuation",
];

const read = (filePath) => fs.readFileSync(filePath, "utf8");
const readJson = (filePath) => JSON.parse(read(filePath).replace(/^\uFEFF/, ""));
const schemas = Object.fromEntries(schemaNames.map((name) => [name, readJson(path.join(schemaRoot, `${name}.schema.json`))]));

function collectRefs(value, refs = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectRefs(item, refs);
  } else if (value && typeof value === "object") {
    if (typeof value.$ref === "string") refs.push(value.$ref);
    for (const child of Object.values(value)) collectRefs(child, refs);
  }
  return refs;
}

for (const [name, schema] of Object.entries(schemas)) {
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.match(schema.$id, /^https:\/\/schemas\.revagent\.app\/spatial\/v0\.2\//);
  assert.equal(schema.additionalProperties, false, `${name} must remain strict at the top level`);
  for (const ref of collectRefs(schema)) {
    const [relativeFile] = ref.split("#", 1);
    if (relativeFile) {
      assert.ok(fs.existsSync(path.resolve(schemaRoot, relativeFile)), `${name} has unresolved ref ${ref}`);
    }
  }
}

const sourceRevision = schemas["source-revision"];
for (const field of [
  "documentKey",
  "documentSessionId",
  "loadedVersion",
  "changeSequence",
  "changeSequenceState",
  "oldestRetainedSequence",
  "trackerSessionId",
  "sourceToHostTransform",
]) {
  assert.ok(sourceRevision.required.includes(field), `SourceRevision v0.2 must require ${field}`);
}
assert.equal(sourceRevision.properties.changeSequence.minimum, 0);
assert.equal(sourceRevision.properties.changeSequenceState.const, "tracked");
assert.equal(sourceRevision.properties.oldestRetainedSequence.minimum, 0);

const cursor = schemas["cursor-envelope"];
assert.equal(cursor.properties.cursorVersion.const, "0.2");

const snapshot = schemas["spatial-snapshot"];
for (const field of ["atomic", "liveness", "livenessBinding", "committedAt", "sourceBindingFingerprint"]) {
  assert.ok(snapshot.required.includes(field), `SpatialSnapshot v0.2 must require ${field}`);
}
assert.equal(snapshot.properties.schemaVersion.const, "0.2");
assert.equal(snapshot.properties.atomic.const, true);
assert.deepEqual(snapshot.properties.liveness.enum, ["current", "stale", "unknown"]);
assert.equal(snapshot.properties.livenessBinding.properties.basis.const, "document_change_sequence");

const extraction = schemas["extraction-page"];
assert.equal(extraction.properties.schemaVersion.const, "0.2");
assert.equal(extraction.properties.atomic.const, false);
assert.equal(extraction.properties.liveness.const, "staging");
assert.equal(extraction.properties.captureConsistency.const, "document_change_sequence_bound");
assert.equal(extraction.$defs.scanPolicy.properties.cursorVersion.const, "0.2");
assert.equal(extraction.$defs.scanPolicy.properties.maxElapsedMs.maximum, 5000);
assert.equal(extraction.$defs.scanPolicy.properties.sequenceBound.const, true);
assert.equal(extraction.$defs.scanPolicy.properties.maxUiOccupancyMs.const, 5000);
for (const field of ["continuationKind", "sourceBindingFingerprint", "preparation"]) {
  assert.ok(extraction.required.includes(field), `Extraction page v0.2 must require ${field}`);
}
assert.equal(extraction.properties.continuationKind.type, "null");
assert.equal(extraction.properties.preparation.type, "null");
assert.ok(extraction.$defs.nodeRecord.oneOf.some((entry) => entry.$ref === "#/$defs/connectorNodeRecord"));
assert.equal(extraction.$defs.connectorNodeRecord.properties.nodeKind.const, "connector");
assert.equal(extraction.$defs.connectorNodeRecord.properties.connectorRef.$ref, "./node-ref.schema.json#/$defs/connectorRef");

const workCursor = schemas["work-cursor-envelope"];
assert.equal(workCursor.properties.cursorVersion.const, "0.2-work");
assert.equal(workCursor.properties.cursorKind.const, "work");
for (const field of ["captureId", "workPhase", "stepOrdinal", "scopeFingerprint", "sourceBindingFingerprint", "capturedAt"]) {
  assert.ok(workCursor.required.includes(field), `Work cursor v0.2 must require ${field}`);
}

const workContinuation = schemas["work-continuation"];
assert.equal(workContinuation.properties.state.const, "in_progress");
assert.equal(workContinuation.properties.continuationKind.const, "work");
assert.equal(workContinuation.properties.atomic.const, false);
assert.equal(workContinuation.properties.liveness.const, "staging");
assert.equal(workContinuation.properties.page.type, "null");
assert.equal(workContinuation.properties.nodes.type, "null");
assert.equal(workContinuation.properties.omissions.type, "null");
assert.match(workContinuation.properties.nextCursor.pattern, /spatial-work-cursor/);
assert.equal(workContinuation.$defs.preparation.properties.cursorVersion.const, "0.2-work");

const spatialRoot = path.join(repoRoot, "src", "revit-plugin", "revAgentCommandSet", "Commands", "Spatial");
const helperSource = read(path.join(spatialRoot, "SpatialSnapshotHelpers.cs"));
const commandSource = read(path.join(spatialRoot, "ExtractSpatialSnapshotCommand.cs"));
const handlerSource = read(path.join(spatialRoot, "ExtractSpatialSnapshotEventHandler.cs"));
const sessionSource = read(path.join(spatialRoot, "SpatialCaptureSessionManager.cs"));
const trackerSource = read(path.join(repoRoot, "src", "revit-plugin", "revAgentPlugin", "Core", "SpatialChangeTracker.cs"));
const applicationSource = read(path.join(repoRoot, "src", "revit-plugin", "revAgentPlugin", "Core", "Application.cs"));
const livenessRequestSource = read(path.join(spatialRoot, "GetSpatialChangeStateCommand.cs"));
const livenessCommandSource = read(path.join(spatialRoot, "GetSpatialChangeStateEventHandler.cs"));

assert.match(helperSource, /SchemaVersion = "0\.2"/);
assert.match(helperSource, /CursorVersion = "0\.2"/);
assert.match(helperSource, /CaptureConsistency = "document_change_sequence_bound"/);
assert.match(helperSource, /SpatialChangeTracker\.Instance\.GetCurrentBinding/);
assert.match(commandSource, /ReadInt\(parameters, "maxElapsedMs", 1800, 250, 5000\)/);
assert.match(handlerSource, /SpatialCaptureSessionManager\.Instance\.Store/);
assert.match(handlerSource, /ValidatePreparedCaptureBindings/);
assert.match(handlerSource, /capture_interrupted_by_change/);
assert.match(handlerSource, /"changeSequence", source\.Identity\.ChangeSequence/);
assert.match(handlerSource, /"oldestRetainedSequence", source\.Identity\.OldestRetainedSequence/);
assert.match(handlerSource, /"trackerSessionId", source\.Identity\.TrackerSessionId/);
const pageContinuationSource = handlerSource.slice(
  handlerSource.indexOf("private void CompletePreparedPageContinuation"),
  handlerSource.indexOf("private DateTime ResolveWorkDeadline"),
);
assert.ok(
  pageContinuationSource.lastIndexOf("ValidatePreparedCaptureBindings")
    < pageContinuationSource.indexOf("result.ElapsedMs = stopwatch.ElapsedMilliseconds"),
  "Data-page UI occupancy must be refreshed after the mandatory post-page source-binding check.",
);
assert.ok(
  pageContinuationSource.indexOf("result.ElapsedMs = stopwatch.ElapsedMilliseconds")
    < pageContinuationSource.indexOf("Complete(result)"),
  "Refreshed data-page UI occupancy must be emitted before completion.",
);
assert.match(handlerSource, /payload\["sourcePartition"\] = sourcePartition/);
assert.match(handlerSource, /placementKey \+ ":" \+ classification \+ ":" \+ \(sourcePartition \?\? ""\)/);
assert.doesNotMatch(helperSource, /emittedScopeSemantics/);
assert.match(sessionSource, /SessionLifetime/);
assert.match(sessionSource, /PurgeExpired/);
assert.match(trackerSource, /DocumentChanged/);
assert.match(trackerSource, /ConditionalWeakTable<Document, DocumentState>/);
assert.match(trackerSource, /DefaultJournalCapacity = 512/);
assert.match(applicationSource, /SpatialChangeTracker\.Instance\.Subscribe/);
assert.match(applicationSource, /SpatialChangeTracker\.Instance\.Unsubscribe/);
assert.match(livenessRequestSource, /InputOrdinal = index/);
assert.match(livenessCommandSource, /host_binding_required_for_link_liveness/);
assert.match(livenessCommandSource, /journal_gap|HistoryGap/);

const storeSource = read(path.join(runtimeRoot, "src", "spatial", "spatialStore.ts"));
const captureSource = read(path.join(runtimeRoot, "src", "spatial", "spatialCapture.ts"));
assert.match(storeSource, /REVAGENT_SPATIAL_DB_PATH/);
assert.match(storeSource, /LOCALAPPDATA/);
assert.match(storeSource, /USING rtree/);
assert.match(storeSource, /DEFAULT_SPATIAL_RETENTION_DAYS = 30/);
assert.match(storeSource, /DEFAULT_SPATIAL_MIN_COMPLETE_SNAPSHOTS = 20/);
assert.match(captureSource, /SPATIAL_CAPTURE_MAX_RETRIES = 2/);
assert.match(captureSource, /commitCapture/);
assert.match(captureSource, /probeLiveness/);

console.log("spatial Phase 1a versioned contract tests: ok");
