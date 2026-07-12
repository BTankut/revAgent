import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import Database from "better-sqlite3";
import { SpatialStore, SpatialStoreIntegrityError } from "../build/spatial/spatialStore.js";
import {
  TEST_NOW_MS,
  createTestStore,
  makeElementNode,
  operationFixtureNodes,
  seedSnapshot,
} from "./spatial-phase1b-test-helpers.mjs";

{
  const fixture = createTestStore("store");
  try {
    assert.deepEqual(fixture.store.getSchemaVersion(), { major: 1, minor: 2 });
    seedSnapshot(fixture.store, {
      snapshotId: "snapshot:store-v03",
      nodes: operationFixtureNodes(),
    });

    const duct = fixture.store.getStoredNode("snapshot:store-v03", "node:duct-a");
    assert.equal(duct.category, "Ducts");
    assert.equal(duct.builtInCategory, "OST_DuctCurves");
    assert.equal(duct.categoryRole, "mep_curve");
    assert.equal(duct.levelUniqueId, "level:01");
    assert.equal(duct.levelName, "Level 01");
    assert.equal(duct.systemKey, "Supply Air");
    assert.match(duct.placementFingerprint, /^sha256:[a-f0-9]{64}$/);

    const filtered = fixture.store.queryStoredNodes({
      snapshotId: "snapshot:store-v03",
      categories: ["Ducts"],
      levelUniqueIds: ["level:01"],
      systemKeys: ["Supply Air"],
      limit: 10,
    });
    assert.deepEqual(filtered.nodes.map((node) => node.nodeId), ["node:duct-a"]);
    assert.equal(filtered.hasMore, false);

    const edges = fixture.store.queryStoredEdges({ snapshotId: "snapshot:store-v03", limit: 100 });
    assert.equal(edges.hasMore, false);
    assert.equal(edges.edges.filter((edge) => edge.relationType === "owns_connector").length, 2);
    assert.equal(edges.edges.filter((edge) => edge.relationType === "connected_to").length, 1,
      "Reciprocal native refs must normalize to one canonical bidirectional connection edge.");
    assert.ok(fixture.store.getAdjacentStoredEdges("snapshot:store-v03", "node:duct-a")
      .some((edge) => edge.relationType === "owns_connector"));

    const topology = fixture.store.getSnapshotTopologyCapability("snapshot:store-v03");
    assert.equal(topology.connectorCount, 2);
    assert.equal(topology.readComplete, true);
    assert.equal(topology.targetMembershipValidated, true);
    assert.equal(topology.unresolvedPeerReferenceCount, 0);
    assert.equal(topology.ambiguousConnectorCount, 0);

    const preview = fixture.store.previewPurge({ snapshotIds: ["snapshot:store-v03"] });
    assert.deepEqual(preview.snapshotIds, ["snapshot:store-v03"]);
    const purged = fixture.store.purge({ snapshotIds: ["snapshot:store-v03"] });
    assert.equal(purged.purgedSnapshotCount, 1);
    assert.equal(fixture.store.getSnapshot("snapshot:store-v03"), null);
    assert.deepEqual(fixture.store.queryStoredEdges({ snapshotId: "snapshot:store-v03" }).edges, []);
    assert.equal(fixture.store.getSnapshotTopologyCapability("snapshot:store-v03"), null);

    seedSnapshot(fixture.store, {
      snapshotId: "snapshot:retention-old-v03",
      nodes: operationFixtureNodes(),
      capturedAtMs: TEST_NOW_MS - 100 * 24 * 60 * 60 * 1_000,
    });
    seedSnapshot(fixture.store, {
      snapshotId: "snapshot:retention-new-v03",
      nodes: operationFixtureNodes(),
      capturedAtMs: TEST_NOW_MS - 1_000,
    });
    assert.ok(fixture.store.queryStoredEdges({ snapshotId: "snapshot:retention-old-v03" }).edges.length > 0);
    const retained = fixture.store.applyRetention({
      nowMs: TEST_NOW_MS,
      retentionDays: 30,
      minCompleteSnapshots: 1,
    });
    assert.equal(retained.purgedSnapshotCount, 1);
    assert.equal(fixture.store.getSnapshot("snapshot:retention-old-v03"), null);
    assert.deepEqual(fixture.store.queryStoredEdges({ snapshotId: "snapshot:retention-old-v03" }).edges, []);
    assert.equal(fixture.store.getSnapshotTopologyCapability("snapshot:retention-old-v03"), null,
      "Retention must cascade through Phase 1b edge and topology rows.");
    assert.ok(fixture.store.getSnapshot("snapshot:retention-new-v03"));
    assert.ok(fixture.store.queryStoredEdges({ snapshotId: "snapshot:retention-new-v03" }).edges.length > 0);
  } finally {
    fixture.cleanup();
  }
}

// A v0.3 exact analytic profile may only enter the indexed store when its
// AABB conservatively contains the diameter-plus-insulation swept envelope.
{
  const fixture = createTestStore("store-invalid-analytic-envelope");
  try {
    assert.throws(() => seedSnapshot(fixture.store, {
      snapshotId: "snapshot:store-invalid-analytic-envelope",
      nodes: [makeElementNode({
        nodeId: "node:bare-aabb-with-thick-insulation",
        category: "Ducts",
        builtInCategory: "OST_DuctCurves",
        categoryRole: "mep_curve",
        aabb: { minMm: [0, -50, -50], maxMm: [1_000, 50, 50] },
        centerline: [[0, 0, 0], [1_000, 0, 0]],
        profile: { shape: "round", diameterMm: 100, insulationThicknessMm: 300 },
      })],
    }), (error) => {
      assert.ok(error instanceof SpatialStoreIntegrityError);
      assert.match(error.message, /does not contain its diameter plus insulation envelope/);
      return true;
    });
    assert.equal(fixture.store.getSnapshot("snapshot:store-invalid-analytic-envelope"), null,
      "An inconsistent exact-analytic AABB commit must roll back atomically.");
  } finally {
    fixture.cleanup();
  }
}

// Exercise the real 1.1 -> 1.2 path against a pre-existing v0.2 snapshot, then
// prove that new v0.3 commits derive edges and that purge cascades the new rows.
{
  const fixture = createTestStore("migration-1-1");
  let migrated = null;
  try {
    seedSnapshot(fixture.store, {
      snapshotId: "snapshot:legacy-v02",
      schemaVersion: "0.2",
      nodes: operationFixtureNodes().slice(0, 2),
    });
    fixture.store.close();

    const legacy = new Database(fixture.databasePath);
    try {
      legacy.pragma("foreign_keys = OFF");
      legacy.transaction(() => {
        for (const indexName of [
          "spatial_nodes_kind",
          "spatial_nodes_category",
          "spatial_nodes_built_in_category",
          "spatial_nodes_role",
          "spatial_nodes_level_name",
          "spatial_nodes_level_unique_id",
          "spatial_nodes_system",
          "spatial_nodes_owner",
        ]) legacy.exec(`DROP INDEX IF EXISTS ${indexName}`);
        legacy.exec("DROP TABLE IF EXISTS spatial_edges");
        legacy.exec("DROP TABLE IF EXISTS spatial_snapshot_topology");
        for (const tableName of ["spatial_nodes", "spatial_staging_nodes"]) {
          for (const columnName of [
            "category",
            "built_in_category",
            "category_role",
            "level_unique_id",
            "level_name",
            "owner_node_id",
            "system_key",
            "geometry_fingerprint",
            "placement_fingerprint",
            "shape_fingerprint",
            "property_fingerprint",
            "topology_fingerprint",
          ]) legacy.exec(`ALTER TABLE ${tableName} DROP COLUMN ${columnName}`);
        }
        legacy.prepare("UPDATE spatial_store_metadata SET value = '1' WHERE key = 'schema_minor'").run();
        legacy.prepare("UPDATE spatial_store_metadata SET value = '1.1' WHERE key = 'schema_version'").run();
        legacy.pragma("user_version = 1001");
      })();
    } finally {
      legacy.close();
    }

    migrated = new SpatialStore({
      databasePath: fixture.databasePath,
      now: () => TEST_NOW_MS,
      retentionPolicy: false,
      cleanupExpiredStagingOnOpen: false,
    });
    assert.deepEqual(migrated.getSchemaVersion(), { major: 1, minor: 2 });
    assert.equal(migrated.getStoredNode("snapshot:legacy-v02", "node:duct-a").nodeId, "node:duct-a",
      "A 1.1 snapshot must remain readable through the v0.2 adapter after migration.");
    assert.equal(migrated.getSnapshotTopologyCapability("snapshot:legacy-v02"), null,
      "Migration must not fabricate connector topology for historical v0.2 snapshots.");

    seedSnapshot(migrated, {
      snapshotId: "snapshot:post-migration-v03",
      nodes: operationFixtureNodes(),
      capturedAtMs: TEST_NOW_MS - 5_000,
    });
    assert.equal(migrated.queryStoredEdges({ snapshotId: "snapshot:post-migration-v03" }).edges.length, 3);
    assert.equal(migrated.getSnapshotTopologyCapability("snapshot:post-migration-v03").targetMembershipValidated, true);

    const purge = migrated.purge({ snapshotIds: ["snapshot:post-migration-v03"] });
    assert.equal(purge.purgedSnapshotCount, 1);
    assert.deepEqual(migrated.queryStoredEdges({ snapshotId: "snapshot:post-migration-v03" }).edges, []);
    assert.equal(migrated.getSnapshotTopologyCapability("snapshot:post-migration-v03"), null);
  } finally {
    try {
      migrated?.close();
    } finally {
      try {
        fixture.store.close();
      } finally {
        rmSync(fixture.root, { recursive: true, force: true });
      }
    }
  }
}

console.log("spatial Phase 1b store 1.2 tests: ok");
