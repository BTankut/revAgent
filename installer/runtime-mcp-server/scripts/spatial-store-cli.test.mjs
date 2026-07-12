import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { SpatialStore } from "../build/spatial/spatialStore.js";
import { runSpatialStoreCli } from "../build/spatial/spatialStoreCli.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const runtimeRoot = path.resolve(__dirname, "..");
const indexPath = path.join(runtimeRoot, "build", "index.js");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "revagent-spatial-cli-"));
const databasePath = path.join(root, "spatial.db");

function sourceRevision(documentKey) {
  return {
    documentKey,
    documentSessionId: `session:${documentKey}`,
    trackerSessionId: "tracker:cli",
    loadedVersion: `loaded:${documentKey}`,
    changeSequence: 1,
    changeSequenceState: "tracked",
    oldestRetainedSequence: 0,
    journalEntryCount: 1,
    journalCapacity: 512,
    journalTruncated: false,
    linkInstanceUniqueId: null,
    sourceToHostTransform: { matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
  };
}

function begin(store, captureId, snapshotId, documentKey, capturedAtMs) {
  store.beginCapture({
    captureId,
    snapshotId,
    documentKey,
    scopeFingerprint: `scope:${snapshotId}`,
    revisionFingerprint: `revision:${snapshotId}`,
    schemaVersion: "0.2",
    extractorVersion: "cli-test/0.2",
    scope: { hostDocumentKey: documentKey },
    counts: { totalNodes: 1 },
    capturedAtMs,
  });
}

function commitSnapshot(store, snapshotId, documentKey, capturedAtMs) {
  const captureId = `capture:${snapshotId}`;
  begin(store, captureId, snapshotId, documentKey, capturedAtMs);
  store.stagePage({
    captureId,
    ordinal: 0,
    priorPageHash: null,
    pageHash: `hash:${snapshotId}`,
    hasMore: false,
    payloadBytes: 1,
    nodes: [{
      nodeId: `node:${snapshotId}`,
      documentKey,
      nodeKind: "revit_element",
      aabb: { minMm: [0, 0, 0], maxMm: [1, 1, 1] },
      payload: { snapshotId },
    }],
    omissions: [],
  });
  store.commitCapture({
    captureId,
    sourceRevisions: [sourceRevision(documentKey)],
    counts: {
      totalNodes: 1,
      nodesByKind: { revit_element: 1, connector: 0, derived: 0 },
      expectedSupportedNodes: 1,
      extractedSupportedNodes: 1,
      omittedSupportedNodes: 0,
      omissionsByReason: {},
      connectorOmissionsByReason: {},
    },
    coverage: { totalOrderedRowCount: 1, sourceAvailabilityOmissionCount: 0 },
    expectedPageCount: 1,
    expectedPayloadBytes: 1,
    expectedNodeCount: 1,
    expectedOmissionCount: 0,
    expectedNodesByKind: { revit_element: 1, connector: 0, derived: 0 },
    partial: false,
    coverageStatus: "complete",
    scanStoppedReason: "completed",
  });
}

function runCli(...args) {
  const result = spawnSync(process.execPath, [indexPath, "spatial-store", ...args], {
    cwd: runtimeRoot,
    encoding: "utf8",
    windowsHide: true,
    env: {
      ...process.env,
      REVAGENT_SPATIAL_DB_PATH: databasePath,
      REVAGENT_SPATIAL_RETENTION_DAYS: "0",
      REVAGENT_SPATIAL_MIN_COMPLETE_SNAPSHOTS: "0",
    },
  });
  assert.equal(result.signal, null);
  assert.equal(result.stderr, "", `spatial-store CLI must emit JSON only on local stdout: ${result.stderr}`);
  const output = JSON.parse(result.stdout);
  return { ...result, output };
}

try {
  let warningStoreClosed = false;
  const warningOutput = [];
  const warningExitCode = runSpatialStoreCli(
    ["purge", "--all", "--confirm"],
    (value) => warningOutput.push(value),
    {
      createStore: () => ({
        previewPurge: () => ({ snapshotIds: ["sensitive"], stagingCaptureIds: [], snapshotCount: 1, stagingCaptureCount: 0 }),
        purge: () => ({
          purgedSnapshotCount: 1,
          purgedStagingCaptureCount: 0,
          removedArtifactCount: 0,
          artifactWarnings: ["pre-purge recovery backup may retain purged data"],
        }),
        close: () => { warningStoreClosed = true; },
      }),
    },
  );
  assert.equal(warningExitCode, 3);
  assert.equal(warningOutput[0].success, false);
  assert.equal(warningOutput[0].partial, true);
  assert.equal(warningOutput[0].reason, "purge_cleanup_incomplete");
  assert.equal(warningStoreClosed, true, "maintenance store must close even for partial purge cleanup");

  const seed = new SpatialStore({
    databasePath,
    retentionPolicy: false,
    now: () => Date.now() - 60 * 60 * 1000,
  });
  const oldCapturedAt = Date.now() - 365 * 24 * 60 * 60 * 1000;
  commitSnapshot(seed, "snapshot:a", "doc:a", oldCapturedAt);
  commitSnapshot(seed, "snapshot:b", "doc:b", oldCapturedAt + 1);
  begin(seed, "capture:staging-a", "snapshot:staging-a", "doc:a", Date.now());
  seed.close();
  const expiredLease = new Database(databasePath);
  expiredLease.prepare("UPDATE spatial_capture_staging SET expires_at_ms = 0 WHERE capture_id = ?")
    .run("capture:staging-a");
  expiredLease.close();

  const preview = runCli("preview", "--document-key", "doc:a");
  assert.equal(preview.status, 0);
  assert.equal(preview.output.mutated, false);
  assert.deepEqual(preview.output.preview.snapshotIds, ["snapshot:a"]);
  assert.deepEqual(preview.output.preview.stagingCaptureIds, ["capture:staging-a"]);

  const afterPreview = new SpatialStore({ databasePath, retentionPolicy: false, cleanupExpiredStagingOnOpen: false });
  assert.equal(afterPreview.listSnapshots().length, 2, "preview must disable constructor retention and remain read-only");
  assert.equal(afterPreview.getStagingCaptureCount(), 1);
  afterPreview.close();

  const invalidSelectors = runCli("preview", "--all", "--document-key", "doc:a");
  assert.equal(invalidSelectors.status, 2);
  assert.equal(invalidSelectors.output.reason, "invalid_arguments");

  const noConfirm = runCli("purge", "--document-key", "doc:a");
  assert.equal(noConfirm.status, 2);
  assert.equal(noConfirm.output.reason, "confirmation_required");
  assert.equal(noConfirm.output.mutated, false);
  const afterNoConfirm = new SpatialStore({ databasePath, retentionPolicy: false, cleanupExpiredStagingOnOpen: false });
  assert.ok(afterNoConfirm.getSnapshot("snapshot:a"), "purge without --confirm must not mutate snapshots");
  assert.equal(afterNoConfirm.getStagingCaptureCount(), 1);
  afterNoConfirm.close();

  const scoped = runCli("purge", "--snapshot-id", "snapshot:b", "--confirm");
  assert.equal(scoped.status, 0);
  assert.equal(scoped.output.purge.purgedSnapshotCount, 1);
  const afterScoped = new SpatialStore({ databasePath, retentionPolicy: false, cleanupExpiredStagingOnOpen: false });
  assert.ok(afterScoped.getSnapshot("snapshot:a"));
  assert.equal(afterScoped.getSnapshot("snapshot:b"), null);
  assert.equal(afterScoped.getStagingCaptureCount(), 1);
  afterScoped.close();

  const all = runCli("purge", "--all", "--confirm");
  assert.equal(all.status, 0);
  assert.equal(all.output.purge.purgedSnapshotCount, 1);
  assert.equal(all.output.purge.purgedStagingCaptureCount, 1);
  const afterAll = new SpatialStore({ databasePath, retentionPolicy: false });
  assert.equal(afterAll.listSnapshots().length, 0);
  assert.equal(afterAll.getStagingCaptureCount(), 0);
  afterAll.close();

  const packageJson = JSON.parse(fs.readFileSync(path.join(runtimeRoot, "package.json"), "utf8"));
  assert.equal(packageJson.scripts["spatial-store"], "node build/index.js spatial-store");
  console.log("spatial store local maintenance CLI tests: ok");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
