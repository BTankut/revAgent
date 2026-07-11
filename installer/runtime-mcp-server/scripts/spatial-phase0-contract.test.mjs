import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "..");
const schemaRoot = path.join(packageRoot, "schemas", "spatial", "v0.1");
const fixturePath = path.join(__dirname, "fixtures", "spatial", "double-placed-link.golden.json");
const repoRoot = process.env.REVIT_MCP_REPO_ROOT
  ? path.resolve(process.env.REVIT_MCP_REPO_ROOT)
  : path.resolve(packageRoot, "..", "..");
const draft202012 = "https://json-schema.org/draft/2020-12/schema";

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function canonicalJson(value) {
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error("Spatial canonical JSON rejects non-finite numbers.");
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function semanticCanonicalJson(value) {
  if (value === null) return "null";
  if (typeof value === "number") {
    assert.ok(Number.isFinite(value), "Semantic spatial JSON rejects non-finite numbers.");
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
}

assert.equal(canonicalJson(1.0), "1");
assert.equal(canonicalJson(-0.0), "0");
assert.equal(canonicalJson(0.000001), "0.000001");
assert.equal(canonicalJson(1e-7), "1e-7");
assert.equal(canonicalJson(1e20), "100000000000000000000");
assert.equal(canonicalJson(1e21), "1e+21");
assert.throws(() => canonicalJson(Number.NaN), /non-finite/);
assert.throws(() => canonicalJson(Number.POSITIVE_INFINITY), /non-finite/);

function sha256(value) {
  return `sha256:${crypto.createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
}

function nodeIdFor(elementRef) {
  const placement = elementRef.linkInstanceUniqueId ?? "host";
  const basis = `revit_element|${elementRef.documentKey}|${placement}|${elementRef.elementUniqueId}`;
  return `node:sha256:${crypto.createHash("sha256").update(basis, "utf8").digest("hex")}`;
}

function assertRequired(schema, names, label) {
  for (const name of names) {
    assert.ok(schema.required?.includes(name), `${label} must require ${name}.`);
  }
}

function assertStrictShape(value, schema, label) {
  assertRequired(schema, schema.required ?? [], label);
  for (const name of schema.required ?? []) {
    assert.ok(Object.hasOwn(value, name), `${label} is missing required ${name}.`);
  }
  if (schema.additionalProperties === false) {
    for (const name of Object.keys(value)) {
      assert.ok(Object.hasOwn(schema.properties ?? {}, name), `${label} has undeclared property ${name}.`);
    }
  }
}

function resolveJsonPointer(document, fragment, refLabel) {
  if (!fragment || fragment === "#") return document;
  assert.ok(fragment.startsWith("#/"), `${refLabel} must use a JSON Pointer fragment.`);
  return fragment
    .slice(2)
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
    .reduce((value, part) => {
      assert.ok(value && Object.hasOwn(value, part), `${refLabel} points to missing segment ${part}.`);
      return value[part];
    }, document);
}

function collectRefs(value, refs = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectRefs(item, refs);
  } else if (value !== null && typeof value === "object") {
    if (typeof value.$ref === "string") refs.push(value.$ref);
    for (const child of Object.values(value)) collectRefs(child, refs);
  }
  return refs;
}

const schemaFiles = {
  elementRef: "element-ref.schema.json",
  nodeRef: "node-ref.schema.json",
  sourceRevision: "source-revision.schema.json",
  cursorEnvelope: "cursor-envelope.schema.json",
  spatialSnapshot: "spatial-snapshot.schema.json",
  extractionPage: "extraction-page.schema.json",
};
const schemas = Object.fromEntries(
  Object.entries(schemaFiles).map(([name, file]) => [name, readJson(path.join(schemaRoot, file))]),
);

const spatialHelpersSource = fs.readFileSync(
  path.join(repoRoot, "src", "revit-plugin", "revAgentCommandSet", "Commands", "Spatial", "SpatialSnapshotHelpers.cs"),
  "utf8",
);
for (const field of ["activePhase", "designOptionsInEffect", "worksetVisibilityPolicy"]) {
  assert.ok(spatialHelpersSource.includes(`{ "${field}",`), `Native scope must emit ${field}.`);
}
assert.ok(
  spatialHelpersSource.includes('{ "emittedScopeSemantics", emittedScopeSemantics }'),
  "Native scope fingerprint must bind the exact emitted Phase 0 scope policy values.",
);
assert.ok(
  spatialHelpersSource.includes("return Sha256(CanonicalJson(fingerprintBasis));"),
  "Native scope fingerprint basis must use canonical JSON.",
);
assert.ok(
  spatialHelpersSource.includes("string roundTrip = ShortestRoundTrip(absolute);")
    && spatialHelpersSource.includes('value.ToString("G15", CultureInfo.InvariantCulture)')
    && spatialHelpersSource.includes("for (int precision = 16; precision <= 17; precision++)")
    && spatialHelpersSource.includes("BitConverter.DoubleToInt64Bits(parsed) == expectedBits"),
  "Native canonical JSON must select the shortest exact double representation before applying ECMAScript exponent thresholds.",
);
assert.ok(
  spatialHelpersSource.includes("bool requiresHostVolumeOverlap = !source.IsHost"),
  "Linked obstruction scope must require transformed host-volume overlap.",
);
assert.ok(
  spatialHelpersSource.includes("if (!requiresHostVolumeOverlap && ("),
  "Linked level-name equality must not independently make an obstruction eligible.",
);
assert.ok(
  spatialHelpersSource.includes('if (requiresHostVolumeOverlap) return "scope_unresolved";'),
  "Linked obstructions without transformed bounds must be classified as unresolved, not silently eligible.",
);
assert.ok(
  spatialHelpersSource.includes("jsonReader.DateParseHandling = DateParseHandling.None;"),
  "Signed cursor decoding must preserve capturedAt as the schema-declared JSON string.",
);

for (const [name, schema] of Object.entries(schemas)) {
  assert.equal(schema.$schema, draft202012, `${name} must use JSON Schema draft 2020-12.`);
  assert.match(schema.$id, /^https:\/\/schemas\.revagent\.app\/spatial\/v0\.1\//);
  assert.equal(schema.type, "object", `${name} must be an object contract.`);
  assert.equal(schema.additionalProperties, false, `${name} must reject undeclared top-level fields.`);

  for (const ref of collectRefs(schema)) {
    const [relativeFile, rawFragment] = ref.split("#", 2);
    const targetFile = relativeFile
      ? path.resolve(schemaRoot, relativeFile)
      : path.join(schemaRoot, schemaFiles[name]);
    assert.ok(targetFile.startsWith(schemaRoot), `${name} must not reference outside the versioned schema directory.`);
    assert.ok(fs.existsSync(targetFile), `${name} has unresolved schema ref ${ref}.`);
    const target = readJson(targetFile);
    resolveJsonPointer(target, rawFragment === undefined ? "" : `#${rawFragment}`, `${name} ${ref}`);
  }
}

assertRequired(
  schemas.elementRef,
  ["documentKey", "documentSessionId", "elementUniqueId", "elementId", "sourceKind"],
  "ElementRef",
);
assert.deepEqual(schemas.elementRef.properties.sourceKind.enum, ["host", "link"]);
assert.ok(
  schemas.elementRef.allOf.some((rule) => rule.if?.properties?.sourceKind?.const === "link"
    && rule.then?.required?.includes("linkInstanceUniqueId")
    && rule.then?.properties?.linkInstanceUniqueId),
  "Linked ElementRef must require placement identity.",
);
assert.ok(
  schemas.elementRef.allOf.some((rule) => rule.if?.properties?.sourceKind?.const === "host"
    && rule.then?.properties?.linkInstanceUniqueId === false),
  "Host ElementRef must forbid linked placement identity.",
);

assertRequired(schemas.nodeRef, ["nodeId", "nodeKind", "sourceRefs"], "NodeRef");
assert.equal(schemas.nodeRef.properties.elementRef.$ref, "./element-ref.schema.json");
assert.deepEqual(schemas.nodeRef.$defs.nodeKind.enum, ["revit_element", "connector", "derived"]);
for (const [kind, refName] of [
  ["revit_element", "elementRef"],
  ["connector", "connectorRef"],
  ["derived", "derivedRef"],
]) {
  assert.ok(
    schemas.nodeRef.allOf.some((rule) => rule.if?.properties?.nodeKind?.const === kind
      && rule.then?.required?.includes(refName)
      && rule.then?.properties?.[refName]
      && ["elementRef", "connectorRef", "derivedRef"]
        .filter((candidate) => candidate !== refName)
        .every((candidate) => rule.then?.properties?.[candidate] === false)),
    `NodeRef ${kind} must require ${refName}.`,
  );
}

assertRequired(
  schemas.sourceRevision,
  ["documentKey", "documentSessionId", "loadedVersion", "changeSequence", "changeSequenceState", "sourceToHostTransform"],
  "SourceRevision",
);
const transformSchema = schemas.sourceRevision.$defs.sourceToHostTransform;
assert.equal(transformSchema.properties.toFrame.const, "host_internal_mm");
assert.equal(transformSchema.properties.lengthUnit.const, "mm");
assert.equal(transformSchema.properties.matrix.minItems, 16);
assert.equal(transformSchema.properties.matrix.maxItems, 16);
assert.equal(schemas.sourceRevision.properties.changeSequence.const, 0);
assert.equal(schemas.sourceRevision.properties.changeSequenceState.const, "unknown_phase0_sentinel");

assertRequired(
  schemas.cursorEnvelope,
  [
    "cursorVersion",
    "captureId",
    "pageOrdinal",
    "sortPosition",
    "priorPageHash",
    "revisionFingerprint",
    "scopeFingerprint",
    "capturedAt",
  ],
  "CursorEnvelope",
);
assert.equal(schemas.cursorEnvelope.properties.cursorVersion.const, "0.1");
assert.equal(schemas.cursorEnvelope.properties.revisionFingerprint.$ref, "#/$defs/sha256");
assert.equal(schemas.cursorEnvelope.properties.scopeFingerprint.$ref, "#/$defs/sha256");
assert.equal(schemas.cursorEnvelope.properties.capturedAt.format, "date-time");
assertRequired(
  schemas.cursorEnvelope.$defs.sortPosition,
  ["documentKey", "linkPlacementKey", "nodeKind", "stableSourceIdentity"],
  "CursorEnvelope.sortPosition",
);
assert.deepEqual(
  schemas.cursorEnvelope.$defs.sortPosition.properties.nodeKind.enum,
  ["revit_element", "connector", "derived", "revit_element_omission", "source_omission"],
);

assertRequired(
  schemas.spatialSnapshot,
  [
    "snapshotId",
    "capturedAt",
    "sourceRevisions",
    "scope",
    "scopeFingerprint",
    "revisionFingerprint",
    "coordinateFrame",
    "lengthUnit",
    "schemaVersion",
    "extractorVersion",
    "counts",
    "partial",
    "scanStoppedReason",
    "suggestedNextScopes",
    "pageCount",
    "payloadBytes",
  ],
  "SpatialSnapshot",
);
assert.equal(schemas.spatialSnapshot.properties.sourceRevisions.items.$ref, "./source-revision.schema.json");
assert.equal(schemas.spatialSnapshot.properties.coordinateFrame.const, "host_internal_mm");
assert.equal(schemas.spatialSnapshot.$defs.scope.properties.coordinateFrame.const, "host_internal_mm");
assert.equal(schemas.spatialSnapshot.properties.lengthUnit.const, "mm");
assert.equal(schemas.spatialSnapshot.properties.schemaVersion.const, "0.1");
assertRequired(
  schemas.extractionPage,
  [
    "resultContractVersion",
    "captureId",
    "snapshotId",
    "sourceRevisions",
    "scope",
    "effectiveSourcePolicy",
    "nodes",
    "omissions",
    "counts",
    "page",
    "pageCount",
    "payloadBytes",
  ],
  "SpatialExtractionPage",
);
assert.equal(schemas.extractionPage.properties.sourceRevisions.items.$ref, "./source-revision.schema.json");
assert.equal(schemas.extractionPage.$defs.nodeRecord.properties.nodeRef.$ref, "./node-ref.schema.json");
assert.equal(schemas.extractionPage.$defs.nodeRecord.properties.elementRef.$ref, "./element-ref.schema.json");
assert.equal(schemas.extractionPage.$defs.page.additionalProperties, false);
assert.ok(schemas.extractionPage.$defs.page.required.includes("rows"));
assert.ok(!Object.hasOwn(schemas.extractionPage.properties, "rows"));
assert.equal(schemas.extractionPage.properties.effectiveSourcePolicy.$ref, "#/$defs/effectiveSourcePolicy");
assert.equal(schemas.extractionPage.$defs.coverage.properties.effectiveScope.const, true);
assert.equal(schemas.extractionPage.$defs.scanPolicy.properties.pagePayloadBasis.const, "canonical_ieee754_rows_utf8_v1");
assert.deepEqual(schemas.extractionPage.$defs.pointLocation.properties.rotationRadians.type, ["number", "null"]);
assert.ok(
  spatialHelpersSource.includes("try { rotationRadians = location.Rotation; }")
    && spatialHelpersSource.includes('{ "rotationRadians", rotationRadians }'),
  "SpatialElement point locations must preserve unsupported Revit rotation as null instead of omitting Room/Space geometry.",
);
const liveVerifierSource = fs.readFileSync(path.join(repoRoot, "scripts", "verify-spatial-phase0-pages.mjs"), "utf8");
assert.ok(
  liveVerifierSource.includes("firstCaptureRawResponses") && liveVerifierSource.includes("JSON.parse(rawResponse)"),
  "The independent live verifier must hash exact raw JSON-RPC page values rather than PowerShell-reserialized coordinates.",
);
const socketServiceSource = fs.readFileSync(
  path.join(repoRoot, "src", "revit-plugin", "revAgentPlugin", "Core", "SocketService.cs"),
  "utf8",
);
assert.ok(
  socketServiceSource.includes('string.Equals(request.Method, "extract_spatial_snapshot", StringComparison.OrdinalIgnoreCase)')
    && socketServiceSource.includes('ExtractRequestParamBool(request, "suppressTaskStatusWindow")')
    && socketServiceSource.includes("if (!suppressTaskStatusWindow) McpTaskStatusWindowController.Instance.ShowCompleted(completedTask);"),
  "Only the read-only paged spatial extractor may suppress its per-page status window while retaining task history.",
);
assert.equal(schemas.extractionPage.$defs.scanPolicy.properties.maxElapsedMs.maximum, 25000);
const spatialCommandSource = fs.readFileSync(
  path.join(repoRoot, "src", "revit-plugin", "revAgentCommandSet", "Commands", "Spatial", "ExtractSpatialSnapshotCommand.cs"),
  "utf8",
);
assert.ok(
  spatialCommandSource.includes('ReadInt(parameters, "maxElapsedMs", 4500, 250, 25000)'),
  "The native explicitly scoped audit budget must allow up to 25 seconds while retaining the 4.5 second default.",
);
for (const scanPolicyField of [
  "pagePayloadBasis",
  "hardPageCap",
  "maxGeometryPointsPerElement",
  "maxBoundarySegmentsPerElement",
  "selectionAndFilteringBeforeMaxElements",
  "cursorIntegrity",
  "cursorInvalidAfterRestart",
]) {
  assert.ok(schemas.extractionPage.$defs.scanPolicy.required.includes(scanPolicyField), `Scan policy must require ${scanPolicyField}.`);
}
for (const phase1aField of ["journal", "staging", "rtree", "migration", "documentChangedTracker"] ) {
  assert.ok(!Object.hasOwn(schemas.spatialSnapshot.properties, phase1aField), `Phase 1a field ${phase1aField} is out of scope.`);
}

const fixture = readJson(fixturePath);
const { snapshot } = fixture;
assert.equal(fixture.fixtureVersion, "0.1");
assert.equal(fixture.scenario, "double_placed_link");
assertStrictShape(snapshot, schemas.spatialSnapshot, "fixture SpatialSnapshot");
assert.equal(snapshot.coordinateFrame, "host_internal_mm");
assert.equal(snapshot.scope.coordinateFrame, "host_internal_mm");
assert.equal(snapshot.lengthUnit, "mm");
assert.equal(snapshot.partial, false);
assert.equal(snapshot.scanStoppedReason, "completed");

for (const [index, revision] of snapshot.sourceRevisions.entries()) {
  assertStrictShape(revision, schemas.sourceRevision, `sourceRevisions[${index}]`);
  assertStrictShape(
    revision.sourceToHostTransform,
    schemas.sourceRevision.$defs.sourceToHostTransform,
    `sourceRevisions[${index}].sourceToHostTransform`,
  );
  assert.equal(revision.sourceToHostTransform.toFrame, "host_internal_mm");
  assert.equal(revision.sourceToHostTransform.lengthUnit, "mm");
}

assert.equal(snapshot.scopeFingerprint, sha256(fixture.fingerprintEvidence.scopeBasis));
assert.equal(snapshot.revisionFingerprint, sha256(fixture.fingerprintEvidence.revisionBasis));
const scopeBasisJson = canonicalJson(fixture.fingerprintEvidence.scopeBasis);
for (const revisionOnlyField of ["loadedVersion", "changeSequence", "linkInstanceUniqueId"]) {
  assert.ok(!scopeBasisJson.includes(revisionOnlyField), `Scope fingerprint must exclude ${revisionOnlyField}.`);
  assert.ok(
    canonicalJson(fixture.fingerprintEvidence.revisionBasis).includes(revisionOnlyField),
    `Revision fingerprint must include ${revisionOnlyField}.`,
  );
}

const rows = fixture.pages.flatMap((page) => page.rows);
const nodeIds = rows.map((row) => row.node.nodeId);
assert.equal(new Set(nodeIds).size, nodeIds.length, "Paged extraction must not duplicate node ids.");
assert.deepEqual(nodeIds, fixture.acceptanceEvidence.pagination.expectedOrderedNodeIds);
assert.deepEqual(fixture.acceptanceEvidence.pagination.duplicateNodeIds, []);
assert.deepEqual(fixture.acceptanceEvidence.pagination.omittedNodeIds, []);
assert.equal(snapshot.pageCount, fixture.pages.length);
assert.equal(snapshot.pageCount, fixture.acceptanceEvidence.pagination.expectedPageCount);

function orderTuple(row) {
  const key = row.orderKey;
  return [key.documentKey, key.linkPlacementKey, key.nodeKind, key.stableSourceIdentity];
}

function compareTuple(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] < right[index]) return -1;
    if (left[index] > right[index]) return 1;
  }
  return 0;
}

for (let index = 1; index < rows.length; index += 1) {
  assert.ok(compareTuple(orderTuple(rows[index - 1]), orderTuple(rows[index])) < 0, "Rows must be globally ordered.");
}

for (const [index, row] of rows.entries()) {
  assertStrictShape(row.node, schemas.nodeRef, `rows[${index}].node`);
  assertStrictShape(row.node.elementRef, schemas.elementRef, `rows[${index}].node.elementRef`);
  const elementRef = row.node.elementRef;
  assert.equal(row.node.nodeKind, "revit_element");
  assert.equal(row.node.nodeId, nodeIdFor(elementRef));
  assert.equal(row.orderKey.documentKey, elementRef.documentKey);
  assert.equal(row.orderKey.linkPlacementKey, elementRef.linkInstanceUniqueId ?? "host");
  assert.equal(row.orderKey.nodeKind, row.node.nodeKind);
  assert.equal(row.orderKey.stableSourceIdentity, elementRef.elementUniqueId);
  assert.equal(row.node.sourceRefs.length, 1);
  assert.equal(row.node.sourceRefs[0].documentKey, elementRef.documentKey);
  assert.equal(row.node.sourceRefs[0].documentSessionId, elementRef.documentSessionId);
  assert.equal(row.node.sourceRefs[0].linkInstanceUniqueId, elementRef.linkInstanceUniqueId);
}

const doublePlaced = rows.filter((row) => row.node.elementRef.documentKey === "cloud:office:architecture"
  && row.node.elementRef.elementUniqueId === "ARCH-ROOM-101-UID");
assert.equal(doublePlaced.length, 2, "Golden fixture must contain both placements of the same linked Room.");
assert.equal(new Set(doublePlaced.map((row) => row.node.elementRef.linkInstanceUniqueId)).size, 2);
assert.equal(new Set(doublePlaced.map((row) => row.node.nodeId)).size, 2);
assert.equal(new Set(doublePlaced.map((row) => row.node.elementRef.elementId)).size, 1);
const doublePlacedTransforms = doublePlaced.map((row) => {
  const ref = row.node.elementRef;
  return snapshot.sourceRevisions.find((revision) => revision.documentKey === ref.documentKey
    && revision.linkInstanceUniqueId === ref.linkInstanceUniqueId).sourceToHostTransform.matrix;
});
assert.notDeepEqual(doublePlacedTransforms[0], doublePlacedTransforms[1]);

let priorPageHash = null;
let totalPayloadBytes = 0;
for (const [index, page] of fixture.pages.entries()) {
  assert.equal(page.pageOrdinal, index);
  assert.equal(page.priorPageHash, priorPageHash);
  assert.equal(page.rowCount, page.rows.length);
  const payloadBytes = Buffer.byteLength(semanticCanonicalJson(page.rows), "utf8");
  assert.equal(page.payloadBytes, payloadBytes);
  totalPayloadBytes += payloadBytes;
  const expectedHash = sha256({
    captureId: fixture.captureId,
    pageOrdinal: page.pageOrdinal,
    priorPageHash,
    rows: page.rows,
  });
  assert.equal(page.pageHash, expectedHash);

  if (index < fixture.pages.length - 1) {
    assertStrictShape(page.nextCursorEnvelope, schemas.cursorEnvelope, `pages[${index}].nextCursorEnvelope`);
    assert.equal(page.nextCursorEnvelope.captureId, fixture.captureId);
    assert.equal(page.nextCursorEnvelope.pageOrdinal, index + 1);
    assert.deepEqual(page.nextCursorEnvelope.sortPosition, page.rows.at(-1).orderKey);
    assert.equal(page.nextCursorEnvelope.priorPageHash, page.pageHash);
    assert.equal(page.nextCursorEnvelope.revisionFingerprint, snapshot.revisionFingerprint);
    assert.equal(page.nextCursorEnvelope.scopeFingerprint, snapshot.scopeFingerprint);
    assert.equal(page.nextCursorEnvelope.capturedAt, snapshot.capturedAt);
    const cursorPayload = Buffer.from(canonicalJson(page.nextCursorEnvelope), "utf8");
    const cursorSignature = crypto
      .createHmac("sha256", Buffer.from(fixture.algorithms.fixtureCursorHmacKeyBase64, "base64"))
      .update(cursorPayload)
      .digest();
    const encoded = `spatial-cursor-v0.1.${cursorPayload.toString("base64url")}.${cursorSignature.toString("base64url")}`;
    assert.equal(page.nextCursor, encoded);
    const cursorBody = page.nextCursor.slice("spatial-cursor-v0.1.".length);
    const cursorSegments = cursorBody.split(".");
    assert.equal(cursorSegments.length, 2);
    assert.equal(Buffer.from(cursorSegments[1], "base64url").length, 32);
    const decoded = JSON.parse(Buffer.from(cursorSegments[0], "base64url").toString("utf8"));
    assert.deepEqual(decoded, page.nextCursorEnvelope);
  } else {
    assert.equal(page.nextCursor, null);
    assert.equal(page.nextCursorEnvelope, null);
  }
  priorPageHash = page.pageHash;
}
assert.equal(snapshot.payloadBytes, totalPayloadBytes);

const coverage = fixture.acceptanceEvidence.coverage;
assert.equal(snapshot.counts.totalNodes, rows.length);
assert.equal(snapshot.counts.extractedSupportedNodes, rows.length);
assert.equal(snapshot.counts.expectedSupportedNodes, coverage.expectedSupportedNodeCount);
assert.equal(snapshot.counts.omittedSupportedNodes, coverage.omittedSupportedNodeCount);
assert.equal(coverage.extractedSupportedNodeCount + coverage.omittedSupportedNodeCount, coverage.expectedSupportedNodeCount);
assert.equal(coverage.ratio, coverage.extractedSupportedNodeCount / coverage.expectedSupportedNodeCount);
assert.ok(coverage.ratio >= 0.995, "Fixture extraction coverage must meet the Phase 0 gate.");
assert.equal(coverage.classifiedOmissions.length, coverage.omittedSupportedNodeCount);
assert.equal(fixture.acceptanceEvidence.stableIdentity.ratio, 1);
assert.equal(fixture.acceptanceEvidence.manualAudit.status, "complete");

function applyMatrix(matrix, point) {
  const input = [...point, 1];
  const output = Array.from({ length: 4 }, (_, row) => matrix
    .slice(row * 4, row * 4 + 4)
    .reduce((sum, coefficient, column) => sum + coefficient * input[column], 0));
  assert.notEqual(output[3], 0, "Affine point must have a nonzero homogeneous coordinate.");
  return output.slice(0, 3).map((value) => value / output[3]);
}

function invert4x4(matrix) {
  const augmented = Array.from({ length: 4 }, (_, row) => [
    ...matrix.slice(row * 4, row * 4 + 4),
    ...Array.from({ length: 4 }, (_, column) => (row === column ? 1 : 0)),
  ]);
  for (let column = 0; column < 4; column += 1) {
    let pivotRow = column;
    for (let row = column + 1; row < 4; row += 1) {
      if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivotRow][column])) pivotRow = row;
    }
    assert.ok(Math.abs(augmented[pivotRow][column]) > 1e-12, "Transform must be invertible.");
    [augmented[column], augmented[pivotRow]] = [augmented[pivotRow], augmented[column]];
    const pivot = augmented[column][column];
    augmented[column] = augmented[column].map((value) => value / pivot);
    for (let row = 0; row < 4; row += 1) {
      if (row === column) continue;
      const factor = augmented[row][column];
      augmented[row] = augmented[row].map((value, index) => value - factor * augmented[column][index]);
    }
  }
  return augmented.flatMap((row) => row.slice(4));
}

function pointDistance(left, right) {
  return Math.hypot(...left.map((value, index) => value - right[index]));
}

const transformAudit = fixture.acceptanceEvidence.transformRoundTrip;
let maxRoundTripError = 0;
for (const sample of transformAudit.samples) {
  const revision = snapshot.sourceRevisions.find((candidate) => candidate.documentKey === sample.documentKey
    && (candidate.linkInstanceUniqueId ?? null) === sample.linkInstanceUniqueId);
  assert.ok(revision, `Missing source revision for ${sample.documentKey}/${sample.linkInstanceUniqueId ?? "host"}.`);
  const matrix = revision.sourceToHostTransform.matrix;
  const hostPoint = applyMatrix(matrix, sample.sourcePointMm);
  assert.ok(pointDistance(hostPoint, sample.expectedHostPointMm) <= 1e-9);
  const roundTripPoint = applyMatrix(invert4x4(matrix), hostPoint);
  assert.ok(pointDistance(roundTripPoint, sample.expectedRoundTripPointMm) <= 1e-9);
  const error = pointDistance(roundTripPoint, sample.sourcePointMm);
  assert.equal(error, sample.observedRoundTripErrorMm);
  assert.ok(error <= transformAudit.toleranceMm);
  maxRoundTripError = Math.max(maxRoundTripError, error);
}
assert.equal(maxRoundTripError, transformAudit.maxObservedErrorMm);
assert.ok(maxRoundTripError <= 0.5, "Transform inverse round-trip must be within 0.5 mm.");

for (const row of rows) {
  const ref = row.node.elementRef;
  const revision = snapshot.sourceRevisions.find((candidate) => candidate.documentKey === ref.documentKey
    && (candidate.linkInstanceUniqueId ?? null) === (ref.linkInstanceUniqueId ?? null));
  assert.ok(pointDistance(applyMatrix(revision.sourceToHostTransform.matrix, row.sourcePointMm), row.hostPointMm) <= 1e-9);
}

const probeEvidence = fixture.boundedProbeEvidence;
assert.equal(probeEvidence.contractVersion, "0.1");
assert.ok(Array.isArray(probeEvidence.probes));
assert.ok(probeEvidence.probes.length >= 3, "Phase 0 must record plural bounded-evidence probes.");
assert.equal(new Set(probeEvidence.probes.map((probe) => probe.probeId)).size, probeEvidence.probes.length);

for (const probe of probeEvidence.probes) {
  const operationOutput = probe.deterministicOperationOutput;
  assert.equal(probe.input.snapshotId, snapshot.snapshotId);
  assert.equal(operationOutput.snapshotId, snapshot.snapshotId);
  assert.equal(operationOutput.revisionFingerprint, snapshot.revisionFingerprint);
  assert.equal(operationOutput.rowCount, operationOutput.evidenceRows.length);
  assert.ok(operationOutput.rowCount <= probe.bounds.maxEvidenceRows);
  assert.ok(operationOutput.rowCount < rows.length, "Probe input must be bounded evidence, not a whole-graph dump.");
  assert.equal(operationOutput.truncated, false);
  assert.equal(probe.evidenceBytes, Buffer.byteLength(canonicalJson(operationOutput), "utf8"));
  assert.ok(probe.evidenceBytes <= probe.bounds.maxEvidenceBytes);
  assert.equal(probe.operationOutputHash, sha256(operationOutput));
  assert.equal(probe.llmProbe.inputMode, "bounded_deterministic_operation_output");
  assert.equal(probe.llmProbe.wholeGraphProvided, false);
  assert.ok(probe.llmProbe.prompt.length > 0);
  assert.ok(probe.llmProbe.response.length > 0);
  assert.ok(probe.llmProbe.assessmentCode.length > 0);
  const evidenceNodeIds = operationOutput.evidenceRows.map((row) => row.nodeId);
  assert.deepEqual(probe.llmProbe.citedNodeIds, evidenceNodeIds);
  for (const evidenceRow of operationOutput.evidenceRows) {
    const sourceRow = rows.find((row) => row.node.nodeId === evidenceRow.nodeId);
    assert.ok(sourceRow, `Probe cites unknown node ${evidenceRow.nodeId}.`);
    if (Object.hasOwn(evidenceRow, "linkInstanceUniqueId")) {
      assert.equal(evidenceRow.linkInstanceUniqueId, sourceRow.node.elementRef.linkInstanceUniqueId);
    }
    assert.deepEqual(evidenceRow.hostPointMm, sourceRow.hostPointMm);
  }
}

const placementProbe = probeEvidence.probes.find((probe) => probe.operation === "lookup_link_placements_for_source_element");
assert.equal(placementProbe.deterministicOperationOutput.resultCode, "two_distinct_placements");
assert.equal(new Set(placementProbe.deterministicOperationOutput.evidenceRows
  .map((row) => row.linkInstanceUniqueId)).size, 2);

const verticalProbe = probeEvidence.probes.find((probe) => probe.operation === "compare_vertical_relation");
const [firstVerticalRow, secondVerticalRow] = verticalProbe.deterministicOperationOutput.evidenceRows;
assert.equal(
  verticalProbe.deterministicOperationOutput.computed.deltaZMm,
  firstVerticalRow.hostPointMm[2] - secondVerticalRow.hostPointMm[2],
);
assert.equal(verticalProbe.deterministicOperationOutput.computed.relation, "above");

const clearanceProbe = probeEvidence.probes.find((probe) => probe.operation === "assess_clearance_verdict_capability");
assert.equal(clearanceProbe.deterministicOperationOutput.verdictCapability, "context_only");
assert.equal(clearanceProbe.deterministicOperationOutput.clearanceVerdict, null);
assert.equal(clearanceProbe.llmProbe.assessmentCode, "clearance_verdict_refused");

console.log("spatial Phase 0 contract and golden fixture tests: ok");
