import assert from "node:assert/strict";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import {
  SpatialStore,
  SpatialStoreMigrationError,
  SpatialStorePathError,
  assertSpatialLocalFilesystemPath,
  resolveSpatialArtifactRoot,
  resolveSpatialDatabasePath,
} from "../build/spatial/spatialStore.js";
import { evaluateSpatialLiveness } from "../build/spatial/spatialLiveness.js";

const DAY = 24 * 60 * 60 * 1000;
const root = mkdtempSync(join(tmpdir(), "revagent-spatial-phase1a-"));
let clock = 200 * DAY;

assert.throws(
  () => assertSpatialLocalFilesystemPath("Z:\\revAgent\\spatial.db", "Mapped spatial test", () => 4),
  (error) => error instanceof SpatialStorePathError && error.reason === "network_path",
);
for (const driveType of [null, 0, 1, 5]) {
  assert.throws(
    () => assertSpatialLocalFilesystemPath("Q:\\revAgent\\spatial.db", "Unverified spatial test", () => driveType),
    (error) => error instanceof SpatialStorePathError && error.reason === "network_path",
  );
}
assert.equal(
  assertSpatialLocalFilesystemPath(join(root, "fixed-drive", "spatial.db"), "Fixed spatial test", () => 3),
  resolve(join(root, "fixed-drive", "spatial.db")),
);
assert.throws(
  () => new SpatialStore({
    databasePath: join(root, "mapped-constructor", "spatial.db"),
    testHooks: { readWindowsDriveType: () => 4 },
    retentionPolicy: false,
  }),
  (error) => error instanceof SpatialStorePathError && error.reason === "network_path",
);

function identityTransform() {
  return {
    representation: "affine_4x4_row_major",
    fromFrame: "source_internal",
    toFrame: "host_internal_mm",
    lengthUnit: "mm",
    matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
  };
}

function source(documentKey, sequence = 10, extra = {}) {
  return {
    documentKey,
    documentSessionId: `session:${documentKey}`,
    trackerSessionId: `tracker:${documentKey}`,
    loadedVersion: `loaded:${documentKey}`,
    changeSequence: sequence,
    changeSequenceState: "tracked",
    oldestRetainedSequence: Math.max(0, sequence - 5),
    journalEntryCount: 5,
    journalCapacity: 100,
    journalTruncated: false,
    documentKeyResolution: {
      resolverVersion: "phase1a-test",
      basis: "saved_standalone",
      crossSessionComparable: true,
    },
    sourceToHostTransform: identityTransform(),
    ...extra,
  };
}

function captureOnePage(store, {
  captureId,
  snapshotId,
  documentKey,
  capturedAtMs,
  partial = false,
  artifactPaths = [],
  nodeAabb = null,
}) {
  store.beginCapture({
    captureId,
    snapshotId,
    documentKey,
    scopeFingerprint: `scope:${documentKey}`,
    revisionFingerprint: `revision:${snapshotId}`,
    schemaVersion: "0.2",
    extractorVersion: "phase1a-test",
    scope: { documentKey, coordinateFrame: "host_internal_mm" },
    counts: { expectedSupportedNodes: 1 },
    effectiveSourcePolicy: { includeHost: true },
    coverage: { complete: !partial },
    transformValidation: { maxRoundTripErrorMm: 0 },
    captureMetadata: { atomic: true },
    capturedAtMs,
    expiresAtMs: clock + DAY,
    artifactPaths,
  });
  store.stagePage({
    captureId,
    ordinal: 0,
    pageHash: `hash:${snapshotId}:0`,
    hasMore: false,
    payloadBytes: 128,
    nodes: [{
      nodeId: `node:${snapshotId}`,
      documentKey,
      nodeKind: "revit_element",
      aabb: nodeAabb,
      payload: { snapshotId },
    }],
  });
  return store.commitCapture({
    captureId,
    sourceRevisions: [source(documentKey)],
    counts: {
      totalNodes: 1,
      nodesByKind: { revit_element: 1, connector: 0, derived: 0 },
      expectedSupportedNodes: 1,
      extractedSupportedNodes: 1,
      omittedSupportedNodes: 0,
      omissionsByReason: {},
    },
    coverage: {
      totalOrderedRowCount: 1,
      sourceAvailabilityOmissionCount: 0,
      complete: !partial,
    },
    expectedPageCount: 1,
    expectedPayloadBytes: 128,
    expectedNodeCount: 1,
    expectedOmissionCount: 0,
    expectedNodesByKind: { revit_element: 1, connector: 0, derived: 0 },
    partial,
    coverageStatus: partial ? "incomplete_budget" : "complete",
    scanStoppedReason: partial ? "max_elapsed" : "completed",
  });
}

try {
  const oldLocalAppData = process.env.LOCALAPPDATA;
  const oldOverride = process.env.REVAGENT_SPATIAL_DB_PATH;
  const fakeLocalAppData = join(root, "LocalAppData");
  delete process.env.REVAGENT_SPATIAL_DB_PATH;
  process.env.LOCALAPPDATA = fakeLocalAppData;
  assert.equal(
    resolveSpatialDatabasePath(),
    join(fakeLocalAppData, "revAgent", "spatial", "spatial.db"),
  );
  const configuredPath = join(root, "override", "custom.db");
  process.env.REVAGENT_SPATIAL_DB_PATH = configuredPath;
  assert.equal(resolveSpatialDatabasePath(), resolve(configuredPath));
  assert.throws(
    () => resolveSpatialDatabasePath("\\\\nas-server\\revagent\\spatial.db"),
    (error) => error instanceof SpatialStorePathError && error.reason === "network_path",
  );
  assert.throws(
    () => resolveSpatialDatabasePath(resolve("managed-spatial.db")),
    (error) => error instanceof SpatialStorePathError && error.reason === "managed_package_path",
  );
  assert.equal(
    resolveSpatialArtifactRoot(configuredPath),
    resolve(join(root, "override", "artifacts")),
  );
  if (oldLocalAppData === undefined) delete process.env.LOCALAPPDATA;
  else process.env.LOCALAPPDATA = oldLocalAppData;
  if (oldOverride === undefined) delete process.env.REVAGENT_SPATIAL_DB_PATH;
  else process.env.REVAGENT_SPATIAL_DB_PATH = oldOverride;

  const databasePath = join(root, "store", "spatial.db");
  const store = new SpatialStore({
    databasePath,
    artifactRoot: join(root, "artifacts"),
    now: () => clock,
  });
  assert.deepEqual(store.getSchemaVersion(), { major: 1, minor: 2 });
  assert.equal(store.isRTreeAvailable(), true);
  assert.throws(() => store.beginCapture({
    captureId: "capture:unsafe-artifact",
    snapshotId: "snapshot:unsafe-artifact",
    documentKey: "doc:unsafe-artifact",
    scopeFingerprint: "scope:unsafe-artifact",
    revisionFingerprint: "revision:unsafe-artifact",
    schemaVersion: "0.2",
    extractorVersion: "phase1a-test",
    scope: {},
    artifactPaths: [join(root, "outside-artifact")],
  }), (error) => error instanceof SpatialStorePathError && error.reason === "artifact_path");

  const expiredArtifact = join(root, "artifacts", "expired.json");
  mkdirSync(join(root, "artifacts"), { recursive: true });
  writeFileSync(expiredArtifact, "sensitive local staging payload", "utf8");
  store.beginCapture({
    captureId: "capture:expired",
    snapshotId: "snapshot:expired",
    documentKey: "doc:expired",
    scopeFingerprint: "scope:expired",
    revisionFingerprint: "revision:expired",
    schemaVersion: "0.2",
    extractorVersion: "phase1a-test",
    scope: { documentKey: "doc:expired", coordinateFrame: "host_internal_mm" },
    expiresAtMs: clock + 1,
    artifactPaths: [expiredArtifact],
  });
  assert.equal(store.getStagingCaptureCount(), 1);
  const expired = store.cleanupExpiredStaging(clock + 2);
  assert.equal(expired.purgedStagingCaptureCount, 1);
  assert.equal(expired.removedArtifactCount, 1);
  assert.equal(existsSync(expiredArtifact), false);

  store.beginCapture({
    captureId: "capture:unfinished",
    snapshotId: "snapshot:unfinished",
    documentKey: "doc:host",
    scopeFingerprint: "scope:host",
    revisionFingerprint: "revision:unfinished",
    schemaVersion: "0.2",
    extractorVersion: "phase1a-test",
    scope: { documentKey: "doc:host", coordinateFrame: "host_internal_mm" },
    expiresAtMs: clock + DAY,
  });
  store.stagePage({
    captureId: "capture:unfinished",
    ordinal: 0,
    pageHash: "hash:unfinished:0",
    hasMore: true,
    payloadBytes: 10,
    nodes: [],
  });
  assert.throws(
    () => store.commitCapture({
      captureId: "capture:unfinished",
      sourceRevisions: [source("doc:host")],
      counts: { totalNodes: 0 },
      coverage: { totalOrderedRowCount: 0 },
      expectedPageCount: 1,
      expectedPayloadBytes: 10,
      expectedNodeCount: 0,
      expectedOmissionCount: 0,
      expectedNodesByKind: {},
      partial: false,
      coverageStatus: "complete",
      scanStoppedReason: "completed",
    }),
    /terminal page/,
  );
  assert.equal(store.getSnapshot("snapshot:unfinished"), null);
  assert.equal(store.abandonCapture("capture:unfinished").purgedStagingCaptureCount, 1);

  store.beginCapture({
    captureId: "capture:count-mismatch",
    snapshotId: "snapshot:count-mismatch",
    documentKey: "doc:host",
    scopeFingerprint: "scope:count-mismatch",
    revisionFingerprint: "revision:count-mismatch",
    schemaVersion: "0.2",
    extractorVersion: "phase1a-test",
    scope: {},
    expiresAtMs: clock + DAY,
  });
  store.stagePage({
    captureId: "capture:count-mismatch",
    ordinal: 0,
    pageHash: "hash:count-mismatch:0",
    hasMore: false,
    payloadBytes: 10,
    nodes: [{
      nodeId: "node:count-mismatch",
      documentKey: "doc:host",
      nodeKind: "revit_element",
      payload: {},
    }],
  });
  assert.throws(() => store.commitCapture({
    captureId: "capture:count-mismatch",
    sourceRevisions: [source("doc:host")],
    counts: { totalNodes: 2 },
    coverage: { totalOrderedRowCount: 2 },
    expectedPageCount: 1,
    expectedPayloadBytes: 10,
    expectedNodeCount: 2,
    expectedOmissionCount: 0,
    expectedNodesByKind: { revit_element: 2 },
    partial: false,
    coverageStatus: "complete",
    scanStoppedReason: "completed",
  }), /count reconciliation failed/);
  assert.equal(store.getSnapshot("snapshot:count-mismatch"), null, "count mismatch must fail before visibility");
  store.abandonCapture("capture:count-mismatch");

  const committedArtifact = join(root, "artifacts", "snapshot-host.json");
  writeFileSync(committedArtifact, "sensitive local snapshot payload", "utf8");
  store.beginCapture({
    captureId: "capture:host",
    snapshotId: "snapshot:host",
    documentKey: "doc:host",
    scopeFingerprint: "scope:host",
    revisionFingerprint: "revision:host",
    schemaVersion: "0.2",
    extractorVersion: "phase1a-test",
    scope: {
      documentKey: "doc:host",
      coordinateFrame: "host_internal_mm",
      requestedLevelUniqueIds: ["level:1"],
    },
    counts: { expectedSupportedNodes: 3, extractedSupportedNodes: 2 },
    effectiveSourcePolicy: { sourceDocumentPolicy: "host_and_loaded_links" },
    coverage: { complete: false, classifiedOmissionCount: 1, pageNodeCount: 1 },
    transformValidation: { maxRoundTripErrorMm: 0 },
    captureMetadata: { atomic: true, retryCount: 0 },
    capturedAtMs: clock - 2 * DAY,
    expiresAtMs: clock + DAY,
    artifactPaths: [committedArtifact],
  });
  store.stagePage({
    captureId: "capture:host",
    ordinal: 0,
    pageHash: "hash:host:0",
    hasMore: true,
    payloadBytes: 100,
    nodes: [{
      nodeId: "node:host:1",
      documentKey: "doc:host",
      nodeKind: "revit_element",
      elementUniqueId: "element:1",
      aabb: { minMm: [0, 0, 0], maxMm: [100, 100, 100] },
      payload: { category: "Ducts" },
    }],
    omissions: [{
      documentKey: "doc:host",
      reason: "geometry_unreadable",
      sourceIdentity: "element:omitted",
      payload: { classified: true },
    }],
  });
  store.stagePage({
    captureId: "capture:host",
    ordinal: 1,
    priorPageHash: "hash:host:0",
    pageHash: "hash:host:1",
    hasMore: false,
    payloadBytes: 75,
    nodes: [{
      nodeId: "node:link:1",
      documentKey: "doc:link",
      nodeKind: "revit_element",
      elementUniqueId: "linked-element:1",
      linkInstanceUniqueId: "link-placement:1",
      aabb: { minMm: [200, 200, 0], maxMm: [300, 300, 100] },
      payload: { category: "Walls" },
    }],
  });
  const committed = store.commitCapture({
    captureId: "capture:host",
    sourceRevisions: [
      source("doc:host"),
      source("doc:link", 4, {
        linkInstanceUniqueId: "link-placement:1",
        journalTruncated: true,
        externalLinkUpdateAvailable: true,
        metadata: { sourceKind: "link" },
      }),
    ],
    counts: {
      totalNodes: 2,
      nodesByKind: { revit_element: 2, connector: 0, derived: 0 },
      expectedSupportedNodes: 3,
      extractedSupportedNodes: 2,
      omittedSupportedNodes: 1,
      omissionsByReason: { geometry_unreadable: 1 },
    },
    effectiveSourcePolicy: { sourceDocumentPolicy: "host_and_loaded_links" },
    coverage: {
      complete: true,
      classifiedOmissionCount: 1,
      pageNodeCount: 1,
      terminalMarker: "terminal-page",
    },
    transformValidation: { maxRoundTripErrorMm: 0 },
    expectedPageCount: 2,
    expectedPayloadBytes: 175,
    expectedNodeCount: 2,
    expectedOmissionCount: 1,
    expectedNodesByKind: { revit_element: 2, connector: 0, derived: 0 },
    partial: false,
    coverageStatus: "complete",
    scanStoppedReason: "completed",
  });
  assert.equal(committed.pageCount, 2);
  assert.equal(committed.payloadBytes, 175);
  assert.equal(committed.sourceCount, 2);
  assert.equal(committed.nodeCount, 2);
  assert.equal(committed.omissionCount, 1);
  assert.equal(committed.complete, true);
  const fullRecord = store.getSnapshotRecord("snapshot:host");
  assert.deepEqual(fullRecord.scope.requestedLevelUniqueIds, ["level:1"]);
  assert.equal(fullRecord.declaredCounts.expectedSupportedNodes, 3);
  assert.equal(fullRecord.derivedCounts.totalNodes, 2);
  assert.equal(fullRecord.effectiveSourcePolicy.sourceDocumentPolicy, "host_and_loaded_links");
  assert.equal(fullRecord.coverage.classifiedOmissionCount, 1);
  assert.equal(fullRecord.coverage.complete, true, "terminal coverage must replace page-0 staging coverage");
  assert.equal(fullRecord.coverage.terminalMarker, "terminal-page");
  assert.equal(fullRecord.transformValidation.maxRoundTripErrorMm, 0);
  assert.equal(fullRecord.captureMetadata.atomic, true);
  assert.equal(fullRecord.sourceRevisions.length, 2);
  assert.equal(fullRecord.sourceRevisions[0].changeSequenceState, "tracked");
  assert.equal(fullRecord.sourceRevisions[0].journalCapacity, 100);
  assert.equal(fullRecord.sourceRevisions[0].documentKeyResolution.resolverVersion, "phase1a-test");
  assert.equal(fullRecord.sourceRevisions[1].journalTruncated, true);
  assert.equal(fullRecord.sourceRevisions[1].externalLinkUpdateAvailable, true);
  assert.equal(fullRecord.sourceRevisions[1].metadata.sourceKind, "link");
  assert.equal(store.getStagingCaptureCount(), 0);
  assert.equal(store.countRTreeEntries("snapshot:host"), 2);
  assert.deepEqual(
    store.queryIntersectingAabbs(
      { minMm: [50, 50, 50], maxMm: [150, 150, 150] },
      "snapshot:host",
    ).map((row) => row.nodeId),
    ["node:host:1"],
  );

  let randomState = 0x5eed1234;
  const random = () => {
    randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
    return randomState / 0x1_0000_0000;
  };
  const propertyNodes = Array.from({ length: 200 }, (_, index) => {
    const min = [0, 1, 2].map(() => Math.round((random() * 20_000 - 10_000) * 1000) / 1000);
    const size = [0, 1, 2].map(() => 1 + Math.round(random() * 500_000) / 1000);
    return {
      nodeId: `node:rtree:${index}`,
      documentKey: "doc:rtree-property",
      nodeKind: "revit_element",
      aabb: {
        minMm: min,
        maxMm: min.map((value, axis) => value + size[axis]),
      },
      payload: { index },
    };
  });
  store.beginCapture({
    captureId: "capture:rtree-property",
    snapshotId: "snapshot:rtree-property",
    documentKey: "doc:rtree-property",
    scopeFingerprint: "scope:rtree-property",
    revisionFingerprint: "revision:rtree-property",
    schemaVersion: "0.2",
    extractorVersion: "phase1a-test",
    scope: { coordinateFrame: "host_internal_mm" },
    capturedAtMs: clock,
    expiresAtMs: clock + DAY,
  });
  store.stagePage({
    captureId: "capture:rtree-property",
    ordinal: 0,
    pageHash: "hash:rtree-property:0",
    hasMore: false,
    payloadBytes: 4096,
    nodes: propertyNodes,
  });
  store.commitCapture({
    captureId: "capture:rtree-property",
    sourceRevisions: [source("doc:rtree-property")],
    counts: {
      totalNodes: propertyNodes.length,
      nodesByKind: { revit_element: propertyNodes.length, connector: 0, derived: 0 },
    },
    coverage: { complete: true, totalOrderedRowCount: propertyNodes.length },
    expectedPageCount: 1,
    expectedPayloadBytes: 4096,
    expectedNodeCount: propertyNodes.length,
    expectedOmissionCount: 0,
    expectedNodesByKind: { revit_element: propertyNodes.length, connector: 0, derived: 0 },
    partial: false,
    coverageStatus: "complete",
    scanStoppedReason: "completed",
  });
  for (let queryIndex = 0; queryIndex < 100; queryIndex += 1) {
    const min = [0, 1, 2].map(() => Math.round((random() * 20_000 - 10_000) * 1000) / 1000);
    const size = [0, 1, 2].map(() => 50 + Math.round(random() * 2000));
    const query = { minMm: min, maxMm: min.map((value, axis) => value + size[axis]) };
    const expectedIds = propertyNodes
      .filter((node) => node.aabb.minMm.every((nodeMin, axis) =>
        nodeMin <= query.maxMm[axis] && node.aabb.maxMm[axis] >= query.minMm[axis]))
      .map((node) => node.nodeId);
    const candidateIds = new Set(store.queryIntersectingAabbs(query, "snapshot:rtree-property").map((row) => row.nodeId));
    for (const expectedId of expectedIds) {
      assert.equal(candidateIds.has(expectedId), true, `RTree missed ${expectedId} for query ${queryIndex}`);
    }
  }

  const retentionDocument = "doc:retention";
  for (let index = 0; index < 25; index += 1) {
    captureOnePage(store, {
      captureId: `capture:retention:${index}`,
      snapshotId: `snapshot:retention:${String(index).padStart(2, "0")}`,
      documentKey: retentionDocument,
      capturedAtMs: (index + 1) * DAY,
    });
  }
  captureOnePage(store, {
    captureId: "capture:partial:old",
    snapshotId: "snapshot:partial:old",
    documentKey: retentionDocument,
    capturedAtMs: DAY,
    partial: true,
  });
  captureOnePage(store, {
    captureId: "capture:partial:recent",
    snapshotId: "snapshot:partial:recent",
    documentKey: retentionDocument,
    capturedAtMs: clock - DAY,
    partial: true,
  });
  const retention = store.applyRetention({ nowMs: clock });
  assert.equal(retention.purgedSnapshotCount, 6);
  const retained = store.listSnapshots(retentionDocument);
  assert.equal(retained.filter((row) => row.complete).length, 20);
  assert.equal(retained.some((row) => row.snapshotId === "snapshot:partial:old"), false);
  assert.equal(retained.some((row) => row.snapshotId === "snapshot:partial:recent"), true);

  const purge = store.purge({ snapshotIds: ["snapshot:host"] });
  assert.equal(purge.purgedSnapshotCount, 1);
  assert.equal(purge.removedArtifactCount, 1);
  assert.deepEqual(purge.artifactWarnings, []);
  assert.equal(existsSync(committedArtifact), false);
  assert.equal(store.getSnapshot("snapshot:host"), null);
  assert.equal(store.countRTreeEntries("snapshot:host"), 0);
  const refreshedBackupName = readdirSync(join(root, "store"))
    .find((entry) => entry.startsWith("spatial.db.migration-backup-"));
  assert.ok(refreshedBackupName);
  const scrubbedBackup = new Database(join(root, "store", refreshedBackupName), { readonly: true });
  assert.equal(
    scrubbedBackup.prepare(
      "SELECT count(*) FROM spatial_snapshots WHERE snapshot_id = 'snapshot:host'",
    ).pluck().get(),
    0,
  );
  scrubbedBackup.close();

  store.close();
  const reopened = new SpatialStore({ databasePath, now: () => clock });
  assert.deepEqual(reopened.getSchemaVersion(), { major: 1, minor: 2 });
  assert.equal(reopened.listSnapshots(retentionDocument).length, 21);
  reopened.close();

  const recoveryPath = join(root, "recovery-order", "spatial.db");
  let failRecoveryCreate = false;
  let failRecoveryDelete = false;
  const recoveryStore = new SpatialStore({
    databasePath: recoveryPath,
    now: () => clock,
    retentionPolicy: false,
    testHooks: {
      beforeRecoveryBackupCreate: () => {
        if (failRecoveryCreate) throw new Error("injected recovery create failure");
      },
      beforeRecoveryBackupDelete: () => {
        if (failRecoveryDelete) throw new Error("injected sensitive backup delete failure");
      },
    },
  });
  captureOnePage(recoveryStore, {
    captureId: "capture:recovery-sensitive",
    snapshotId: "snapshot:recovery-sensitive",
    documentKey: "doc:recovery",
    capturedAtMs: clock - 10,
  });
  captureOnePage(recoveryStore, {
    captureId: "capture:recovery-seed",
    snapshotId: "snapshot:recovery-seed",
    documentKey: "doc:recovery",
    capturedAtMs: clock - 9,
  });
  assert.deepEqual(
    recoveryStore.purge({ snapshotIds: ["snapshot:recovery-seed"] }).artifactWarnings,
    [],
  );
  const backupFolder = join(root, "recovery-order");
  const previousBackup = readdirSync(backupFolder)
    .map((name) => join(backupFolder, name))
    .find((filePath) => filePath.includes("spatial.db.migration-backup-"));
  assert.ok(previousBackup && existsSync(previousBackup));

  captureOnePage(recoveryStore, {
    captureId: "capture:recovery-create-fail",
    snapshotId: "snapshot:recovery-create-fail",
    documentKey: "doc:recovery",
    capturedAtMs: clock - 8,
  });
  failRecoveryCreate = true;
  const createFailurePurge = recoveryStore.purge({ snapshotIds: ["snapshot:recovery-create-fail"] });
  assert.match(createFailurePurge.artifactWarnings.join("; "), /previous backups were preserved/i);
  assert.equal(existsSync(previousBackup), true, "a failed replacement backup must not erase the prior recovery point");
  failRecoveryCreate = false;

  failRecoveryDelete = true;
  const deleteFailurePurge = recoveryStore.purge({ snapshotIds: ["snapshot:recovery-sensitive"] });
  assert.match(deleteFailurePurge.artifactWarnings.join("; "), /may retain purged data/i);
  assert.equal(existsSync(previousBackup), true, "an undeletable pre-purge backup must remain explicit evidence");
  const sensitiveBackup = new Database(previousBackup, { readonly: true });
  assert.equal(
    sensitiveBackup.prepare(
      "SELECT count(*) FROM spatial_snapshots WHERE snapshot_id = 'snapshot:recovery-sensitive'",
    ).pluck().get(),
    1,
  );
  sensitiveBackup.close();
  recoveryStore.close();

  const legacyPath = join(root, "legacy-1-0", "spatial.db");
  mkdirSync(join(root, "legacy-1-0"), { recursive: true });
  const legacySeed = new Database(legacyPath);
  legacySeed.exec(`
    CREATE TABLE spatial_store_metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO spatial_store_metadata(key, value) VALUES
      ('schema_major', '1'), ('schema_minor', '0'), ('schema_version', '1.0');
    CREATE TABLE spatial_snapshots(
      snapshot_id TEXT PRIMARY KEY, document_key TEXT NOT NULL,
      captured_at_ms INTEGER NOT NULL, committed_at_ms INTEGER NOT NULL,
      scope_fingerprint TEXT NOT NULL, revision_fingerprint TEXT NOT NULL,
      schema_version TEXT NOT NULL, extractor_version TEXT NOT NULL,
      complete INTEGER NOT NULL, partial INTEGER NOT NULL, coverage_status TEXT,
      scan_stopped_reason TEXT NOT NULL, suggested_next_scopes_json TEXT NOT NULL,
      counts_json TEXT NOT NULL, page_count INTEGER NOT NULL, payload_bytes INTEGER NOT NULL
    );
    INSERT INTO spatial_snapshots VALUES(
      'legacy:snapshot', 'legacy:doc', ${clock}, ${clock}, 'legacy:scope', 'legacy:revision',
      '0.2', 'legacy-extractor', 1, 0, 'complete', 'completed', '[]',
      '{"totalNodes":0,"nodesByKind":{},"omittedSupportedNodes":0,"omissionsByReason":{}}', 1, 0
    );
    CREATE TABLE spatial_snapshot_sources(
      snapshot_id TEXT NOT NULL, source_key TEXT NOT NULL, document_key TEXT NOT NULL,
      document_session_id TEXT NOT NULL, loaded_version TEXT NOT NULL,
      change_sequence INTEGER NOT NULL, oldest_retained_sequence INTEGER,
      link_instance_unique_id TEXT, source_to_host_transform_json TEXT NOT NULL,
      external_link_update_available INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(snapshot_id, source_key)
    );
    INSERT INTO spatial_snapshot_sources VALUES(
      'legacy:snapshot', 'legacy:doc::host', 'legacy:doc', 'legacy:session',
      'legacy:loaded', 3, 0, NULL, '{"matrix":[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]}', 0
    );
    CREATE TABLE spatial_capture_staging(
      capture_id TEXT PRIMARY KEY, snapshot_id TEXT NOT NULL UNIQUE,
      document_key TEXT NOT NULL, scope_fingerprint TEXT NOT NULL,
      revision_fingerprint TEXT NOT NULL, schema_version TEXT NOT NULL,
      extractor_version TEXT NOT NULL, captured_at_ms INTEGER NOT NULL,
      created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL,
      expires_at_ms INTEGER NOT NULL
    );
    CREATE TABLE spatial_nodes(snapshot_id TEXT NOT NULL, node_id TEXT NOT NULL);
    CREATE TABLE spatial_omissions(snapshot_id TEXT NOT NULL);
    CREATE VIRTUAL TABLE spatial_node_rtree USING rtree(
      node_rowid, min_x, max_x, min_y, max_y, min_z, max_z
    );
  `);
  legacySeed.close();
  const legacyMigrated = new SpatialStore({
    databasePath: legacyPath,
    now: () => clock,
    retentionPolicy: false,
  });
  assert.deepEqual(legacyMigrated.getSchemaVersion(), { major: 1, minor: 2 });
  const legacyRecord = legacyMigrated.getSnapshotRecord("legacy:snapshot");
  assert.equal(legacyRecord.documentKey, "legacy:doc");
  assert.equal(legacyRecord.revisionFingerprint, "legacy:revision");
  assert.equal(legacyRecord.sourceRevisions[0].changeSequence, 3);
  assert.deepEqual(legacyRecord.scope, {});
  legacyMigrated.close();

  const migrationPath = join(root, "migration", "spatial.db");
  mkdirSync(join(root, "migration"), { recursive: true });
  const seed = new Database(migrationPath);
  seed.exec("CREATE TABLE sentinel(value TEXT NOT NULL); INSERT INTO sentinel(value) VALUES ('preserve-me');");
  seed.close();
  assert.throws(
    () => new SpatialStore({
      databasePath: migrationPath,
      now: () => clock,
      testHooks: {
        beforeMigrationCommit: () => {
          throw new Error("injected migration failure");
        },
      },
    }),
    (error) => error instanceof SpatialStoreMigrationError && error.backupPath !== null,
  );
  const restoredSeed = new Database(migrationPath, { readonly: true });
  assert.equal(restoredSeed.prepare("SELECT value FROM sentinel").pluck().get(), "preserve-me");
  assert.equal(
    restoredSeed.prepare("SELECT count(*) FROM sqlite_master WHERE name = 'spatial_snapshots'").pluck().get(),
    0,
  );
  restoredSeed.close();
  const migrated = new SpatialStore({ databasePath: migrationPath, now: () => clock });
  assert.deepEqual(migrated.getSchemaVersion(), { major: 1, minor: 2 });
  migrated.close();

  const recoveryBackup = `${migrationPath}.migration-backup-manual`;
  copyFileSync(migrationPath, recoveryBackup);
  writeFileSync(migrationPath, "not a sqlite database", "utf8");
  const recovered = new SpatialStore({ databasePath: migrationPath, now: () => clock });
  assert.equal(recovered.recoveredFromBackupPath, recoveryBackup);
  assert.deepEqual(recovered.getSchemaVersion(), { major: 1, minor: 2 });
  recovered.close();
  assert.ok(readFileSync(migrationPath).subarray(0, 15).toString("utf8").startsWith("SQLite format 3"));

  const retentionEnvPath = join(root, "retention-env", "spatial.db");
  const retentionEnvSeed = new SpatialStore({
    databasePath: retentionEnvPath,
    now: () => clock,
    retentionPolicy: false,
  });
  captureOnePage(retentionEnvSeed, {
    captureId: "capture:retention-env:old",
    snapshotId: "snapshot:retention-env:old",
    documentKey: "doc:retention-env",
    capturedAtMs: clock - 10 * DAY,
  });
  captureOnePage(retentionEnvSeed, {
    captureId: "capture:retention-env:new",
    snapshotId: "snapshot:retention-env:new",
    documentKey: "doc:retention-env",
    capturedAtMs: clock - 5 * DAY,
  });
  retentionEnvSeed.close();
  const retentionEnvironment = [
    "REVAGENT_SPATIAL_RETENTION_DAYS",
    "REVAGENT_SPATIAL_MIN_COMPLETE_SNAPSHOTS",
    "REVAGENT_SPATIAL_RETENTION_DISABLED",
  ];
  const savedRetentionEnvironment = Object.fromEntries(
    retentionEnvironment.map((name) => [name, process.env[name]]),
  );
  try {
    process.env.REVAGENT_SPATIAL_RETENTION_DAYS = "0";
    process.env.REVAGENT_SPATIAL_MIN_COMPLETE_SNAPSHOTS = "1";
    delete process.env.REVAGENT_SPATIAL_RETENTION_DISABLED;
    const retentionEnvApplied = new SpatialStore({
      databasePath: retentionEnvPath,
      now: () => clock,
    });
    assert.deepEqual(
      retentionEnvApplied.listSnapshots("doc:retention-env").map((row) => row.snapshotId),
      ["snapshot:retention-env:new"],
    );
    retentionEnvApplied.close();
  } finally {
    for (const name of retentionEnvironment) {
      const value = savedRetentionEnvironment[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }

  const snapshotSource = {
    documentKey: "doc:live",
    documentSessionId: "session:1",
    trackerSessionId: "tracker:1",
    changeSequence: 10,
  };
  const liveBase = {
    documentKey: "doc:live",
    documentSessionId: "session:1",
    trackerSessionId: "tracker:1",
    changeSequence: 10,
    oldestRetainedSequence: 5,
    journal: [],
  };
  assert.equal(evaluateSpatialLiveness({
    snapshotSources: [snapshotSource],
    liveSources: [liveBase],
  }).liveness, "current");
  assert.equal(evaluateSpatialLiveness({
    snapshotSources: [{ ...snapshotSource, trackerSessionId: null }],
    liveSources: [liveBase],
  }).reasons[0].code, "tracker_session_unavailable");
  assert.equal(evaluateSpatialLiveness({
    snapshotSources: [snapshotSource],
    liveSources: [{
      ...liveBase,
      changeSequence: 11,
      journal: [{ sequence: 11, scopeImpact: "relevant" }],
    }],
  }).liveness, "stale");
  assert.equal(evaluateSpatialLiveness({
    snapshotSources: [snapshotSource],
    liveSources: [{
      ...liveBase,
      changeSequence: 12,
      journal: [
        { sequence: 11, scopeImpact: "irrelevant" },
        { sequence: 12, scopeImpact: "irrelevant" },
      ],
    }],
  }).liveness, "current");
  assert.equal(evaluateSpatialLiveness({
    snapshotSources: [snapshotSource],
    liveSources: [{ ...liveBase, documentSessionId: "session:2" }],
  }).liveness, "unknown");
  assert.equal(evaluateSpatialLiveness({
    snapshotSources: [{ ...snapshotSource, trackerSessionId: "tracker:1" }],
    liveSources: [{ ...liveBase, trackerSessionId: "tracker:2" }],
  }).reasons[0].code, "tracker_session_changed");
  assert.equal(evaluateSpatialLiveness({
    snapshotSources: [{ ...snapshotSource, changeSequenceState: "unknown_phase0_sentinel" }],
    liveSources: [liveBase],
  }).reasons[0].code, "change_sequence_unknown");
  assert.equal(evaluateSpatialLiveness({
    snapshotSources: [snapshotSource],
    liveSources: [{
      ...liveBase,
      changeSequence: 12,
      oldestRetainedSequence: 11,
      historyCompleteAfterSequence: 11,
      journal: [{ sequence: 11 }, { sequence: 12 }],
    }],
  }).reasons[0].code, "journal_gap");
  assert.equal(evaluateSpatialLiveness({
    snapshotSources: [snapshotSource],
    liveSources: [{
      ...liveBase,
      changeSequence: 12,
      journal: [{ sequence: 12 }],
    }],
  }).reasons[0].code, "journal_incomplete");
  const externalUpdate = evaluateSpatialLiveness({
    snapshotSources: [snapshotSource],
    liveSources: [{ ...liveBase, externalLinkUpdateAvailable: true }],
  });
  assert.equal(externalUpdate.liveness, "current");
  assert.equal(externalUpdate.warnings.length, 1);

  console.log("spatial-phase1a-store.test: passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
