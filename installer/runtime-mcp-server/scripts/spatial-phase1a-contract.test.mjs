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
const liveHarnessSource = read(path.join(repoRoot, "scripts", "test-spatial-phase1a-live.mjs"));

assert.match(helperSource, /SchemaVersion = "0\.3"/);
assert.match(helperSource, /ExtractorVersion = "phase1b-native\/0\.3"/);
assert.match(helperSource, /CursorVersion = "0\.2"/);
assert.match(helperSource, /WorkCursorVersion = "0\.2-work"/);
assert.match(helperSource, /CursorPrefix = "spatial-cursor-v0\.2\."/,
  "The v0.3 native payload must preserve the deployed opaque v0.2 page-cursor wire prefix.");
assert.match(helperSource, /WorkCursorPrefix = "spatial-work-cursor-v0\.2\."/,
  "The v0.3 native payload must preserve the deployed opaque v0.2 work-cursor wire prefix.");
assert.match(helperSource, /CaptureConsistency = "document_change_sequence_bound"/);
assert.match(helperSource, /SpatialChangeTracker\.Instance\.GetCurrentBinding/);
assert.match(commandSource, /ReadInt\(parameters, "maxElapsedMs", 1800, 250, 5000\)/);
assert.match(handlerSource, /SpatialCaptureSessionManager\.Instance\.Store/);
assert.match(handlerSource, /ValidatePreparedCaptureBindings/);
assert.match(handlerSource, /TryBindCurrentHostDocument/);
assert.match(handlerSource, /capture_interrupted_by_change/);
assert.match(handlerSource, /capture_document_session_changed/);
assert.match(handlerSource, /"changeSequence", source\.Identity\.ChangeSequence/);
assert.match(handlerSource, /"oldestRetainedSequence", source\.Identity\.OldestRetainedSequence/);
assert.match(handlerSource, /"trackerSessionId", source\.Identity\.TrackerSessionId/);
const workContinuationSource = handlerSource.slice(
  handlerSource.indexOf("private void CompletePreparedWorkContinuation"),
  handlerSource.indexOf("private void CompletePreparedPageContinuation"),
);
const pageContinuationSource = handlerSource.slice(
  handlerSource.indexOf("private void CompletePreparedPageContinuation"),
  handlerSource.indexOf("private DateTime ResolveWorkDeadline"),
);
for (const [name, source] of [
  ["work", workContinuationSource],
  ["page", pageContinuationSource],
]) {
  assert.match(source, /TryBindCurrentHostDocument/,
    `${name} continuation must validate the tracker-backed active host binding.`);
  assert.match(source, /BuildInterruptedByChange/,
    `${name} continuation must discard a prepared capture when its host session changed.`);
  assert.doesNotMatch(source, /ReferenceEquals\(prepared\.HostDocument,\s*hostDocument\)/,
    `${name} continuation must not bind a cursor to one transient managed Document wrapper.`);
}
const hostBindingSource = handlerSource.slice(
  handlerSource.indexOf("private static bool TryBindCurrentHostDocument"),
  handlerSource.indexOf("private bool ValidatePreparedCaptureBindings"),
);
assert.match(hostBindingSource, /ResolveDocumentIdentity\(hostDocument\)/);
assert.match(hostBindingSource, /prepared\.HostDocumentKey, currentIdentity\.DocumentKey/);
assert.match(hostBindingSource, /prepared\.HostTrackerSessionId, currentIdentity\.TrackerSessionId/);
assert.match(hostBindingSource, /prepared\.HostDocumentSessionId, currentIdentity\.DocumentSessionId/);
assert.match(hostBindingSource, /prepared\.HostDocument = hostDocument/);
assert.ok(
  hostBindingSource.indexOf("prepared.HostDocumentSessionId, currentIdentity.DocumentSessionId")
    < hostBindingSource.indexOf("prepared.HostDocument = hostDocument"),
  "The transient host wrapper may refresh only after the stable open-document session matches.",
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
assert.match(sessionSource, /public string HostDocumentKey;/);
assert.match(sessionSource, /public string HostDocumentSessionId;/);
assert.match(sessionSource, /public string HostTrackerSessionId;/);
assert.match(handlerSource, /HostDocumentKey = hostIdentity\.DocumentKey/);
assert.match(handlerSource, /HostDocumentSessionId = hostIdentity\.DocumentSessionId/);
assert.match(handlerSource, /HostTrackerSessionId = hostIdentity\.TrackerSessionId/);
assert.match(trackerSource, /DocumentChanged/);
assert.match(trackerSource, /ConditionalWeakTable<Document, DocumentState>/);
assert.match(trackerSource, /Dictionary<string, DocumentState> _documentsByStableKey/);
assert.match(trackerSource, /DocumentClosing \+= OnDocumentClosing/);
assert.match(trackerSource, /DocumentClosed \+= OnDocumentClosed/);
assert.match(trackerSource, /DocumentSaved \+= OnDocumentSaved/);
assert.match(trackerSource, /DocumentSavedAs \+= OnDocumentSavedAs/);
assert.match(trackerSource, /DocumentSynchronizedWithCentral \+= OnDocumentSynchronizedWithCentral/);
assert.match(trackerSource, /DocumentReloadedLatest \+= OnDocumentReloadedLatest/);
assert.match(trackerSource, /args\.Status != RevitAPIEventStatus\.Succeeded/);
assert.match(trackerSource, /A stable key is authoritative for the lifetime bracketed by/);
const savedAsSource = trackerSource.slice(
  trackerSource.indexOf("private void OnDocumentSavedAs"),
  trackerSource.indexOf("private DocumentState GetOrCreateState"),
);
assert.match(savedAsSource, /RefreshStableAliases\(document, state\)/);
const refreshAliasesSource = trackerSource.slice(
  trackerSource.indexOf("private void RefreshStableAliases"),
  trackerSource.indexOf("private void RemoveDocumentState"),
);
assert.match(refreshAliasesSource, /_documentsByStableKey\.Remove\(key\)/);
assert.match(refreshAliasesSource, /state\.StableKeys\.Clear\(\)/);
assert.ok(
  refreshAliasesSource.indexOf("state.StableKeys.Clear()")
    < refreshAliasesSource.indexOf("RegisterStableAliases(document, state)"),
  "Save As must retire old stable identities before registering the current identity.",
);
const stableKeyResolutionSource = trackerSource.slice(
  trackerSource.indexOf("private bool TryResolveState"),
  trackerSource.indexOf("private void AddWrapperAlias"),
);
assert.match(stableKeyResolutionSource, /state = candidate;\s*return true;/);
assert.doesNotMatch(stableKeyResolutionSource, /Equals\(|IsValidObject|ReferenceEquals/);
assert.doesNotMatch(trackerSource, /keys\.Add\("project\|" \+ projectInformationId\)/);
assert.match(trackerSource, /RemoveDocumentState\(state\)/);
assert.match(trackerSource, /DefaultJournalCapacity = 512/);
assert.match(applicationSource, /SpatialChangeTracker\.Instance\.Subscribe/);
assert.match(applicationSource, /SpatialChangeTracker\.Instance\.Unsubscribe/);
assert.match(applicationSource, /ViewActivated \+= OnViewActivated/);
assert.match(applicationSource, /ViewActivated -= OnViewActivated/);
assert.match(applicationSource, /InvalidateActiveDocumentView/);
assert.match(livenessRequestSource, /InputOrdinal = index/);
assert.match(livenessCommandSource, /host_binding_required_for_link_liveness/);
assert.match(livenessCommandSource, /journal_gap|HistoryGap/);
assert.match(trackerSource, /public long LivenessGeneration/);
assert.match(trackerSource, /checked\s*\{\s*_livenessGeneration\+\+/);
const subscribeSource = trackerSource.slice(
  trackerSource.indexOf("public void Subscribe"),
  trackerSource.indexOf("public void Unsubscribe"),
);
const unsubscribeSource = trackerSource.slice(
  trackerSource.indexOf("public void Unsubscribe"),
  trackerSource.indexOf("public SpatialDocumentChangeSnapshot GetCurrentBinding"),
);
assert.match(subscribeSource, /AdvanceLivenessGeneration\(\)/,
  "A new tracker subscription must invalidate prior process-local liveness cache entries.");
assert.match(unsubscribeSource, /ResetDocumentBindings\(\)[\s\S]*AdvanceLivenessGeneration\(\)/,
  "Tracker unsubscribe/reset must invalidate prior process-local liveness cache entries.");
for (const [eventName, handlerName] of [
  ["DocumentSaved", "OnDocumentSaved"],
  ["DocumentSynchronizedWithCentral", "OnDocumentSynchronizedWithCentral"],
  ["DocumentReloadedLatest", "OnDocumentReloadedLatest"],
]) {
  assert.match(subscribeSource, new RegExp(`${eventName} \\+= ${handlerName}`),
    `${eventName} must invalidate current-liveness cache entries after success.`);
  assert.match(unsubscribeSource, new RegExp(`${eventName} -= ${handlerName}`),
    `${eventName} must be detached with the tracker subscription.`);
}
const documentChangedSource = trackerSource.slice(
  trackerSource.indexOf("private void OnDocumentChanged"),
  trackerSource.indexOf("private void OnDocumentClosing"),
);
assert.ok(
  documentChangedSource.indexOf("AdvanceLivenessGeneration()")
    < documentChangedSource.indexOf("ReadElementIds"),
  "DocumentChanged must invalidate cached current evidence before reading change-id collections.",
);
const documentClosedSource = trackerSource.slice(
  trackerSource.indexOf("private void OnDocumentClosed"),
  trackerSource.indexOf("private void OnDocumentSavedAs"),
);
assert.ok(
  documentClosedSource.indexOf("_closingDocuments.Remove(args.DocumentId)")
    < documentClosedSource.indexOf("args.Status != RevitAPIEventStatus.Succeeded"),
  "Every close result must retire its temporary closing marker before a cancelled/failed close returns.",
);
assert.ok(
  documentClosedSource.indexOf("args.Status != RevitAPIEventStatus.Succeeded")
    < documentClosedSource.indexOf("RemoveDocumentState(state)")
    && documentClosedSource.indexOf("RemoveDocumentState(state)")
      < documentClosedSource.indexOf("AdvanceLivenessGeneration()"),
  "Only a successful close may retire document state and advance the liveness generation.",
);
for (const invalidationSource of [
  documentChangedSource,
  documentClosedSource,
  trackerSource.slice(trackerSource.indexOf("private void OnDocumentSavedAs"), trackerSource.indexOf("private DocumentState GetOrCreateState")),
  trackerSource.slice(trackerSource.indexOf("private void ResetDocumentBindings"), trackerSource.indexOf("private sealed class DocumentState")),
]) {
  assert.match(invalidationSource, /AdvanceLivenessGeneration\(\)/,
    "Every model/session reset boundary must invalidate process-local current-liveness cache entries.");
}
const successfulDocumentBoundarySource = trackerSource.slice(
  trackerSource.indexOf("private void OnDocumentSaved("),
  trackerSource.indexOf("private DocumentState GetOrCreateState"),
);
assert.match(successfulDocumentBoundarySource, /OnDocumentSaved[\s\S]*InvalidateSuccessfulDocumentBoundary/);
assert.match(successfulDocumentBoundarySource, /OnDocumentSynchronizedWithCentral[\s\S]*InvalidateSuccessfulDocumentBoundary/);
assert.match(successfulDocumentBoundarySource, /OnDocumentReloadedLatest[\s\S]*InvalidateSuccessfulDocumentBoundary/);
assert.ok(
  successfulDocumentBoundarySource.indexOf("status != RevitAPIEventStatus.Succeeded")
    < successfulDocumentBoundarySource.indexOf("AdvanceLivenessGeneration()"),
  "Save, synchronize, and reload boundaries must invalidate only after successful completion.",
);
assert.match(livenessRequestSource, /MaxCurrentLivenessCacheEntries = 64/);
assert.match(livenessRequestSource, /HandlerExecutionSync/);
assert.match(livenessRequestSource, /BuildExactExpectedRevisionsKey/);
assert.match(livenessRequestSource, /sourceToHostTransformFingerprint/);
assert.match(livenessRequestSource, /generationBeforeEvaluation == generationAfterEvaluation/);
assert.match(livenessRequestSource, /IsCacheableCurrentResult/);
assert.match(livenessRequestSource, /sequence_bound_process_cache/);
assert.match(livenessRequestSource, /revit_external_event/);
assert.match(livenessRequestSource, /CloneRequest\(request\)/);
assert.match(livenessRequestSource, /CloneResult\(entry\.Result\)/);
assert.match(livenessRequestSource, /CurrentLivenessCache\.Count >= MaxCurrentLivenessCacheEntries/);
assert.match(livenessRequestSource, /RaiseAndWaitForCompletion\(request\.TimeoutMs\)/,
  "A cache miss or generation mismatch must retain the existing fail-closed ExternalEvent path.");
const livenessExecuteSource = livenessRequestSource.slice(
  livenessRequestSource.indexOf("public override object Execute"),
  livenessRequestSource.indexOf("private static GetSpatialChangeStateResult PrepareCachedResult"),
);
const firstCacheLookup = livenessExecuteSource.indexOf("TryReadCurrentLivenessCache");
const handlerLock = livenessExecuteSource.indexOf("lock (HandlerExecutionSync)");
const secondCacheLookup = livenessExecuteSource.indexOf("TryReadCurrentLivenessCache", firstCacheLookup + 1);
const priorPendingGuard = livenessExecuteSource.indexOf("HandlerInstance.WaitForCompletion(0)");
const setSharedRequest = livenessExecuteSource.indexOf("HandlerInstance.SetRequest");
assert.ok(
  firstCacheLookup >= 0 && firstCacheLookup < handlerLock
    && handlerLock < secondCacheLookup && secondCacheLookup < priorPendingGuard
    && priorPendingGuard < setSharedRequest,
  "The fast cache hit must remain lock-free while cache misses recheck trust inside the shared-handler lock.",
);
assert.match(livenessRequestSource, /_handlerRequestMayBePending = true[\s\S]*RaiseAndWaitForCompletion/,
  "A timed-out ExternalEvent must remain marked pending so the next miss cannot overwrite its shared handler state.");
assert.match(livenessRequestSource, /IsExactCurrentRowForRequest/);
for (const exactBindingField of [
  "documentKey",
  "trackerSessionId",
  "documentSessionId",
  "changeSequence",
  "loadedVersion",
  "sourceToHostTransformFingerprint",
  "externalLinkUpdateAvailable",
  "changedSinceExpectedSequenceCount",
]) {
  assert.match(livenessRequestSource, new RegExp(exactBindingField),
    `Cache admission must validate exact ${exactBindingField} evidence.`);
}
const livenessCacheSource = livenessRequestSource.slice(
  livenessRequestSource.indexOf("BuildExactExpectedRevisionsKey"),
  livenessRequestSource.indexOf("private static List<ExpectedSpatialSourceRevision> ReadSourceRevisions"),
);
assert.doesNotMatch(livenessCacheSource, /DateTime|TimeSpan|ttl|expires/i,
  "Current liveness cache validity must be sequence/generation-bound, never clock-age-bound.");
assert.doesNotMatch(handlerSource, /CurrentLivenessCache|sequence_bound_process_cache/,
  "Native extraction must retain its revision-consistency checks and must not consume current-liveness cache entries.");
assert.match(liveHarnessSource, /doublePlacedBindingsConsistent/);
assert.match(liveHarnessSource, /sharedDocumentSessionAndRevisionBinding/);
assert.match(liveHarnessSource, /do not share one document session, tracker, sequence, and loaded version/);

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
