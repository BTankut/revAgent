import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const runtimeRoot = path.resolve(__dirname, "..");
const repositoryRoot = process.env.REVIT_MCP_REPO_ROOT
  ? path.resolve(process.env.REVIT_MCP_REPO_ROOT)
  : path.resolve(runtimeRoot, "..", "..");
const schemaRoot = path.join(runtimeRoot, "schemas", "spatial", "v0.3");
const read = (filePath) => fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
const readJson = (filePath) => JSON.parse(read(filePath));

const schemaFiles = fs.readdirSync(schemaRoot)
  .filter((name) => name.endsWith(".schema.json"))
  .sort();
assert.deepEqual(schemaFiles, [
  "extraction-page.schema.json",
  "fingerprints.schema.json",
  "profile.schema.json",
  "spatial-properties.schema.json",
  "spatial-snapshot.schema.json",
  "topology-coverage.schema.json",
  "work-continuation.schema.json",
]);

function collectRefs(value, output = []) {
  if (Array.isArray(value)) value.forEach((item) => collectRefs(item, output));
  else if (value && typeof value === "object") {
    if (typeof value.$ref === "string") output.push(value.$ref);
    Object.values(value).forEach((item) => collectRefs(item, output));
  }
  return output;
}

const schemas = Object.fromEntries(schemaFiles.map((name) => [name, readJson(path.join(schemaRoot, name))]));
for (const [name, schema] of Object.entries(schemas)) {
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.match(schema.$id, /^https:\/\/schemas\.revagent\.app\/spatial\/v0\.3\//);
  assert.equal(schema.additionalProperties, false, `${name} must remain strict at the top level.`);
  for (const ref of collectRefs(schema)) {
    const [relativeFile] = ref.split("#", 1);
    if (relativeFile) {
      const absoluteV02 = /^https:\/\/schemas\.revagent\.app\/spatial\/v0\.2\/(.+)$/.exec(relativeFile);
      const resolvedPath = absoluteV02
        ? path.join(runtimeRoot, "schemas", "spatial", "v0.2", absoluteV02[1])
        : path.resolve(schemaRoot, relativeFile);
      assert.ok(fs.existsSync(resolvedPath), `${name} has unresolved ref ${ref}.`);
    }
  }
}

const extraction = schemas["extraction-page.schema.json"];
assert.equal(extraction.properties.schemaVersion.const, "0.3");
assert.match(extraction.properties.nextCursor.pattern, /spatial-cursor-v0\\\.2\\\./,
  "v0.3 must preserve the deployed v0.2 opaque page-cursor wire prefix.");
const elementRequired = new Set(extraction.$defs.elementNodeRecord.required);
for (const field of ["spatialProperties", "profile", "fingerprints", "geometry"]) {
  assert.ok(elementRequired.has(field), `v0.3 element records must require ${field}.`);
}
const connectorRequired = new Set(extraction.$defs.connectorNodeRecord.required);
for (const field of [
  "ownerNodeId",
  "connectedToNodeIds",
  "connectedOwnerNodeIds",
  "connectionRefs",
  "topologyCoverage",
  "fingerprints",
]) {
  assert.ok(connectorRequired.has(field), `v0.3 connector records must require ${field}.`);
}
assert.equal(extraction.$defs.connectionRef.properties.basis.const, "revit_connector_all_refs");
assert.deepEqual(extraction.$defs.connectionRef.properties.relationKind.enum, ["physical", "logical", "unknown"]);

const profile = schemas["profile.schema.json"];
assert.deepEqual(profile.required, [
  "shape", "diameterMm", "widthMm", "heightMm", "insulationThicknessMm",
]);
assert.deepEqual(profile.properties.shape.enum, ["round", "rectangular", "oval", "unknown"]);
const fingerprints = schemas["fingerprints.schema.json"];
assert.equal(fingerprints.properties.version.const, "phase1b-spatial-fingerprint/1.0");
assert.deepEqual(fingerprints.required, ["version", "placement", "shape", "property", "topology"]);
const topology = schemas["topology-coverage.schema.json"];
assert.equal(topology.properties.basis.const, "revit_connector_all_refs");
assert.equal(topology.properties.targetMembershipValidated.const, false,
  "Native pages are staging evidence; committed store membership is runtime-owned.");

const snapshot = schemas["spatial-snapshot.schema.json"];
assert.equal(snapshot.properties.schemaVersion.const, "0.3");
for (const field of ["atomic", "liveness", "coverageStatus", "revisionFingerprint"]) {
  assert.ok(snapshot.required.includes(field), `v0.3 durable snapshot must require ${field}.`);
}
const work = schemas["work-continuation.schema.json"];
assert.equal(work.properties.schemaVersion.const, "0.3");
assert.match(work.properties.nextCursor.pattern, /spatial-work-cursor-v0\\\.2\\\./,
  "v0.3 must preserve the deployed v0.2 opaque work-cursor wire prefix.");

const storeSource = read(path.join(runtimeRoot, "src", "spatial", "spatialStore.ts"));
assert.match(storeSource, /SPATIAL_STORE_SCHEMA_MAJOR = 1/);
assert.match(storeSource, /SPATIAL_STORE_SCHEMA_MINOR = 2/);
for (const member of [
  "getStoredNode",
  "getStoredNodesByIds",
  "queryStoredNodes",
  "getStoredOmissions",
  "queryStoredEdges",
  "getAdjacentStoredEdges",
  "getSnapshotTopologyCapability",
]) {
  assert.match(storeSource, new RegExp(`public ${member}\\(`), `SpatialStore 1.2 must expose ${member}.`);
}
assert.match(storeSource, /CREATE TABLE spatial_edges/);
assert.match(storeSource, /CREATE TABLE IF NOT EXISTS spatial_snapshot_topology/);
assert.match(storeSource, /target_membership_validated/);
assert.match(storeSource, /assertExactAnalyticEnvelope/);
assert.match(storeSource, /does not contain its diameter plus insulation envelope/,
  "The durable v0.3 store must fail closed on non-conservative exact-analytic AABBs.");

const nativeSpatialHelperSource = read(path.join(
  repositoryRoot,
  "src", "revit-plugin", "revAgentCommandSet", "Commands", "Spatial", "SpatialSnapshotHelpers.cs",
));
const nativeSpatialHandlerSource = read(path.join(
  repositoryRoot,
  "src", "revit-plugin", "revAgentCommandSet", "Commands", "Spatial", "ExtractSpatialSnapshotEventHandler.cs",
));
assert.match(nativeSpatialHelperSource, /internal static void ApplyAnalyticProfileEnvelopeToGeometry\(/);
assert.match(nativeSpatialHelperSource,
  /double outerRadiusMm = diameterMm\.Value \/ 2\.0 \+ insulationThicknessMm\.Value/);
assert.match(nativeSpatialHelperSource, /coordinate - outerRadiusMm/);
assert.match(nativeSpatialHelperSource, /coordinate \+ outerRadiusMm/);
assert.match(nativeSpatialHandlerSource,
  /BuildElementProfile\(element\);\s*SpatialSnapshotHelpers\.ApplyAnalyticProfileEnvelopeToGeometry\(geometry, profile\);\s*Dictionary<string, object> propertyBasis/,
  "Native capture must expand the analytic envelope before computing v0.3 fingerprints.");

const querySource = read(path.join(runtimeRoot, "src", "spatial", "spatialQuery.ts"));
for (const operation of [
  "relation_between",
  "nearest_elements",
  "elements_within",
  "clearance_between",
  "trace_connectivity",
  "locate_in_space",
  "above_below",
]) {
  assert.match(querySource, new RegExp(`\\b${operation}\\b`), `Missing deterministic query operation ${operation}.`);
}
assert.match(querySource, /incomplete_topology_coverage/);
assert.match(querySource, /screening_only/);
assert.match(querySource, /encodeSpatialQueryCursor/);
assert.match(querySource, /decodeSpatialQueryCursor/);

const diffSource = read(path.join(runtimeRoot, "src", "spatial", "spatialDiff.ts"));
for (const classification of [
  "added",
  "removed",
  "sourceAvailabilityChanges",
  "transformChanges",
  "moved",
  "geometryChanges",
  "geometryIndeterminate",
  "propertyChanges",
  "connectorChanges",
  "connectivityChanges",
  "proximityChanges",
]) {
  assert.match(diffSource, new RegExp(`\\b${classification}\\b`), `Snapshot diff must expose ${classification}.`);
}
assert.match(diffSource, /allowLegacyV02/);
assert.match(diffSource, /incomparable_scopes/);
assert.match(diffSource, /incomplete_snapshot/);
assert.match(diffSource, /aabb_only_geometry_change_classification_is_capability_limited/);
assert.match(diffSource, /classification: aabbOnlyGeometryCapabilityGap \? "capability_limited" : "complete"/);

const summarySource = read(path.join(runtimeRoot, "src", "spatial", "spatialSummary.ts"));
assert.match(summarySource, /advisory: true/);
assert.match(summarySource, /quotableAsVerification: false/);
assert.match(summarySource, /verdictCapability: "context_only"/);
assert.doesNotMatch(summarySource, /clashVerdict|clearanceVerdict|clashFree/);

const registerSource = read(path.join(runtimeRoot, "src", "tools", "register.ts"));
for (const registration of [
  "registerQuerySpatialContextTool",
  "registerCompareSpatialSnapshotsTool",
  "registerSummarizeSpatialStateTool",
]) {
  assert.match(registerSource, new RegExp(`${registration}\\((?:telemetryServer|server)\\)`));
}

const telemetrySource = read(path.join(runtimeRoot, "src", "utils", "telemetry.ts"));
for (const reason of ["snapshot_capability_mismatch", "max_bytes"]) {
  assert.match(telemetrySource, new RegExp(`"${reason}"`),
    `Spatial telemetry must preserve the bounded reason code ${reason}.`);
}

const compareToolSource = read(path.join(runtimeRoot, "src", "tools", "compare_spatial_snapshots.ts"));
assert.match(compareToolSource, /when both snapshots are legacy v0\.2/);
assert.match(compareToolSource, /Mixed v0\.2\/v0\.3 comparisons remain unsupported/);

const nativeSpatialHelpersSource = read(path.join(
  repositoryRoot,
  "src",
  "revit-plugin",
  "revAgentCommandSet",
  "Commands",
  "Spatial",
  "SpatialSnapshotHelpers.cs",
));
assert.match(nativeSpatialHelpersSource, /JObject centerline = source\["centerline"\] as JObject;/,
  "Native v0.3 fingerprinting must treat null centerline tokens as non-object geometry.");
assert.match(nativeSpatialHelpersSource, /JObject aabb = source\["aabb"\] as JObject;/,
  "Native v0.3 fingerprinting must treat null AABB tokens as non-object geometry.");
assert.doesNotMatch(nativeSpatialHelpersSource, /source\["centerline"\]\s*!=\s*null\s*\?\s*source\["centerline"\]\["points"\]/,
  "Native v0.3 fingerprinting must not index a Newtonsoft JValue null token as an object.");
assert.match(nativeSpatialHelpersSource, /peerConnectorType, "Reference"/,
  "Native v0.3 topology must ignore non-topological insulation/reference bindings from Connector.AllRefs.");
assert.match(nativeSpatialHelpersSource, /peerOwner is MEPSystem/,
  "Native v0.3 topology must keep MEPSystem container membership out of element adjacency.");

console.log("spatial Phase 1b contract tests: ok");
